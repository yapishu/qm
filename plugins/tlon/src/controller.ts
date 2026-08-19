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
}

type ConnectionFactory = (
  installation: Installation,
  inbound: (message: InboundMessage) => Promise<void>,
) => ManagedConnection;

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
  private readonly retries = new Map<string, { version: string; at: number; delay: number }>();

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
  }

  health(): { ok: true; accounts: number } {
    return { ok: true, accounts: this.connections.size };
  }

  private async reconcile(): Promise<void> {
    const installations = await this.core.installations();
    const desired = new Map(installations.map((installation) => [installation.id, installation]));
    for (const id of this.retries.keys()) if (!desired.has(id)) this.retries.delete(id);
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
          const connection = this.connectionFactory(installation, (message) => this.core.turn(message));
          try {
            await within(connection.start(), 30_000);
            await this.core.report(installation.id, installation.version, "connected");
            this.connections.set(installation.id, connection);
            this.retries.delete(installation.id);
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

  private async deliveryLoop(): Promise<void> {
    while (!this.abort.signal.aborted) {
      try {
        const deliveries = await this.core.deliveries();
        await Promise.all(
          deliveries.map(async (delivery) => {
            try {
              const target = decodeDeliveryTarget(delivery.destination.target);
              const connection = this.connections.get(target.accountId);
              if (!connection) return;
              await connection.deliver(delivery);
              await this.core.ack(delivery.id);
            } catch (error) {
              console.error(
                `[tlon] delivery ${delivery.id} failed:`,
                error instanceof Error ? error.message : String(error),
              );
            }
          }),
        );
      } catch (error) {
        console.error("[tlon] delivery failed:", error instanceof Error ? error.message : String(error));
      }
      await pause(1_000, this.abort.signal);
    }
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await Promise.all([this.reconcileTask, this.deliveryTask]);
    await Promise.all(
      [...this.connections.values()].map((connection) =>
        connection.stop().catch((error) => swallow(`stop Tlon connection ${connection.installation.id}`, error)),
      ),
    );
    this.connections.clear();
  }
}
