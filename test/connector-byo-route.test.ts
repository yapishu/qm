import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { TEST_CAPABILITY_SECRET, testConfig } from "./support/test-config.ts";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../plugins/chassis/src/portal-identity.ts";
import { CAPABILITY_HEADER } from "../plugins/chassis/src/core-client.ts";
import { encodeDeliveryTarget } from "../plugins/tlon/src/target.ts";
import { createTlonInstallationStore, tlonChannelRef } from "../src/surfaces/tlon-installation.ts";
import { scopeId } from "../src/types.ts";
import { mintCapabilityToken } from "../src/auth/capability-token.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { createIdentityService, type DeactivationRecord } from "../src/identity/identity-service.ts";

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };
const PORTAL_SECRET = "tlon-user-connections-portal-secret";
const userHeaders = (principalId: string) => ({
  "content-type": "application/json",
  [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: principalId, exp: Date.now() + 60_000 }, PORTAL_SECRET),
});

function start(
  socketAppId = "A-ACME",
  requireSignedPortalIdentity = false,
): { base: string; built: BuiltApp; close: () => Promise<void> } {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "byo-route-")) }));
  const server = createInsecureTestServer(built.app, {
    oauthStateSecret: "byo-route-oauth-state-secret",
    replayDedupe: built.replayDedupe,
    connectorTokens: built.connectorTokens,
    slackInstallation: built.slackInstallation,
    tlonInstallations: built.tlonInstallations,
    portalIdentitySecret: PORTAL_SECRET,
    slackInstallationFetch: (async (input: string | URL | Request) => {
      const url = String(input);
      return new Response(
        JSON.stringify(
          url.endsWith("/auth.test")
            ? { ok: true, team_id: "T-ACME", team: "Acme", app_id: "A-ACME" }
            : { ok: true, url: "wss://example.invalid" },
        ),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch,
    slackInstallationSocketAppId: async () => socketAppId,
    resolveClient: built.resolveClient,
    config: built.config,
    admin: built.admin,
    auditLog: built.auditLog,
    runs: built.runs,
    runActivity: built.runActivity,
    requireSignedPortalIdentity,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function verifyTlonOwner(
  built: BuiltApp,
  connection: {
    id: string;
    version: string;
    ownerShip: string;
    ownerVerificationCode?: string;
  },
  principalId: string,
): Promise<void> {
  assert.ok(connection.ownerVerificationCode);
  await built.tlonInstallations.enqueueInbound({
    accountId: connection.id,
    installationVersion: connection.version,
    principalId,
    messageId: `verify-${connection.id}-${connection.version}`,
    senderShip: connection.ownerShip,
    text: `/qm-link ${connection.ownerVerificationCode}`,
    kind: "dm",
    target: connection.ownerShip,
  });
}

const putConnector = (base: string, b: object) =>
  fetch(`${base}/v1/admin/scopes/org:default-org/connectors`, {
    method: "PUT",
    headers: ADMIN,
    body: JSON.stringify(b),
  });

test("the slack-installation createUrl adopts the live branding label", async () => {
  const srv = start();
  try {
    const nameFrom = async (): Promise<string> => {
      const r = (await (await fetch(`${srv.base}/v1/admin/slack-installation`, { headers: ADMIN })).json()) as {
        createUrl: string;
      };
      const manifest = JSON.parse(new URL(r.createUrl).searchParams.get("manifest_json") ?? "{}") as {
        display_information?: { name?: string };
      };
      return manifest.display_information?.name ?? "";
    };
    assert.equal(await nameFrom(), "qm");
    assert.equal(
      (
        await fetch(`${srv.base}/v1/admin/scopes/org:default-org/branding`, {
          method: "PUT",
          headers: ADMIN,
          body: JSON.stringify({ selfLabel: "straylight" }),
        })
      ).status,
      200,
    );
    assert.equal(await nameFrom(), "straylight");
  } finally {
    await srv.close();
  }
});

test("admin registers a BYO client → /start uses it; the secret is never echoed", async () => {
  const srv = start();
  try {
    const redirectUri = `${srv.base}/v1/connectors/oauth/google/callback`;
    const startPath = `/v1/connectors/oauth/google/start?principalId=U1&redirectUri=${encodeURIComponent(redirectUri)}`;

    assert.equal((await fetch(`${srv.base}${startPath}`)).status, 501);

    const putRes = await putConnector(srv.base, {
      provider: "google",
      clientId: "byo-cid",
      clientSecret: "byo-super-secret",
      redirectAllowlist: [redirectUri],
    });
    assert.equal(putRes.status, 200);

    const denied = await fetch(`${srv.base}/v1/admin/scopes/org:default-org/connectors`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-admin-actor": "nobody@default-org" },
      body: JSON.stringify({ provider: "google", clientId: "x", clientSecret: "y" }),
    });
    assert.equal(denied.status, 403);

    const startRes = await fetch(`${srv.base}${startPath}`);
    assert.equal(startRes.status, 200);
    const body = (await startRes.json()) as { authorizeUrl: string };
    assert.equal(new URL(body.authorizeUrl).searchParams.get("client_id"), "byo-cid");

    const cfg = (await (await fetch(`${srv.base}/v1/admin/scopes/org:default-org`, { headers: ADMIN })).json()) as {
      connectors: Array<{ provider: string; clientId: string; hasSecret: boolean }>;
    };
    const google = cfg.connectors.find((c) => c.provider === "google");
    assert.equal(google?.clientId, "byo-cid");
    assert.equal(google?.hasSecret, true);
    assert.doesNotMatch(JSON.stringify(cfg), /byo-super-secret/);

    const badPath = `/v1/connectors/oauth/google/start?principalId=U1&redirectUri=${encodeURIComponent("https://evil/cb")}`;
    const bad = await fetch(`${srv.base}${badPath}`);
    assert.equal(bad.status, 400);
    assert.match(await bad.text(), /redirect_not_allowed/);
  } finally {
    await srv.close();
  }
});

test("admin stores validated Slack tokens without ever returning them", async () => {
  const srv = start();
  try {
    const put = await fetch(`${srv.base}/v1/admin/slack-installation`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ botToken: "xoxb-super-secret", appToken: "xapp-super-secret" }),
    });
    assert.equal(put.status, 200);
    const putBody = await put.text();
    assert.doesNotMatch(putBody, /xoxb|xapp|super-secret/);
    assert.match(putBody, /T-ACME/);

    const status = await fetch(`${srv.base}/v1/admin/slack-installation`, { headers: ADMIN });
    assert.equal(status.status, 200);
    const statusText = await status.text();
    assert.doesNotMatch(statusText, /xoxb|xapp|super-secret/);
    const createUrl = new URL((JSON.parse(statusText) as { createUrl: string }).createUrl);
    assert.equal(createUrl.searchParams.get("new_app"), "1");
    assert.equal(JSON.parse(createUrl.searchParams.get("manifest_json")!).display_information.name, "qm");
    assert.equal((await srv.built.slackInstallation.get())?.botToken, "xoxb-super-secret");

    const del = await fetch(`${srv.base}/v1/admin/slack-installation`, { method: "DELETE", headers: ADMIN });
    assert.equal(del.status, 200);
    assert.equal(await srv.built.slackInstallation.get(), null);
  } finally {
    await srv.close();
  }
});

test("admin rejects Slack bot and Socket Mode tokens from different apps", async () => {
  const srv = start("A-OTHER");
  try {
    const put = await fetch(`${srv.base}/v1/admin/slack-installation`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ botToken: "xoxb-super-secret", appToken: "xapp-super-secret" }),
    });
    assert.equal(put.status, 400);
    assert.match(await put.text(), /different Slack apps/);
    assert.equal(await srv.built.slackInstallation.get(), null);
  } finally {
    await srv.close();
  }
});

