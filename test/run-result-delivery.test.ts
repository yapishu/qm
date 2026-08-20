import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import { createDeliveryStore, type DeliveryStore } from "../src/delivery/delivery-store.ts";
import {
  reconcileTlonApprovalDeliveries,
  runApprovalDeliveries,
  runResultDelivery,
  wireRunResultDeliveries,
} from "../src/delivery/run-result-delivery.ts";
import type { Run } from "../src/runs/run-store.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import { commandApprovalControlId } from "../src/core/approval-id.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import type { DurableMap } from "../src/persistence/durable-map.ts";
import type { PendingApprovalRecord, Principal, TurnResult } from "../src/types.ts";
import { SECURITY_QUARANTINE_REFUSAL_TEXT } from "../plugins/chassis/src/security-quarantine.ts";

const actor: Principal = { id: "internal:U1", type: "internal" };
const turn = (text: string, deliveryTarget?: string): OrchestratorInput => ({
  surface: "slack",
  ...(deliveryTarget ? { deliveryTarget } : {}),
  actor,
  conversation: { kind: "dm", threadRef: "t", audience: [actor] },
  origin: { kind: "direct" },
  text,
});

function run(over: Partial<Run>): Run {
  return {
    id: "r-1",
    sessionId: "s-1",
    status: "done",
    request: turn("hi", "C9:171.001"),
    result: { status: "ok", reply: "the reply" },
    deliveryState: null,
    dedupKey: null,
    attempts: 1,
    errorAttempts: 0,
    maxAttempts: 3,
    leaseToken: null,
    leaseExpiresAt: null,
    workerId: null,
    createdAt: 1,
    startedAt: 1,
    finishedAt: 2,
    ...over,
  };
}

test("runResultDelivery maps ok-with-reply to a recovery delivery keyed by run", () => {
  const d = runResultDelivery(run({}));
  assert.deepEqual(d, {
    destination: { type: "slack", target: "C9:171.001" },
    text: "the reply",
    idempotencyKey: "run:r-1",
  });
});

test("runResultDelivery preserves the Tlon shared-room roster epoch", () => {
  const recovered = run({
    request: { ...turn("hi", "tlon-target"), surface: "tlon", scopeVersion: "roster-1" },
  });
  assert.equal(runResultDelivery(recovered)?.destination.scopeVersion, "roster-1");
});

test("Tlon pending approvals become durable requester-DM prompts", () => {
  const [approval] = runApprovalDeliveries(
    run({
      request: {
        ...turn("deploy", "channel-target"),
        surface: "tlon",
        approvalDeliveryTarget: "dm-target",
        approvalDeliveryQueueKey: "tlon:account:version",
      },
      result: {
        status: "pending_approval",
        pendingApprovals: [
          {
            requestId: "9e45ee0714522db5",
            controlId: "4a92d7cf1268fe31",
            command: "rm -rf build",
            reason: "recursive delete",
            purpose: "replace the preview build",
          },
        ],
      },
    }),
  );
  assert.equal(approval?.destination.target, "dm-target");
  assert.equal(approval?.destination.queueKey, "tlon:account:version");
  assert.equal(approval?.destination.scopeVersion, undefined);
  assert.equal(approval?.destination.approvalRequests?.[0]?.requestId, "9e45ee0714522db5");
  assert.match(approval?.text ?? "", /Approval needed/);
  assert.match(approval?.text ?? "", /\/qm approve 9e45ee0714522db5:4a92d7cf1268fe31 once/);
  assert.equal(approval?.idempotencyKey, "approval:r-1:4a92d7cf1268fe31");
});

test("runResultDelivery carries the reply's attachments so recovery can replay the files", () => {
  const atts = [{ name: "report.csv", mimetype: "text/csv", sizeBytes: 42, blobId: "blob-1" }];
  const d = runResultDelivery(run({ result: { status: "ok", reply: "here's the file", attachments: atts } }));
  assert.deepEqual(d?.attachments, atts);
  assert.equal(d?.text, "here's the file");
});

