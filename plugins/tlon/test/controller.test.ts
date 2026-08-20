import assert from "node:assert/strict";
import test from "node:test";
import { TlonController } from "../src/controller.ts";
import type { CoreClient } from "../src/core.ts";
import { parseChannelMessage, parseDmMessage } from "../src/messages.ts";
import { encodeDeliveryTarget } from "../src/target.ts";
import { TlonConnection } from "../src/tlon.ts";
import type { Delivery, InboundMessage, Installation } from "../src/types.ts";
import type { Urbit } from "@tloncorp/api";

const installation: Installation = {
  id: "support",
  principalId: "alice@example.com",
  ship: "~sampel-palnet",
  url: "https://ship.example.com",
  code: "secret",
  ownerShip: "~zod",
  channels: [],
  respondWithoutMention: false,
  ownerVerified: true,
  sharedChannelsEnabled: true,
  version: "1",
};

async function settlePresence(controller: TlonController): Promise<void> {
  for (;;) {
    const workers = [
      ...(controller as unknown as { presenceWorkers: Map<string, Promise<void>> }).presenceWorkers.values(),
    ];
    if (!workers.length) return;
    await Promise.all(workers);
  }
}

async function enrichInbound(message: InboundMessage): Promise<InboundMessage> {
  return message;
}

function deliveryTarget(accountId = installation.id, accountVersion = installation.version): string {
  return encodeDeliveryTarget({ accountId, accountVersion, kind: "dm", target: "~zod" });
}

const operationLeases = {
  acquire: async (id: string, version: string) => `lease:${id}:${version}`,
  release: async () => {},
};

test("a failed connected status report stops and removes the connection", async () => {
  const statuses: string[] = [];
  const core = {
    ...operationLeases,
    installations: async () => [installation],
    report: async (_id: string, _version: string, status: string) => {
      statuses.push(status);
      if (status === "connected") throw new Error("status store unavailable");
    },
    turn: async (_message: InboundMessage) => {},
    deliveries: async () => [],
    ack: async (_id: string) => {},
  } as unknown as CoreClient;
  let stopped = false;
  const controller = new TlonController(core, (next) => ({
    installation: next,
    start: async () => {},
    stop: async () => {
      stopped = true;
    },
    runtimeStatus: () => ({ status: "connected" }),
    deliver: async (_delivery: Delivery) => {},
    enrichInbound,
    publishPresence: async (_conversationId: string, _toolNames: string[]) => {},
    clearPresence: async (_conversationId: string) => {},
  }));
  await (controller as unknown as { reconcile(): Promise<void> }).reconcile();
  assert.equal(stopped, true);
  assert.equal(controller.health().accounts, 0);
  assert.deepEqual(statuses, ["connecting", "connected", "error"]);
});

test("startup holds the installation generation lease until the connection is live", async () => {
  let releaseStart = (): void => {};
  const started = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  let releases = 0;
  const core = {
    installations: async () => [installation],
    report: async () => {},
    acquire: async () => "lease-1",
    release: async () => {
      releases++;
    },
  } as unknown as CoreClient;
  const controller = new TlonController(core, (next) => ({
    installation: next,
    start: async () => await started,
    stop: async () => {},
    runtimeStatus: () => ({ status: "connected" }),
    deliver: async () => {},
    enrichInbound,
    publishPresence: async () => {},
    clearPresence: async () => {},
  }));
  const reconciling = (controller as unknown as { reconcile(): Promise<void> }).reconcile();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releases, 0);
  releaseStart();
  await reconciling;
  assert.equal(releases, 1);
  assert.equal(controller.health().accounts, 1);
});

test("a stale installation never starts or enters retry", async () => {
  const statuses: string[] = [];
  let starts = 0;
  const core = {
    installations: async () => [installation],
    report: async (_id: string, _version: string, status: string) => {
      statuses.push(status);
    },
    acquire: async () => null,
    release: async () => {},
  } as unknown as CoreClient;
  const controller = new TlonController(core, (next) => ({
    installation: next,
    start: async () => {
      starts++;
    },
    stop: async () => {},
    runtimeStatus: () => ({ status: "connected" }),
    deliver: async () => {},
    enrichInbound,
    publishPresence: async () => {},
    clearPresence: async () => {},
  }));
  await (controller as unknown as { reconcile(): Promise<void> }).reconcile();
  assert.equal(starts, 0);
  assert.deepEqual(statuses, ["connecting"]);
  assert.equal((controller as unknown as { retries: Map<string, unknown> }).retries.size, 0);
});

test("stopping during startup closes the Airlock client and pinned transport", async () => {
  let rejectPoke = (_error: Error): void => {};
  let deleted = 0;
  let closed = 0;
  const client = {
    nodeId: null,
    poke: () =>
      new Promise<never>((_resolve, reject) => {
        rejectPoke = reject;
      }),
    delete: async () => {
      deleted++;
      rejectPoke(new Error("channel deleted"));
    },
  } as unknown as Urbit;
  const connection = new TlonConnection(installation, async () => {}, {
    createTransport: async () => ({
      fetch: (async () =>
        new Response(null, {
          status: 204,
          headers: { "set-cookie": "urbauth-~sampel-palnet=session-secret; Path=/; HttpOnly" },
        })) as typeof fetch,
      close: async () => {
        closed++;
      },
    }),
    createClient: () => client,
  });
  const starting = connection.start();
  await new Promise((resolve) => setImmediate(resolve));
  await connection.stop();
  await assert.rejects(starting, /channel deleted/);
  assert.equal(deleted, 1);
  assert.equal(closed, 1);
});

test("connected ships authorize only configured channels they have actually joined", async () => {
  let reads = 0;
  const client = { nodeId: installation.ship } as Urbit;
  const connection = new TlonConnection(
    { ...installation, channels: ["chat/~host/allowed", "chat/~host/missing"] },
    async () => {},
    {
      listGroups: async () => {
        reads++;
        return [
          {
            id: "~host/group",
            currentUserIsMember: true,
            currentUserIsHost: false,
            hostUserId: "~host",
            channels: [
              { id: "chat/~host/allowed", type: "chat", currentUserIsMember: true },
              { id: "chat/~host/restricted", type: "chat", currentUserIsMember: false },
            ],
          },
        ];
      },
    },
  );
  (connection as unknown as { client: Urbit }).client = client;

  assert.deepEqual(await connection.verifiedChannels(), ["chat/~host/allowed"]);
  assert.deepEqual(await connection.verifiedChannels(), ["chat/~host/allowed"]);
  assert.equal(reads, 1);
});

test("stopping before transport creation finishes never submits the login code", async () => {
  let resolveTransport = (_transport: { fetch: typeof fetch; close: () => Promise<void> }): void => {};
  const transportCreated = new Promise<{
    fetch: typeof fetch;
    close: () => Promise<void>;
  }>((resolve) => {
    resolveTransport = resolve;
  });
  let fetched = 0;
  let closed = 0;
  const connection = new TlonConnection(installation, async () => {}, {
    createTransport: () => transportCreated,
  });
  const starting = connection.start();
  await connection.stop();
  resolveTransport({
    fetch: (async () => {
      fetched++;
      return new Response(null, { status: 204 });
    }) as typeof fetch,
    close: async () => {
      closed++;
    },
  });
  await assert.rejects(starting, /stopped during startup/);
  assert.equal(fetched, 0);
  assert.equal(closed, 1);
});

