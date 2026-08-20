import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { conversationThreadRef, CoreClient, tlonApprovalCommand } from "../src/core.ts";
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

  assert.equal(conversationThreadRef(topLevel), "tlon:channel:chat%2F~zod%2FGeneral");
  assert.equal(conversationThreadRef({ ...topLevel, accountId: "sales" }), conversationThreadRef(topLevel));
  await client.turn(topLevel);
  await client.turn({ ...topLevel, messageId: "message-2", threadRoot: "root-1" });
  await client.turn({ ...topLevel, installationVersion: "2" });

  const first = bodies[0] as {
    deliveryTarget: string;
    conversation: { threadRef: string; channelRef: string; isPrivate: boolean };
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
  assert.equal(first.conversation.threadRef, "tlon:channel:chat%2F~zod%2FGeneral");
  assert.equal(first.conversation.channelRef, "tlon:chat%2F~zod%2FGeneral");
  assert.equal(first.conversation.isPrivate, true);
  assert.deepEqual(decodeDeliveryTarget(second.deliveryTarget), {
    accountId: "support",
    accountVersion: "1",
    kind: "channel",
    target: "chat/~zod/General",
    replyTo: "root-1",
  });
  assert.equal(second.conversation.threadRef, "tlon:channel:chat%2F~zod%2FGeneral:thread:root-1");
  assert.equal((bodies[0] as { deliveryQueueKey: string }).deliveryQueueKey, "tlon:channel:chat%2F~zod%2FGeneral");
  assert.equal(
    (bodies[0] as { idempotencyKey: string }).idempotencyKey,
    "tlon:channel:chat%2F~zod%2FGeneral:~zod:message-1",
  );
  assert.equal(third.idempotencyKey, "tlon:channel:chat%2F~zod%2FGeneral:~zod:message-1");
});

test("completed idempotent Tlon turns are accepted as durable replays", async () => {
  const results = [
    { status: "queued", runId: "run-1" },
    ...["ok", "failed", "pending_approval", "silent", "react"].map((status) => ({ status })),
  ];
  const client = new CoreClient("http://core:8080", undefined, (async () =>
    Response.json(results.shift())) as typeof fetch);
  for (let i = 0; i < 6; i++) {
    await client.turn(topLevel);
  }
  assert.equal(results.length, 0);
});

test("Tlon approval commands are exact DM-only control messages", () => {
  assert.deepEqual(tlonApprovalCommand({ kind: "dm", text: "/qm approve 9e45ee0714522db5:4a92d7cf1268fe31 once" }), {
    requestId: "9e45ee0714522db5",
    controlId: "4a92d7cf1268fe31",
    approved: true,
    scope: "once",
  });
  assert.deepEqual(tlonApprovalCommand({ kind: "dm", text: "/QM APPROVE 9E45EE0714522DB5:4A92D7CF1268FE31 always" }), {
    requestId: "9e45ee0714522db5",
    controlId: "4a92d7cf1268fe31",
    approved: true,
    scope: "always",
  });
  assert.deepEqual(tlonApprovalCommand({ kind: "dm", text: "/qm deny 9e45ee0714522db5:4a92d7cf1268fe31" }), {
    requestId: "9e45ee0714522db5",
    controlId: "4a92d7cf1268fe31",
    approved: false,
  });
  for (const input of [
    { kind: "channel" as const, text: "/qm approve 9e45ee0714522db5:4a92d7cf1268fe31 once" },
    { kind: "dm" as const, text: "/qm approve 9e45ee0714522db5 once" },
    { kind: "dm" as const, text: "/qm deny 9e45ee0714522db5:4a92d7cf1268fe31 once" },
    { kind: "dm" as const, text: "please /qm approve 9e45ee0714522db5:4a92d7cf1268fe31 once" },
  ]) {
    assert.equal(tlonApprovalCommand(input), null);
  }
});

