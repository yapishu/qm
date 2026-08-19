import {
  configureClient,
  getTextContent,
  sendPost,
  sendReply,
  Urbit,
  type ChannelStatus,
  type Story,
} from "@tloncorp/api";
import { errMessage, swallow } from "../../chassis/src/errors.ts";
import { parseChannelMessage, parseDmMessage, dmInvites } from "./messages.ts";
import { createPinnedOriginFetch, type PinnedOriginFetch } from "./network.ts";
import type { Delivery, Installation } from "./types.ts";
import { decodeDeliveryTarget } from "./target.ts";

let apiTail = Promise.resolve();

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
    return lockedFetch(input, { ...init, headers });
  }) as typeof fetch;
}

function storyToText(content: unknown): string {
  return getTextContent(content as Story) ?? "";
}

function textToStory(text: string): Story {
  return text.split(/\n{2,}/).map((paragraph) => ({ inline: [paragraph] }));
}

async function withApi<T>(installation: Installation, client: Urbit, action: () => Promise<T>): Promise<T> {
  const previous = apiTail;
  let release = (): void => {};
  apiTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    await configureClient({ shipName: installation.ship.slice(1), shipUrl: installation.url, client });
    return await action();
  } finally {
    release();
  }
}

function deliveryTime(delivery: Delivery): number {
  let hash = 0;
  for (const char of delivery.id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return delivery.createdAt + (hash % 1000);
}

export class TlonConnection {
  readonly installation: Installation;
  private client: Urbit | null = null;
  private transport: PinnedOriginFetch | null = null;
  private stopped = false;
  private state: { status: "connecting" | "connected" | "error"; message?: string } = { status: "connecting" };
  private readonly seen = new Set<string>();
  private readonly inbound: (message: ReturnType<typeof parseChannelMessage>) => Promise<void>;
  private readonly createTransport: (baseUrl: string) => Promise<PinnedOriginFetch>;
  private readonly createClient: (baseUrl: string, fetchImpl: typeof fetch) => Urbit;
  private readonly cleanupTimeoutMs: number;

  constructor(
    installation: Installation,
    inbound: (message: NonNullable<ReturnType<typeof parseChannelMessage>>) => Promise<void>,
    deps: {
      createTransport?: (baseUrl: string) => Promise<PinnedOriginFetch>;
      createClient?: (baseUrl: string, fetchImpl: typeof fetch) => Urbit;
      cleanupTimeoutMs?: number;
    } = {},
  ) {
    this.installation = installation;
    this.createTransport = deps.createTransport ?? createPinnedOriginFetch;
    this.createClient =
      deps.createClient ?? ((baseUrl, fetchImpl) => new Urbit(baseUrl, undefined, undefined, fetchImpl));
    this.cleanupTimeoutMs = deps.cleanupTimeoutMs ?? 1_000;
    this.inbound = async (message) => {
      if (!message || this.seen.has(message.messageId)) return;
      this.seen.add(message.messageId);
      if (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value!);
      try {
        await inbound(message);
      } catch (error) {
        this.seen.delete(message.messageId);
        console.error(
          `[tlon] inbound ${this.installation.id}/${message.messageId} failed:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    };
  }

  private receive(source: string, value: unknown, parse: typeof parseChannelMessage | typeof parseDmMessage): void {
    try {
      void this.inbound(parse(this.installation, value, storyToText));
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
      const authenticatedFetch = await authenticateShip(
        this.installation.url,
        this.installation.ship,
        this.installation.code,
        transport.fetch,
      );
      if (this.stopped) throw new Error("Tlon connection stopped during startup");
      client = this.createClient(this.installation.url, authenticatedFetch);
      client.nodeId = this.installation.ship;
      this.client = client;
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
    if (status === "active" || status === "reconnected") this.state = { status: "connected" };
    else if (status === "errored") this.state = { status: "error", ...(message ? { message } : {}) };
    else if (this.state.status !== "error") this.state = { status: "connecting", ...(message ? { message } : {}) };
  }

  runtimeStatus(): { status: "connecting" | "connected" | "error"; message?: string } {
    return this.state;
  }

  async deliver(delivery: Delivery): Promise<void> {
    const client = this.client;
    if (!client) throw new Error(`Tlon account ${this.installation.id} is not connected`);
    const target = decodeDeliveryTarget(delivery.destination.target);
    if (target.accountId !== this.installation.id) throw new Error("delivery belongs to another Tlon account");
    try {
      await withApi(this.installation, client, async () => {
        const content = textToStory(delivery.text);
        const sentAt = deliveryTime(delivery);
        if (target.replyTo) {
          await sendReply({
            channelId: target.target,
            parentId: target.replyTo,
            parentAuthor: target.parentAuthor ?? (target.kind === "dm" ? target.target : ""),
            content,
            sentAt,
            authorId: this.installation.ship,
          });
        } else {
          await sendPost({
            channelId: target.target,
            content,
            sentAt,
            authorId: this.installation.ship,
          });
        }
      });
    } catch (error) {
      this.state = { status: "error", message: errMessage(error) };
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const client = this.client;
    const transport = this.transport;
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