test("stopping remains bounded when Airlock cleanup never settles", async () => {
  const never = new Promise<never>(() => {});
  const client = {
    nodeId: null,
    poke: () => never,
    delete: () => never,
  } as unknown as Urbit;
  const connection = new TlonConnection(installation, async () => {}, {
    createTransport: async () => ({
      fetch: (async () =>
        new Response(null, {
          status: 204,
          headers: { "set-cookie": "urbauth-~sampel-palnet=session-secret; Path=/; HttpOnly" },
        })) as typeof fetch,
      close: () => never,
    }),
    createClient: () => client,
    cleanupTimeoutMs: 10,
  });
  void connection.start().catch(() => undefined);
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.race([
    connection.stop(),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("stop remained blocked")), 100)),
  ]);
});

test("computing presence uses Tlon's protocol and clears the same conversation", async () => {
  const pokes: Array<{ app: string; mark: string; json: unknown }> = [];
  const client = {
    nodeId: installation.ship,
    on: () => client,
    poke: async (poke: { app: string; mark: string; json: unknown }) => {
      pokes.push(poke);
    },
  } as unknown as Urbit;
  const connection = new TlonConnection(installation, async () => {});
  (connection as unknown as { client: Urbit | null }).client = client;

  await connection.publishPresence("chat/~zod/General", ["exec"]);
  await connection.publishPresence("chat/~zod/General", ["mcp_private_service"]);
  await connection.clearPresence("chat/~zod/General");

  const active = pokes[0]!.json as {
    set: {
      key: { context: string; ship: string; topic: string };
      timeout: string;
      display: { text: string; blob: string };
    };
  };
  assert.deepEqual(active.set.key, {
    context: "/channel/chat/~zod/General",
    ship: "~sampel-palnet",
    topic: "computing",
  });
  assert.equal(active.set.timeout, "~m1.s30");
  assert.equal(active.set.display.text, "Running a command");
  assert.equal((active.set.display as { icon?: unknown }).icon, null);
  assert.deepEqual(JSON.parse(active.set.display.blob), {
    protocol: "tlon.computing-status.v1",
    thinking: true,
    toolCalls: [{ toolName: "exec", label: "Running a command" }],
  });
  const generic = pokes[1]!.json as { set: { display: { text: string; blob: string } } };
  assert.equal(generic.set.display.text, "Using tool");
  assert.deepEqual(JSON.parse(generic.set.display.blob), {
    protocol: "tlon.computing-status.v1",
    thinking: true,
    toolCalls: [{ toolName: "tool", label: "Using tool" }],
  });
  assert.deepEqual(pokes[2], {
    app: "presence",
    mark: "presence-action-1",
    json: {
      clear: {
        context: "/channel/chat/~zod/General",
        ship: "~sampel-palnet",
        topic: "computing",
      },
    },
  });
});

test("outbound Markdown is delivered as native Tlon rich text", async () => {
  const pokes: Array<{ app: string; mark: string; json: unknown }> = [];
  const client = {
    nodeId: installation.ship,
    on: () => client,
    poke: async (poke: { app: string; mark: string; json: unknown }) => {
      pokes.push(poke);
    },
  } as unknown as Urbit;
  const connection = new TlonConnection(installation, async () => {});
  (connection as unknown as { client: Urbit | null }).client = client;

  await connection.deliver({
    id: "delivery-markdown",
    destination: {
      type: "tlon",
      target: deliveryTarget(),
    },
    text: "# Result\n\n**bold** and `code`\n\n- first\n- second",
    idempotencyKey: "run:markdown",
    createdAt: 1,
    connectorRef: 1_000_001,
  });

  const wire = JSON.stringify(pokes[0]!.json);
  assert.match(wire, /"header":\{"tag":"h1","content":\["Result"\]\}/);
  assert.match(wire, /"bold":\["bold"\]/);
  assert.match(wire, /"inline-code":"code"/);
  assert.match(wire, /"listing":\{"list":\{"type":"unordered"/);
  assert.doesNotMatch(wire, /\*\*bold\*\*/);
});

test("concurrent deliveries keep independent authenticated request cancellation", async () => {
  const alpha = "chat/~sampel-palnet/alpha";
  const beta = "chat/~sampel-palnet/beta";
  let releaseAlpha = (): void => {};
  const alphaGate = new Promise<void>((resolve) => {
    releaseAlpha = resolve;
  });
  let alphaFetchStarted = (): void => {};
  const alphaFetch = new Promise<void>((resolve) => {
    alphaFetchStarted = resolve;
  });
  const transportFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith("/~/login")) {
      return new Response(null, {
        status: 204,
        headers: { "set-cookie": "urbauth-~sampel-palnet=session-secret; Path=/; HttpOnly" },
      });
    }
    if (String(input).endsWith("/alpha")) {
      alphaFetchStarted();
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const connection = new TlonConnection({ ...installation, channels: [alpha, beta] }, async () => {}, {
    postExists: async () => false,
    createTransport: async () => ({ fetch: transportFetch, close: async () => {} }),
    createClient: (_url, authenticatedFetch) => {
      const client = {
        nodeId: installation.ship,
        on: () => client,
        eventSource: async () => {},
        subscribe: async () => 1,
        delete: async () => {},
        poke: async (poke: { app: string; json: unknown }) => {
          if (poke.app === "hood") return;
          const wire = JSON.stringify(poke.json);
          const channel = wire.includes("/alpha") ? alpha : beta;
          if (channel === alpha) await alphaGate;
          const response = await authenticatedFetch(`${installation.url}/${channel.split("/").at(-1)}`);
          if (!response.ok) throw new Error(`poke failed with HTTP ${response.status}`);
        },
      };
      return client as unknown as Urbit;
    },
  });
  await connection.start();
  const delivery = (id: string, target: string): Delivery => ({
    id,
    destination: {
      type: "tlon",
      scopeVersion: "roster-1",
      target: encodeDeliveryTarget({
        accountId: installation.id,
        accountVersion: installation.version,
        kind: "channel",
        target,
      }),
    },
    text: id,
    idempotencyKey: `delivery:${id}`,
    createdAt: 1,
    connectorRef: id === "alpha" ? 1_000_002 : 1_000_003,
  });
  const alphaAbort = new AbortController();
  const alphaDelivery = connection.deliver(delivery("alpha", alpha), alphaAbort.signal);
  await new Promise((resolve) => setImmediate(resolve));
  await connection.deliver(delivery("beta", beta));
  releaseAlpha();
  await alphaFetch;
  alphaAbort.abort(new Error("alpha canceled"));
  await Promise.race([
    assert.rejects(alphaDelivery, /alpha canceled/),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("alpha request did not inherit its cancellation signal")), 100),
    ),
  ]);
  await connection.stop();
});