test("Tlon approval buttons resume through the requester's durable DM route", async () => {
  let body: Record<string, unknown> = {};
  const client = new CoreClient("http://core:8080", undefined, (async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ status: "queued", runId: "approval-run" }, { status: 202 });
  }) as typeof fetch);
  await client.turn({
    ...topLevel,
    kind: "dm",
    target: "~zod",
    senderShip: "~zod",
    text: "/qm approve 9e45ee0714522db5:4a92d7cf1268fe31 session",
  });
  assert.deepEqual(body.approval, {
    requestId: "9e45ee0714522db5",
    controlId: "4a92d7cf1268fe31",
    approved: true,
    scope: "session",
  });
  assert.equal(body.approvalDeliveryTarget, body.deliveryTarget);
  assert.equal(body.approvalDeliveryQueueKey, "tlon:support:1");
});

test("expired Tlon approval controls are consumed without poisoning the DM queue", async () => {
  const client = new CoreClient("http://core:8080", undefined, (async () =>
    Response.json(
      {
        status: "refused",
        refusalCode: "stale_approval",
        reason: "that approval request is no longer available",
      },
      { status: 403 },
    )) as typeof fetch);
  await client.turn({
    ...topLevel,
    kind: "dm",
    target: "~zod",
    text: "/qm approve 9e45ee0714522db5:4a92d7cf1268fe31 once",
  });
});

test("unrelated Tlon approval refusals remain retryable", async () => {
  const client = new CoreClient("http://core:8080", undefined, (async () =>
    Response.json(
      { status: "refused", reason: "shared context membership changed; retry" },
      { status: 403 },
    )) as typeof fetch);
  await assert.rejects(
    client.turn({
      ...topLevel,
      kind: "dm",
      target: "~zod",
      text: "/qm approve 9e45ee0714522db5:4a92d7cf1268fe31 once",
    }),
    /HTTP 403/,
  );
});

test("malformed queued Tlon turns are rejected", async () => {
  for (const runId of [undefined, 123, true, {}, "", "   ", " run-1", "run-1 "]) {
    const client = new CoreClient("http://core:8080", undefined, (async () =>
      Response.json({ status: "queued", runId }, { status: 202 })) as typeof fetch);
    await assert.rejects(client.turn(topLevel), /invalid Tlon turn result/);
  }
});

test("connection reports include the ship-verified channel set", async () => {
  let body: Record<string, unknown> = {};
  const client = new CoreClient("http://core:8080", undefined, (async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ ok: true });
  }) as typeof fetch);

  await client.report("account", "version", "connected", undefined, ["chat/~zod/general"]);
  assert.deepEqual(body, {
    version: "version",
    status: "connected",
    verifiedChannels: ["chat/~zod/general"],
  });
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

  const stale = new CoreClient("http://core:8080", undefined, (async () =>
    Response.json({ error: "stale_roster" }, { status: 409 })) as typeof fetch);
  assert.equal(await stale.run("account/one", "run/1"), null);
});

test("shared-room scope checks use the narrow source-auth endpoint", async () => {
  let path = "";
  const client = new CoreClient("http://core:8080", undefined, (async (input) => {
    path = String(input);
    return Response.json({ current: true });
  }) as typeof fetch);
  assert.equal(await client.channelScopeIsCurrent("chat/~zod/general", "roster-1"), true);
  const url = new URL(path);
  assert.equal(url.pathname, "/v1/tlon/channel-scope");
  assert.equal(url.searchParams.get("channel"), "chat/~zod/general");
  assert.equal(url.searchParams.get("scopeVersion"), "roster-1");
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
  const externalPromptData = [{ source: "tlon-citation:1", content: "untrusted cited text" }];
  await client.turn({
    ...topLevel,
    attachments: [attachment],
    inboundNotes: ["one file was unavailable"],
    externalPromptData,
  });
  assert.deepEqual(body.attachments, [attachment]);
  assert.deepEqual(body.inboundNotes, ["one file was unavailable"]);
  assert.deepEqual(body.externalPromptData, externalPromptData);
});

test("raw inbound messages and bounded delivery claims use the durable connector queues", async () => {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const record = {
    id: "inbound-1",
    queueKey: "channel:chat/~zod/General",
    message: { ...topLevel, scopeVersion: "scope-1" },
    createdAt: 1,
    claimToken: "claim-1",
  };
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
