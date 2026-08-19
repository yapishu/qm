import assert from "node:assert/strict";
import test from "node:test";
import { TlonController } from "../src/controller.ts";
import type { CoreClient } from "../src/core.ts";
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

test("a failed connected status report stops and removes the connection", async () => {
  const statuses: string[] = [];
  const core = {
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
    publishPresence: async (_conversationId: string, _toolNames: string[]) => {},
    clearPresence: async (_conversationId: string) => {},
  }));
  await (controller as unknown as { reconcile(): Promise<void> }).reconcile();
  assert.equal(stopped, true);
  assert.equal(controller.health().accounts, 0);
  assert.deepEqual(statuses, ["connecting", "connected", "error"]);
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

test("controller mirrors active run tools and clears presence after delivery", async () => {
  let inbound = async (_message: InboundMessage): Promise<void> => {};
  let activeTools: string[] = [];
  let active = true;
  const published: Array<{ conversationId: string; toolNames: string[] }> = [];
  const cleared: string[] = [];
  const delivered: string[] = [];
  const acknowledged: string[] = [];
  const validated: Array<{ accountId: string; runId: string }> = [];
  let deliveries: Delivery[] = [];
  const core = {
    installations: async () => [installation],
    report: async () => {},
    turn: async () => ({ runId: "run-1" }),
    presenceRuns: async () =>
      active ? [{ runId: "run-1", accountId: "support", conversationId: "~zod", status: "running", activeTools }] : [],
    run: async (accountId: string, runId: string) => {
      validated.push({ accountId, runId });
      return {
        runId,
        accountId,
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
    refreshPresence(): Promise<void>;
    deliverPending(): Promise<void>;
  };
  await internals.reconcile();
  await inbound({
    accountId: "support",
    principalId: "alice@example.com",
    messageId: "message-1",
    senderShip: "~zod",
    text: "hello",
    kind: "dm",
    target: "~zod",
  });
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
      destination: {
        type: "tlon",
        target: encodeDeliveryTarget({ accountId: "support", kind: "dm", target: "~zod" }),
      },
      text: "done",
      idempotencyKey: "run:run-1",
      createdAt: 1,
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
    installations: async () => [installation],
    report: async () => {},
    presenceRuns: async () => [
      {
        runId: "existing-run",
        accountId: "support",
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
    installations: async () => [installation],
    report: async () => {},
    presenceRuns: async () =>
      active
        ? [
            {
              runId: "silent-run",
              accountId: "support",
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
  const inbound = new Map<string, (message: InboundMessage) => Promise<void>>();
  const published: string[] = [];
  let resolveBlocked = (): void => {};
  const blocked = new Promise<void>((resolve) => {
    resolveBlocked = resolve;
  });
  const core = {
    installations: async () => [installation, sales],
    report: async () => {},
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
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(published.sort(), ["sales", "support"]);
  await Promise.race([
    controller.stop(),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("shutdown remained blocked")), 100)),
  ]);
});

test("controller rejects an inbound message attributed to another account", async () => {
  let receive = async (_message: InboundMessage): Promise<void> => {};
  let turns = 0;
  const core = {
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
      publishPresence: async () => {},
      clearPresence: async () => {},
    };
  });
  await (controller as unknown as { reconcile(): Promise<void> }).reconcile();
  await assert.rejects(
    receive({
      accountId: "sales",
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