test("a reply accepted before a lost response is reconciled instead of duplicated", async () => {
  let remoteReply = false;
  let pokes = 0;
  const client = {
    nodeId: installation.ship,
    on: () => client,
    poke: async () => {
      pokes++;
      remoteReply = true;
      throw new Error("response lost after acceptance");
    },
  } as unknown as Urbit;
  const connection = new TlonConnection(installation, async () => {}, {
    replyExists: async (_target, sentAt) => remoteReply && sentAt === 1_000_012,
  });
  (connection as unknown as { client: Urbit | null }).client = client;
  const delivery: Delivery = {
    id: "reply-retry",
    destination: {
      type: "tlon",
      scopeVersion: "roster-1",
      target: encodeDeliveryTarget({
        accountId: installation.id,
        accountVersion: installation.version,
        kind: "channel",
        target: "chat/~sampel-palnet/general",
        replyTo: "parent-post",
        parentAuthor: "~zod",
      }),
    },
    text: "one reply",
    idempotencyKey: "delivery:reply-retry",
    createdAt: 1_000_000,
    connectorRef: 1_000_012,
  };
  await assert.rejects(connection.deliver(delivery), /response lost after acceptance/);
  await connection.deliver(delivery);
  assert.equal(pokes, 1);
});

test("a top-level post accepted before a lost response is reconciled across bot ships", async () => {
  let remoteDeliveryId: string | undefined;
  let pokes = 0;
  const client = {
    nodeId: installation.ship,
    on: () => client,
    poke: async (poke: { json: unknown }) => {
      pokes++;
      const wire = JSON.stringify(poke.json);
      if (wire.includes("qm-delivery") && wire.includes("top-level-retry")) {
        remoteDeliveryId = "top-level-retry";
      }
      throw new Error("response lost after acceptance");
    },
  } as unknown as Urbit;
  const connection = new TlonConnection(installation, async () => {}, {
    postExists: async (_target, deliveryId) => remoteDeliveryId === deliveryId,
  });
  (connection as unknown as { client: Urbit | null }).client = client;
  const delivery: Delivery = {
    id: "top-level-retry",
    destination: {
      type: "tlon",
      scopeVersion: "roster-1",
      target: encodeDeliveryTarget({
        accountId: installation.id,
        accountVersion: installation.version,
        kind: "channel",
        target: "chat/~sampel-palnet/general",
      }),
    },
    text: "one post",
    idempotencyKey: "delivery:top-level-retry",
    createdAt: 1_000_000,
    connectorRef: 1_000_014,
  };
  await assert.rejects(connection.deliver(delivery), /response lost after acceptance/);
  assert.equal(remoteDeliveryId, delivery.id);
  await connection.deliver(delivery);
  assert.equal(pokes, 1);
});

test("inbound Tlon cites and media become quoted context and staged QM attachments", async () => {
  const staged: Uint8Array[] = [];
  const connection = new TlonConnection(installation, async () => {}, {
    resolveCite: async (cite) => ({ author: "~nec", text: `referenced ${cite.postId}` }),
    downloadAttachment: async (media) => ({
      bytes: new Uint8Array([media.name.length]),
      name: media.name,
      mimetype: media.mimetype === "image/*" ? "image/png" : (media.mimetype ?? "application/octet-stream"),
    }),
    stageBlob: async (bytes) => {
      staged.push(bytes);
      return { blobId: `blob-${staged.length}`, sizeBytes: bytes.byteLength };
    },
  });
  const enriched = await (
    connection as unknown as { enrichInbound(message: InboundMessage): Promise<InboundMessage> }
  ).enrichInbound({
    accountId: "support",
    installationVersion: installation.version,
    principalId: "alice@example.com",
    messageId: "message-rich",
    senderShip: "~zod",
    text: "What does this mean?",
    content: [
      { block: { cite: { chan: { nest: "chat/~zod/general", where: "/msg/123" } } } },
      { block: { image: { src: "https://cdn.example.com/photo.png", alt: "photo.png" } } },
    ],
    blob: JSON.stringify([
      {
        type: "file",
        version: 1,
        fileUri: "https://cdn.example.com/report.pdf",
        mimeType: "application/pdf",
        name: "report.pdf",
        size: 10,
      },
    ]),
    kind: "channel",
    target: "chat/~zod/general",
  });
  assert.equal(enriched.text, "What does this mean?");
  assert.deepEqual(enriched.externalPromptData, [
    { source: "tlon-citation:1", content: "Quoted Tlon message from ~nec:\n> referenced 123" },
  ]);
  assert.deepEqual(enriched.attachments, [
    {
      name: "photo.png",
      mimetype: "image/png",
      sizeBytes: 1,
      blobId: "blob-1",
      sourceId: "tlon:message-rich:0",
      author: "~zod",
    },
    {
      name: "report.pdf",
      mimetype: "application/pdf",
      sizeBytes: 1,
      blobId: "blob-2",
      sourceId: "tlon:message-rich:1",
      author: "~zod",
    },
  ]);
});

test("production cite lookup stays on the connected ship client", async () => {
  const paths: string[] = [];
  const client = {
    nodeId: installation.ship,
    subscribeOnce: async (_app: string, path: string) => {
      paths.push(path);
      return {
        nest: "chat/~zod/general",
        reference: {
          post: {
            essay: {
              author: "~nec",
              content: [{ inline: ["from the cited post"] }],
            },
          },
        },
      };
    },
  } as unknown as Urbit;
  const connection = new TlonConnection(installation, async () => {});
  (connection as unknown as { client: Urbit | null }).client = client;
  const message = await connection.enrichInbound({
    accountId: "support",
    installationVersion: installation.version,
    principalId: "alice@example.com",
    messageId: "cited",
    senderShip: "~zod",
    text: "look",
    content: [{ block: { cite: { chan: { nest: "chat/~zod/general", where: "/msg/123" } } } }],
    kind: "channel",
    target: "chat/~zod/general",
  });
  assert.deepEqual(paths, ["/v5/said/~zod/chat/~zod/general/post/123"]);
  assert.equal(message.text, "look");
  assert.deepEqual(message.externalPromptData, [
    { source: "tlon-citation:1", content: "Quoted Tlon message from ~nec:\n> from the cited post" },
  ]);
});

test("inbound Tlon cites cannot read outside the active shared channel", async () => {
  const resolved: string[] = [];
  const connection = new TlonConnection(installation, async () => {}, {
    resolveCite: async (cite) => {
      resolved.push(cite.channelId);
      return { author: "~nec", text: "private" };
    },
  });
  const message = await connection.enrichInbound({
    accountId: "support",
    installationVersion: installation.version,
    principalId: "alice@example.com",
    messageId: "cross-channel-cite",
    senderShip: "~zod",
    text: "look",
    content: [{ block: { cite: { chan: { nest: "chat/~zod/private", where: "/msg/123" } } } }],
    kind: "channel",
    target: "chat/~zod/general",
  });
  assert.deepEqual(resolved, []);
  assert.equal(message.text, "look");
  assert.deepEqual(message.inboundNotes, ["A cited Tlon message could not be loaded."]);
});

