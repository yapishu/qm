import assert from "node:assert/strict";
import test from "node:test";
import { conversationThreadRef, CoreClient } from "../src/core.ts";
import { decodeDeliveryTarget } from "../src/target.ts";
import type { InboundMessage } from "../src/types.ts";

const topLevel: InboundMessage = {
  accountId: "support",
  principalId: "alice@example.com",
  messageId: "message-1",
  senderShip: "~zod",
  text: "hello",
  kind: "channel",
  target: "chat/~zod/General",
};

test("top-level Tlon turns share a timeline and only explicit replies create thread sessions", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const client = new CoreClient("http://core:8080", undefined, (async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({ status: "queued", runId: `run-${bodies.length}` }, { status: 202 });
  }) as typeof fetch);

  assert.equal(conversationThreadRef(topLevel), "tlon:support:channel:chat/~zod/General");
  assert.deepEqual(await client.turn(topLevel), { runId: "run-1" });
  assert.deepEqual(await client.turn({ ...topLevel, messageId: "message-2", threadRoot: "root-1" }), {
    runId: "run-2",
  });

  const first = bodies[0] as {
    deliveryTarget: string;
    conversation: { threadRef: string };
  };
  const second = bodies[1] as {
    deliveryTarget: string;
    conversation: { threadRef: string };
  };
  assert.deepEqual(decodeDeliveryTarget(first.deliveryTarget), {
    accountId: "support",
    kind: "channel",
    target: "chat/~zod/General",
  });
  assert.equal(first.conversation.threadRef, "tlon:support:channel:chat/~zod/General");
  assert.deepEqual(decodeDeliveryTarget(second.deliveryTarget), {
    accountId: "support",
    kind: "channel",
    target: "chat/~zod/General",
    replyTo: "root-1",
  });
  assert.equal(second.conversation.threadRef, "tlon:support:channel:chat/~zod/General:thread:root-1");
});

test("presence reads use the narrow Tlon runtime endpoints", async () => {
  const paths: string[] = [];
  const snapshot = {
    runId: "run-1",
    accountId: "account/one",
    conversationId: "~zod",
    status: "running" as const,
    activeTools: ["read"],
  };
  const client = new CoreClient("http://core:8080", undefined, (async (input) => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    return Response.json(path === "/v1/tlon/presence/runs" ? { runs: [snapshot] } : snapshot);
  }) as typeof fetch);

  assert.deepEqual(await client.presenceRuns(), [snapshot]);
  assert.deepEqual(await client.run("account/one", "run/1"), snapshot);
  assert.deepEqual(paths, ["/v1/tlon/presence/runs", "/v1/tlon/presence/runs/account%2Fone/run%2F1"]);
});