test("signed-in users manage only their own encrypted Tlon connections", async () => {
  const srv = start("A-ACME", true);
  try {
    const alice = userHeaders("alice@example.com");
    const bob = userHeaders("bob@example.com");
    const connectionInput = {
      ship: "~sampel-palnet",
      url: "https://sampel-palnet.tlon.network",
      code: "lidlut-tabwed-pillex-ridrup",
      ownerShip: "~zod",
      channels: ["chat/~sampel-palnet/general"],
    };
    const create = await fetch(`${srv.base}/v1/tlon/connections`, {
      method: "POST",
      headers: alice,
      body: JSON.stringify(connectionInput),
    });
    const createText = await create.text();
    assert.equal(create.status, 201, createText);
    const created = JSON.parse(createText) as {
      connection: { id: string; ownerVerified: boolean; ownerVerificationCode?: string };
    };
    const id = created.connection.id;
    assert.equal(created.connection.ownerVerified, false);
    assert.match(created.connection.ownerVerificationCode ?? "", /^[0-9A-F]{12}$/);
    const capability = await mintCapabilityToken(
      {
        actorId: "alice@example.com",
        scopeId: "personal:alice@example.com",
        exp: Date.now() + 60_000,
      },
      TEST_CAPABILITY_SECRET,
    );
    assert.equal(
      (
        await fetch(`${srv.base}/v1/tlon/connections/${id}`, {
          method: "PUT",
          headers: { "content-type": "application/json", [CAPABILITY_HEADER]: capability },
          body: JSON.stringify({ ...connectionInput, url: "https://attacker.example.com", code: "" }),
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(`${srv.base}/v1/tlon/connections`, {
          method: "POST",
          headers: alice,
          body: JSON.stringify(connectionInput),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(`${srv.base}/v1/tlon/connections`, {
          method: "POST",
          headers: alice,
          body: JSON.stringify({
            ship: "~nec",
            url: "https://many.example.com",
            code: "too-many",
            ownerShip: "~bus",
            channels: Array.from({ length: 101 }, (_value, index) => `chat/~nec/channel-${index}`),
          }),
        })
      ).status,
      400,
    );

    const response = await fetch(`${srv.base}/v1/tlon/connections`, { headers: alice });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.doesNotMatch(text, /lidlut/);
    assert.deepEqual(
      (JSON.parse(text) as { connections: Array<{ id: string }> }).connections.map((record) => record.id),
      [id],
    );
    assert.deepEqual(
      ((await (await fetch(`${srv.base}/v1/tlon/connections`, { headers: bob })).json()) as { connections: unknown[] })
        .connections,
      [],
    );
    assert.equal((await fetch(`${srv.base}/v1/tlon/connections`)).status, 401);
    assert.equal(
      (
        await fetch(`${srv.base}/v1/tlon/connections`, {
          method: "POST",
          headers: alice,
          body: JSON.stringify({
            ship: "~nec",
            url: "http://127.0.0.1:8080",
            code: "unsafe",
            ownerShip: "~zod",
          }),
        })
      ).status,
      400,
    );

    const runtime = await srv.built.tlonInstallations.runtime();
    assert.equal(runtime[0]?.code, "lidlut-tabwed-pillex-ridrup");
    assert.equal(runtime[0]?.principalId, "alice@example.com");
    const oldVersion = runtime[0]!.version;
    await srv.built.tlonInstallations.enqueueInbound({
      accountId: id,
      installationVersion: oldVersion,
      principalId: "alice@example.com",
      messageId: "wrong-owner-proof",
      senderShip: "~zod",
      text: "/qm-link WRONG",
      kind: "dm",
      target: "~zod",
    });
    await verifyTlonOwner(srv.built, runtime[0]!, "alice@example.com");
    assert.equal((await srv.built.tlonInstallations.list("alice@example.com"))[0]?.ownerVerified, true);
    const lease = await fetch(`${srv.base}/v1/tlon/installations/${id}/lease`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: oldVersion }),
    });
    const leaseBody = (await lease.json()) as { token: string };
    assert.equal(lease.status, 200);
    assert.equal(
      (await fetch(`${srv.base}/v1/tlon/connections/${id}`, { method: "DELETE", headers: alice })).status,
      409,
    );
    assert.equal(
      (
        await fetch(`${srv.base}/v1/tlon/installations/${id}/release`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ version: oldVersion, token: leaseBody.token }),
        })
      ).status,
      200,
    );
    const sourceResponse = await fetch(`${srv.base}/v1/tlon/installations`);
    assert.equal(sourceResponse.status, 200);
    const sourceRecords = (await sourceResponse.json()) as {
      installations: Array<{ principalId: string; code: string }>;
    };
    assert.equal(sourceRecords.installations[0]?.principalId, "alice@example.com");
    const statusReport = await fetch(`${srv.base}/v1/tlon/installations/${id}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: oldVersion,
        status: "connected",
        verifiedChannels: ["chat/~sampel-palnet/general"],
      }),
    });
    assert.equal(statusReport.status, 200, await statusReport.text());
    assert.equal((await srv.built.tlonInstallations.list("alice@example.com"))[0]?.runtimeStatus, "connected");
    assert.equal(
      await srv.built.tlonInstallations.membership(tlonChannelRef("chat/~sampel-palnet/general"), "alice@example.com"),
      true,
    );

    const inboundMessage = {
      accountId: id,
      installationVersion: oldVersion,
      principalId: "alice@example.com",
      messageId: "ship-event-1",
      senderShip: "~zod",
      text: "look at this",
      content: [{ inline: ["look at this"] }],
      kind: "dm",
      target: "~zod",
    };
    const enqueue = async (body: object) =>
      await fetch(`${srv.base}/v1/tlon/inbound`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const firstReceipt = (await (await enqueue({ message: inboundMessage })).json()) as { id: string };
    const duplicateReceipt = (await (await enqueue({ message: inboundMessage })).json()) as { id: string };
    assert.equal(duplicateReceipt.id, firstReceipt.id);
    const secondMessage = { ...inboundMessage, messageId: "ship-event-2" };
    const secondReceipt = (await (await enqueue({ message: secondMessage, previousId: firstReceipt.id })).json()) as {
      id: string;
    };
    assert.equal((await enqueue({ message: { ...inboundMessage, principalId: "bob@example.com" } })).status, 404);
    const claimed = (await (await fetch(`${srv.base}/v1/tlon/inbound?claimMs=60000`)).json()) as {
      records: Array<{ id: string; claimToken: string; message: typeof inboundMessage }>;
    };
    assert.equal(claimed.records.length, 1);
    assert.deepEqual(claimed.records[0]?.message, inboundMessage);
    assert.equal(
      (
        await fetch(`${srv.base}/v1/tlon/inbound/${encodeURIComponent(firstReceipt.id)}/ack`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ claimToken: "wrong-lease" }),
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await fetch(`${srv.base}/v1/tlon/inbound/${encodeURIComponent(firstReceipt.id)}/ack`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ claimToken: claimed.records[0]!.claimToken }),
        })
      ).status,
      200,
    );
    const secondClaim = (await (await fetch(`${srv.base}/v1/tlon/inbound?claimMs=60000`)).json()) as {
      records: Array<{ id: string; claimToken: string; message: typeof secondMessage }>;
    };
    assert.equal(secondClaim.records[0]?.id, secondReceipt.id);
    assert.equal(
      (
        await fetch(`${srv.base}/v1/tlon/inbound/${encodeURIComponent(secondReceipt.id)}/ack`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ claimToken: secondClaim.records[0]!.claimToken }),
        })
      ).status,
      200,
    );
    assert.deepEqual(await (await fetch(`${srv.base}/v1/tlon/inbound?claimMs=60000`)).json(), { records: [] });

    const queued = await srv.built.app.turn({
      surface: "tlon",
      deliveryTarget: encodeDeliveryTarget({ accountId: id, accountVersion: oldVersion, kind: "dm", target: "~zod" }),
      actor: { externalId: "alice@example.com", displayName: "~zod" },
      conversation: { kind: "dm", threadRef: `tlon:${id}:dm:~zod`, isPrivate: true },
      text: "check this",
      idempotencyKey: "tlon:presence-test",
      async: true,
    });
    assert.equal(queued.status, "queued");
    await srv.built.runActivity.append(queued.runId!, {
      seq: 1,
      parentSeq: null,
      type: "thinking",
      payload: { thinking: "private chain of thought" },
      createdAt: Date.now(),
    });
    await srv.built.runActivity.append(queued.runId!, {
      seq: 2,
      parentSeq: 1,
      type: "tool_call",
      payload: { tool: "mcp_private_service", callId: "private-call", command: "secret command" },
      createdAt: Date.now(),
    });
    const presence = await fetch(`${srv.base}/v1/tlon/presence/runs`);
    const presenceText = await presence.text();
    assert.equal(presence.status, 200, presenceText);
    assert.deepEqual(JSON.parse(presenceText), {
      runs: [
        {
          runId: queued.runId,
          accountId: id,
          accountVersion: oldVersion,
          conversationId: "~zod",
          status: "pending",
          activeTools: ["tool"],
        },
      ],
    });
    assert.doesNotMatch(presenceText, /private|secret|command|thinking|call/);
    assert.deepEqual(await (await fetch(`${srv.base}/v1/tlon/presence/runs/${id}/${queued.runId}`)).json(), {
      runId: queued.runId,
      accountId: id,
      accountVersion: oldVersion,
      conversationId: "~zod",
      status: "pending",
      activeTools: ["tool"],
    });
    assert.equal((await fetch(`${srv.base}/v1/runs/${queued.runId}`)).status, 401);
    const other = await srv.built.tlonInstallations.create("alice@example.com", {
      ship: "~nec",
      url: "https://other.example.com",
      code: "other-code",
      ownerShip: "~zod",
    });
    assert.equal((await fetch(`${srv.base}/v1/tlon/presence/runs/${other.id}/${queued.runId}`)).status, 404);
    assert.equal(await srv.built.tlonInstallations.delete("alice@example.com", other.id), true);

    const deniedEdit = await fetch(`${srv.base}/v1/tlon/connections/${id}`, {
      method: "PUT",
      headers: bob,
      body: JSON.stringify({
        ship: "~sampel-palnet",
        url: "https://support.example.com",
        code: "",
        ownerShip: "~zod",
      }),
    });
    assert.equal(deniedEdit.status, 404);
    const edit = await fetch(`${srv.base}/v1/tlon/connections/${id}`, {
      method: "PUT",
      headers: alice,
      body: JSON.stringify({
        ship: "~sampel-palnet",
        url: "https://new-support.example.com",
        code: "",
        ownerShip: "~zod",
      }),
    });
    assert.equal(edit.status, 200, await edit.text());
    assert.equal((await srv.built.tlonInstallations.runtime())[0]?.code, "lidlut-tabwed-pillex-ridrup");
    assert.equal(await srv.built.tlonInstallations.report(id, { version: oldVersion, status: "connected" }), false);

    assert.equal(
      (await fetch(`${srv.base}/v1/tlon/connections/${id}`, { method: "DELETE", headers: bob })).status,
      404,
    );
    assert.equal(
      (await enqueue({ message: { ...inboundMessage, messageId: "stale-event-before-delete" } })).status,
      404,
    );
    const currentVersion = (await srv.built.tlonInstallations.runtime())[0]!.version;
    assert.equal(
      (
        await enqueue({
          message: {
            ...inboundMessage,
            installationVersion: currentVersion,
            messageId: "ship-event-before-delete",
          },
        })
      ).status,
      202,
    );
    const del = await fetch(`${srv.base}/v1/tlon/connections/${id}`, { method: "DELETE", headers: alice });
    assert.equal(del.status, 200);
    assert.deepEqual(await srv.built.tlonInstallations.list("alice@example.com"), []);
    assert.deepEqual(await (await fetch(`${srv.base}/v1/tlon/inbound?claimMs=60000`)).json(), { records: [] });
  } finally {
    await srv.close();
  }
});

test("configured Tlon channel members share one durable QM context", async () => {
  const srv = start("A-ACME", true);
  try {
    const channel = "chat/~sampel-palnet/General";
    const channelRef = tlonChannelRef(channel);
    const alice = await srv.built.tlonInstallations.create("alice@example.com", {
      ship: "~sampel-palnet",
      url: "https://sampel-palnet.tlon.network",
      code: "alice-code",
      ownerShip: "~zod",
      channels: [channel],
    });
    const bob = await srv.built.tlonInstallations.create("bob@example.com", {
      ship: "~nec",
      url: "https://nec.tlon.network",
      code: "bob-code",
      ownerShip: "~bus",
      channels: [channel],
    });
    const backup = await srv.built.tlonInstallations.create("alice@example.com", {
      ship: "~marzod",
      url: "https://marzod.tlon.network",
      code: "alice-backup-code",
      ownerShip: "~zod",
      channels: [channel],
    });
    await verifyTlonOwner(srv.built, alice, "alice@example.com");
    await verifyTlonOwner(srv.built, bob, "bob@example.com");
    await verifyTlonOwner(srv.built, backup, "alice@example.com");

    assert.equal(srv.built.tlonInstallations.recognizes(channelRef), true);
    assert.deepEqual(await srv.built.tlonInstallations.channelMembers(channelRef), []);
    assert.equal(await srv.built.tlonInstallations.membership(channelRef, "alice@example.com"), false);
    await srv.built.tlonInstallations.report(alice.id, {
      version: alice.version,
      status: "connected",
      verifiedChannels: [channel],
    });
    await srv.built.tlonInstallations.report(bob.id, {
      version: bob.version,
      status: "connected",
      verifiedChannels: [channel],
    });
    await srv.built.tlonInstallations.report(backup.id, {
      version: backup.version,
      status: "connected",
      verifiedChannels: [channel],
    });
    assert.deepEqual(await srv.built.tlonInstallations.channelMembers(channelRef), [
      { principalId: "alice@example.com", displayName: "~zod" },
      { principalId: "bob@example.com", displayName: "~bus" },
    ]);
    assert.equal(await srv.built.tlonInstallations.membership(channelRef, "alice@example.com"), true);
    assert.equal(await srv.built.tlonInstallations.membership(channelRef, "carol@example.com"), false);
    const firstRosterVersion = await srv.built.tlonInstallations.version(channelRef);
    const scopeUrl = new URL(`${srv.base}/v1/tlon/channel-scope`);
    scopeUrl.searchParams.set("channel", channel);
    scopeUrl.searchParams.set("scopeVersion", firstRosterVersion!);
    assert.deepEqual(await (await fetch(scopeUrl)).json(), { current: true });
    scopeUrl.searchParams.set("scopeVersion", "stale");
    assert.deepEqual(await (await fetch(scopeUrl)).json(), { current: false });
    assert.equal(
      await srv.built.app.authorizesCapabilityScope({
        actorId: "alice@example.com",
        scopeId: scopeId("channel", channelRef),
        scopeVersion: "stale",
      }),
      false,
    );
    assert.equal(
      await srv.built.app.authorizesCapabilityScope({
        actorId: "alice@example.com",
        scopeId: scopeId("channel", channelRef),
        scopeVersion: firstRosterVersion,
      }),
      true,
    );
    await srv.built.tlonInstallations.report(alice.id, {
      version: alice.version,
      status: "connected",
      verifiedChannels: [],
    });
    await srv.built.tlonInstallations.report(alice.id, {
      version: alice.version,
      status: "connected",
      verifiedChannels: [channel],
    });
    assert.notEqual(await srv.built.tlonInstallations.version(channelRef), firstRosterVersion);
    const beforeDeactivation = await srv.built.tlonInstallations.version(channelRef);
    await srv.built.identity.deactivate("bob@example.com");
    assert.deepEqual(await srv.built.tlonInstallations.members(channelRef), ["alice@example.com"]);
    const afterDeactivation = await srv.built.tlonInstallations.version(channelRef);
    assert.notEqual(afterDeactivation, beforeDeactivation);
    await srv.built.identity.reactivate("bob@example.com");
    assert.deepEqual(await srv.built.tlonInstallations.members(channelRef), ["alice@example.com", "bob@example.com"]);
    assert.notEqual(await srv.built.tlonInstallations.version(channelRef), beforeDeactivation);
    assert.deepEqual(await srv.built.tlonInstallations.channelsFor("bob@example.com"), [
      { channelId: channelRef, name: "General", isPrivate: true },
    ]);

    const deliveryQueueKey = `tlon:channel:${encodeURIComponent(channel)}`;
    const direct = await srv.built.app.turn({
      surface: "tlon",
      deliveryTarget: encodeDeliveryTarget({
        accountId: alice.id,
        accountVersion: alice.version,
        kind: "channel",
        target: channel,
      }),
      deliveryQueueKey,
      actor: { externalId: "alice@example.com", displayName: "~zod" },
      conversation: {
        kind: "channel",
        channelRef,
        channelName: "General",
        threadRef: deliveryQueueKey,
      },
      text: "Post this to the shared room",
      idempotencyKey: "tlon:shared-room:direct",
    });
    assert.equal(direct.status, "ok");
    assert.equal((await srv.built.deliveries.pending("tlon")).at(-1)?.destination.queueKey, deliveryQueueKey);

    const queued = await srv.built.app.turn({
      surface: "tlon",
      deliveryTarget: encodeDeliveryTarget({
        accountId: alice.id,
        accountVersion: alice.version,
        kind: "channel",
        target: channel,
      }),
      deliveryQueueKey,
      actor: { externalId: "alice@example.com", displayName: "~zod" },
      conversation: {
        kind: "channel",
        channelRef,
        channelName: "General",
        threadRef: deliveryQueueKey,
      },
      text: "What did we decide?",
      idempotencyKey: "tlon:shared-room:alice",
      async: true,
    });
    assert.equal(queued.status, "queued");
    const currentPresence = (await (
      await fetch(`${srv.base}/v1/tlon/presence/runs/${alice.id}/${queued.runId}`)
    ).json()) as { scopeVersion?: string };
    assert.equal(currentPresence.scopeVersion, await srv.built.tlonInstallations.version(channelRef));
    await srv.built.identity.deactivate("bob@example.com");
    assert.equal((await fetch(`${srv.base}/v1/tlon/presence/runs/${alice.id}/${queued.runId}`)).status, 409);
    await srv.built.identity.reactivate("bob@example.com");
    assert.deepEqual(await srv.built.tlonInstallations.members(channelRef), ["alice@example.com", "bob@example.com"]);
    const run = await srv.built.runs.get(queued.runId!);
    assert.deepEqual(
      run?.request.conversation.audience.map((member) => ({ id: member.id, displayName: member.displayName })),
      [
        { id: "alice@example.com", displayName: "~zod" },
        { id: "bob@example.com", displayName: "~bus" },
      ],
    );
    assert.deepEqual(run?.request.sessionParticipantIds, ["alice@example.com", "bob@example.com"]);
    assert.equal(run?.request.conversation.isPrivate, true);

    const webQueued = await srv.built.app.turn({
      surface: "web",
      actor: { externalId: "bob@example.com", displayName: "Bob" },
      conversation: {
        kind: "channel",
        channelRef,
        channelName: "General",
        threadRef: `web:bob@example.com:${crypto.randomUUID()}`,
        publishMembers: [{ externalId: "carol@example.com" }],
      },
      text: "Continue this from the web",
      idempotencyKey: "tlon:shared-room:web",
      async: true,
    });
    assert.equal(webQueued.status, "queued");
    assert.deepEqual(
      (await srv.built.runs.get(webQueued.runId!))?.request.conversation.publishMembers?.map((member) => member.id),
      ["alice@example.com", "bob@example.com"],
    );

    const foreignThread = `web:bob@example.com:${crypto.randomUUID()}`;
    const foreignScope = scopeId("channel", tlonChannelRef("chat/~sampel-palnet/Foreign"));
    const foreignSession = await srv.built.sessions.getOrCreateByThread(
      foreignThread,
      "channel",
      foreignScope,
      "Foreign",
      "web",
    );
    const crossChannel = await srv.built.app.turn({
      surface: "web",
      actor: { externalId: "bob@example.com", displayName: "Bob" },
      conversation: {
        kind: "channel",
        channelRef,
        channelName: "General",
        threadRef: foreignThread,
      },
      text: "Do not cross channel boundaries",
      idempotencyKey: "tlon:shared-room:cross-channel",
      async: true,
    });
    assert.equal(crossChannel.status, "refused");
    assert.equal((await srv.built.sessions.get(foreignSession.id))?.scopeId, foreignScope);

    const unopenedForeignTimeline = `tlon:channel:${encodeURIComponent("chat/~sampel-palnet/Unopened")}`;
    const squatting = await srv.built.app.turn({
      surface: "web",
      actor: { externalId: "bob@example.com", displayName: "Bob" },
      conversation: {
        kind: "channel",
        channelRef,
        channelName: "General",
        threadRef: unopenedForeignTimeline,
      },
      text: "Do not preclaim another channel timeline",
      idempotencyKey: "tlon:shared-room:timeline-squat",
      async: true,
    });
    assert.equal(squatting.status, "refused");
    assert.equal(await srv.built.sessions.getByThread(unopenedForeignTimeline), null);

    const foreignReply = `${deliveryQueueKey}:thread:foreign-scope`;
    await srv.built.sessions.getOrCreateByThread(foreignReply, "channel", foreignScope, "Foreign", "tlon");
    const nativeCrossChannel = await srv.built.app.turn({
      surface: "tlon",
      actor: { externalId: "alice@example.com", displayName: "~zod" },
      conversation: {
        kind: "channel",
        channelRef,
        channelName: "General",
        threadRef: foreignReply,
      },
      text: "Do not reuse another channel session",
      idempotencyKey: "tlon:shared-room:native-cross-channel",
      async: true,
    });
    assert.equal(nativeCrossChannel.status, "refused");

    const sharedScope = scopeId("channel", channelRef);
    assert.equal(await srv.built.app.belongsToScope("alice@example.com", sharedScope), true);
    assert.equal(await srv.built.app.belongsToScope("bob@example.com", sharedScope), true);
    assert.equal(await srv.built.app.belongsToScope("carol@example.com", sharedScope), false);
    assert.equal(await srv.built.app.membershipControlsScope(sharedScope), true);
    assert.ok(await srv.built.app.listScopeResources("bob@example.com", sharedScope));
    assert.equal(await srv.built.app.listScopeResources("carol@example.com", sharedScope), null);
    const spawned = await srv.built.app.spawnSession("bob@example.com", {
      scopeId: sharedScope,
      title: "Shared room plan",
    });
    assert.ok(spawned);
    assert.deepEqual(await srv.built.sessions.participantsOf(spawned.session.id), [
      "alice@example.com",
      "bob@example.com",
    ]);
    assert.deepEqual(
      (await srv.built.app.listContexts("bob@example.com"))
        .filter((context) => context.scopeId === sharedScope)
        .map((context) => ({ name: context.name, isPrivate: context.isPrivate })),
      [{ name: "General", isPrivate: true }],
    );

    const refused = await srv.built.app.turn({
      surface: "tlon",
      actor: { externalId: "carol@example.com", displayName: "~marzod" },
      conversation: { kind: "channel", channelRef, threadRef: `tlon:channel:${encodeURIComponent(channel)}` },
      text: "Let me in",
      idempotencyKey: "tlon:shared-room:carol",
      async: true,
    });
    assert.equal(refused.status, "refused");

    const wrongThread = await srv.built.app.turn({
      surface: "tlon",
      actor: { externalId: "alice@example.com", displayName: "~zod" },
      conversation: { kind: "channel", channelRef, threadRef: "tlon:channel:another-room" },
      text: "Cross the streams",
      idempotencyKey: "tlon:shared-room:wrong-thread",
      async: true,
    });
    assert.equal(wrongThread.status, "refused");

    const tenureThread = `tlon:channel:${encodeURIComponent(channel)}:thread:tenure`;
    const tenure = await srv.built.sessions.getOrCreateByThread(
      tenureThread,
      "channel",
      sharedScope,
      "General",
      "tlon",
    );
    await srv.built.sessions.addParticipant(tenure.id, "alice@example.com");
    await srv.built.sessions.addParticipant(tenure.id, "bob@example.com");
    const removed = await srv.built.tlonInstallations.update("bob@example.com", bob.id, {
      ship: "~nec",
      url: "https://nec.tlon.network",
      code: "",
      ownerShip: "~bus",
      channels: [],
    });
    assert.ok(removed);
    assert.equal(await srv.built.app.belongsToScope("bob@example.com", sharedScope), false);
    assert.equal(await srv.built.app.listScopeResources("bob@example.com", sharedScope), null);
    const { lease } = await srv.built.sessions.acquireLease(tenure.id);
    assert.ok(lease);
    await srv.built.sessions.append(lease, {
      type: "user",
      payload: { text: "gap-secret" },
      scopeLabel: sharedScope,
    });
    await srv.built.sessions.releaseLease(lease);
    assert.equal(
      (await srv.built.app.listContexts("bob@example.com")).some((context) => context.scopeId === sharedScope),
      false,
    );
    const restored = await srv.built.tlonInstallations.update("bob@example.com", bob.id, {
      ship: "~nec",
      url: "https://nec.tlon.network",
      code: "",
      ownerShip: "~bus",
      channels: [channel],
    });
    assert.ok(restored);
    assert.equal(await srv.built.app.belongsToScope("bob@example.com", sharedScope), false);
    await srv.built.tlonInstallations.report(bob.id, {
      version: restored.version,
      status: "connected",
      verifiedChannels: [channel],
    });
    assert.equal(await srv.built.app.belongsToScope("bob@example.com", sharedScope), true);
    assert.doesNotMatch(
      JSON.stringify(await srv.built.sessions.visibleEntries(tenure.id, "bob@example.com")),
      /gap-secret/,
    );
    assert.equal(await srv.built.tlonInstallations.delete("bob@example.com", bob.id), true);
    assert.equal(await srv.built.app.belongsToScope("bob@example.com", sharedScope), false);
  } finally {
    await srv.close();
  }
});

test("Tlon roster reconciliation survives a failed post-commit callback", async () => {
  const connections = createMemoryMap() as Parameters<typeof createTlonInstallationStore>[1];
  const inbound = createMemoryMap() as Parameters<typeof createTlonInstallationStore>[3];
  const reconciled: string[][] = [];
  let fail = false;
  const store = createTlonInstallationStore(
    "acme",
    connections,
    "roster-test-key",
    inbound,
    undefined,
    async (_channelId, _previous, current) => {
      if (fail) throw new Error("session store unavailable");
      reconciled.push(current);
    },
  );
  const channel = "chat/~sampel-palnet/general";
  const channelRef = tlonChannelRef(channel);
  const connection = await store.create("alice@example.com", {
    ship: "~sampel-palnet",
    url: "https://sampel-palnet.tlon.network",
    code: "secret",
    ownerShip: "~zod",
    channels: [channel],
  });
  await store.enqueueInbound({
    accountId: connection.id,
    installationVersion: connection.version,
    principalId: "alice@example.com",
    messageId: "owner-proof",
    senderShip: "~zod",
    text: `/qm-link ${connection.ownerVerificationCode}`,
    kind: "dm",
    target: "~zod",
  });
  await store.report(connection.id, {
    version: connection.version,
    status: "connected",
    verifiedChannels: [channel],
  });
  assert.equal(await store.membership(channelRef, "alice@example.com"), true);
  fail = true;
  await store.update("alice@example.com", connection.id, {
    ship: "~sampel-palnet",
    url: "https://sampel-palnet.tlon.network",
    code: "",
    ownerShip: "~zod",
    channels: [],
  });
  fail = false;
  const recovered = createTlonInstallationStore(
    "acme",
    connections,
    "roster-test-key",
    inbound,
    undefined,
    async (_channelId, _previous, current) => {
      reconciled.push(current);
    },
  );
  assert.equal(await recovered.membership(channelRef, "alice@example.com"), false);
  assert.deepEqual(reconciled.at(-1), []);
});

test("unchanged Tlon heartbeats avoid roster locks and owner linking is replay-safe", async () => {
  const connections = createMemoryMap() as Parameters<typeof createTlonInstallationStore>[1];
  const inbound = createMemoryMap() as Parameters<typeof createTlonInstallationStore>[3];
  const lockCalls: string[] = [];
  const activeLocks = new Set<string>();
  const store = createTlonInstallationStore("acme", connections, "heartbeat-test-key", inbound, {
    async withLock(key, fn) {
      lockCalls.push(key);
      activeLocks.add(key);
      try {
        return await fn();
      } finally {
        activeLocks.delete(key);
      }
    },
  });
  const channel = "chat/~sampel-palnet/general";
  const channelRef = tlonChannelRef(channel);
  const connection = await store.create("alice@example.com", {
    ship: "~sampel-palnet",
    url: "https://sampel-palnet.tlon.network",
    code: "secret",
    ownerShip: "~zod",
    channels: [channel],
  });
  const link = {
    accountId: connection.id,
    installationVersion: connection.version,
    principalId: "alice@example.com",
    messageId: "owner-link",
    senderShip: "~zod",
    text: `/qm-link ${connection.ownerVerificationCode}`,
    kind: "dm" as const,
    target: "~zod",
  };
  await store.enqueueInbound(link);
  await store.enqueueInbound({ ...link, messageId: "owner-link-replay" });
  assert.deepEqual(await store.claimInbound(60_000, 10), []);
  await store.report(connection.id, {
    version: connection.version,
    status: "connected",
    verifiedChannels: [channel],
  });
  lockCalls.length = 0;
  await store.report(connection.id, {
    version: connection.version,
    status: "connected",
    verifiedChannels: [channel],
  });
  assert.deepEqual(lockCalls, []);
  const version = await store.version(channelRef);
  lockCalls.length = 0;
  await store.withVersion(channelRef, version, async () => {
    assert.equal(activeLocks.has(`tlon-channel:acme:${channel.toLowerCase()}`), true);
    assert.equal(activeLocks.has("tlon-roster:acme"), false);
  });
  assert.equal((lockCalls as string[]).includes(`tlon-channel:acme:${channel.toLowerCase()}`), true);
});

test("a connector-wide roster change waits for every affected channel fence", async () => {
  const connections = createMemoryMap() as Parameters<typeof createTlonInstallationStore>[1];
  const inbound = createMemoryMap() as Parameters<typeof createTlonInstallationStore>[3];
  let active = true;
  const store = createTlonInstallationStore(
    "acme",
    connections,
    "channel-fence-test-key",
    inbound,
    createMemoryAdvisoryLock(),
    undefined,
    () => active,
  );
  const alpha = "chat/~sampel-palnet/alpha";
  const beta = "chat/~sampel-palnet/beta";
  const connection = await store.create("alice@example.com", {
    ship: "~sampel-palnet",
    url: "https://sampel-palnet.tlon.network",
    code: "secret",
    ownerShip: "~zod",
    channels: [alpha, beta],
  });
  await store.enqueueInbound({
    accountId: connection.id,
    installationVersion: connection.version,
    principalId: "alice@example.com",
    messageId: "owner-link",
    senderShip: "~zod",
    text: `/qm-link ${connection.ownerVerificationCode}`,
    kind: "dm",
    target: "~zod",
  });
  await store.report(connection.id, {
    version: connection.version,
    status: "connected",
    verifiedChannels: [alpha, beta],
  });
  const betaRef = tlonChannelRef(beta);
  const version = await store.version(betaRef);
  const alphaRef = tlonChannelRef(alpha);
  const alphaVersion = await store.version(alphaRef);
  let enteredAlpha = (): void => {};
  const alphaEntered = new Promise<void>((resolve) => {
    enteredAlpha = resolve;
  });
  let releaseAlpha = (): void => {};
  const alphaRelease = new Promise<void>((resolve) => {
    releaseAlpha = resolve;
  });
  const alphaFence = store.withVersion(alphaRef, alphaVersion, async () => {
    enteredAlpha();
    await alphaRelease;
  });
  await alphaEntered;
  try {
    await Promise.race([
      store.withVersion(betaRef, version, async () => {}),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("an unrelated channel fence was blocked")), 100),
      ),
    ]);
  } finally {
    releaseAlpha();
    await alphaFence;
  }
  let enterFence = (): void => {};
  const entered = new Promise<void>((resolve) => {
    enterFence = resolve;
  });
  let leaveFence = (): void => {};
  const leave = new Promise<void>((resolve) => {
    leaveFence = resolve;
  });
  const fenced = store.withVersion(betaRef, version, async () => {
    enterFence();
    await leave;
  });
  await entered;
  active = false;
  let refreshed = false;
  const refresh = store.membership(tlonChannelRef(alpha), "alice@example.com").then((membership) => {
    refreshed = true;
    return membership;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshed, false);
  leaveFence();
  await fenced;
  assert.equal(await refresh, false);
});

test("failed roster effects close tenure before a rapid principal reactivation", async () => {
  const connections = createMemoryMap() as Parameters<typeof createTlonInstallationStore>[1];
  const inbound = createMemoryMap() as Parameters<typeof createTlonInstallationStore>[3];
  const beta = "chat/~sampel-palnet/beta";
  const betaRef = tlonChannelRef(beta);
  const reconciled: string[][] = [];
  let active = true;
  let fail = false;
  const store = createTlonInstallationStore(
    "acme",
    connections,
    "roster-order-test-key",
    inbound,
    createMemoryAdvisoryLock(),
    async (channelId, _previous, current) => {
      if (fail) throw new Error("session store unavailable");
      if (channelId === betaRef) reconciled.push(current);
    },
    () => active,
  );
  const connection = await store.create("alice@example.com", {
    ship: "~sampel-palnet",
    url: "https://sampel-palnet.tlon.network",
    code: "secret",
    ownerShip: "~zod",
    channels: ["chat/~sampel-palnet/alpha", beta],
  });
  await store.enqueueInbound({
    accountId: connection.id,
    installationVersion: connection.version,
    principalId: "alice@example.com",
    messageId: "owner-link",
    senderShip: "~zod",
    text: `/qm-link ${connection.ownerVerificationCode}`,
    kind: "dm",
    target: "~zod",
  });
  await store.report(connection.id, {
    version: connection.version,
    status: "connected",
    verifiedChannels: ["chat/~sampel-palnet/alpha", beta],
  });
  fail = true;
  active = false;
  assert.equal(await store.membership(tlonChannelRef("chat/~sampel-palnet/alpha"), "alice@example.com"), false);
  fail = false;
  active = true;
  await store.membership(tlonChannelRef("chat/~sampel-palnet/alpha"), "alice@example.com");
  assert.deepEqual(reconciled.slice(-2), [[], ["alice@example.com"]]);
});

test("a principal deactivated and reactivated during a channel lease starts a new tenure", async () => {
  const connections = createMemoryMap() as Parameters<typeof createTlonInstallationStore>[1];
  const inbound = createMemoryMap() as Parameters<typeof createTlonInstallationStore>[3];
  const events: string[][] = [];
  let active = true;
  const store = createTlonInstallationStore(
    "acme",
    connections,
    "lease-tenure-test-key",
    inbound,
    createMemoryAdvisoryLock(),
    async (_channelId, _previous, current) => {
      events.push(current);
    },
    () => active,
  );
  const channel = "chat/~sampel-palnet/general";
  const channelRef = tlonChannelRef(channel);
  const connection = await store.create("alice@example.com", {
    ship: "~sampel-palnet",
    url: "https://sampel-palnet.tlon.network",
    code: "secret",
    ownerShip: "~zod",
    channels: [channel],
  });
  await store.enqueueInbound({
    accountId: connection.id,
    installationVersion: connection.version,
    principalId: "alice@example.com",
    messageId: "owner-link",
    senderShip: "~zod",
    text: `/qm-link ${connection.ownerVerificationCode}`,
    kind: "dm",
    target: "~zod",
  });
  await store.report(connection.id, {
    version: connection.version,
    status: "connected",
    verifiedChannels: [channel],
  });
  const version = await store.version(channelRef);
  const token = await store.acquire(connection.id, connection.version, 300_000, channel, version);
  assert.ok(token);
  active = false;
  assert.deepEqual(await store.members(channelRef), ["alice@example.com"]);
  active = true;
  await store.release(connection.id, connection.version, token);
  assert.deepEqual(await store.members(channelRef), ["alice@example.com"]);
  assert.notEqual(await store.version(channelRef), version);
  assert.deepEqual(events.slice(-2), [[], ["alice@example.com"]]);
});

test("a ship leave and rejoin observed during a channel lease starts a new tenure", async () => {
  const events: string[][] = [];
  const store = createTlonInstallationStore(
    "acme",
    createMemoryMap() as Parameters<typeof createTlonInstallationStore>[1],
    "lease-roster-test-key",
    createMemoryMap() as Parameters<typeof createTlonInstallationStore>[3],
    createMemoryAdvisoryLock(),
    async (_channelId, _previous, current) => {
      events.push(current);
    },
  );
  const channel = "chat/~sampel-palnet/general";
  const channelRef = tlonChannelRef(channel);
  const connection = await store.create("alice@example.com", {
    ship: "~sampel-palnet",
    url: "https://sampel-palnet.tlon.network",
    code: "secret",
    ownerShip: "~zod",
    channels: [channel],
  });
  await store.enqueueInbound({
    accountId: connection.id,
    installationVersion: connection.version,
    principalId: "alice@example.com",
    messageId: "owner-link",
    senderShip: "~zod",
    text: `/qm-link ${connection.ownerVerificationCode}`,
    kind: "dm",
    target: "~zod",
  });
  await store.report(connection.id, {
    version: connection.version,
    status: "connected",
    verifiedChannels: [channel],
  });
  const version = await store.version(channelRef);
  const token = await store.acquire(connection.id, connection.version, 300_000, channel, version);
  assert.ok(token);
  await assert.rejects(
    store.report(connection.id, { version: connection.version, status: "connected", verifiedChannels: [] }),
    /shared channel is busy/,
  );
  assert.equal(
    await store.report(connection.id, {
      version: connection.version,
      status: "connected",
      verifiedChannels: [channel],
    }),
    true,
  );
  await store.release(connection.id, connection.version, token);
  assert.deepEqual(await store.members(channelRef), []);
  assert.notEqual(await store.version(channelRef), version);
  await store.report(connection.id, {
    version: connection.version,
    status: "connected",
    verifiedChannels: [channel],
  });
  assert.deepEqual(await store.members(channelRef), ["alice@example.com"]);
  assert.deepEqual(events.slice(-2), [[], ["alice@example.com"]]);
});

test("Tlon source authorization refreshes principal deactivation across core instances", async () => {
  const identities = createMemoryMap<DeactivationRecord>();
  const writer = createIdentityService(identities);
  const reader = createIdentityService(identities);
  await Promise.all([writer.hydrate(), reader.hydrate()]);
  const store = createTlonInstallationStore(
    "acme",
    createMemoryMap() as Parameters<typeof createTlonInstallationStore>[1],
    "identity-refresh-test-key",
    createMemoryMap() as Parameters<typeof createTlonInstallationStore>[3],
    createMemoryAdvisoryLock(),
    undefined,
    (principalId) => reader.isInternal(reader.classify(principalId)),
    () => reader.refresh(true),
  );
  const channel = "chat/~sampel-palnet/general";
  const connection = await store.create("alice@example.com", {
    ship: "~sampel-palnet",
    url: "https://sampel-palnet.tlon.network",
    code: "secret",
    ownerShip: "~zod",
    channels: [channel],
  });
  await store.enqueueInbound({
    accountId: connection.id,
    installationVersion: connection.version,
    principalId: "alice@example.com",
    messageId: "owner-link",
    senderShip: "~zod",
    text: `/qm-link ${connection.ownerVerificationCode}`,
    kind: "dm",
    target: "~zod",
  });
  await store.report(connection.id, {
    version: connection.version,
    status: "connected",
    verifiedChannels: [channel],
  });
  await writer.deactivate("alice@example.com");
  assert.deepEqual(await store.members(tlonChannelRef(channel)), []);
  assert.equal(reader.classify("alice@example.com").type, "guest");
  assert.deepEqual(await store.runtime(), []);
  await store.enqueueInbound({
    accountId: connection.id,
    installationVersion: connection.version,
    principalId: "alice@example.com",
    messageId: "inactive-dm",
    senderShip: "~zod",
    text: "must be dropped",
    kind: "dm",
    target: "~zod",
  });
  assert.deepEqual(await store.claimInbound(60_000, 10), []);
});

test("one Tlon owner cannot bind a shared channel to two QM principals", async () => {
  const connections = createMemoryMap() as Parameters<typeof createTlonInstallationStore>[1];
  const inbound = createMemoryMap() as Parameters<typeof createTlonInstallationStore>[3];
  const store = createTlonInstallationStore("acme", connections, "owner-binding-test-key", inbound);
  const channel = "chat/~sampel-palnet/general";
  const create = (principalId: string, ship: string) =>
    store.create(principalId, {
      ship,
      url: `https://${ship.slice(1)}.tlon.network`,
      code: "secret",
      ownerShip: "~zod",
      channels: [channel],
    });
  const alice = await create("alice@example.com", "~sampel-palnet");
  const bob = await create("bob@example.com", "~nec");
  for (const connection of [alice, bob]) {
    await store.report(connection.id, {
      version: connection.version,
      status: "connected",
      verifiedChannels: [channel],
    });
  }
  const link = (connection: typeof alice, principalId: string, messageId: string) =>
    store.enqueueInbound({
      accountId: connection.id,
      installationVersion: connection.version,
      principalId,
      messageId,
      senderShip: "~zod",
      text: `/qm-link ${connection.ownerVerificationCode}`,
      kind: "dm",
      target: "~zod",
    });
  await link(alice, "alice@example.com", "alice-owner-link");
  await link(bob, "bob@example.com", "bob-owner-link");
  assert.deepEqual(await store.members(tlonChannelRef(channel)), ["alice@example.com"]);
  assert.equal((await store.list("bob@example.com"))[0]?.ownerVerified, false);
  assert.deepEqual(await store.claimInbound(60_000, 10), []);
});

