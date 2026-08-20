import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };

function start(): { base: string; built: BuiltApp; close: () => Promise<void> } {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "policy-route-")) }));
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    admin: built.admin,
    auditLog: built.auditLog,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const putPolicy = (base: string, b: unknown) =>
  fetch(`${base}/v1/admin/scopes/org:default-org/command-policy`, {
    method: "PUT",
    headers: ADMIN,
    body: JSON.stringify(b),
  });

function tlonDmTarget(accountId: string, accountVersion: string, ship: string): string {
  return Buffer.from(JSON.stringify({ accountId, accountVersion, kind: "dm", target: ship })).toString("base64url");
}

test("a pending approval survives a surface restart: GET /v1/approvals/:id returns a replayable request", async () => {
  const srv = start();
  try {
    const command = "git push --force origin main";
    const turn = {
      surface: "slack",
      actor: { externalId: "U1", displayName: "Alice" },
      conversation: { kind: "dm", threadRef: "dm:U1:t-approval-recovery" },
      text: `!run ${command}`,
    };
    const first = await fetch(`${srv.base}/v1/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(turn),
    });
    const firstBody = (await first.json()) as {
      status: string;
      pendingApprovals?: { requestId: string; command: string }[];
    };
    assert.equal(firstBody.status, "pending_approval");
    const requestId = firstBody.pendingApprovals?.[0]?.requestId;
    assert.ok(requestId);

    const pendingByThread = await fetch(
      `${srv.base}/v1/approvals/pending?threadRef=${encodeURIComponent(turn.conversation.threadRef)}`,
    );
    assert.equal(pendingByThread.status, 200);
    const pendingBody = (await pendingByThread.json()) as {
      pending?: { status?: string; pendingApprovals?: { requestId?: string }[] } | null;
    };
    assert.equal(pendingBody.pending?.status, "pending_approval");
    assert.equal(pendingBody.pending?.pendingApprovals?.[0]?.requestId, requestId);

    const fetched = await fetch(`${srv.base}/v1/approvals/${requestId}`);
    assert.equal(fetched.status, 200);
    const record = (await fetched.json()) as {
      requestId: string;
      command: string;
      reason?: string;
      request?: {
        actor: { externalId: string };
        conversation: { threadRef: string };
        text: string;
        approval?: unknown;
      };
    };
    assert.equal(record.requestId, requestId);
    assert.equal(record.command, command);
    assert.ok(record.reason);
    assert.equal(record.request?.actor.externalId, "U1");
    assert.equal(record.request?.conversation.threadRef, "dm:U1:t-approval-recovery");
    assert.equal(record.request?.text, `!run ${command}`);
    assert.equal(record.request?.approval, undefined);

    const approved = await fetch(`${srv.base}/v1/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...record.request, approval: { requestId, approved: true } }),
    });
    const approvedBody = (await approved.json()) as { status: string };
    assert.equal(approvedBody.status, "ok");

    const gone = await fetch(`${srv.base}/v1/approvals/${requestId}`);
    assert.equal(gone.status, 404);
    const pendingGone = await fetch(
      `${srv.base}/v1/approvals/pending?threadRef=${encodeURIComponent(turn.conversation.threadRef)}`,
    );
    assert.equal(((await pendingGone.json()) as { pending?: unknown }).pending, null);
  } finally {
    await srv.close();
  }
});

test("a Tlon DM approval prompt resumes the stored turn instead of treating the button text as a new prompt", async () => {
  const srv = start();
  try {
    const command = "git push --force origin main";
    const deliveryTarget = tlonDmTarget("account-u3", "version-u3", "~zod");
    const deliveryQueueKey = "tlon:account-u3:version-u3";
    srv.built.tlonInstallations.runtimeVersions = async () => [{ id: "account-u3", version: "version-u3" }];
    const original = {
      surface: "tlon",
      deliveryTarget,
      approvalDeliveryTarget: deliveryTarget,
      deliveryQueueKey,
      approvalDeliveryQueueKey: deliveryQueueKey,
      actor: { externalId: "U3", displayName: "Carol" },
      conversation: { kind: "dm", threadRef: "tlon:account:dm:~zod", isPrivate: true },
      text: `!run ${command}`,
    };
    const first = await fetch(`${srv.base}/v1/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(original),
    });
    const pending = (await first.json()) as {
      status: string;
      pendingApprovals?: Array<{ requestId: string; controlId: string }>;
    };
    assert.equal(pending.status, "pending_approval");
    const requestId = pending.pendingApprovals?.[0]?.requestId;
    const controlId = pending.pendingApprovals?.[0]?.controlId;
    assert.ok(requestId);
    assert.ok(controlId);
    await new Promise((resolve) => setImmediate(resolve));
    const prompts = await srv.built.deliveries.pending("tlon");
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0]?.destination.target, deliveryTarget);
    assert.equal(prompts[0]?.destination.approvalRequests?.[0]?.requestId, requestId);
    assert.equal(prompts[0]?.destination.approvalRequests?.[0]?.controlId, controlId);
    const storedApproval = await srv.built.app.getApproval(requestId);
    assert.ok(storedApproval?.sourceRunId);
    assert.equal(prompts[0]?.idempotencyKey, `approval:${storedApproval.sourceRunId}:${storedApproval.controlId}`);

    const approved = await fetch(`${srv.base}/v1/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...original,
        text: `/qm approve ${requestId}:${controlId} once`,
        approval: { requestId, controlId, approved: true, scope: "once" },
        idempotencyKey: "tlon:account:version:approval-message",
      }),
    });
    const result = (await approved.json()) as { status: string };
    assert.equal(result.status, "ok");
    assert.equal(await srv.built.app.getApproval(requestId), null);
  } finally {
    await srv.close();
  }
});

