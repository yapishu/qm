import { AsyncLocalStorage } from "node:async_hooks";
import {
  appendFileUploadToPostBlob,
  appendVideoToPostBlob,
  clearConversationPresence,
  createComputingStatus,
  getGroups,
  getChannelPosts,
  getPostWithReplies,
  getTextContent,
  getComputingStatusText,
  sendPost,
  sendReply,
  serializeComputingStatus,
  setClientResolver,
  setConversationPresence,
  Urbit,
  type ChannelStatus,
  type Group,
  type Story,
} from "@tloncorp/api";
import { errMessage, swallow } from "../../chassis/src/errors.ts";
import { parseChannelMessage, parseDmMessage, dmInvites } from "./messages.ts";
import {
  citedPost,
  citeReferences,
  downloadMedia,
  MAX_TLON_ATTACHMENT_BYTES,
  MAX_TLON_ATTACHMENTS,
  mediaReferences,
  publicMediaUrl,
  safeMediaName,
  type CiteReference,
  type DownloadedMedia,
  type MediaReference,
} from "./attachments.ts";
import { createPinnedOriginFetch, type PinnedOriginFetch } from "./network.ts";
import type { Delivery, InboundMessage, Installation, OutgoingAttachment } from "./types.ts";
import { decodeDeliveryTarget } from "./target.ts";
import { markdownToStory } from "./story.ts";
import { uploadTlonAttachment } from "./upload.ts";

const apiClient = new AsyncLocalStorage<Urbit>();
const PRESENCE_TIMEOUT = "~m1.s30";
const PRESENCE_TOOLS = new Set(["exec", "read", "web_fetch"]);
const MAX_CITED_TEXT = 4_000;
const MAX_INBOUND_RECEIPTS = 20;
const VERIFIED_CHANNEL_REFRESH_MS = 30_000;
const DELIVERY_MARKER_TYPE = "qm-delivery";

setClientResolver(() => apiClient.getStore() ?? null);

async function withinCleanup(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`cleanup timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}

function deliveryMarker(blob: string | null | undefined): string | undefined {
  if (!blob) return undefined;
  try {
    const entries = JSON.parse(blob) as unknown;
    if (!Array.isArray(entries)) return undefined;
    const marker = entries.find(
      (entry) =>
        !!entry &&
        typeof entry === "object" &&
        (entry as Record<string, unknown>).type === DELIVERY_MARKER_TYPE &&
        (entry as Record<string, unknown>).version === 1,
    ) as Record<string, unknown> | undefined;
    return typeof marker?.id === "string" ? marker.id : undefined;
  } catch {
    return undefined;
  }
}

function appendDeliveryMarker(blob: string | undefined, id: string): string {
  let entries: unknown[] = [];
  if (blob) {
    try {
      const parsed = JSON.parse(blob) as unknown;
      if (Array.isArray(parsed)) entries = parsed;
    } catch {
      entries = [];
    }
  }
  return JSON.stringify([...entries, { type: DELIVERY_MARKER_TYPE, version: 1, id }]);
}

export function originLockedFetch(baseUrl: string, fetchImpl: typeof fetch = fetch): typeof fetch {
  const origin = new URL(baseUrl).origin;
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const destination = new URL(input instanceof Request ? input.url : String(input));
    if (destination.origin !== origin) throw new Error("Tlon request left the configured ship origin");
    const response = await fetchImpl(input, { ...init, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) throw new Error("Tlon ship redirects are not allowed");
    return response;
  }) as typeof fetch;
}

function requestHeaders(input: string | URL | Request, init?: RequestInit): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  return headers;
}

export async function authenticateShip(
  baseUrl: string,
  ship: string,
  code: string,
  fetchImpl: typeof fetch = fetch,
  operationSignal?: () => AbortSignal | null,
): Promise<typeof fetch> {
  const origin = new URL(baseUrl).origin;
  const lockedFetch = originLockedFetch(origin, fetchImpl);
  const response = await lockedFetch(`${origin}/~/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: new URLSearchParams({ password: code }).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  await response.body?.cancel().catch((error) => swallow("cancel Tlon login response", error));
  if (!response.ok) throw new Error(`Tlon login failed with HTTP ${response.status}`);
  const expected = `urbauth-${ship}=`;
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0]?.trim() ?? "")
    .find((value) => value.startsWith(expected));
  if (!cookie) throw new Error(`Tlon login did not return the ${expected.slice(0, -1)} cookie`);
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = requestHeaders(input, init);
    headers.set("cookie", cookie);
    const activeSignal = operationSignal?.();
    const signal =
      activeSignal && init?.signal ? AbortSignal.any([activeSignal, init.signal]) : (activeSignal ?? init?.signal);
    return lockedFetch(input, { ...init, headers, ...(signal ? { signal } : {}) });
  }) as typeof fetch;
}