test("inbound attachment work caps attempted sources even when every download fails", async () => {
  let attempts = 0;
  const connection = new TlonConnection(installation, async () => {}, {
    stageBlob: async () => ({ blobId: "unused", sizeBytes: 1 }),
    downloadAttachment: async () => {
      attempts++;
      throw new Error("unavailable");
    },
  });
  const message = await connection.enrichInbound({
    accountId: "support",
    installationVersion: installation.version,
    principalId: "alice@example.com",
    messageId: "many-files",
    senderShip: "~zod",
    text: "files",
    blob: JSON.stringify(
      Array.from({ length: 50 }, (_, index) => ({
        type: "file",
        version: 1,
        fileUri: `https://cdn.example.com/${index}.pdf`,
        mimeType: "application/pdf",
        name: `${index}.pdf`,
        size: 1,
      })),
    ),
    kind: "dm",
    target: "~zod",
  });
  assert.equal(attempts, 10);
  assert.equal(message.inboundNotes?.length, 11);
});

test("ship intake durably hands off raw messages before media enrichment", async () => {
  let downloads = 0;
  const accepted: InboundMessage[] = [];
  const connection = new TlonConnection(
    installation,
    async (message) => {
      accepted.push(message);
    },
    {
      stageBlob: async () => ({ blobId: "unused", sizeBytes: 1 }),
      downloadAttachment: async () => {
        downloads++;
        return { bytes: new Uint8Array([1]), name: "unused", mimetype: "image/png" };
      },
    },
  );
  const receive = (
    connection as unknown as {
      receive(source: string, value: unknown, parse: typeof parseDmMessage): void;
    }
  ).receive.bind(connection);
  const event = (id: string) => ({
    whom: "~zod",
    id,
    response: {
      add: {
        essay: {
          author: "~zod",
          content: [
            { inline: ["hello"] },
            { block: { image: { src: `https://cdn.example.com/${id}.png`, alt: `${id}.png` } } },
          ],
        },
      },
    },
  });
  receive("DM", event("one"), parseDmMessage);
  receive("DM", event("two"), parseDmMessage);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(downloads, 0);
  assert.deepEqual(
    accepted.map((message) => message.messageId),
    ["one", "two"],
  );
});

