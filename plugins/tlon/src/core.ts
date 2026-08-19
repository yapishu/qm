import { signedHeaders, withSourceAuthNonce } from "../../chassis/src/core-client.ts";
import type { Delivery, InboundMessage, Installation } from "./types.ts";
import { encodeDeliveryTarget } from "./target.ts";

export class CoreClient {
  private readonly baseUrl: string;
  private readonly secret: string | undefined;

  constructor(baseUrl: string, secret: string | undefined) {
    this.baseUrl = baseUrl;
    this.secret = secret;
  }

  private async request<T>(method: "GET" | "POST", rawPath: string, body?: unknown): Promise<T> {
    const path = withSourceAuthNonce(rawPath, this.secret);
    const rawBody = body === undefined ? "" : JSON.stringify(body);
    const response = await fetch(`${this.baseUrl}${path}`, {
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

  async turn(message: InboundMessage): Promise<void> {
    const target = encodeDeliveryTarget({
      accountId: message.accountId,
      kind: message.kind,
      target: message.target,
      ...(message.threadRoot ? { replyTo: message.threadRoot } : {}),
      ...(message.parentAuthor ? { parentAuthor: message.parentAuthor } : {}),
    });
    const channelName = message.kind === "channel" ? message.target.split("/").at(-1) : undefined;
    await this.request("POST", "/v1/turns?async=1", {
      surface: "tlon",
      deliveryTarget: target,
      actor: { externalId: message.principalId, displayName: message.senderShip },
      conversation: {
        kind: message.kind === "dm" ? "dm" : "channel",
        threadRef:
          message.kind === "dm"
            ? `tlon:${message.accountId}:dm:${message.target}:${message.threadRoot}`
            : `tlon:${message.accountId}:channel:${message.target}:${message.threadRoot}`,
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