function storyToText(content: unknown): string {
  return getTextContent(content as Story) ?? "";
}

async function withApi<T>(installation: Installation, client: Urbit, action: () => Promise<T>): Promise<T> {
  if (client.nodeId !== installation.ship) throw new Error("Tlon API client belongs to another ship");
  return await apiClient.run(client, action);
}

function deliveryTime(delivery: Delivery): number {
  if (!Number.isSafeInteger(delivery.connectorRef) || delivery.connectorRef <= 0) {
    throw new Error(`Tlon delivery ${delivery.id} has no stable remote reference`);
  }
  return delivery.connectorRef;
}

export class TlonConnection {
  readonly installation: Installation;
  private client: Urbit | null = null;
  private transport: PinnedOriginFetch | null = null;
  private stopped = false;
  private state: { status: "connecting" | "connected" | "error"; message?: string } = { status: "connecting" };
  private readonly seen = new Set<string>();
  private readonly inbound: (
    message: InboundMessage | null,
    previousId?: string,
    signal?: AbortSignal,
  ) => Promise<string | void>;
  private readonly inboundReceipts = new Set<Promise<void>>();
  private readonly inboundTails = new Map<string, Promise<void>>();
  private readonly previousInboundIds = new Map<string, string>();
  private inboundFailed = false;
  private inboundFailureMessage = "durable inbound handoff failed";
  private pendingAckId = -1;
  private ackTask: Promise<void> | null = null;
  private readonly createTransport: (baseUrl: string) => Promise<PinnedOriginFetch>;
  private readonly createClient: (baseUrl: string, fetchImpl: typeof fetch) => Urbit;
  private readonly stageBlob?: (
    bytes: Uint8Array,
    signal?: AbortSignal,
  ) => Promise<{ blobId: string; sizeBytes: number }>;
  private readonly readAttachment?: (deliveryId: string, index: number, signal?: AbortSignal) => Promise<Uint8Array>;
  private readonly downloadAttachment: (
    media: MediaReference,
    maxBytes?: number,
    signal?: AbortSignal,
  ) => Promise<DownloadedMedia>;
  private readonly uploadAttachment: (
    attachment: OutgoingAttachment,
    bytes: Uint8Array,
    deliveryId: string,
    index: number,
    signal: AbortSignal,
  ) => Promise<{ url: string }>;
  private readonly resolveCite: (
    cite: CiteReference,
    signal?: AbortSignal,
  ) => Promise<{ author: string; text: string } | null>;
  private readonly replyExists: (
    target: ReturnType<typeof decodeDeliveryTarget>,
    sentAt: number,
    signal: AbortSignal,
  ) => Promise<boolean>;
  private readonly postExists: (
    target: ReturnType<typeof decodeDeliveryTarget>,
    deliveryId: string,
    sentAt: number,
    signal: AbortSignal,
  ) => Promise<boolean>;
  private readonly validateUploadUrl: (url: string) => Promise<string>;
  private readonly cleanupTimeoutMs: number;
  private readonly operationTimeoutMs: number;
  private readonly presenceContexts = new Set<string>();
  private readonly operationAbort = new AbortController();
  private readonly operationSignals = new AsyncLocalStorage<AbortSignal>();
  private verified: { channels: string[]; at: number } | null = null;
  private readonly listGroups: () => Promise<Group[]>;