test("a stalled durable handoff bounds intake and forces replay", async () => {
  let accepted = 0;
  const never = new Promise<never>(() => {});
  const connection = new TlonConnection(installation, async () => {
    accepted++;
    await never;
  });
  const receive = (
    connection as unknown as {
      receive(source: string, value: unknown, parse: typeof parseDmMessage): void;
    }
  ).receive.bind(connection);
  for (let index = 0; index < 21; index++) {
    receive(
      "DM",
      {
        whom: "~zod",
        id: `burst-${index}`,
        response: { add: { essay: { author: "~zod", content: [{ inline: ["hello"] }] } } },
      },
      parseDmMessage,
    );
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(accepted, 1);
  assert.deepEqual(connection.runtimeStatus(), {
    status: "error",
    message: "durable inbound handoff is overloaded",
  });
});

test("durable handoffs preserve event order and predecessor identity", async () => {
  const accepted: Array<{ messageId: string; previousId?: string }> = [];
  let releaseFirst = (): void => {};
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const connection = new TlonConnection(installation, async (message, previousId) => {
    accepted.push({ messageId: message.messageId, ...(previousId ? { previousId } : {}) });
    if (message.messageId === "first") await first;
    return `receipt-${message.messageId}`;
  });
  const receive = (
    connection as unknown as {
      receive(source: string, value: unknown, parse: typeof parseDmMessage): void;
    }
  ).receive.bind(connection);
  const event = (id: string) => ({
    whom: "~zod",
    id,
    response: { add: { essay: { author: "~zod", content: [{ inline: [id] }] } } },
  });
  receive("DM", event("first"), parseDmMessage);
  receive("DM", event("second"), parseDmMessage);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(accepted, [{ messageId: "first" }]);
  releaseFirst();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(accepted, [{ messageId: "first" }, { messageId: "second", previousId: "receipt-first" }]);
});

test("same message ids in different Tlon conversations are handed off independently", async () => {
  const accepted: string[] = [];
  const connection = new TlonConnection(
    { ...installation, channels: ["chat/~zod/alpha", "chat/~zod/beta"] },
    async (message) => {
      accepted.push(message.target);
      return `receipt-${message.target}`;
    },
  );
  const receive = (
    connection as unknown as {
      receive(source: string, value: unknown, parse: typeof parseChannelMessage): void;
    }
  ).receive.bind(connection);
  const event = (nest: string) => ({
    nest,
    response: {
      post: {
        id: "same-id",
        "r-post": { set: { essay: { author: "~zod", content: [{ inline: [nest] }] } } },
      },
    },
  });
  receive("Channel", event("chat/~zod/alpha"), parseChannelMessage);
  receive("Channel", event("chat/~zod/beta"), parseChannelMessage);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(accepted.sort(), ["chat/~zod/alpha", "chat/~zod/beta"]);
});

test("durable handoff failure remains visible after a reconnect status", async () => {
  const connection = new TlonConnection(installation, async () => {
    throw new Error("core unavailable");
  });
  const receive = (
    connection as unknown as {
      receive(source: string, value: unknown, parse: typeof parseDmMessage): void;
      updateStatus(status: "active"): void;
    }
  ).receive.bind(connection);
  receive(
    "DM",
    {
      whom: "~zod",
      id: "failed-handoff",
      response: { add: { essay: { author: "~zod", content: [{ inline: ["hello"] }] } } },
    },
    parseDmMessage,
  );
  await new Promise((resolve) => setImmediate(resolve));
  (connection as unknown as { updateStatus(status: "active"): void }).updateStatus("active");
  assert.deepEqual(connection.runtimeStatus(), {
    status: "error",
    message: "durable inbound handoff failed",
  });
});

test("Airlock acknowledgement waits for the durable inbound receipt", async () => {
  const subscriptions: Array<{ app: string; path: string; event: (value: unknown) => void }> = [];
  const acknowledged: number[] = [];
  let releaseReceipt = (): void => {};
  const receipt = new Promise<void>((resolve) => {
    releaseReceipt = resolve;
  });
  const client = {
    nodeId: null,
    poke: async () => 1,
    eventSource: async () => {},
    on: () => client,
    subscribe: async (subscription: { app: string; path: string; event: (value: unknown) => void }) => {
      subscriptions.push(subscription);
      return subscriptions.length;
    },
    ack: async (eventId: number) => {
      acknowledged.push(eventId);
    },
    delete: async () => {},
  } as unknown as Urbit;
  const connection = new TlonConnection(installation, async () => await receipt, {
    createTransport: async () => ({
      fetch: (async () =>
        new Response(null, {
          status: 204,
          headers: { "set-cookie": "urbauth-~sampel-palnet=session-secret; Path=/; HttpOnly" },
        })) as typeof fetch,
      close: async () => {},
    }),
    createClient: () => client,
  });
  await connection.start();
  const ack = (client as unknown as { ack(eventId: number): Promise<void> }).ack(21);
  subscriptions
    .find((subscription) => subscription.app === "chat")!
    .event({
      whom: "~zod",
      id: "durable-message",
      response: {
        add: {
          essay: {
            author: "~zod",
            content: [{ inline: ["hello"] }],
          },
        },
      },
    });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(acknowledged, []);
  releaseReceipt();
  await ack;
  assert.deepEqual(acknowledged, [21]);
  await connection.stop();
});

test("outbound QM files upload through the connected ship and use native Tlon media fields", async () => {
  const pokes: Array<{ app: string; mark: string; json: unknown }> = [];
  const reads: Array<{ deliveryId: string; index: number }> = [];
  const uploads: string[] = [];
  const client = {
    nodeId: installation.ship,
    on: () => client,
    poke: async (poke: { app: string; mark: string; json: unknown }) => {
      pokes.push(poke);
    },
  } as unknown as Urbit;
  const connection = new TlonConnection(installation, async () => {}, {
    readAttachment: async (deliveryId, index) => {
      reads.push({ deliveryId, index });
      return new Uint8Array(index === 0 ? [1, 2, 3] : [4, 5]);
    },
    uploadAttachment: async (attachment) => {
      uploads.push(attachment.name);
      return { url: `https://storage.example.com/${attachment.name}` };
    },
    validateUploadUrl: async (url) => url,
  });
  (connection as unknown as { client: Urbit | null }).client = client;

  await connection.deliver({
    id: "delivery-files",
    destination: {
      type: "tlon",
      target: deliveryTarget(),
    },
    text: "Here they are",
    attachments: [
      { name: "photo.png", mimetype: "image/png", sizeBytes: 3, blobId: "blob-image" },
      { name: "report.pdf", mimetype: "application/pdf", sizeBytes: 2, blobId: "blob-file" },
    ],
    idempotencyKey: "run:files",
    createdAt: 1,
    connectorRef: 1_000_004,
  });

  assert.deepEqual(reads, [
    { deliveryId: "delivery-files", index: 0 },
    { deliveryId: "delivery-files", index: 1 },
  ]);
  assert.deepEqual(uploads, ["photo.png", "report.pdf"]);
  const wire = JSON.stringify(pokes[0]!.json);
  assert.match(wire, /"image":\{"src":"https:\/\/storage\.example\.com\/photo\.png"/);
  assert.match(wire, /\\"type\\":\\"file\\"/);
  assert.match(wire, /\\"fileUri\\":\\"https:\/\/storage\.example\.com\/report\.pdf\\"/);
});

test("attachment failures remain visible and cannot poison text delivery", async () => {
  const pokes: Array<{ app: string; mark: string; json: unknown }> = [];
  const reads: string[] = [];
  const never = new Promise<never>(() => {});
  const client = {
    nodeId: installation.ship,
    on: () => client,
    poke: async (poke: { app: string; mark: string; json: unknown }) => {
      pokes.push(poke);
    },
  } as unknown as Urbit;
  const connection = new TlonConnection(installation, async () => {}, {
    operationTimeoutMs: 10,
    readAttachment: async (_deliveryId, index) => {
      reads.push(String(index));
      if (index === 1) throw new Error("gone");
      return new Uint8Array([1]);
    },
    uploadAttachment: async () => await never,
    validateUploadUrl: async (url) => url,
  });
  (connection as unknown as { client: Urbit | null }).client = client;
  await connection.deliver({
    id: "delivery-fail-open",
    destination: {
      type: "tlon",
      target: deliveryTarget(),
    },
    text: "The text still arrives",
    attachments: [
      {
        name: "too-large.bin",
        mimetype: "application/octet-stream",
        sizeBytes: 100 * 1024 * 1024 + 1,
        blobId: "large",
      },
      { name: "gone.pdf", mimetype: "application/pdf", sizeBytes: 1, blobId: "gone" },
      { name: "hung.pdf", mimetype: "application/pdf", sizeBytes: 1, blobId: "hung" },
    ],
    idempotencyKey: "run:fail-open",
    createdAt: 1,
    connectorRef: 1_000_005,
  });
  assert.deepEqual(reads, ["1", "2"]);
  const wire = JSON.stringify(pokes[0]!.json);
  assert.match(wire, /The text still arrives/);
  assert.match(wire, /Attachment too-large\.bin could not be sent/);
  assert.match(wire, /Attachment gone\.pdf could not be sent/);
  assert.match(wire, /Attachment hung\.pdf could not be sent/);
});

test("a blocked ship cannot stall another account or add API listeners", async () => {
  const blockedInstallation = { ...installation, id: "blocked", ship: "~nec" };
  let blockedPokes = 0;
  let healthyPokes = 0;
  let listeners = 0;
  const never = new Promise<never>(() => {});
  const blockedClient = {
    nodeId: blockedInstallation.ship,
    on: () => {
      listeners++;
      return blockedClient;
    },
    poke: async () => {
      blockedPokes++;
      await never;
    },
  } as unknown as Urbit;
  const healthyClient = {
    nodeId: installation.ship,
    on: () => {
      listeners++;
      return healthyClient;
    },
    poke: async () => {
      healthyPokes++;
    },
  } as unknown as Urbit;
  const blocked = new TlonConnection(blockedInstallation, async () => {});
  const healthy = new TlonConnection(installation, async () => {});
  (blocked as unknown as { client: Urbit | null }).client = blockedClient;
  (healthy as unknown as { client: Urbit | null }).client = healthyClient;

  void blocked.publishPresence("~zod", []).catch(() => undefined);
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.race([
    healthy.publishPresence("~zod", []),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("healthy account remained blocked")), 100),
    ),
  ]);

  assert.equal(blockedPokes, 1);
  assert.equal(healthyPokes, 1);
  assert.equal(listeners, 0);
});