test("shared Tlon ingress maps the author and preserves channel order across observer ships", async () => {
  const inbound = createMemoryMap() as Parameters<typeof createTlonInstallationStore>[3];
  const store = createTlonInstallationStore(
    "acme",
    createMemoryMap() as Parameters<typeof createTlonInstallationStore>[1],
    "shared-ingress-test-key",
    inbound,
  );
  const channel = "chat/~sampel-palnet/general";
  const connect = async (principalId: string, ship: string, ownerShip: string) => {
    const connection = await store.create(principalId, {
      ship,
      url: `https://${ship.slice(1)}.tlon.network`,
      code: "secret",
      ownerShip,
      channels: [channel],
    });
    await store.enqueueInbound({
      accountId: connection.id,
      installationVersion: connection.version,
      principalId,
      messageId: `${connection.id}-owner-link`,
      senderShip: ownerShip,
      text: `/qm-link ${connection.ownerVerificationCode}`,
      kind: "dm",
      target: ownerShip,
    });
    await store.report(connection.id, {
      version: connection.version,
      status: "connected",
      verifiedChannels: [channel],
    });
    return connection;
  };
  const alice = await connect("alice@example.com", "~sampel-palnet", "~zod");
  const backup = await connect("alice@example.com", "~marzod", "~zod");
  const bob = await connect("bob@example.com", "~nec", "~bus");
  const observed = (observer: typeof alice, senderShip: string, messageId: string, text: string) => ({
    accountId: observer.id,
    installationVersion: observer.version,
    principalId: "alice@example.com",
    messageId,
    senderShip,
    text,
    kind: "channel" as const,
    target: channel,
  });

  await store.enqueueInbound(observed(backup, "~bus", "ordinary-chatter", "not addressed to the bot"));
  await store.enqueueInbound(observed(backup, "~bus", "substring-chatter", "necessary work"));
  assert.deepEqual(await store.claimInbound(60_000, 10), []);

  await store.enqueueInbound(observed(backup, "~bus", "removed-observer", "~nec discard this"));
  await store.report(backup.id, { version: backup.version, status: "connected", verifiedChannels: [] });
  assert.deepEqual(await store.claimInbound(60_000, 10), []);
  assert.deepEqual(await inbound.all(), []);
  await store.report(backup.id, { version: backup.version, status: "connected", verifiedChannels: [channel] });

  const first = await store.enqueueInbound(observed(backup, "~bus", "shared-first", "~nec first request"));
  await store.enqueueInbound(observed(alice, "~bus", "shared-first", "~nec first request"));
  const second = await store.enqueueInbound(
    observed(backup, "~zod", "shared-second", "~sampel-palnet second request"),
    first.id,
  );
  const firstClaim = await store.claimInbound(60_000, 10);
  assert.equal(firstClaim.length, 1);
  assert.equal(firstClaim[0]?.id, first.id);
  assert.equal(firstClaim[0]?.message.accountId, bob.id);
  assert.equal(firstClaim[0]?.message.principalId, "bob@example.com");
  assert.equal(firstClaim[0]?.message.text, "first request");
  assert.equal(await store.ackInbound(first.id, firstClaim[0]!.claimToken!), true);
  const secondClaim = await store.claimInbound(60_000, 10);
  assert.equal(secondClaim[0]?.id, second.id);
  assert.equal(secondClaim[0]?.message.accountId, alice.id);
  assert.equal(secondClaim[0]?.message.principalId, "alice@example.com");
  assert.equal(secondClaim[0]?.message.text, "second request");
  assert.equal(await store.ackInbound(second.id, secondClaim[0]!.claimToken!), true);

  const bobCollision = await store.enqueueInbound(observed(backup, "~bus", "same-author-local-id", "~nec bob"));
  const aliceCollision = await store.enqueueInbound(
    observed(backup, "~zod", "same-author-local-id", "~sampel-palnet alice"),
  );
  assert.notEqual(bobCollision.id, aliceCollision.id);
  const collisionClaims = [];
  for (let index = 0; index < 2; index++) {
    const [claim] = await store.claimInbound(60_000, 10);
    assert.ok(claim);
    collisionClaims.push(claim.message.principalId);
    assert.equal(await store.ackInbound(claim.id, claim.claimToken!), true);
  }
  assert.deepEqual(collisionClaims.sort(), ["alice@example.com", "bob@example.com"]);
});

