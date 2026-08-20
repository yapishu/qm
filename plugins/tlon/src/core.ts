import { createHash } from "node:crypto";
import { signedHeaders, withSourceAuthNonce } from "../../chassis/src/core-client.ts";
import { MAX_TLON_ATTACHMENT_BYTES, readResponseBytes } from "./attachments.ts";
import type { Delivery, InboundMessage, InboundRecord, Installation, RunPresence } from "./types.ts";
import { encodeDeliveryTarget } from "./target.ts";

const COMPLETED_TURN_STATUSES = new Set(["ok", "failed", "pending_approval", "silent", "react"]);

class CoreRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function conversationThreadRef(message: InboundMessage): string {
  const timeline =
    message.kind === "channel"
      ? `tlon:channel:${encodeURIComponent(message.target)}`
      : `tlon:${message.accountId}:${message.kind}:${message.target}`;
  return message.threadRoot ? `${timeline}:thread:${encodeURIComponent(message.threadRoot)}` : timeline;
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

  private async request<T>(method: "GET" | "POST", rawPath: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const path = withSourceAuthNonce(rawPath, this.secret);
    const rawBody = body === undefined ? "" : JSON.stringify(body);
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: signedHeaders(this.secret, method, path, rawBody),
      ...(body === undefined ? {} : { body: rawBody }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new CoreRequestError(
        response.status,
        `${method} ${rawPath} failed with HTTP ${response.status}: ${await response.text()}`,
      );
    return (await response.json()) as T;
  }

  async installations(signal?: AbortSignal): Promise<Installation[]> {
    const result = await this.request<{ installations?: Installation[] }>(
      "GET",
      "/v1/tlon/installations",
      undefined,
      signal,
    );
    if (!Array.isArray(result.installations)) throw new Error("core returned an invalid Tlon installation list");
    return result.installations;
  }

  async report(
    id: string,
    version: string,
    status: string,
    message?: string,
    verifiedChannels?: string[],
  ): Promise<void> {
    await this.request("POST", `/v1/tlon/installations/${encodeURIComponent(id)}/status`, {
      version,
      status,
      ...(message ? { message } : {}),
      ...(verifiedChannels ? { verifiedChannels } : {}),
    });
  }

  async acquire(id: string, version: string, channel?: string, scopeVersion?: string): Promise<string | null> {
    const result = await this.request<{ token?: unknown }>(
      "POST",
      `/v1/tlon/installations/${encodeURIComponent(id)}/lease`,
      { version, ...(channel ? { channel } : {}), ...(scopeVersion ? { scopeVersion } : {}) },
    );
    if (result.token !== null && typeof result.token !== "string") {
      throw new Error("core returned an invalid Tlon operation lease");
    }
    return result.token;
  }

  async release(id: string, version: string, token: string): Promise<void> {
    await this.request("POST", `/v1/tlon/installations/${encodeURIComponent(id)}/release`, { version, token });
  }

  async turn(message: InboundMessage, signal?: AbortSignal): Promise<void> {
    const target = encodeDeliveryTarget({
      accountId: message.accountId,
      accountVersion: message.installationVersion,
      kind: message.kind,
      target: message.target,
      ...(message.threadRoot ? { replyTo: message.threadRoot } : {}),
      ...(message.parentAuthor ? { parentAuthor: message.parentAuthor } : {}),
    });
    const channelName = message.kind === "channel" ? message.target.split("/").at(-1) : undefined;
    const result = await this.request<{ status?: string; runId?: string }>(
      "POST",
      "/v1/turns?async=1",
      {
        surface: "tlon",
        deliveryTarget: target,
        deliveryQueueKey:
          message.kind === "channel"
            ? `tlon:channel:${encodeURIComponent(message.target)}`
            : `tlon:${message.accountId}:${message.installationVersion}`,
        actor: { externalId: message.principalId, displayName: message.principalId },
        conversation: {
          kind: message.kind === "dm" ? "dm" : "channel",
          threadRef: conversationThreadRef(message),
          ...(message.kind === "channel"
            ? { channelRef: `tlon:${encodeURIComponent(message.target)}`, channelName, isPrivate: true }
            : { isPrivate: true }),
        },
        text: message.text,
        ...(message.attachments?.length ? { attachments: message.attachments } : {}),
        ...(message.inboundNotes?.length ? { inboundNotes: message.inboundNotes } : {}),
        ...(message.externalPromptData?.length ? { externalPromptData: message.externalPromptData } : {}),
        triggerTs: message.messageId,
        idempotencyKey:
          message.kind === "channel"
            ? `tlon:channel:${encodeURIComponent(message.target)}:${encodeURIComponent(message.senderShip)}:${message.messageId}`
            : `tlon:${message.accountId}:${message.installationVersion}:${message.messageId}`,
        addressed: true,
        liveActor: true,
        async: true,
      },
      signal,
    );
    if (
      result.status === "queued" &&
      typeof result.runId === "string" &&
      result.runId.length > 0 &&
      result.runId === result.runId.trim()
    )
      return;
    if (result.status && COMPLETED_TURN_STATUSES.has(result.status)) return;
    throw new Error("core returned an invalid Tlon turn result");
  }

  async enqueueInbound(message: InboundMessage, previousId?: string, signal?: AbortSignal): Promise<string> {
    const result = await this.request<{ id?: unknown }>(
      "POST",
      "/v1/tlon/inbound",
      { message, ...(previousId ? { previousId } : {}) },
      signal,
    );
    if (typeof result.id !== "string") throw new Error("core returned an invalid Tlon inbound receipt");
    return result.id;
  }

  async inboundRecords(): Promise<InboundRecord[]> {
    const result = await this.request<{ records?: InboundRecord[] }>("GET", "/v1/tlon/inbound?claimMs=300000");
    if (
      !Array.isArray(result.records) ||
      result.records.some(
        (record) =>
          !record ||
          typeof record.id !== "string" ||
          typeof record.queueKey !== "string" ||
          typeof record.claimToken !== "string" ||
          !record.message ||
          typeof record.message.accountId !== "string" ||
          (record.message.kind === "channel" && typeof record.message.scopeVersion !== "string"),
      )
    )
      throw new Error("core returned an invalid Tlon inbound queue");
    return result.records;
  }

  async ackInbound(id: string, claimToken: string): Promise<void> {
    await this.request("POST", `/v1/tlon/inbound/${encodeURIComponent(id)}/ack`, { claimToken });
  }

  async releaseInbound(id: string, claimToken: string): Promise<void> {
    await this.request("POST", `/v1/tlon/inbound/${encodeURIComponent(id)}/release`, { claimToken });
  }

  async presenceRuns(): Promise<RunPresence[]> {
    const result = await this.request<{ runs?: RunPresence[] }>("GET", "/v1/tlon/presence/runs");
    if (!Array.isArray(result.runs)) throw new Error("core returned an invalid Tlon presence run list");
    return result.runs;
  }

  async run(accountId: string, runId: string, signal?: AbortSignal): Promise<RunPresence | null> {
    try {
      return await this.request(
        "GET",
        `/v1/tlon/presence/runs/${encodeURIComponent(accountId)}/${encodeURIComponent(runId)}`,
        undefined,
        signal,
      );
    } catch (error) {
      if (error instanceof CoreRequestError && error.status === 409) return null;
      throw error;
    }
  }

  async channelScopeIsCurrent(channel: string, scopeVersion: string, signal?: AbortSignal): Promise<boolean> {
    const query = new URLSearchParams({ channel, scopeVersion });
    const result = await this.request<{ current?: unknown }>(
      "GET",
      `/v1/tlon/channel-scope?${query.toString()}`,
      undefined,
      signal,
    );
    if (typeof result.current !== "boolean") throw new Error("core returned an invalid Tlon channel scope status");
    return result.current;
  }

  async deliveries(): Promise<Delivery[]> {
    const result = await this.request<{ deliveries?: Delivery[] }>(
      "GET",
      "/v1/deliveries?type=tlon&claimMs=300000&limit=10&grouped=1",
    );
    if (
      !Array.isArray(result.deliveries) ||
      result.deliveries.some(
        (delivery) =>
          !delivery ||
          typeof delivery.claimToken !== "string" ||
          typeof delivery.connectorRef !== "number" ||
          !Number.isSafeInteger(delivery.connectorRef) ||
          delivery.connectorRef <= 0,
      )
    ) {
      throw new Error("core returned an invalid Tlon delivery list");
    }
    return result.deliveries;
  }

  async releaseDelivery(id: string, claimToken: string): Promise<void> {
    await this.request("POST", `/v1/deliveries/${encodeURIComponent(id)}/release`, { claimToken });
  }

  async stageBlob(bytes: Uint8Array, signal?: AbortSignal): Promise<{ blobId: string; sizeBytes: number }> {
    const rawPath = "/v1/blobs";
    const path = withSourceAuthNonce(rawPath, this.secret);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        ...signedHeaders(this.secret, "POST", path, "", sha256),
        "content-type": "application/octet-stream",
        "x-content-sha256": sha256,
      },
      body: Buffer.from(bytes),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`POST ${rawPath} failed with HTTP ${response.status}: ${await response.text()}`);
    const result = (await response.json()) as { blobId?: unknown; sizeBytes?: unknown };
    if (typeof result.blobId !== "string" || result.sizeBytes !== bytes.byteLength) {
      throw new Error("core returned an invalid staged blob");
    }
    return { blobId: result.blobId, sizeBytes: result.sizeBytes as number };
  }

  async deliveryAttachment(deliveryId: string, index: number, signal?: AbortSignal): Promise<Uint8Array> {
    const rawPath = `/v1/deliveries/${encodeURIComponent(deliveryId)}/attachments/${index}`;
    const path = withSourceAuthNonce(rawPath, this.secret);
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: signedHeaders(this.secret, "GET", path),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GET ${rawPath} failed with HTTP ${response.status}: ${await response.text()}`);
    const declared = response.headers.get("content-length");
    if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_TLON_ATTACHMENT_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`GET ${rawPath} exceeded the Tlon attachment size limit`);
    }
    return readResponseBytes(response, MAX_TLON_ATTACHMENT_BYTES);
  }

  async ack(id: string): Promise<void> {
    await this.request("POST", `/v1/deliveries/${encodeURIComponent(id)}/ack`, {});
  }
}