test("independent channel claims do not block each other on the same account", async () => {
  const channels = ["chat/~sampel-palnet/alpha", "chat/~sampel-palnet/beta"];
  const channelInstallation = { ...installation, channels };
  const started: string[] = [];
  const acknowledged: string[] = [];
  const delivery = (id: string, target: string): Delivery => ({
    id,
    claimToken: `claim:${id}`,
    destination: {
      type: "tlon",
      scopeVersion: "roster-1",
      target: encodeDeliveryTarget({
        accountId: installation.id,
        accountVersion: installation.version,
        kind: "channel",
        target,
      }),
    },
    text: id,
    idempotencyKey: `delivery:${id}`,
    createdAt: 1,
    connectorRef: id === "alpha" ? 1_000_006 : 1_000_007,
  });
  const core = {
    ...operationLeases,
    installations: async () => [channelInstallation],
    report: async () => {},
    presenceRuns: async () => [],
    deliveries: async () => [delivery("alpha", channels[0]!), delivery("beta", channels[1]!)],
    ack: async (id: string) => {
      acknowledged.push(id);
    },
  } as unknown as CoreClient;
  const controller = new TlonController(core, (next) => ({
    installation: next,
    start: async () => {},
    stop: async () => {},
    runtimeStatus: () => ({ status: "connected" }),
    enrichInbound,
    verifiedChannels: async () => channels,
    deliver: async (nextDelivery) => {
      started.push(nextDelivery.id);
      if (nextDelivery.id === "alpha") throw new Error("alpha unavailable");
    },
    publishPresence: async () => {},
    clearPresence: async () => {},
  }));
  const internals = controller as unknown as { reconcile(): Promise<void>; deliverPending(): Promise<void> };
  await internals.reconcile();
  await internals.deliverPending();
  assert.deepEqual(started.sort(), ["alpha", "beta"]);
  assert.deepEqual(acknowledged, ["beta"]);
});

test("current-generation claims are released while their connection is starting", async () => {
  const released: string[] = [];
  const message: InboundMessage = {
    accountId: installation.id,
    installationVersion: installation.version,
    principalId: installation.principalId,
    messageId: "waiting-inbound",
    senderShip: installation.ownerShip,
    text: "wait",
    kind: "dm",
    target: installation.ownerShip,
  };
  const delivery: Delivery = {
    id: "waiting-delivery",
    claimToken: "delivery-claim",
    destination: { type: "tlon", target: deliveryTarget() },
    text: "wait",
    idempotencyKey: "waiting-delivery",
    createdAt: 1,
    connectorRef: 1_000_008,
  };
  const core = {
    inboundRecords: async () => [{ id: "waiting-inbound", message, createdAt: 1, claimToken: "inbound-claim" }],
    deliveries: async () => [delivery],
    acquire: async () => "installation-lease",
    release: async () => {},
    releaseInbound: async (id: string) => {
      released.push(`inbound:${id}`);
    },
    releaseDelivery: async (id: string) => {
      released.push(`delivery:${id}`);
    },
    ackInbound: async () => {
      throw new Error("current inbound claim was dropped");
    },
    ack: async () => {
      throw new Error("current delivery claim was dropped");
    },
  } as unknown as CoreClient;
  const controller = new TlonController(core);
  const internals = controller as unknown as {
    processInbound(): Promise<void>;
    deliverPending(): Promise<void>;
  };
  await internals.processInbound();
  await internals.deliverPending();
  assert.deepEqual(released, ["inbound:waiting-inbound", "delivery:waiting-delivery"]);
});