test("Tlon ingress and delivery leases fence the shared roster epoch", async () => {
  const connections = createMemoryMap() as Parameters<typeof createTlonInstallationStore>[1];
  const inbound = createMemoryMap() as Parameters<typeof createTlonInstallationStore>[3];
  const active = new Set(["alice@example.com", "bob@example.com"]);
  const store = createTlonInstallationStore(
    "acme",
    connections,
    "scope-lease-test-key",
    inbound,
    undefined,
    undefined,
    (principalId) => active.has(principalId),
  );
  const channel = "chat/~sampel-palnet/general";
  const privateChannel = "chat/~sampel-palnet/private";
  const channelRef = tlonChannelRef(channel);
  const connect = async (principalId: string, ship: string, ownerShip: string, channels = [channel]) => {
    const connection = await store.create(principalId, {
      ship,
      url: `https://${ship.slice(1)}.tlon.network`,
      code: "secret",
      ownerShip,
      channels,
    });
    await store.enqueueInbound({
      accountId: connection.id,
      installationVersion: connection.version,
      principalId,
      messageId: `${principalId}-owner-link`,
      senderShip: ownerShip,
      text: `/qm-link ${connection.ownerVerificationCode}`,
      kind: "dm",
      target: ownerShip,
    });
    await store.report(connection.id, {
      version: connection.version,
      status: "connected",
      verifiedChannels: channels,
    });
    return connection;
  };
  const alice = await connect("alice@example.com", "~sampel-palnet", "~zod");
  const ingressVersion = await store.version(channelRef);
  const receipt = await store.enqueueInbound({
    accountId: alice.id,
    installationVersion: alice.version,
    principalId: "alice@example.com",
    messageId: "before-bob-joined",
    senderShip: "~zod",
    text: "~sampel-palnet old roster message",
    kind: "channel",
    target: channel,
  });
  assert.equal(receipt.message.scopeVersion, ingressVersion);
  const bob = await connect("bob@example.com", "~nec", "~bus", [channel, privateChannel]);
  await connections.update?.(`acme:${bob.id}`, (record) => ({ ...record, channelEpochs: undefined }));
  const joinedVersion = await store.version(channelRef);
  assert.notEqual(joinedVersion, ingressVersion);
  assert.equal(await store.acquire(alice.id, alice.version, 300_000, channel, ingressVersion), null);

  const token = await store.acquire(alice.id, alice.version, 300_000, channel, joinedVersion);
  assert.ok(token);
  assert.equal(
    await store.report(bob.id, { version: bob.version, status: "connected", verifiedChannels: [channel] }),
    true,
  );
  assert.deepEqual(await store.members(tlonChannelRef(privateChannel)), []);
  assert.deepEqual(await store.members(channelRef), ["alice@example.com", "bob@example.com"]);
  assert.equal(await store.version(channelRef), joinedVersion);
  active.delete("bob@example.com");
  assert.deepEqual(await store.members(channelRef), ["alice@example.com", "bob@example.com"]);
  await assert.rejects(
    store.report(bob.id, { version: bob.version, status: "connected", verifiedChannels: [] }),
    /shared channel is busy/,
  );
  assert.equal(await store.release(alice.id, alice.version, token), true);
  assert.deepEqual(await store.members(channelRef), ["alice@example.com"]);
});