test("runResultDelivery recovers an attachments-only reply (empty text, files still land)", () => {
  const atts = [{ name: "report.csv", mimetype: "text/csv", sizeBytes: 42, blobId: "blob-1" }];
  const d = runResultDelivery(run({ result: { status: "ok", attachments: atts } }));
  assert.equal(d?.text, "");
  assert.deepEqual(d?.attachments, atts);
  assert.equal(d?.idempotencyKey, "run:r-1");
});

test("runResultDelivery does not recover a turn whose only output was file problems", () => {
  const d = runResultDelivery(run({ result: { status: "ok", reply: "" } }));
  assert.equal(d, null);
});

test("runResultDelivery sheds a surface-spine turn's text reply (the agent posted it via `post` — no double-post)", () => {
  const spine = run({ result: { status: "silent" } });
  spine.request = { ...spine.request, surfaceTools: true };
  assert.equal(runResultDelivery(spine), null, "no recovery copy — post already delivered the text");
  const okReply = run({ result: { status: "ok", reply: "leaked reply" } });
  okReply.request = { ...okReply.request, surfaceTools: true };
  assert.equal(runResultDelivery(okReply), null, "post owns the text — the turn reply is never re-posted");
});

test("runResultDelivery STILL recovers a surface-spine turn's file attachments (post is text-only)", () => {
  const atts = [{ name: "report.csv", mimetype: "text/csv", sizeBytes: 42, blobId: "blob-1" }];
  const spine = run({ result: { status: "ok", reply: "", attachments: atts } });
  spine.request = { ...spine.request, surfaceTools: true };
  const d = runResultDelivery(spine);
  assert.deepEqual(d?.attachments, atts, "files ride the turn result, so they must not be shed");
  assert.equal(d?.text, "");
});

test("runResultDelivery still posts a surface-spine turn's FAILURE note", () => {
  const spine = run({ status: "failed", result: { status: "failed", reason: "boom" } });
  spine.request = { ...spine.request, surfaceTools: true };
  assert.equal(runResultDelivery(spine)?.text, "⚠️ I couldn't finish that turn: boom");
});

test("runResultDelivery recovers a security quarantine without exposing its internal reason", () => {
  const d = runResultDelivery(
    run({
      request: { ...turn("hi", "C9:171.001"), addressed: true },
      result: {
        status: "refused",
        refusalKind: "security_quarantine",
        reason: "internal screening details",
      },
    }),
  );
  assert.equal(d?.text, SECURITY_QUARANTINE_REFUSAL_TEXT);
  assert.doesNotMatch(d?.text ?? "", /internal screening details/);
});

test("runResultDelivery keeps an unprompted quarantine silent — a replay has no live handler to suppress it", () => {
  const spine = run({ result: { status: "refused", refusalKind: "security_quarantine" } });
  spine.request = { ...spine.request, surfaceTools: true, origin: { kind: "ambient" } };
  assert.equal(runResultDelivery(spine), null);
});

test("runResultDelivery recovers security quarantine for an addressed surface-spine turn", () => {
  const spine = run({ result: { status: "refused", refusalKind: "security_quarantine" } });
  spine.request = { ...spine.request, surfaceTools: true, addressed: true };
  assert.equal(runResultDelivery(spine)?.text, SECURITY_QUARANTINE_REFUSAL_TEXT);
});

test("runResultDelivery keeps proactive ambient quarantine silent", () => {
  const ambient = run({ result: { status: "refused", refusalKind: "security_quarantine" } });
  ambient.request = { ...ambient.request, origin: { kind: "automation" }, surfaceTools: true };
  assert.equal(runResultDelivery(ambient), null);
});

test("runResultDelivery carries the surface's edit checkpoint into the destination", () => {
  const d = runResultDelivery(run({ deliveryState: { editRef: "171.002" } }));
  assert.equal(d?.destination.editRef, "171.002");
});

test("runResultDelivery carries a durable terminal task projection", () => {
  const d = runResultDelivery(run({ deliveryState: { editRef: "171.002" } }), [
    {
      id: "task-1",
      sessionId: "s1",
      originRunId: "r-1",
      title: "research",
      status: "failed",
      createdAt: 1,
      updatedAt: 2,
    },
  ]);
  assert.deepEqual(d?.destination.taskList, [{ id: "task-1", title: "research", status: "failed" }]);
});

