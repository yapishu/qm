import assert from "node:assert/strict";
import test from "node:test";
import { TlonController } from "../src/controller.ts";
import type { CoreClient } from "../src/core.ts";
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
  }));
  await (controller as unknown as { reconcile(): Promise<void> }).reconcile();
  assert.equal(stopped, true);
  assert.equal(controller.health().accounts, 0);
  assert.deepEqual(statuses, ["connecting", "connected", "error"]);
});

test("stopping during startup closes the Airlock client and pinned transport", async () => {
  let rejectPoke = (_error: Error): void => {};
  let deleted = false;
  let closed = false;
  const client = {
    nodeId: null,
    poke: () =>
      new Promise<never>((_resolve, reject) => {
        rejectPoke = reject;
      }),
    delete: async () => {
      deleted = true;
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
        closed = true;
      },
    }),
    createClient: () => client,
  });
  const starting = connection.start();
  await new Promise((resolve) => setImmediate(resolve));
  await connection.stop();
  await assert.rejects(starting, /channel deleted/);
  assert.equal(deleted, true);
  assert.equal(closed, true);
});