test("owner proof from a custom endpoint does not authorize a canonical shared connection", async () => {
  const connections = createMemoryMap() as Parameters<typeof createTlonInstallationStore>[1];
  const inbound = createMemoryMap() as Parameters<typeof createTlonInstallationStore>[3];
  const store = createTlonInstallationStore("acme", connections, "owner-origin-test-key", inbound);
  const channel = "chat/~sampel-palnet/general";
  const connection = await store.create("alice@example.com", {
    ship: "~sampel-palnet",
    url: "https://custom.example.com",
    code: "secret",
    ownerShip: "~zod",
    channels: [channel],
  });
  await store.enqueueInbound({
    accountId: connection.id,
    installationVersion: connection.version,
    principalId: "alice@example.com",
    messageId: "custom-owner-link",
    senderShip: "~zod",
    text: `/qm-link ${connection.ownerVerificationCode}`,
    kind: "dm",
    target: "~zod",
  });
  const updated = await store.update("alice@example.com", connection.id, {
    ship: "~sampel-palnet",
    url: "https://sampel-palnet.tlon.network",
    code: "",
    ownerShip: "~zod",
    channels: [channel],
  });
  assert.equal(updated?.ownerVerified, false);
  await store.report(connection.id, {
    version: updated!.version,
    status: "connected",
    verifiedChannels: [channel],
  });
  assert.deepEqual(await store.members(tlonChannelRef(channel)), []);
});