test("runResultDelivery turns a parked run into a visible failure note", () => {
  const d = runResultDelivery(
    run({ status: "failed", result: { status: "failed", reason: "lease expired (reaped)" } }),
  );
  assert.equal(d?.text, "⚠️ I couldn't finish that turn: lease expired (reaped)");
  assert.equal(d?.idempotencyKey, "run:r-1");
});

test("runResultDelivery keeps unprompted failures quiet, like the live path", () => {
  const failed = run({ status: "failed", result: { status: "failed", reason: "boom" } });
  failed.request = { ...failed.request, origin: { kind: "ambient" } };
  assert.equal(runResultDelivery(failed), null, "no failure note where nobody addressed the agent");
  const ok = run({});
  ok.request = { ...ok.request, origin: { kind: "ambient" } };
  assert.equal(runResultDelivery(ok)?.text, "the reply", "an unprompted reply the agent chose to send still recovers");
});

test("runResultDelivery recognizes legacy queued ambient turns", () => {
  const failed = run({ status: "failed", result: { status: "failed", reason: "boom" } });
  failed.request = { ...failed.request, origin: undefined, unprompted: true } as unknown as OrchestratorInput;
  assert.equal(runResultDelivery(failed), null);
});

test("runResultDelivery skips terminal results that cannot be safely replayed", () => {
  assert.equal(runResultDelivery(run({ request: turn("hi") })), null);
  assert.equal(runResultDelivery(run({ result: { status: "refused", reason: "not allowed" } })), null);
  for (const result of [
    { status: "pending_approval" } as TurnResult,
    { status: "react", reactions: ["thumbsup"] } as TurnResult,
    { status: "silent" } as TurnResult,
    { status: "ok" } as TurnResult,
  ]) {
    assert.equal(runResultDelivery(run({ result })), null, `skips ${result.status}`);
  }
});

test("wired stores: a completed turn lands in the outbox unless the live path acked it", async () => {
  const { runs } = createMemoryRunStore();
  const deliveries = createDeliveryStore();
  wireRunResultDeliveries(runs, deliveries);

  const crashed = (await runs.enqueue({ sessionId: "sA", request: turn("a", "C9:171.001") })).run;
  const c1 = await runs.claim("w1", 5_000);
  await runs.setDeliveryState(crashed.id, null, { editRef: "171.002" });
  await runs.complete(crashed.id, c1?.leaseToken ?? "", { status: "ok", reply: "recovered reply" });
  const pending = await deliveries.pending("slack");
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.text, "recovered reply");
  assert.equal(pending[0]!.destination.editRef, "171.002");
  assert.equal(pending[0]!.idempotencyKey, `run:${crashed.id}`);

  const live = (await runs.enqueue({ sessionId: "sB", request: turn("b", "C9") })).run;
  const c2 = await runs.claim("w2", 5_000);
  await deliveries.ackByKey(`run:${live.id}`, 99);
  await runs.complete(live.id, c2?.leaseToken ?? "", { status: "ok", reply: "delivered live" });
  await new Promise((r) => setTimeout(r, 0));
  const after = await deliveries.pending("slack");
  assert.deepEqual(
    after.map((d) => d.idempotencyKey),
    [`run:${crashed.id}`],
    "live-acked copy stays suppressed",
  );
});

test("durable pending approvals recover Tlon prompts after transient outbox failure", async () => {
  const approvals = createMemoryMap<PendingApprovalRecord>();
  const backing = createDeliveryStore();
  let fail = true;
  const deliveries: DeliveryStore = {
    ...backing,
    async enqueue(input) {
      if (fail) {
        fail = false;
        throw new Error("temporary outbox failure");
      }
      return backing.enqueue(input);
    },
  };
  const sourceRunId = "run-approval";
  const requestId = "9e45ee0714522db5";
  const controlId = commandApprovalControlId(sourceRunId, requestId);
  await approvals.put(requestId, {
    sessionId: "s-approval",
    sourceRunId,
    controlId,
    command: "rm -rf build",
    reason: "recursive delete",
    request: {
      surface: "tlon",
      approvalDeliveryTarget: "dm-target",
      approvalDeliveryQueueKey: "tlon:account:version",
      actor: { externalId: "alice@example.com" },
      conversation: { kind: "dm", threadRef: "tlon:account:dm:~zod" },
      text: "deploy",
    },
  });
  await assert.rejects(reconcileTlonApprovalDeliveries(approvals, deliveries), /temporary outbox failure/);
  assert.deepEqual(await backing.pending("tlon"), []);
  await reconcileTlonApprovalDeliveries(approvals, backing);
  await reconcileTlonApprovalDeliveries(approvals, backing);
  const prompts = await backing.pending("tlon");
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0]?.idempotencyKey, `approval:${sourceRunId}:${controlId}`);
  assert.equal(prompts[0]?.destination.approvalRequests?.[0]?.controlId, controlId);
});

