import { decodeDeliveryTarget } from "./target.ts";
import { errMessage, swallow } from "../../chassis/src/errors.ts";
import { CoreClient } from "./core.ts";
import { TlonConnection } from "./tlon.ts";
import type { Delivery, InboundMessage, Installation } from "./types.ts";

interface ManagedConnection {
  readonly installation: Installation;
  start(): Promise<void>;
  stop(): Promise<void>;
  runtimeStatus(): { status: "connecting" | "connected" | "error"; message?: string };
  deliver(delivery: Delivery): Promise<void>;
  publishPresence(conversationId: string, toolNames: string[]): Promise<void>;
  clearPresence(conversationId: string): Promise<void>;
}

type ConnectionFactory = (
  installation: Installation,
  inbound: (message: InboundMessage) => Promise<void>,
) => ManagedConnection;

interface DesiredPresence {
  accountId: string;
  conversationId: string;
  toolNames: string[] | null;
  revision: number;
  force: boolean;
}

interface PublishedPresence {
  accountId: string;
  conversationId: string;
  value: string;
  at: number;
}

const PRESENCE_REFRESH_MS = 30_000;
const PRESENCE_OPERATION_MS = 5_000;

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
  private readonly abort = new AbortController();
  private reconcileTask: Promise<void> | null = null;
  private deliveryTask: Promise<void> | null = null;
  private presenceTask: Promise<void> | null = null;
  private readonly retries = new Map<string, { version: string; at: number; delay: number }>();
  private readonly desiredPresence = new Map<string, DesiredPresence>();
  private readonly publishedPresence = new Map<string, PublishedPresence>();
  private readonly presenceWorkers = new Map<string, Promise<void>>();
  private readonly presenceOperations = new Map<string, Promise<void>>();
  private presenceRefreshGeneration = 0;

  constructor(
    core: CoreClient,
    connectionFactory: ConnectionFactory = (installation, inbound) => new TlonConnection(installation, inbound),
  ) {
    this.core = core;
    this.connectionFactory = connectionFactory;
  }

  start(): void {
    if (this.reconcileTask) return;
    this.reconcileTask = this.reconcileLoop();
    this.deliveryTask = this.deliveryLoop();
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
      if (!desired.has(presence.accountId)) this.dropAccountPresence(presence.accountId);
    }
    for (const [id, connection] of this.connections) {
      const next = desired.get(id);
      if (next?.version === connection.installation.version) {
        const runtime = connection.runtimeStatus();
        await this.core
          .report(id, next.version, runtime.status, runtime.message)
          .catch((error) => swallow(`report Tlon connection ${id}`, error));
        if (runtime.status !== "error") continue;
        this.scheduleRetry(id, next.version);
      }
      this.connections.delete(id);
      await connection.stop().catch((error) => swallow(`stop Tlon connection ${id}`, error));
      this.forgetPublishedPresence(id);
      if (!next || next.version !== connection.installation.version)
        await this.core
          .report(id, connection.installation.version, "stopped")
          .catch((error) => swallow(`report stopped Tlon connection ${id}`, error));
    }
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
          const connection = this.connectionFactory(installation, (message) =>
            this.acceptTurn(installation.id, message),
          );
          try {
            await within(connection.start(), 30_000);
            await this.core.report(installation.id, installation.version, "connected");
            this.connections.set(installation.id, connection);
            this.retries.delete(installation.id);
            this.syncAccountPresence(installation.id);
          } catch (error) {
            this.connections.delete(installation.id);
            await connection
              .stop()
              .catch((stopError) => swallow(`stop failed Tlon connection ${installation.id}`, stopError));
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

  private async acceptTurn(accountId: string, message: InboundMessage): Promise<void> {
    if (message.accountId !== accountId) throw new Error("inbound Tlon message belongs to another account");
    await this.core.turn(message);
    this.setDesiredPresence(accountId, message.target, []);
  }

  private setDesiredPresence(
    accountId: string,
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
          this.setDesiredPresence(desired.accountId, desired.conversationId, desired.toolNames, true);
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
      if (!connection || this.presenceOperations.has(key)) return;
      const revision = desired.revision;
      const published = this.publishedPresence.get(key);
      let operationState: { settled: boolean; timedOut: boolean } | null = null;
      try {
        if (desired.toolNames) {
          const value = desired.toolNames.join("\u0000");
          if (!desired.force && published?.value === value && Date.now() - published.at < PRESENCE_REFRESH_MS) return;
          const operation = connection.publishPresence(desired.conversationId, desired.toolNames);
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
            conversationId: desired.conversationId,
            value,
            at: Date.now(),
          });
        } else {
          if (published || desired.force) {
            const operation = connection.clearPresence(desired.conversationId);
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
    const active = new Map<string, { accountId: string; conversationId: string; toolNames: string[] }>();
    for (const run of runs) {
      if (!this.connections.has(run.accountId)) continue;
      const key = this.presenceKey(run.accountId, run.conversationId);
      const current = active.get(key) ?? {
        accountId: run.accountId,
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
      this.setDesiredPresence(presence.accountId, presence.conversationId, presence.toolNames);
    }
    for (const key of knownKeys) {
      const presence = this.desiredPresence.get(key) ?? this.publishedPresence.get(key);
      if (presence) this.setDesiredPresence(presence.accountId, presence.conversationId, null);
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
          const target = decodeDeliveryTarget(delivery.destination.target);
          const connection = this.connections.get(target.accountId);
          if (!connection) return false;
          const runId = delivery.idempotencyKey.startsWith("run:") ? delivery.idempotencyKey.slice("run:".length) : "";
          if (runId) await this.core.run(target.accountId, runId);
          await connection.deliver(delivery);
          await this.core.ack(delivery.id);
          return true;
        } catch (error) {
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
    await Promise.all([this.reconcileTask, this.deliveryTask, this.presenceTask, firstStop]);
    await Promise.all(this.presenceWorkers.values());
    await stopConnections();
    this.connections.clear();
  }
}
