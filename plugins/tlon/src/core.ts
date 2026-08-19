import { signedHeaders, withSourceAuthNonce } from "../../chassis/src/core-client.ts";
import type { Delivery, InboundMessage, Installation, RunPresence } from "./types.ts";
import { encodeDeliveryTarget } from "./target.ts";

export function conversationThreadRef(message: InboundMessage): string {
  const timeline = `tlon:${message.accountId}:${message.kind}:${message.target}`;
  return message.threadRoot ? `${timeline}:thread:${message.threadRoot}` : timeline;
}

export class CoreClient {
  private readonly baseUrl: string;
  private readonly secret: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, secret: string | undefined, fetchImpl: typeof fetch = fetch) {
    this.baseUrl = baseUrl;
    this.secret = secret;
    this.fetchImpl = fetchImpl;
  }

  private async request<T>(method: "GET" | "POST", rawPath: string, body?: unknown): Promise<T> {
    const path = withSourceAuthNonce(rawPath, this.secret);
    const rawBody = body === undefined ? "" : JSON.stringify(body);
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: signedHeaders(this.secret, method, path, rawBody),
      ...(body === undefined ? {} : { body: rawBody }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new Error(`${method} ${rawPath} failed with HTTP ${response.status}: ${await response.text()}`);
    return (await response.json()) as T;
  }

  async installations(): Promise<Installation[]> {
    const result = await this.request<{ installations?: Installation[] }>("GET", "/v1/tlon/installations");
    if (!Array.isArray(result.installations)) throw new Error("core returned an invalid Tlon installation list");
    return result.installations;
  }

  async report(id: string, version: string, status: string, message?: string): Promise<void> {
    await this.request("POST", `/v1/tlon/installations/${encodeURIComponent(id)}/status`, {
      version,
      status,
      ...(message ? { message } : {}),
    });
  }

  async turn(message: InboundMessage): Promise<{ runId: string }> {
    const target = encodeDeliveryTarget({
      accountId: message.accountId,
      kind: message.kind,
      target: message.target,
      ...(message.threadRoot ? { replyTo: message.threadRoot } : {}),
      ...(message.parentAuthor ? { parentAuthor: message.parentAuthor } : {}),
    });
    const channelName = message.kind === "channel" ? message.target.split("/").at(-1) : undefined;
    const result = await this.request<{ status?: string; runId?: string }>("POST", "/v1/turns?async=1", {
      surface: "tlon",
      deliveryTarget: target,
      actor: { externalId: message.principalId, displayName: message.senderShip },
      conversation: {
        kind: message.kind === "dm" ? "dm" : "channel",
        threadRef: conversationThreadRef(message),
        ...(message.kind === "channel"
          ? { channelRef: `tlon:${message.accountId}:${message.target}`, channelName }
          : { isPrivate: true }),
      },
      text: message.text,
      triggerTs: message.messageId,
      idempotencyKey: `tlon:${message.accountId}:${message.messageId}`,
      addressed: true,
      liveActor: true,
      async: true,
    });
    if (result.status !== "queued" || !result.runId) throw new Error("core returned an invalid queued Tlon turn");
    return { runId: result.runId };
  }

  async presenceRuns(): Promise<RunPresence[]> {
    const result = await this.request<{ runs?: RunPresence[] }>("GET", "/v1/tlon/presence/runs");
    if (!Array.isArray(result.runs)) throw new Error("core returned an invalid Tlon presence run list");
    return result.runs;
  }

  run(accountId: string, runId: string): Promise<RunPresence> {
    return this.request("GET", `/v1/tlon/presence/runs/${encodeURIComponent(accountId)}/${encodeURIComponent(runId)}`);
  }

  async deliveries(): Promise<Delivery[]> {
    const result = await this.request<{ deliveries?: Delivery[] }>("GET", "/v1/deliveries?type=tlon&claimMs=30000");
    if (!Array.isArray(result.deliveries)) throw new Error("core returned an invalid Tlon delivery list");
    return result.deliveries;
  }

  async ack(id: string): Promise<void> {
    await this.request("POST", `/v1/deliveries/${encodeURIComponent(id)}/ack`, {});
  }
}