test("an old Tlon approval card cannot resolve a later occurrence of the same command", async () => {
  const srv = start();
  try {
    const deliveryTarget = tlonDmTarget("account-u4", "version-u4", "~nec");
    srv.built.tlonInstallations.runtimeVersions = async () => [{ id: "account-u4", version: "version-u4" }];
    const original = {
      surface: "tlon",
      deliveryTarget,
      approvalDeliveryTarget: deliveryTarget,
      deliveryQueueKey: "tlon:account-u4:version-u4",
      approvalDeliveryQueueKey: "tlon:account-u4:version-u4",
      actor: { externalId: "U4", displayName: "Dana" },
      conversation: { kind: "dm", threadRef: "tlon:account:dm:~nec", isPrivate: true },
      text: "!run git push --force origin main",
    };
    const request = async (body: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
      const response = await fetch(`${srv.base}/v1/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    const first = await request(original);
    const firstApproval = (first.body.pendingApprovals as Array<{ requestId: string; controlId: string }>)[0]!;
    const denied = await request({
      ...original,
      text: `/qm deny ${firstApproval.requestId}:${firstApproval.controlId}`,
      approval: { ...firstApproval, approved: false },
    });
    assert.equal(denied.status, 403);

    const second = await request(original);
    const secondApproval = (second.body.pendingApprovals as Array<{ requestId: string; controlId: string }>)[0]!;
    assert.equal(secondApproval.requestId, firstApproval.requestId);
    assert.notEqual(secondApproval.controlId, firstApproval.controlId);

    const stale = await request({
      ...original,
      text: `/qm approve ${firstApproval.requestId}:${firstApproval.controlId} always`,
      approval: { ...firstApproval, approved: true, scope: "always" },
    });
    assert.equal(stale.status, 403);
    assert.equal(stale.body.refusalCode, "stale_approval");
    const current = await srv.built.app.getApproval(secondApproval.requestId);
    assert.equal(current?.controlId, secondApproval.controlId);
  } finally {
    await srv.close();
  }
});

test("GET /v1/sessions/:id/approvals lists the commands the session is still paused on", async () => {
  const srv = start();
  try {
    const command = "git push --force origin main";
    const turn = {
      surface: "slack",
      actor: { externalId: "U2", displayName: "Bob" },
      conversation: { kind: "dm", threadRef: "dm:U2:t-approvals-list" },
      text: `!run ${command}`,
    };
    const first = await fetch(`${srv.base}/v1/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(turn),
    });
    const firstBody = (await first.json()) as {
      status: string;
      sessionId: string;
      pendingApprovals?: { requestId: string }[];
    };
    assert.equal(firstBody.status, "pending_approval");
    const requestId = firstBody.pendingApprovals?.[0]?.requestId;
    assert.ok(requestId);

    const listed = await fetch(
      `${srv.base}/v1/sessions/${encodeURIComponent(firstBody.sessionId)}/approvals?viewer=U2`,
    );
    assert.equal(listed.status, 200);
    const body = (await listed.json()) as { approvals: { requestId: string; command: string; reason: string }[] };
    assert.equal(body.approvals.length, 1);
    assert.equal(body.approvals[0]?.requestId, requestId);
    assert.equal(body.approvals[0]?.command, command);
    assert.ok(body.approvals[0]?.reason);

    const otherViewer = await fetch(
      `${srv.base}/v1/sessions/${encodeURIComponent(firstBody.sessionId)}/approvals?viewer=U999`,
    );
    assert.equal(otherViewer.status, 200);
    assert.deepEqual(((await otherViewer.json()) as { approvals: unknown[] }).approvals, []);

    const noViewer = await fetch(`${srv.base}/v1/sessions/${encodeURIComponent(firstBody.sessionId)}/approvals`);
    assert.equal(noViewer.status, 400);

    const empty = await fetch(`${srv.base}/v1/sessions/some-other-session/approvals?viewer=U2`);
    assert.equal(empty.status, 200);
    assert.deepEqual(((await empty.json()) as { approvals: unknown[] }).approvals, []);
  } finally {
    await srv.close();
  }
});

test("admin command-policy write validates the body and rejects invalid regexes", async () => {
  const srv = start();
  try {
    const ok = await putPolicy(srv.base, {
      mode: "denylist",
      rules: [{ pattern: "^curl\\b", decision: "require_approval", reason: "network" }],
    });
    assert.equal(ok.status, 200);

    const badRegex = await putPolicy(srv.base, {
      mode: "denylist",
      rules: [{ pattern: "(", decision: "deny" }],
    });
    assert.equal(badRegex.status, 400);
    const body = (await badRegex.json()) as { message: string };
    assert.match(body.message, /not a valid regex/);

    const badMode = await putPolicy(srv.base, { mode: "blocklist", rules: [] });
    assert.equal(badMode.status, 400);

    const badShape = await putPolicy(srv.base, { mode: "denylist" });
    assert.equal(badShape.status, 400);
  } finally {
    await srv.close();
  }
});