test("updating a Tlon connection purges its stale durable ingress generation", async () => {
  const store = createTlonInstallationStore(
    "acme",
    createMemoryMap() as Parameters<typeof createTlonInstallationStore>[1],
    "ingress-generation-test-key",
    createMemoryMap() as Parameters<typeof createTlonInstallationStore>[3],
  );
  const connection = await store.create("alice@example.com", {
    ship: "~sampel-palnet",
    url: "https://sampel-palnet.tlon.network",
    code: "secret",
    ownerShip: "~zod",
  });
  await store.enqueueInbound({
    accountId: connection.id,
    installationVersion: connection.version,
    principalId: "alice@example.com",
    messageId: "owner-link",
    senderShip: "~zod",
    text: `/qm-link ${connection.ownerVerificationCode}`,
    kind: "dm",
    target: "~zod",
  });
  const oldFirst = await store.enqueueInbound({
    accountId: connection.id,
    installationVersion: connection.version,
    principalId: "alice@example.com",
    messageId: "old-first",
    senderShip: "~zod",
    text: "old first",
    kind: "dm",
    target: "~zod",
  });
  await store.enqueueInbound(
    {
      accountId: connection.id,
      installationVersion: connection.version,
      principalId: "alice@example.com",
      messageId: "old-second",
      senderShip: "~zod",
      text: "old second",
      kind: "dm",
      target: "~zod",
    },
    oldFirst.id,
  );
  const updated = await store.update("alice@example.com", connection.id, {
    ship: "~sampel-palnet",
    url: "https://sampel-palnet.tlon.network",
    code: "",
    ownerShip: "~zod",
  });
  assert.ok(updated);
  const current = await store.enqueueInbound({
    accountId: updated.id,
    installationVersion: updated.version,
    principalId: "alice@example.com",
    messageId: "current",
    senderShip: "~zod",
    text: "current generation",
    kind: "dm",
    target: "~zod",
  });
  assert.deepEqual(
    (await store.claimInbound(60_000, 10)).map((record) => record.id),
    [current.id],
  );
});

