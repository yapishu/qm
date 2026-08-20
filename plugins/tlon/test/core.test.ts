import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { conversationThreadRef, CoreClient } from "../src/core.ts";
import { decodeDeliveryTarget } from "../src/target.ts";
import type { InboundMessage } from "../src/types.ts";

const topLevel: InboundMessage = {
  accountId: "support",
  installationVersion: "1",
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
  assert.deepEqual(await client.turn({ ...topLevel, installationVersion: "2" }), { runId: "run-3" });

  const first = bodies[0] as {
    deliveryTarget: string;
    conversation: { threadRef: string };
  };
  const second = bodies[1] as {
    deliveryTarget: string;
    conversation: { threadRef: string };
  };
  const third = bodies[2] as { idempotencyKey: string };
  assert.deepEqual(decodeDeliveryTarget(first.deliveryTarget), {
    accountId: "support",
    accountVersion: "1",
    kind: "channel",
    target: "chat/~zod/General",
  });
  assert.equal(first.conversation.threadRef, "tlon:support:channel:chat/~zod/General");
  assert.deepEqual(decodeDeliveryTarget(second.deliveryTarget), {
    accountId: "support",
    accountVersion: "1",
    kind: "channel",
    target: "chat/~zod/General",
    replyTo: "root-1",
  });
  assert.equal(second.conversation.threadRef, "tlon:support:channel:chat/~zod/General:thread:root-1");
  assert.equal((bodies[0] as { idempotencyKey: string }).idempotencyKey, "tlon:support:1:message-1");
  assert.equal(third.idempotencyKey, "tlon:support:2:message-1");
});

test("presence reads use the narrow Tlon runtime endpoints", async () => {
  const paths: string[] = [];
  const snapshot = {
    runId: "run-1",
    accountId: "account/one",
    accountVersion: "version-1",
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

test("Tlon turns carry staged attachments and connector notices into core", async () => {
  let body: Record<string, unknown> = {};
  const client = new CoreClient("http://core:8080", undefined, (async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ status: "queued", runId: "run-media" }, { status: 202 });
  }) as typeof fetch);
  const attachment = {
    name: "photo.png",
    mimetype: "image/png",
    sizeBytes: 3,
    blobId: "blob-1",
    sourceId: "tlon:message-1:0",
    author: "~zod",
  };
  await client.turn({ ...topLevel, attachments: [attachment], inboundNotes: ["one file was unavailable"] });
  assert.deepEqual(body.attachments, [attachment]);
  assert.deepEqual(body.inboundNotes, ["one file was unavailable"]);
});

test("raw inbound messages and bounded delivery claims use the durable connector queues", async () => {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const record = { id: "inbound-1", message: topLevel, createdAt: 1, claimToken: "claim-1" };
  const client = new CoreClient("http://core:8080", undefined, (async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    calls.push({ path: `${url.pathname}${url.search}`, method: init?.method ?? "GET", body });
    if (url.pathname === "/v1/tlon/inbound" && init?.method === "POST") return Response.json({ id: record.id });
    if (url.pathname === "/v1/tlon/inbound") return Response.json({ records: [record] });
    if (url.pathname.endsWith("/ack")) return Response.json({ ok: true });
    return Response.json({ deliveries: [] });
  }) as typeof fetch);
  await client.enqueueInbound(topLevel);
  assert.deepEqual(await client.inboundRecords(), [record]);
  await client.ackInbound(record.id, record.claimToken);
  assert.deepEqual(await client.deliveries(), []);
  assert.deepEqual(calls, [
    { path: "/v1/tlon/inbound", method: "POST", body: { message: topLevel } },
    { path: "/v1/tlon/inbound?claimMs=300000", method: "GET", body: undefined },
    {
      path: "/v1/tlon/inbound/inbound-1/ack",
      method: "POST",
      body: { claimToken: "claim-1" },
    },
    { path: "/v1/deliveries?type=tlon&claimMs=300000&limit=10&grouped=1", method: "GET", body: undefined },
  ]);
});

test("core blob transfers sign staged bytes and read delivery-scoped attachments", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const calls: Array<{ path: string; method: string; headers: Headers; body: Uint8Array }> = [];
  const client = new CoreClient("http://core:8080", "s".repeat(64), (async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body = init?.body ? new Uint8Array(await new Response(init.body).arrayBuffer()) : new Uint8Array();
    calls.push({ path, method: init?.method ?? "GET", headers: new Headers(init?.headers), body });
    if (path === "/v1/blobs") return Response.json({ blobId: "blob-1", sizeBytes: bytes.byteLength });
    return new Response(bytes);
  }) as typeof fetch);

  assert.deepEqual(await client.stageBlob(bytes), { blobId: "blob-1", sizeBytes: 3 });
  assert.deepEqual(await client.deliveryAttachment("delivery/one", 2), bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.headers.get("content-type"), "application/octet-stream");
  assert.equal(calls[0]!.headers.get("x-content-sha256"), sha256);
  assert.ok(calls[0]!.headers.get("x-signature"));
  assert.deepEqual(calls[0]!.body, bytes);
  assert.equal(calls[1]!.path, "/v1/deliveries/delivery%2Fone/attachments/2");
});