test("legacy Tlon approvals are upgraded from their durable run and prompted after restart", async () => {
  const approvals = createMemoryMap<PendingApprovalRecord>();
  const deliveries = createDeliveryStore();
  const { runs } = createMemoryRunStore();
  const target = Buffer.from(
    JSON.stringify({ accountId: "account-1", accountVersion: "version-1", kind: "dm", target: "~zod" }),
  ).toString("base64url");
  const queued = await runs.enqueue({
    sessionId: "s-legacy",
    request: {
      ...turn("deploy", target),
      surface: "tlon",
      deliveryQueueKey: "tlon:account-1:version-1:dm:~zod",
    },
  });
  const claimed = await runs.claimById(queued.run.id, "worker", 5_000);
  const requestId = "legacy-approval";
  await runs.complete(queued.run.id, claimed!.leaseToken!, {
    status: "pending_approval",
    pendingApprovals: [{ requestId, command: "rm -rf build", reason: "recursive delete", blocksInput: true }],
  });
  await approvals.put(requestId, {
    sessionId: "s-legacy",
    createdAt: 1,
    command: "rm -rf build",
    reason: "recursive delete",
    request: {
      surface: "tlon",
      deliveryTarget: target,
      deliveryQueueKey: "tlon:account-1:version-1:dm:~zod",
      actor: { externalId: "alice@example.com" },
      conversation: { kind: "dm", threadRef: "tlon:account-1:dm:~zod" },
      text: "deploy",
    },
  });
  await reconcileTlonApprovalDeliveries(approvals, deliveries, runs, {
    runtimeVersions: async () => [{ id: "account-1", version: "version-1" }],
  });
  const migrated = await approvals.get(requestId);
  assert.equal(migrated?.sourceRunId, queued.run.id);
  assert.equal(migrated?.controlId, commandApprovalControlId(queued.run.id, requestId));
  assert.equal(migrated?.request?.approvalDeliveryTarget, target);
  assert.equal((await deliveries.pending("tlon")).length, 1);
});

test("a legacy approval is preserved while its old worker is still completing the run", async () => {
  const approvals = createMemoryMap<PendingApprovalRecord>();
  const deliveries = createDeliveryStore();
  const { runs } = createMemoryRunStore();
  const target = Buffer.from(
    JSON.stringify({ accountId: "account-1", accountVersion: "version-1", kind: "dm", target: "~zod" }),
  ).toString("base64url");
  const queued = await runs.enqueue({
    sessionId: "s-rolling",
    request: { ...turn("deploy", target), surface: "tlon" },
  });
  const claimed = await runs.claimById(queued.run.id, "old-worker", 5_000);
  await approvals.put("rolling-approval", {
    sessionId: "s-rolling",
    createdAt: 1,
    command: "rm -rf build",
    request: {
      surface: "tlon",
      deliveryTarget: target,
      actor: { externalId: "alice@example.com" },
      conversation: { kind: "dm", threadRef: "tlon:account-1:dm:~zod" },
      text: "deploy",
    },
  });
  const installations = {
    runtimeVersions: async () => [{ id: "account-1", version: "version-1" }],
  };
  await reconcileTlonApprovalDeliveries(approvals, deliveries, runs, installations);
  assert.ok(await approvals.get("rolling-approval"));
  assert.deepEqual(await deliveries.pending("tlon"), []);
  await runs.complete(queued.run.id, claimed!.leaseToken!, {
    status: "pending_approval",
    pendingApprovals: [{ requestId: "rolling-approval", command: "rm -rf build", reason: "recursive delete" }],
  });
  await reconcileTlonApprovalDeliveries(approvals, deliveries, runs, installations);
  assert.equal((await approvals.get("rolling-approval"))?.sourceRunId, queued.run.id);
  assert.equal((await deliveries.pending("tlon")).length, 1);
});