test("disabling a BYO connector grays it out in the app-grid status", async () => {
  const srv = start();
  try {
    await putConnector(srv.base, { provider: "google", clientId: "c", clientSecret: "s", enabled: true });
    const statusPath = "/v1/connectors/oauth/status?principalId=U1";
    let st = (await (await fetch(`${srv.base}${statusPath}`)).json()) as {
      providers: Record<string, { configured: boolean }>;
    };
    assert.equal(st.providers.google!.configured, true);

    await putConnector(srv.base, { provider: "google", clientId: "c", clientSecret: "s", enabled: false });
    st = (await (await fetch(`${srv.base}${statusPath}`)).json()) as {
      providers: Record<string, { configured: boolean }>;
    };
    assert.equal(st.providers.google!.configured, false);
  } finally {
    await srv.close();
  }
});

test("the catalog endpoint exposes per-provider setup guidance (no secrets)", async () => {
  const srv = start();
  try {
    const { catalog } = (await (await fetch(`${srv.base}/v1/connectors/catalog`)).json()) as {
      catalog: Array<{ provider: string; setupGuide: { url: string; steps: string[] }; consentMode: string }>;
    };
    const names = catalog.map((c) => c.provider).sort();
    assert.deepEqual(names, ["dropbox", "github", "google", "linear", "notion", "slack", "x"]);
    const google = catalog.find((c) => c.provider === "google")!;
    assert.ok(google.setupGuide.steps.length >= 3);
    assert.match(google.setupGuide.url, /^https:\/\//);
    assert.equal(catalog.find((c) => c.provider === "github")!.consentMode, "github_app");
  } finally {
    await srv.close();
  }
});
