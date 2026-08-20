import { decodeDeliveryTarget, encodeDeliveryTarget } from "./target.ts";
import { errMessage, swallow } from "../../chassis/src/errors.ts";
import { CoreClient } from "./core.ts";
import { TlonConnection } from "./tlon.ts";
import type { Delivery, InboundMessage, Installation } from "./types.ts";

interface ManagedConnection {
  readonly installation: Installation;
  start(): Promise<void>;
  stop(): Promise<void>;
  runtimeStatus(): { status: "connecting" | "connected" | "error"; message?: string };
  deliver(delivery: Delivery, signal?: AbortSignal): Promise<void>;
  enrichInbound(message: InboundMessage, signal?: AbortSignal): Promise<InboundMessage>;
  publishPresence(conversationId: string, toolNames: string[]): Promise<void>;
  clearPresence(conversationId: string): Promise<void>;
  verifiedChannels?(): Promise<string[]>;
}

type ConnectionFactory = (
  installation: Installation,
  inbound: (message: InboundMessage, previousId?: string, signal?: AbortSignal) => Promise<string | void>,
) => ManagedConnection;

interface DesiredPresence {
  accountId: string;
  accountVersion: string;
  conversationId: string;
  toolNames: string[] | null;
  revision: number;
  force: boolean;
}

interface PublishedPresence {
  accountId: string;
  accountVersion: string;
  conversationId: string;
  value: string;
  at: number;
}

const PRESENCE_REFRESH_MS = 30_000;
const PRESENCE_OPERATION_MS = 5_000;