test("a connector generation change invalidates its pending DM approval", async () => {
  const approvals = createMemoryMap<PendingApprovalRecord>();
  const deliveries = createDeliveryStore();
  const target = Buffer.from(
    JSON.stringify({ accountId: "account-1", accountVersion: "version-1", kind: "dm", target: "~zod" }),
  ).toString("base64url");
  await approvals.put("stale-approval", {
    sessionId: "s-stale",
    sourceRunId: "run-stale",
    controlId: "4a92d7cf1268fe31",
    command: "rm -rf build",
    request: {
      surface: "tlon",
      approvalDeliveryTarget: target,
      actor: { externalId: "alice@example.com" },
      conversation: { kind: "dm", threadRef: "tlon:account-1:dm:~zod" },
      text: "deploy",
    },
  });
  await reconcileTlonApprovalDeliveries(approvals, deliveries, undefined, {
    runtimeVersions: async () => [{ id: "account-1", version: "version-2" }],
  });
  assert.equal(await approvals.get("stale-approval"), null);
  assert.deepEqual(await deliveries.pending("tlon"), []);
});

test("an unmatched legacy Tlon approval is invalidated instead of blocking forever", async () => {
  const approvals = createMemoryMap<PendingApprovalRecord>();
  const deliveries = createDeliveryStore();
  const { runs } = createMemoryRunStore();
  const target = Buffer.from(
    JSON.stringify({ accountId: "account-1", accountVersion: "version-1", kind: "dm", target: "~zod" }),
  ).toString("base64url");
  await approvals.put("unmatched-approval", {
    sessionId: "s-unmatched",
    createdAt: 1,
    command: "rm -rf build",
    request: {
      surface: "tlon",
      deliveryTarget: target,
      actor: { externalId: "alice@example.com" },
      conversation: { kind: "dm", threadRef: "tlon:account-1:dm:~zod" },
      text: "deploy",
    },
  });
  await reconcileTlonApprovalDeliveries(approvals, deliveries, runs, {
    runtimeVersions: async () => [{ id: "account-1", version: "version-1" }],
  });
  assert.equal(await approvals.get("unmatched-approval"), null);
  assert.deepEqual(await deliveries.pending("tlon"), []);
});

test("a legacy channel approval is invalidated instead of exposing its command to the room", async () => {
  const approvals = createMemoryMap<PendingApprovalRecord>();
  const deliveries = createDeliveryStore();
  const { runs } = createMemoryRunStore();
  const target = Buffer.from(
    JSON.stringify({
      accountId: "account-1",
      accountVersion: "version-1",
      kind: "channel",
      target: "chat/~zod/private",
    }),
  ).toString("base64url");
  const queued = await runs.enqueue({
    sessionId: "s-channel-legacy",
    request: { ...turn("deploy", target), surface: "tlon" },
  });
  const claimed = await runs.claimById(queued.run.id, "worker", 5_000);
  await runs.complete(queued.run.id, claimed!.leaseToken!, {
    status: "pending_approval",
    pendingApprovals: [{ requestId: "channel-approval", command: "rm -rf build", reason: "recursive delete" }],
  });
  await approvals.put("channel-approval", {
    sessionId: "s-channel-legacy",
    createdAt: 1,
    command: "rm -rf build",
    request: {
      surface: "tlon",
      deliveryTarget: target,
      actor: { externalId: "alice@example.com" },
      conversation: { kind: "channel", threadRef: "tlon:channel:private" },
      text: "deploy",
    },
  });
  await reconcileTlonApprovalDeliveries(approvals, deliveries, runs, {
    runtimeVersions: async () => [{ id: "account-1", version: "version-1" }],
  });
  assert.equal(await approvals.get("channel-approval"), null);
  assert.deepEqual(await deliveries.pending("tlon"), []);
});