  constructor(
    installation: Installation,
    inbound: (
      message: NonNullable<ReturnType<typeof parseChannelMessage>>,
      previousId?: string,
      signal?: AbortSignal,
    ) => Promise<string | void>,
    deps: {
      createTransport?: (baseUrl: string) => Promise<PinnedOriginFetch>;
      createClient?: (baseUrl: string, fetchImpl: typeof fetch) => Urbit;
      stageBlob?: (bytes: Uint8Array, signal?: AbortSignal) => Promise<{ blobId: string; sizeBytes: number }>;
      readAttachment?: (deliveryId: string, index: number, signal?: AbortSignal) => Promise<Uint8Array>;
      downloadAttachment?: (media: MediaReference, maxBytes?: number, signal?: AbortSignal) => Promise<DownloadedMedia>;
      uploadAttachment?: (
        attachment: OutgoingAttachment,
        bytes: Uint8Array,
        deliveryId: string,
        index: number,
        signal: AbortSignal,
      ) => Promise<{ url: string }>;
      resolveCite?: (cite: CiteReference, signal?: AbortSignal) => Promise<{ author: string; text: string } | null>;
      replyExists?: (
        target: ReturnType<typeof decodeDeliveryTarget>,
        sentAt: number,
        signal: AbortSignal,
      ) => Promise<boolean>;
      postExists?: (
        target: ReturnType<typeof decodeDeliveryTarget>,
        deliveryId: string,
        sentAt: number,
        signal: AbortSignal,
      ) => Promise<boolean>;
      validateUploadUrl?: (url: string) => Promise<string>;
      cleanupTimeoutMs?: number;
      operationTimeoutMs?: number;
      listGroups?: () => Promise<Group[]>;
    } = {},
  ) {
    this.installation = installation;
    this.createTransport = deps.createTransport ?? createPinnedOriginFetch;
    this.createClient =
      deps.createClient ?? ((baseUrl, fetchImpl) => new Urbit(baseUrl, undefined, undefined, fetchImpl));
    this.stageBlob = deps.stageBlob;
    this.readAttachment = deps.readAttachment;
    this.downloadAttachment =
      deps.downloadAttachment ??
      ((media, maxBytes, signal) => downloadMedia(media, maxBytes, createPinnedOriginFetch, signal));
    this.uploadAttachment =
      deps.uploadAttachment ??
      ((attachment, bytes, deliveryId, index, signal) => {
        const client = this.client;
        if (!client) throw new Error(`Tlon account ${this.installation.id} is not connected`);
        return uploadTlonAttachment({
          installation: this.installation,
          client,
          attachment,
          bytes,
          deliveryId,
          index,
          signal,
        });
      });
    this.resolveCite =
      deps.resolveCite ??
      (async (cite, signal) => {
        const client = this.client;
        if (!client) return null;
        if (client.nodeId !== this.installation.ship) throw new Error("Tlon API client belongs to another ship");
        const host = cite.channelId.split("/")[1];
        if (!host) return null;
        const path = `/v5/said/${host}/${cite.channelId}/post/${cite.postId}${cite.replyId ? `/${cite.replyId}` : ""}`;
        const raw = await withSignal(
          client.subscribeOnce("channels", path, undefined, 3_000),
          signal ?? AbortSignal.timeout(3_100),
        );
        const post = citedPost(raw);
        const text = (post ? getTextContent(post.content as Story) : "").trim();
        return post && text ? { author: post.author, text } : null;
      });
    this.replyExists =
      deps.replyExists ??
      (async (target, sentAt, signal) => {
        const postId = target.replyTo;
        if (!postId) return false;
        const parent = await withSignal(
          getPostWithReplies({
            channelId: target.target,
            postId,
            authorId: target.parentAuthor ?? target.target,
          }),
          signal,
        );
        return parent.replies?.some((reply) => reply.sentAt === sentAt) === true;
      });
    this.postExists =
      deps.postExists ??
      (async (target, deliveryId, sentAt, signal) => {
        const page = await withSignal(
          getChannelPosts({
            channelId: target.target,
            mode: "around",
            cursor: new Date(sentAt),
            count: 100,
            skipGapFill: true,
          }),
          signal,
        );
        return page.posts.some((post) => deliveryMarker(post.blob) === deliveryId);
      });
    this.validateUploadUrl = deps.validateUploadUrl ?? (deps.uploadAttachment ? publicMediaUrl : async (url) => url);
    this.cleanupTimeoutMs = deps.cleanupTimeoutMs ?? 1_000;
    this.operationTimeoutMs = deps.operationTimeoutMs ?? 30_000;
    this.listGroups = deps.listGroups ?? getGroups;
    this.inbound = async (message, previousId, signal) => {
      if (!message || this.stopped) return;
      const seenKey = `${message.kind}:${message.target}:${message.messageId}`;
      if (this.seen.has(seenKey)) return;
      this.seen.add(seenKey);
      if (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value!);
      try {
        return await inbound(message, previousId, signal);
      } catch (error) {
        this.seen.delete(seenKey);
        this.inboundFailed = true;
        this.inboundFailureMessage = "durable inbound handoff failed";
        if (!this.stopped) this.state = { status: "error", message: this.inboundFailureMessage };
        console.error(
          `[tlon] inbound ${this.installation.id}/${message.messageId} failed:`,
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }
    };
  }

  private async citedText(
    message: InboundMessage,
    signal: AbortSignal,
  ): Promise<{ notes: string[]; externalPromptData: Array<{ source: string; content: string }> }> {
    const resolved = await Promise.all(
      citeReferences(message.content).map(async (cite) => {
        if (message.kind !== "channel" || cite.channelId !== message.target) {
          return { text: "", failed: true };
        }
        try {
          const post = await this.resolveCite(cite, signal);
          if (!post) return { text: "", failed: false };
          const quoted = post.text.slice(0, MAX_CITED_TEXT).replace(/\n/g, "\n> ");
          return { text: `Quoted Tlon message from ${post.author}:\n> ${quoted}`, failed: false };
        } catch (error) {
          if (this.operationAbort.signal.aborted) throw error;
          return { text: "", failed: true };
        }
      }),
    );
    return {
      notes: resolved.some((entry) => entry.failed) ? ["A cited Tlon message could not be loaded."] : [],
      externalPromptData: resolved.flatMap((entry, index) =>
        entry.text ? [{ source: `tlon-citation:${index + 1}`, content: entry.text }] : [],
      ),
    };
  }

  private async inboundAttachments(
    message: InboundMessage,
    signal: AbortSignal,
  ): Promise<{
    attachments: NonNullable<InboundMessage["attachments"]>;
    notes: string[];
  }> {
    const sources = mediaReferences(message.content, message.blob);
    const attachments: NonNullable<InboundMessage["attachments"]> = [];
    const notes: string[] = [];
    if (!this.stageBlob && sources.length) return { attachments, notes: ["Tlon media transfer is not configured."] };
    let remaining = MAX_TLON_ATTACHMENT_BYTES;
    if (sources.length > MAX_TLON_ATTACHMENTS)
      notes.push(`Only the first ${MAX_TLON_ATTACHMENTS} Tlon attachments were accepted.`);
    for (const [index, source] of sources.slice(0, MAX_TLON_ATTACHMENTS).entries()) {
      try {
        const media = await withSignal(this.downloadAttachment(source, remaining, signal), signal);
        const staged = await withSignal(this.stageBlob!(media.bytes, signal), signal);
        if (staged.sizeBytes !== media.bytes.byteLength) throw new Error("staged media size mismatch");
        remaining -= staged.sizeBytes;
        attachments.push({
          name: media.name,
          mimetype: media.mimetype,
          sizeBytes: staged.sizeBytes,
          blobId: staged.blobId,
          sourceId: `tlon:${message.messageId}:${index}`,
          author: message.senderShip,
        });
      } catch (error) {
        if (this.operationAbort.signal.aborted) throw error;
        notes.push(`${safeMediaName(source.name)} could not be downloaded from Tlon.`);
      }
      if (remaining <= 0) break;
    }
    return { attachments, notes };
  }

  async enrichInbound(message: InboundMessage, signal?: AbortSignal): Promise<InboundMessage> {
    const operationSignal = signal ? AbortSignal.any([signal, this.operationAbort.signal]) : this.operationAbort.signal;
    const [citation, media] = await Promise.all([
      this.citedText(message, operationSignal),
      this.inboundAttachments(message, operationSignal),
    ]);
    const notes = [...citation.notes, ...media.notes];
    return {
      ...message,
      ...(media.attachments.length ? { attachments: media.attachments } : {}),
      ...(notes.length ? { inboundNotes: notes } : {}),
      ...(citation.externalPromptData.length ? { externalPromptData: citation.externalPromptData } : {}),
    };
  }

  private trackInbound(message: InboundMessage): void {
    if (this.inboundFailed || this.inboundReceipts.size >= MAX_INBOUND_RECEIPTS) {
      this.inboundFailed = true;
      this.inboundFailureMessage = "durable inbound handoff is overloaded";
      if (!this.stopped) this.state = { status: "error", message: this.inboundFailureMessage };
      return;
    }
    const queueKey = message.kind === "channel" ? `channel:${message.target}` : `dm:${message.target}`;
    const receipt = (this.inboundTails.get(queueKey) ?? Promise.resolve()).then(async () => {
      const id = await this.inbound(message, this.previousInboundIds.get(queueKey), this.operationAbort.signal);
      if (id) this.previousInboundIds.set(queueKey, id);
    });
    this.inboundTails.set(queueKey, receipt);
    this.inboundReceipts.add(receipt);
    void receipt.finally(() => this.inboundReceipts.delete(receipt)).catch(() => undefined);
  }

  private async flushAck(originalAck: (eventId: number) => Promise<unknown>): Promise<void> {
    await Promise.resolve();
    for (;;) {
      if (this.stopped || this.inboundFailed) return;
      const receipts = [...this.inboundReceipts];
      if (receipts.length) {
        try {
          await Promise.all(receipts);
        } catch {
          return;
        }
        continue;
      }
      const eventId = this.pendingAckId;
      this.pendingAckId = -1;
      if (eventId < 0) return;
      try {
        await originalAck(eventId);
      } catch (error) {
        if (!this.stopped) this.state = { status: "error", message: errMessage(error) };
        return;
      }
      if (this.pendingAckId < 0) return;
    }
  }

  private installDurableAck(client: Urbit): void {
    const airlock = client as unknown as {
      ack?: (eventId: number) => Promise<unknown>;
    };
    if (typeof airlock.ack !== "function") return;
    const originalAck = airlock.ack.bind(client);
    airlock.ack = async (eventId) => {
      this.pendingAckId = Math.max(this.pendingAckId, eventId);
      if (!this.ackTask) {
        this.ackTask = this.flushAck(originalAck).finally(() => {
          this.ackTask = null;
        });
      }
      await this.ackTask;
    };
  }

  private receive(source: string, value: unknown, parse: typeof parseChannelMessage | typeof parseDmMessage): void {
    try {
      const message = parse(this.installation, value, storyToText);
      if (!message || this.stopped) return;
      this.trackInbound(message);
    } catch (error) {
      console.error(
        `[tlon] ${source} event for ${this.installation.id} failed:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async start(): Promise<void> {
    const transport = await this.createTransport(this.installation.url);
    this.transport = transport;
    let client: Urbit | null = null;
    try {
      if (this.stopped) throw new Error("Tlon connection stopped during startup");
      const authenticatedFetch = await authenticateShip(
        this.installation.url,
        this.installation.ship,
        this.installation.code,
        transport.fetch,
        () => this.operationSignals.getStore() ?? null,
      );
      if (this.stopped) throw new Error("Tlon connection stopped during startup");
      client = this.createClient(this.installation.url, authenticatedFetch);
      client.nodeId = this.installation.ship;
      this.client = client;
      this.installDurableAck(client);
      await client.poke({ app: "hood", mark: "helm-hi", json: "opening airlock" });
      await client.eventSource();
      if (this.stopped) throw new Error("Tlon connection stopped during startup");
      this.state = { status: "connected" };
      client.on("status-update", ({ status, context }) => this.updateStatus(status, context?.message));
      client.on("error", ({ msg }) => {
        this.state = { status: "error", message: msg };
      });
      client.on("subscription", ({ status }) => {
        if (status === "open" && this.state.status !== "error") this.state = { status: "connected" };
      });
      await client.subscribe({
        app: "channels",
        path: "/v4",
        event: (value) => this.receive("channel", value, parseChannelMessage),
        err: (error) => {
          this.state = { status: "error", message: String(error) };
        },
        quit: () => {
          this.state = { status: "connecting", message: "channel subscription restarting" };
        },
      });
      await client.subscribe({
        app: "chat",
        path: "/v4",
        event: (value) => {
          for (const sender of dmInvites(this.installation, value)) {
            void client!
              .poke({ app: "chat", mark: "chat-dm-rsvp", json: { ship: sender, ok: true } })
              .catch((error) =>
                console.error(
                  `[tlon] accepting DM invite for ${this.installation.id} failed:`,
                  error instanceof Error ? error.message : String(error),
                ),
              );
          }
          this.receive("DM", value, parseDmMessage);
        },
        err: (error) => {
          this.state = { status: "error", message: String(error) };
        },
        quit: () => {
          this.state = { status: "connecting", message: "DM subscription restarting" };
        },
      });
    } catch (error) {
      await this.release(client, transport);
      throw error;
    }
  }

  private updateStatus(status: ChannelStatus, message?: string): void {
    if (this.inboundFailed) return;
    if (status === "active" || status === "reconnected") this.state = { status: "connected" };
    else if (status === "errored") this.state = { status: "error", ...(message ? { message } : {}) };
    else if (this.state.status !== "error") this.state = { status: "connecting", ...(message ? { message } : {}) };
  }

  runtimeStatus(): { status: "connecting" | "connected" | "error"; message?: string } {
    if (this.inboundFailed) return { status: "error", message: this.inboundFailureMessage };
    return this.state;
  }

  async verifiedChannels(): Promise<string[]> {
    const client = this.client;
    if (!client || this.stopped) throw new Error(`Tlon account ${this.installation.id} is not connected`);
    if (this.verified && Date.now() - this.verified.at < VERIFIED_CHANNEL_REFRESH_MS) {
      return [...this.verified.channels];
    }
    const groups = await withApi(this.installation, client, this.listGroups);
    const joined = new Set(
      groups
        .filter((group) => group.currentUserIsMember)
        .flatMap((group) => group.channels ?? [])
        .filter((channel) => channel.currentUserIsMember !== false)
        .map((channel) => channel.id),
    );
    const channels = this.installation.channels.filter((channel) => joined.has(channel));
    this.verified = { channels, at: Date.now() };
    return [...channels];
  }

  async deliver(delivery: Delivery, signal?: AbortSignal): Promise<void> {
    const client = this.client;
    if (!client) throw new Error(`Tlon account ${this.installation.id} is not connected`);
    const target = decodeDeliveryTarget(delivery.destination.target);
    if (target.accountId !== this.installation.id) throw new Error("delivery belongs to another Tlon account");
    if (target.accountVersion && target.accountVersion !== this.installation.version) {
      throw new Error("delivery belongs to another Tlon installation version");
    }
    const revocationSignal = signal
      ? AbortSignal.any([this.operationAbort.signal, signal])
      : this.operationAbort.signal;
    const operationSignal = AbortSignal.any([revocationSignal, AbortSignal.timeout(this.operationTimeoutMs)]);
    try {
      await this.operationSignals.run(operationSignal, () =>
        withApi(this.installation, client, async () => {
          const sentAt = deliveryTime(delivery);
          if (target.replyTo && (await this.replyExists(target, sentAt, operationSignal))) return;
          if (
            target.kind === "channel" &&
            !target.replyTo &&
            (await this.postExists(target, delivery.id, sentAt, operationSignal))
          )
            return;
          const content = markdownToStory(delivery.text);
          let blob: string | undefined;
          let aggregateBytes = 0;
          const manifest = (delivery.attachments ?? []).map((attachment, index) => {
            const accepted =
              index < MAX_TLON_ATTACHMENTS &&
              attachment.sizeBytes >= 0 &&
              aggregateBytes + attachment.sizeBytes <= MAX_TLON_ATTACHMENT_BYTES;
            if (accepted) aggregateBytes += attachment.sizeBytes;
            return { attachment, index, accepted };
          });
          for (const { attachment, index, accepted } of manifest) {
            const name = safeMediaName(attachment.name);
            if (!accepted) {
              content.push({ inline: [`Attachment ${name} could not be sent.`] });
              continue;
            }
            try {
              if (!this.readAttachment) throw new Error("Tlon delivery attachment transfer is not configured");
              const bytes = await withSignal(this.readAttachment(delivery.id, index, operationSignal), operationSignal);
              if (bytes.byteLength !== attachment.sizeBytes) {
                throw new Error(`${name} changed size before Tlon delivery`);
              }
              const uploaded = await withSignal(
                this.uploadAttachment(attachment, bytes, delivery.id, index, operationSignal),
                operationSignal,
              );
              const url = await withSignal(this.validateUploadUrl(uploaded.url), operationSignal);
              if (attachment.mimetype.toLowerCase().startsWith("image/")) {
                content.push({
                  block: {
                    image: { src: url, width: 0, height: 0, alt: name },
                  },
                });
              } else if (attachment.mimetype.toLowerCase().startsWith("video/")) {
                blob = appendVideoToPostBlob(blob, {
                  fileUri: url,
                  mimeType: attachment.mimetype,
                  name,
                  size: attachment.sizeBytes,
                });
              } else {
                blob = appendFileUploadToPostBlob(blob, {
                  fileUri: url,
                  mimeType: attachment.mimetype,
                  name,
                  size: attachment.sizeBytes,
                });
              }
            } catch {
              if (revocationSignal.aborted) throw revocationSignal.reason;
              content.push({ inline: [`Attachment ${name} could not be sent.`] });
            }
          }
          if (!content.length) content.push({ inline: [""] });
          const sendSignal = AbortSignal.any([revocationSignal, AbortSignal.timeout(this.operationTimeoutMs)]);
          const replyTo = target.replyTo;
          if (replyTo) {
            await this.operationSignals.run(sendSignal, () =>
              withSignal(
                sendReply({
                  channelId: target.target,
                  parentId: replyTo,
                  parentAuthor: target.parentAuthor ?? (target.kind === "dm" ? target.target : ""),
                  content,
                  sentAt,
                  authorId: this.installation.ship,
                  ...(blob ? { blob } : {}),
                }),
                sendSignal,
              ),
            );
          } else {
            blob = appendDeliveryMarker(blob, delivery.id);
            await this.operationSignals.run(sendSignal, () =>
              withSignal(
                sendPost({
                  channelId: target.target,
                  content,
                  sentAt,
                  authorId: this.installation.ship,
                  ...(blob ? { blob } : {}),
                }),
                sendSignal,
              ),
            );
          }
        }),
      );
    } catch (error) {
      this.state = { status: "error", message: errMessage(error) };
      throw error;
    }
  }

  async publishPresence(conversationId: string, toolNames: string[]): Promise<void> {
    const client = this.client;
    if (!client || this.stopped) throw new Error(`Tlon account ${this.installation.id} is not connected`);
    const toolCalls = [...new Set(toolNames.map((toolName) => (PRESENCE_TOOLS.has(toolName) ? toolName : "tool")))].map(
      (toolName) => ({ toolName }),
    );
    const status = createComputingStatus({ thinking: true, toolCalls });
    await withApi(this.installation, client, () =>
      setConversationPresence({
        conversationId,
        topic: "computing",
        disclose: [],
        timeout: PRESENCE_TIMEOUT,
        display: {
          text: getComputingStatusText(status),
          blob: serializeComputingStatus({ thinking: true, toolCalls }),
        },
      }),
    );
    if (this.client === client && !this.stopped) this.presenceContexts.add(conversationId);
  }

  async clearPresence(conversationId: string): Promise<void> {
    const client = this.client;
    this.presenceContexts.delete(conversationId);
    if (!client) return;
    await withApi(this.installation, client, () => clearConversationPresence({ conversationId, topic: "computing" }));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.operationAbort.abort();
    const client = this.client;
    const transport = this.transport;
    const contexts = [...this.presenceContexts];
    this.presenceContexts.clear();
    await Promise.all(
      contexts.map((conversationId) =>
        withinCleanup(this.clearPresence(conversationId), this.cleanupTimeoutMs).catch((error) =>
          swallow(`clear Tlon presence ${this.installation.id}/${conversationId}`, error),
        ),
      ),
    );
    await this.release(client, transport);
  }

  private async release(client: Urbit | null, transport: PinnedOriginFetch | null): Promise<void> {
    if (!transport || this.transport !== transport) return;
    this.transport = null;
    if (this.client === client) this.client = null;
    if (client)
      await withinCleanup(client.delete(), this.cleanupTimeoutMs).catch((error) =>
        swallow(`delete Tlon channel ${this.installation.id}`, error),
      );
    await withinCleanup(transport.close(), this.cleanupTimeoutMs).catch((error) =>
      swallow(`close Tlon transport ${this.installation.id}`, error),
    );
  }
}