test("shutdown releases in-flight inbound and delivery claims", async () => {
  const inboundMessage: InboundMessage = {
    accountId: installation.id,
    installationVersion: installation.version,
    principalId: installation.principalId,
    messageId: "shutdown-inbound",
    senderShip: installation.ownerShip,
    text: "wait",
    kind: "dm",
    target: installation.ownerShip,
  };
  const released: string[] = [];
  const started: string[] = [];
  const core = {
    ...operationLeases,
    installations: async () => [installation],
    report: async () => {},
    inboundRecords: async () => [
      { id: "shutdown-inbound", message: inboundMessage, createdAt: 1, claimToken: "inbound-claim" },
    ],
    deliveries: async () => [
      {
        id: "shutdown-delivery",
        claimToken: "delivery-claim",
        destination: { type: "tlon", target: deliveryTarget() },
        text: "wait",
        idempotencyKey: "shutdown-delivery",
        createdAt: 1,
        connectorRef: 1_000_009,
      },
    ],
    releaseInbound: async (id: string) => {
      released.push(`inbound:${id}`);
    },
    releaseDelivery: async (id: string) => {
      released.push(`delivery:${id}`);
    },
    ackInbound: async () => {
      throw new Error("shutdown inbound was acknowledged");
    },
    ack: async () => {
      throw new Error("shutdown delivery was acknowledged");
    },
  } as unknown as CoreClient;
  const waitForAbort = (signal?: AbortSignal): Promise<never> =>
    new Promise((_resolve, reject) => {
      started.push("operation");
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  const controller = new TlonController(core, (next) => ({
    installation: next,
    start: async () => {},
    stop: async () => {},
    runtimeStatus: () => ({ status: "connected" }),
    enrichInbound: async (_message, signal) => waitForAbort(signal),
    deliver: async (_delivery, signal) => waitForAbort(signal),
    publishPresence: async () => {},
    clearPresence: async () => {},
  }));
  const internals = controller as unknown as {
    abort: AbortController;
    reconcile(): Promise<void>;
    processInbound(): Promise<void>;
    deliverPending(): Promise<void>;
  };
  await internals.reconcile();
  const inbound = internals.processInbound();
  const delivery = internals.deliverPending();
  while (started.length < 2) await new Promise((resolve) => setImmediate(resolve));
  internals.abort.abort();
  await Promise.all([inbound, delivery]);
  assert.deepEqual(released.sort(), ["delivery:shutdown-delivery", "inbound:shutdown-inbound"]);
});

test("a stale preferred channel route falls through to a core-authorized alternate", async () => {
  const channel = "chat/~sampel-palnet/general";
  const channelInstallation = { ...installation, ownerVerified: false, channels: [channel] };
  const alternate = {
    ...installation,
    id: "alternate",
    ship: "~nec",
    version: "2",
    channels: [channel],
  };
  const acknowledged: string[] = [];
  const released: string[] = [];
  const delivered: string[] = [];
  const channelLeases: Array<{ id: string; scopeVersion?: string }> = [];
  const core = {
    installations: async () => [channelInstallation, alternate],
    report: async () => {},
    presenceRuns: async () => [],
    acquire: async (id: string, _version: string, requestedChannel?: string, scopeVersion?: string) => {
      if (requestedChannel) channelLeases.push({ id, scopeVersion });
      return requestedChannel && id === installation.id ? null : `lease:${id}`;
    },
    release: async () => {},
    run: async () => ({
      runId: "channel-run",
      accountId: installation.id,
      accountVersion: installation.version,
      conversationId: channel,
      status: "done",
      activeTools: [],
      scopeVersion: "roster-1",
    }),
    deliveries: async () => [
      {
        id: "stale-candidate",
        claimToken: "delivery-claim",
        destination: {
          type: "tlon",
          scopeVersion: "roster-1",
          target: encodeDeliveryTarget({
            accountId: installation.id,
            accountVersion: installation.version,
            kind: "channel",
            target: channel,
          }),
        },
        text: "durable output",
        idempotencyKey: "run:channel-run",
        createdAt: 1,
        connectorRef: 1_000_010,
      },
    ],
    ack: async (id: string) => {
      acknowledged.push(id);
    },
    releaseDelivery: async (id: string) => {
      released.push(id);
    },
  } as unknown as CoreClient;
  const controller = new TlonController(core, (next) => ({
    installation: next,
    start: async () => {},
    stop: async () => {},
    runtimeStatus: () => ({ status: "connected" }),
    verifiedChannels: async () => [channel],
    enrichInbound,
    deliver: async () => {
      delivered.push(next.id);
    },
    publishPresence: async () => {},
    clearPresence: async () => {},
  }));
  const internals = controller as unknown as { reconcile(): Promise<void>; deliverPending(): Promise<void> };
  await internals.reconcile();
  await internals.deliverPending();
  assert.deepEqual(delivered, ["alternate"]);
  assert.deepEqual(acknowledged, ["stale-candidate"]);
  assert.deepEqual(released, []);
  assert.deepEqual(channelLeases, [
    { id: installation.id, scopeVersion: "roster-1" },
    { id: alternate.id, scopeVersion: "roster-1" },
  ]);
});

test("a delivery from a stale shared-room roster is acknowledged without posting", async () => {
  const channel = "chat/~sampel-palnet/general";
  const acknowledged: string[] = [];
  let delivered = false;
  const core = {
    installations: async () => [{ ...installation, channels: [channel] }],
    report: async () => {},
    acquire: async (_id: string, _version: string, requestedChannel?: string) =>
      requestedChannel ? null : "source-lease",
    release: async () => {},
    run: async () => {
      throw new Error("post deliveries must not depend on run idempotency keys");
    },
    channelScopeIsCurrent: async () => false,
    deliveries: async () => [
      {
        id: "stale-roster-output",
        claimToken: "delivery-claim",
        connectorRef: 1_000_013,
        destination: {
          type: "tlon",
          scopeVersion: "old-roster",
          target: encodeDeliveryTarget({
            accountId: installation.id,
            accountVersion: installation.version,
            kind: "channel",
            target: channel,
          }),
        },
        text: "old roster output",
        idempotencyKey: "post:shared-session:surface-tool",
        createdAt: 1,
      },
    ],
    ack: async (id: string) => {
      acknowledged.push(id);
    },
  } as unknown as CoreClient;
  const controller = new TlonController(core, (next) => ({
    installation: next,
    start: async () => {},
    stop: async () => {},
    runtimeStatus: () => ({ status: "connected" }),
    verifiedChannels: async () => [channel],
    enrichInbound,
    deliver: async () => {
      delivered = true;
    },
    publishPresence: async () => {},
    clearPresence: async () => {},
  }));
  const internals = controller as unknown as { reconcile(): Promise<void>; deliverPending(): Promise<void> };
  await internals.reconcile();
  await internals.deliverPending();
  assert.equal(delivered, false);
  assert.deepEqual(acknowledged, ["stale-roster-output"]);
});

test("controller mirrors active run tools and clears presence after delivery", async () => {
  let inbound = async (_message: InboundMessage): Promise<string | void> => {};
  let queuedInbound: InboundMessage | null = null;
  let activeTools: string[] = [];
  let active = true;
  const published: Array<{ conversationId: string; toolNames: string[] }> = [];
  const cleared: string[] = [];
  const delivered: string[] = [];
  const acknowledged: string[] = [];
  const validated: Array<{ accountId: string; runId: string }> = [];
  let deliveries: Delivery[] = [];
  const core = {
    ...operationLeases,
    installations: async () => [installation],
    report: async () => {},
    enqueueInbound: async (message: InboundMessage) => {
      queuedInbound = message;
      return "inbound-1";
    },
    inboundRecords: async () =>
      queuedInbound ? [{ id: "inbound-1", message: queuedInbound, createdAt: 1, claimToken: "claim-1" }] : [],
    ackInbound: async () => {
      queuedInbound = null;
    },
    turn: async () => ({ runId: "run-1" }),
    presenceRuns: async () =>
      active
        ? [
            {
              runId: "run-1",
              accountId: "support",
              accountVersion: installation.version,
              conversationId: "~zod",
              status: "running",
              activeTools,
            },
          ]
        : [],
    run: async (accountId: string, runId: string) => {
      validated.push({ accountId, runId });
      return {
        runId,
        accountId,
        accountVersion: installation.version,
        conversationId: "~zod",
        status: "done",
        activeTools: [],
      };
    },
    deliveries: async () => deliveries,
    ack: async (id: string) => {
      acknowledged.push(id);
    },
  } as unknown as CoreClient;
  const controller = new TlonController(core, (next, receive) => {
    inbound = receive;
    return {
      installation: next,
      start: async () => {},
      stop: async () => {},
      runtimeStatus: () => ({ status: "connected" }),
      deliver: async (delivery) => {
        delivered.push(delivery.id);
      },
      enrichInbound,
      publishPresence: async (conversationId, toolNames) => {
        published.push({ conversationId, toolNames });
      },
      clearPresence: async (conversationId) => {
        cleared.push(conversationId);
      },
    };
  });
  const internals = controller as unknown as {
    reconcile(): Promise<void>;
    processInbound(): Promise<void>;
    refreshPresence(): Promise<void>;
    deliverPending(): Promise<void>;
  };
  await internals.reconcile();
  await inbound({
    accountId: "support",
    installationVersion: installation.version,
    principalId: "alice@example.com",
    messageId: "message-1",
    senderShip: "~zod",
    text: "hello",
    kind: "dm",
    target: "~zod",
  });
  await internals.processInbound();
  await settlePresence(controller);
  assert.deepEqual(published, [{ conversationId: "~zod", toolNames: [] }]);

  activeTools = ["exec"];
  await internals.refreshPresence();
  await settlePresence(controller);
  assert.deepEqual(published.at(-1), { conversationId: "~zod", toolNames: ["exec"] });

  active = false;
  deliveries = [
    {
      id: "delivery-1",
      claimToken: "claim:delivery-1",
      destination: {
        type: "tlon",
        target: deliveryTarget(),
      },
      text: "done",
      idempotencyKey: "run:run-1",
      createdAt: 1,
      connectorRef: 1_000_011,
    },
  ];
  await internals.deliverPending();
  await settlePresence(controller);
  assert.deepEqual(delivered, ["delivery-1"]);
  assert.deepEqual(acknowledged, ["delivery-1"]);
  assert.deepEqual(validated, [{ accountId: "support", runId: "run-1" }]);
  assert.deepEqual(cleared, ["~zod"]);
});

test("controller reconstructs active presence from durable core state after startup", async () => {
  const published: Array<{ conversationId: string; toolNames: string[] }> = [];
  const cleared: string[] = [];
  const core = {
    ...operationLeases,
    installations: async () => [installation],
    report: async () => {},
    presenceRuns: async () => [
      {
        runId: "existing-run",
        accountId: "support",
        accountVersion: installation.version,
        conversationId: "~zod",
        status: "running",
        activeTools: ["read"],
      },
    ],
    deliveries: async () => [],
    ack: async () => {},
  } as unknown as CoreClient;
  const controller = new TlonController(core, (next) => ({
    installation: next,
    start: async () => {},
    stop: async () => {},
    runtimeStatus: () => ({ status: "connected" }),
    deliver: async () => {},
    enrichInbound,
    publishPresence: async (conversationId, toolNames) => {
      published.push({ conversationId, toolNames });
    },
    clearPresence: async (conversationId) => {
      cleared.push(conversationId);
    },
  }));
  const internals = controller as unknown as {
    reconcile(): Promise<void>;
    refreshPresence(): Promise<void>;
  };
  await internals.reconcile();
  await internals.refreshPresence();
  await settlePresence(controller);
  assert.deepEqual(published, [{ conversationId: "~zod", toolNames: ["read"] }]);
  assert.deepEqual(cleared, []);
});

test("a silent terminal run clears presence without a delivery", async () => {
  let active = true;
  const cleared: string[] = [];
  const core = {
    ...operationLeases,
    installations: async () => [installation],
    report: async () => {},
    presenceRuns: async () =>
      active
        ? [
            {
              runId: "silent-run",
              accountId: "support",
              accountVersion: installation.version,
              conversationId: "~zod",
              status: "running",
              activeTools: [],
            },
          ]
        : [],
    deliveries: async () => [],
    ack: async () => {},
  } as unknown as CoreClient;
  const controller = new TlonController(core, (next) => ({
    installation: next,
    start: async () => {},
    stop: async () => {},
    runtimeStatus: () => ({ status: "connected" }),
    deliver: async () => {},
    enrichInbound,
    publishPresence: async () => {},
    clearPresence: async (conversationId) => {
      cleared.push(conversationId);
    },
  }));
  const internals = controller as unknown as { reconcile(): Promise<void>; refreshPresence(): Promise<void> };
  await internals.reconcile();
  await internals.refreshPresence();
  await settlePresence(controller);
  active = false;
  await internals.refreshPresence();
  await settlePresence(controller);
  assert.deepEqual(cleared, ["~zod"]);
});

test("a stale presence snapshot cannot resurrect activity after a newer snapshot clears it", async () => {
  const activeRun = {
    runId: "run-1",
    accountId: "support",
    accountVersion: installation.version,
    conversationId: "~zod",
    status: "running" as const,
    activeTools: [],
  };
  let resolveStale = (_runs: (typeof activeRun)[]): void => {};
  const stale = new Promise<(typeof activeRun)[]>((resolve) => {
    resolveStale = resolve;
  });
  const snapshots = [Promise.resolve([activeRun]), stale, Promise.resolve([])];
  const published: string[] = [];
  const cleared: string[] = [];
  const core = {
    ...operationLeases,
    installations: async () => [installation],
    report: async () => {},
    presenceRuns: async () => await snapshots.shift()!,
    deliveries: async () => [],
    ack: async () => {},
  } as unknown as CoreClient;
  const controller = new TlonController(core, (next) => ({
    installation: next,
    start: async () => {},
    stop: async () => {},
    runtimeStatus: () => ({ status: "connected" }),
    deliver: async () => {},
    enrichInbound,
    publishPresence: async (conversationId) => {
      published.push(conversationId);
    },
    clearPresence: async (conversationId) => {
      cleared.push(conversationId);
    },
  }));
  const internals = controller as unknown as { reconcile(): Promise<void>; refreshPresence(): Promise<void> };
  await internals.reconcile();
  await internals.refreshPresence();
  await settlePresence(controller);

  const older = internals.refreshPresence();
  const newer = internals.refreshPresence();
  await newer;
  await settlePresence(controller);
  resolveStale([activeRun]);
  await older;
  await settlePresence(controller);

  assert.deepEqual(published, ["~zod"]);
  assert.deepEqual(cleared, ["~zod"]);
});

test("presence coalesces per conversation, isolates accounts, and closes transports before shutdown waits", async () => {
  const sales = { ...installation, id: "sales", ship: "~nec", version: "2" };
  const inbound = new Map<string, (message: InboundMessage) => Promise<string | void>>();
  const published: string[] = [];
  let resolveBlocked = (): void => {};
  const blocked = new Promise<void>((resolve) => {
    resolveBlocked = resolve;
  });
  const queuedInbound = new Map<string, InboundMessage>();
  const core = {
    ...operationLeases,
    installations: async () => [installation, sales],
    report: async () => {},
    enqueueInbound: async (message: InboundMessage) => {
      queuedInbound.set(`${message.accountId}:${message.messageId}`, message);
      return `${message.accountId}:${message.messageId}`;
    },
    inboundRecords: async () =>
      [...queuedInbound.entries()].map(([id, message]) => ({ id, message, createdAt: 1, claimToken: id })),
    ackInbound: async (id: string) => {
      queuedInbound.delete(id);
    },
    turn: async () => ({ runId: "run-1" }),
    presenceRuns: async () => [],
    deliveries: async () => [],
    ack: async () => {},
  } as unknown as CoreClient;
  const controller = new TlonController(core, (next, receive) => {
    inbound.set(next.id, receive);
    return {
      installation: next,
      start: async () => {},
      stop: async () => {
        if (next.id === "support") resolveBlocked();
      },
      runtimeStatus: () => ({ status: "connected" }),
      deliver: async () => {},
      enrichInbound,
      publishPresence: async () => {
        published.push(next.id);
        if (next.id === "support") await blocked;
      },
      clearPresence: async () => {},
    };
  });
  await (controller as unknown as { reconcile(): Promise<void> }).reconcile();
  const message = (accountId: string): InboundMessage => ({
    accountId,
    installationVersion: accountId === installation.id ? installation.version : sales.version,
    principalId: "alice@example.com",
    messageId: `${accountId}-message`,
    senderShip: "~zod",
    text: "hello",
    kind: "dm",
    target: "~zod",
  });
  await Promise.all([
    inbound.get("support")!(message("support")),
    inbound.get("support")!(message("support")),
    inbound.get("sales")!(message("sales")),
  ]);
  await (controller as unknown as { processInbound(): Promise<void> }).processInbound();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(published.sort(), ["sales", "support"]);
  await Promise.race([
    controller.stop(),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("shutdown remained blocked")), 100)),
  ]);
});

test("controller rejects an inbound message attributed to another account", async () => {
  let receive = async (_message: InboundMessage): Promise<string | void> => {};
  let turns = 0;
  const core = {
    ...operationLeases,
    installations: async () => [installation],
    report: async () => {},
    turn: async () => {
      turns++;
      return { runId: "run-1" };
    },
  } as unknown as CoreClient;
  const controller = new TlonController(core, (next, inbound) => {
    receive = inbound;
    return {
      installation: next,
      start: async () => {},
      stop: async () => {},
      runtimeStatus: () => ({ status: "connected" }),
      deliver: async () => {},
      enrichInbound,
      publishPresence: async () => {},
      clearPresence: async () => {},
    };
  });
  await (controller as unknown as { reconcile(): Promise<void> }).reconcile();
  await assert.rejects(
    receive({
      accountId: "sales",
      installationVersion: "2",
      principalId: "alice@example.com",
      messageId: "message-1",
      senderShip: "~zod",
      text: "hello",
      kind: "dm",
      target: "~zod",
    }),
    /another account/,
  );
  assert.equal(turns, 0);
});