test("legacy cleanup cannot delete a replacement occurrence written after its snapshot", async () => {
  const backing = createMemoryMap<PendingApprovalRecord>();
  const deliveries = createDeliveryStore();
  const { runs } = createMemoryRunStore();
  const target = Buffer.from(
    JSON.stringify({ accountId: "account-1", accountVersion: "version-1", kind: "dm", target: "~zod" }),
  ).toString("base64url");
  const record = (createdAt: number, idempotencyKey: string): PendingApprovalRecord => ({
    sessionId: "s-replaced",
    createdAt,
    command: "rm -rf build",
    request: {
      surface: "tlon",
      deliveryTarget: target,
      idempotencyKey,
      actor: { externalId: "alice@example.com" },
      conversation: { kind: "dm", threadRef: "tlon:account-1:dm:~zod" },
      text: "deploy",
    },
  });
  const first = record(1, "message-a");
  const replacement = record(2, "message-b");
  await backing.put("reused-approval", first);
  let swapped = false;
  const approvals: DurableMap<PendingApprovalRecord> = {
    ...backing,
    async deleteIf(id, predicate) {
      if (!swapped) {
        swapped = true;
        await backing.put(id, replacement);
      }
      return backing.deleteIf!(id, predicate);
    },
  };
  await reconcileTlonApprovalDeliveries(approvals, deliveries, runs, {
    runtimeVersions: async () => [{ id: "account-1", version: "version-1" }],
  });
  assert.deepEqual(await backing.get("reused-approval"), replacement);
});

test("durable reconciliation cannot hide a later approval from the same run", async () => {
  const approvals = createMemoryMap<PendingApprovalRecord>();
  const deliveries = createDeliveryStore();
  const sourceRunId = "run-multiple";
  const request = {
    surface: "tlon",
    approvalDeliveryTarget: "dm-target",
    approvalDeliveryQueueKey: "tlon:account:version",
    actor: { externalId: "alice@example.com" },
    conversation: { kind: "dm" as const, threadRef: "tlon:account:dm:~zod" },
    text: "deploy",
  };
  for (const requestId of ["approval-a", "approval-b"]) {
    await approvals.put(requestId, {
      sessionId: "s-approval",
      sourceRunId,
      controlId: commandApprovalControlId(sourceRunId, requestId),
      command: `run ${requestId}`,
      reason: "requires approval",
      request,
    });
    await reconcileTlonApprovalDeliveries(approvals, deliveries);
  }
  const prompts = await deliveries.pending("tlon");
  assert.equal(prompts.length, 2);
  assert.deepEqual(prompts.map((prompt) => prompt.destination.approvalRequests?.[0]?.requestId).sort(), [
    "approval-a",
    "approval-b",
  ]);
});

test("approval control ids are stable within a run and unique across occurrences", () => {
  const requestId = "9e45ee0714522db5";
  assert.equal(commandApprovalControlId("run-1", requestId), commandApprovalControlId("run-1", requestId));
  assert.notEqual(commandApprovalControlId("run-1", requestId), commandApprovalControlId("run-2", requestId));
});

test("wired stores: a parked run lands a durable, non-ackable failure note", async () => {
  const { runs } = createMemoryRunStore();
  const deliveries = createDeliveryStore();
  wireRunResultDeliveries(runs, deliveries);

  const parked = (await runs.enqueue({ sessionId: "sP", request: turn("p", "C9:171.001"), maxAttempts: 1 })).run;
  const claimed = await runs.claim("w1", 5_000);
  await runs.fail(parked.id, claimed?.leaseToken ?? "", "boom", { retry: true });
  await new Promise((r) => setTimeout(r, 0));

  const stored = await runs.get(parked.id);
  assert.equal(stored?.status, "failed");
  assert.equal(stored?.result?.status, "failed", "park stores a distinct terminal status, not refused");

  const pending = await deliveries.pending("slack");
  assert.equal(pending.length, 1, "the park enqueues a durable recovery copy");
  assert.equal(pending[0]!.text, "⚠️ I couldn't finish that turn: boom");
  assert.equal(pending[0]!.idempotencyKey, `run:${parked.id}`);
});