class InstallationChangedError extends Error {}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`operation timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class TlonController {
  private readonly core: CoreClient;
  private readonly connectionFactory: ConnectionFactory;
  private readonly connections = new Map<string, ManagedConnection>();
  private readonly verifiedChannels = new Map<string, { version: string; channels: Set<string> }>();
  private readonly abort = new AbortController();
  private reconcileTask: Promise<void> | null = null;
  private deliveryTask: Promise<void> | null = null;
  private inboundTask: Promise<void> | null = null;
  private presenceTask: Promise<void> | null = null;
  private readonly retries = new Map<string, { version: string; at: number; delay: number }>();
  private readonly desiredPresence = new Map<string, DesiredPresence>();
  private readonly publishedPresence = new Map<string, PublishedPresence>();
  private readonly presenceWorkers = new Map<string, Promise<void>>();
  private readonly presenceOperations = new Map<string, Promise<void>>();
  private presenceRefreshGeneration = 0;

  constructor(core: CoreClient, connectionFactory?: ConnectionFactory) {
    this.core = core;
    this.connectionFactory =
      connectionFactory ??
      ((installation, inbound) =>
        new TlonConnection(installation, inbound, {
          stageBlob: (bytes, signal) => this.core.stageBlob(bytes, signal),
          readAttachment: (deliveryId, index, signal) => this.core.deliveryAttachment(deliveryId, index, signal),
        }));
  }

  start(): void {
    if (this.reconcileTask) return;
    this.reconcileTask = this.reconcileLoop();
    this.deliveryTask = this.deliveryLoop();
    this.inboundTask = this.inboundLoop();
    this.presenceTask = this.presenceLoop();
  }

  health(): { ok: true; accounts: number } {
    return { ok: true, accounts: this.connections.size };
  }

  private async reconcile(): Promise<void> {
    const installations = await this.core.installations();
    const desired = new Map(installations.map((installation) => [installation.id, installation]));
    for (const id of this.retries.keys()) if (!desired.has(id)) this.retries.delete(id);
    for (const presence of this.desiredPresence.values()) {
      if (desired.get(presence.accountId)?.version !== presence.accountVersion) {
        this.dropAccountPresence(presence.accountId);
      }
    }
    await Promise.all(
      [...this.connections].map(async ([id, connection]) => {
        const next = desired.get(id);
        if (next?.version === connection.installation.version) {
          let runtime = connection.runtimeStatus();
          let verifiedChannels: string[] | undefined;
          if (runtime.status === "connected") {
            try {
              verifiedChannels = await within(connection.verifiedChannels?.() ?? Promise.resolve([]), 30_000);
            } catch (error) {
              runtime = { status: "error", message: `channel verification failed: ${errMessage(error)}` };
              verifiedChannels = [];
            }
          }
          let reportFailed = false;
          await this.core.report(id, next.version, runtime.status, runtime.message, verifiedChannels).then(
            () => {
              if (verifiedChannels) {
                this.verifiedChannels.set(id, { version: next.version, channels: new Set(verifiedChannels) });
              }
            },
            (error) => {
              swallow(`report Tlon connection ${id}`, error);
              reportFailed = verifiedChannels !== undefined;
            },
          );
          if (runtime.status !== "error" && !reportFailed) return;
          this.scheduleRetry(id, next.version);
        }
        this.connections.delete(id);
        this.verifiedChannels.delete(id);
        await connection.stop().catch((error) => swallow(`stop Tlon connection ${id}`, error));
        this.forgetPublishedPresence(id);
        if (!next || next.version !== connection.installation.version)
          await this.core
            .report(id, connection.installation.version, "stopped")
            .catch((error) => swallow(`report stopped Tlon connection ${id}`, error));
      }),
    );
    await Promise.all(
      installations
        .filter((installation) => {
          if (this.connections.has(installation.id)) return false;
          const retry = this.retries.get(installation.id);
          if (!retry || retry.version !== installation.version) {
            this.retries.delete(installation.id);
            return true;
          }
          return retry.at <= Date.now();
        })
        .map(async (installation) => {
          await this.core.report(installation.id, installation.version, "connecting");
          const connection = this.connectionFactory(installation, (message, previousId, signal) =>
            this.acceptInbound(installation.id, message, previousId, signal),
          );
          let stopped = false;
          const stopConnection = async (): Promise<void> => {
            if (stopped) return;
            stopped = true;
            await connection
              .stop()
              .catch((stopError) => swallow(`stop failed Tlon connection ${installation.id}`, stopError));
          };
          try {
            await this.whileInstallationCurrent(installation.id, installation.version, async () => {
              try {
                await within(connection.start(), 30_000);
                const verifiedChannels = await within(connection.verifiedChannels?.() ?? Promise.resolve([]), 30_000);
                await this.core.report(installation.id, installation.version, "connected", undefined, verifiedChannels);
                this.verifiedChannels.set(installation.id, {
                  version: installation.version,
                  channels: new Set(verifiedChannels),
                });
                this.connections.set(installation.id, connection);
                this.retries.delete(installation.id);
                this.syncAccountPresence(installation.id);
              } catch (error) {
                await stopConnection();
                throw error;
              }
            });
          } catch (error) {
            this.connections.delete(installation.id);
            this.verifiedChannels.delete(installation.id);
            await stopConnection();
            if (error instanceof InstallationChangedError) {
              const retry = this.retries.get(installation.id);
              if (retry?.version === installation.version) this.retries.delete(installation.id);
              return;
            }
            const message = errMessage(error);
            console.error(`[tlon] connection ${installation.id} failed: ${message}`);
            this.scheduleRetry(installation.id, installation.version);
            await this.core.report(installation.id, installation.version, "error", message);
          }
        }),
    );
  }

  private scheduleRetry(id: string, version: string): void {
    const previous = this.retries.get(id);
    const delay = previous?.version === version ? Math.min(previous.delay * 2, 300_000) : 5_000;
    this.retries.set(id, { version, delay, at: Date.now() + delay });
  }

  private async reconcileLoop(): Promise<void> {
    while (!this.abort.signal.aborted) {
      try {
        await this.reconcile();
      } catch (error) {
        console.error("[tlon] reconcile failed:", error instanceof Error ? error.message : String(error));
      }
      await pause(5_000, this.abort.signal);
    }
  }

  private presenceKey(accountId: string, conversationId: string): string {
    return `${accountId}\u0000${conversationId}`;
  }

  private forgetPublishedPresence(accountId: string): void {
    for (const [key, presence] of this.publishedPresence) {
      if (presence.accountId === accountId) this.publishedPresence.delete(key);
    }
  }

  private dropAccountPresence(accountId: string): void {
    for (const [key, presence] of this.desiredPresence) {
      if (presence.accountId === accountId) this.desiredPresence.delete(key);
    }
    this.forgetPublishedPresence(accountId);
  }

  private async acceptInbound(
    accountId: string,
    message: InboundMessage,
    previousId?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (message.accountId !== accountId) throw new Error("inbound Tlon message belongs to another account");
    return await this.core.enqueueInbound(message, previousId, signal);
  }

  private async whileInstallationCurrent<T>(
    accountId: string,
    accountVersion: string,
    action: (signal: AbortSignal) => Promise<T>,
    channel?: string,
    scopeVersion?: string,
  ): Promise<T> {
    const token = await this.core.acquire(accountId, accountVersion, channel, scopeVersion);
    if (!token) throw new InstallationChangedError("Tlon installation changed");
    try {
      return await action(this.abort.signal);
    } finally {
      await this.core.release(accountId, accountVersion, token).catch(() => undefined);
    }
  }

  private async acceptTurn(accountId: string, message: InboundMessage, signal?: AbortSignal): Promise<void> {
    await this.core.turn(message, signal);
    this.setDesiredPresence(accountId, message.installationVersion, message.target, []);
  }

  private async processInbound(): Promise<void> {
    const records = await this.core.inboundRecords();
    const byQueue = new Map<string, typeof records>();
    for (const record of records) {
      const queueRecords = byQueue.get(record.queueKey) ?? [];
      queueRecords.push(record);
      byQueue.set(record.queueKey, queueRecords);
    }
    await Promise.all(
      [...byQueue.values()].map(async (queueRecords) => {
        for (const record of queueRecords) {
          try {
            if (this.abort.signal.aborted) {
              await this.core.releaseInbound(record.id, record.claimToken).catch(() => undefined);
              break;
            }
            if (record.message.kind === "channel" && !record.message.scopeVersion) {
              await this.core.ackInbound(record.id, record.claimToken);
              continue;
            }
            const connection = this.connections.get(record.message.accountId);
            if (!connection || connection.installation.version !== record.message.installationVersion) {
              const token = await this.core.acquire(record.message.accountId, record.message.installationVersion);
              if (!token) {
                await this.core.ackInbound(record.id, record.claimToken);
                continue;
              }
              await this.core.release(record.message.accountId, record.message.installationVersion, token);
              await this.core.releaseInbound(record.id, record.claimToken);
              break;
            }
            await this.whileInstallationCurrent(
              record.message.accountId,
              record.message.installationVersion,
              async (signal) => {
                const message = await within(
                  connection.enrichInbound(record.message, AbortSignal.any([signal, AbortSignal.timeout(30_000)])),
                  31_000,
                );
                await this.acceptTurn(record.message.accountId, message, signal);
              },
              record.message.kind === "channel" ? record.message.target : undefined,
              record.message.scopeVersion,
            );
            await this.core.ackInbound(record.id, record.claimToken);
          } catch (error) {
            if (this.abort.signal.aborted) {
              await this.core.releaseInbound(record.id, record.claimToken).catch(() => undefined);
              break;
            }
            if (error instanceof InstallationChangedError) {
              await this.core.ackInbound(record.id, record.claimToken).catch(() => undefined);
              continue;
            }
            console.error(
              `[tlon] inbound ${record.id} failed:`,
              error instanceof Error ? error.message : String(error),
            );
            break;
          }
        }
      }),
    );
  }

  private async inboundLoop(): Promise<void> {
    while (!this.abort.signal.aborted) {
      try {
        await this.processInbound();
      } catch (error) {
        console.error("[tlon] inbound queue failed:", error instanceof Error ? error.message : String(error));
      }
      await pause(1_000, this.abort.signal);
    }
  }

  private setDesiredPresence(
    accountId: string,
    accountVersion: string,
    conversationId: string,
    toolNames: string[] | null,
    force = false,
  ): void {
    const key = this.presenceKey(accountId, conversationId);
    const previous = this.desiredPresence.get(key);
    const value = toolNames?.join("\u0000") ?? null;
    const previousValue = previous?.toolNames?.join("\u0000") ?? null;
    const nextForce = force || previous?.force === true;
    const changed = value !== previousValue || nextForce !== previous?.force;
    this.desiredPresence.set(key, {
      accountId,
      accountVersion,
      conversationId,
      toolNames,
      revision: (previous?.revision ?? 0) + (changed ? 1 : 0),
      force: nextForce,
    });
    this.startPresenceWorker(key);
  }

  private syncAccountPresence(accountId: string): void {
    for (const [key, presence] of this.desiredPresence) {
      if (presence.accountId === accountId) this.startPresenceWorker(key);
    }
  }

  private trackPresenceOperation(key: string, connection: ManagedConnection, operation: Promise<void>) {
    const state = { settled: false, timedOut: false };
    this.presenceOperations.set(key, operation);
    void operation
      .then(() => {
        state.settled = true;
        if (this.presenceOperations.get(key) === operation) this.presenceOperations.delete(key);
        const desired = this.desiredPresence.get(key);
        if (
          state.timedOut &&
          !this.abort.signal.aborted &&
          desired &&
          this.connections.get(desired.accountId) === connection
        ) {
          this.setDesiredPresence(
            desired.accountId,
            desired.accountVersion,
            desired.conversationId,
            desired.toolNames,
            true,
          );
        }
      })
      .catch(() => {
        state.settled = true;
        if (this.presenceOperations.get(key) === operation) this.presenceOperations.delete(key);
      });
    return state;
  }

  private startPresenceWorker(key: string): void {
    if (this.abort.signal.aborted || this.presenceWorkers.has(key)) return;
    const worker = this.runPresenceWorker(key).finally(() => this.presenceWorkers.delete(key));
    this.presenceWorkers.set(key, worker);
  }

  private async runPresenceWorker(key: string): Promise<void> {
    while (!this.abort.signal.aborted) {
      const desired = this.desiredPresence.get(key);
      if (!desired) return;
      const connection = this.connections.get(desired.accountId);
      if (!connection || connection.installation.version !== desired.accountVersion || this.presenceOperations.has(key))
        return;
      const revision = desired.revision;
      const published = this.publishedPresence.get(key);
      let operationState: { settled: boolean; timedOut: boolean } | null = null;
      try {
        if (desired.toolNames) {
          const value = desired.toolNames.join("\u0000");
          if (!desired.force && published?.value === value && Date.now() - published.at < PRESENCE_REFRESH_MS) return;
          const operation = this.whileInstallationCurrent(desired.accountId, desired.accountVersion, () =>
            connection.publishPresence(desired.conversationId, desired.toolNames!),
          );
          operationState = this.trackPresenceOperation(key, connection, operation);
          await within(operation, PRESENCE_OPERATION_MS);
          if (
            this.abort.signal.aborted ||
            this.connections.get(desired.accountId) !== connection ||
            !this.desiredPresence.has(key)
          )
            return;
          this.publishedPresence.set(key, {
            accountId: desired.accountId,
            accountVersion: desired.accountVersion,
            conversationId: desired.conversationId,
            value,
            at: Date.now(),
          });
        } else {
          if (published || desired.force) {
            const operation = this.whileInstallationCurrent(desired.accountId, desired.accountVersion, () =>
              connection.clearPresence(desired.conversationId),
            );
            operationState = this.trackPresenceOperation(key, connection, operation);
            await within(operation, PRESENCE_OPERATION_MS);
          }
          this.publishedPresence.delete(key);
        }
      } catch (error) {
        if (operationState && !operationState.settled) operationState.timedOut = true;
        console.error(
          `[tlon] presence ${desired.accountId}/${desired.conversationId} failed:`,
          error instanceof Error ? error.message : String(error),
        );
        return;
      }
      const latest = this.desiredPresence.get(key);
      if (!latest || latest.revision !== revision) continue;
      if (latest.toolNames) latest.force = false;
      else this.desiredPresence.delete(key);
      return;
    }
  }

  private async refreshPresence(): Promise<void> {
    const generation = ++this.presenceRefreshGeneration;
    const runs = await this.core.presenceRuns();
    if (generation !== this.presenceRefreshGeneration || this.abort.signal.aborted) return;
    const active = new Map<
      string,
      { accountId: string; accountVersion: string; conversationId: string; toolNames: string[] }
    >();
    for (const run of runs) {
      if (this.connections.get(run.accountId)?.installation.version !== run.accountVersion) continue;
      const key = this.presenceKey(run.accountId, run.conversationId);
      const current = active.get(key) ?? {
        accountId: run.accountId,
        accountVersion: run.accountVersion,
        conversationId: run.conversationId,
        toolNames: [],
      };
      for (const toolName of run.activeTools)
        if (!current.toolNames.includes(toolName)) current.toolNames.push(toolName);
      active.set(key, current);
    }
    const knownKeys = new Set([...this.desiredPresence.keys(), ...this.publishedPresence.keys()]);
    for (const [key, presence] of active) {
      knownKeys.delete(key);
      this.setDesiredPresence(presence.accountId, presence.accountVersion, presence.conversationId, presence.toolNames);
    }
    for (const key of knownKeys) {
      const presence = this.desiredPresence.get(key) ?? this.publishedPresence.get(key);
      if (presence) {
        this.setDesiredPresence(presence.accountId, presence.accountVersion, presence.conversationId, null);
      }
    }
  }

  private async presenceLoop(): Promise<void> {
    while (!this.abort.signal.aborted) {
      try {
        await this.refreshPresence();
      } catch (error) {
        console.error("[tlon] presence failed:", error instanceof Error ? error.message : String(error));
      }
      await pause(1_000, this.abort.signal);
    }
  }

  private async deliverPending(): Promise<void> {
    const deliveries = await this.core.deliveries();
    const delivered = await Promise.all(
      deliveries.map(async (delivery) => {
        try {
          if (this.abort.signal.aborted) {
            if (delivery.claimToken)
              await this.core.releaseDelivery(delivery.id, delivery.claimToken).catch(() => undefined);
            return false;
          }
          const target = decodeDeliveryTarget(delivery.destination.target);
          if (!target.accountVersion || !delivery.claimToken) {
            await this.core.ack(delivery.id);
            return false;
          }
          const scopeVersion = target.kind === "channel" ? delivery.destination.scopeVersion : undefined;
          if (target.kind === "channel" && !scopeVersion) {
            await this.core.ack(delivery.id);
            return false;
          }
          const preferred = this.connections.get(target.accountId);
          const connections = [
            ...(preferred?.installation.version === target.accountVersion &&
            (target.kind === "dm" ||
              this.verifiedChannels.get(preferred.installation.id)?.channels.has(target.target) === true)
              ? [preferred]
              : []),
            ...(target.kind === "channel"
              ? [...this.connections.values()].filter(
                  (candidate) =>
                    candidate !== preferred &&
                    this.verifiedChannels.get(candidate.installation.id)?.version === candidate.installation.version &&
                    this.verifiedChannels.get(candidate.installation.id)?.channels.has(target.target),
                )
              : []),
          ].slice(0, 2);
          if (!connections.length) {
            if (
              target.kind === "channel" &&
              !(await this.core.channelScopeIsCurrent(target.target, scopeVersion!, this.abort.signal))
            ) {
              await this.core.ack(delivery.id);
              return false;
            }
            const token = await this.core.acquire(target.accountId, target.accountVersion);
            if (!token) {
              await this.core.ack(delivery.id);
              return false;
            }
            await this.core.release(target.accountId, target.accountVersion, token);
            await this.core.releaseDelivery(delivery.id, delivery.claimToken);
            return false;
          }
          const approvalRunId = /^approval:([^:]+):[a-f0-9]{16}$/.exec(delivery.idempotencyKey)?.[1];
          const runId = delivery.idempotencyKey.startsWith("run:")
            ? delivery.idempotencyKey.slice("run:".length)
            : (approvalRunId ?? "");
          let sourceToken = await this.core.acquire(target.accountId, target.accountVersion);
          if (!sourceToken) {
            await this.core.ack(delivery.id);
            return false;
          }
          try {
            const run = runId ? await this.core.run(target.accountId, runId, this.abort.signal) : null;
            if (runId && !run) {
              await this.core.ack(delivery.id);
              return false;
            }
            if (approvalRunId && run?.scopeVersion) {
              await this.core.release(target.accountId, target.accountVersion, sourceToken).catch(() => undefined);
              sourceToken = "";
              const scopedToken = await this.core.acquire(
                target.accountId,
                target.accountVersion,
                run.conversationId,
                run.scopeVersion,
              );
              if (!scopedToken) {
                await this.core.ack(delivery.id);
                return false;
              }
              sourceToken = scopedToken;
            }
            if (target.kind === "channel" && runId && run?.scopeVersion !== scopeVersion) {
              await this.core.ack(delivery.id);
              return false;
            }
            for (const connection of connections) {
              const candidateToken = await this.core.acquire(
                connection.installation.id,
                connection.installation.version,
                target.kind === "channel" ? target.target : undefined,
                scopeVersion,
              );
              if (!candidateToken) {
                if (target.kind === "channel") {
                  const cached = this.verifiedChannels.get(connection.installation.id);
                  if (cached?.version === connection.installation.version) cached.channels.delete(target.target);
                }
                continue;
              }
              const candidateTarget = encodeDeliveryTarget({
                ...target,
                accountId: connection.installation.id,
                accountVersion: connection.installation.version,
              });
              try {
                await connection.deliver(
                  { ...delivery, destination: { ...delivery.destination, target: candidateTarget } },
                  this.abort.signal,
                );
              } finally {
                await this.core
                  .release(connection.installation.id, connection.installation.version, candidateToken)
                  .catch(() => undefined);
              }
              await this.core.ack(delivery.id);
              return true;
            }
            if (
              target.kind === "channel" &&
              !(await this.core.channelScopeIsCurrent(target.target, scopeVersion!, this.abort.signal))
            ) {
              await this.core.ack(delivery.id);
              return false;
            }
            await this.core.releaseDelivery(delivery.id, delivery.claimToken);
            return false;
          } finally {
            if (sourceToken)
              await this.core.release(target.accountId, target.accountVersion, sourceToken).catch(() => undefined);
          }
        } catch (error) {
          if (this.abort.signal.aborted) {
            if (delivery.claimToken)
              await this.core.releaseDelivery(delivery.id, delivery.claimToken).catch(() => undefined);
            return false;
          }
          console.error(
            `[tlon] delivery ${delivery.id} failed:`,
            error instanceof Error ? error.message : String(error),
          );
          return false;
        }
      }),
    );
    if (delivered.some(Boolean)) await this.refreshPresence();
  }

  private async deliveryLoop(): Promise<void> {
    while (!this.abort.signal.aborted) {
      try {
        await this.deliverPending();
      } catch (error) {
        console.error("[tlon] delivery failed:", error instanceof Error ? error.message : String(error));
      }
      await pause(1_000, this.abort.signal);
    }
  }

  async stop(): Promise<void> {
    this.abort.abort();
    const stopConnections = (): Promise<void[]> =>
      Promise.all(
        [...this.connections.values()].map((connection) =>
          connection.stop().catch((error) => swallow(`stop Tlon connection ${connection.installation.id}`, error)),
        ),
      );
    const firstStop = stopConnections();
    await Promise.all([this.reconcileTask, this.deliveryTask, this.inboundTask, this.presenceTask, firstStop]);
    await Promise.all(this.presenceWorkers.values());
    await stopConnections();
    this.connections.clear();
  }
}
