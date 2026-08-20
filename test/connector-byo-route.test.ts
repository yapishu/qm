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
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../plugins/chassis/src/portal-identity.ts";
import { encodeDeliveryTarget } from "../plugins/tlon/src/target.ts";

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
      url: "https://support.example.com",
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
    const created = JSON.parse(createText) as { connection: { id: string } };
    const id = created.connection.id;
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
      body: JSON.stringify({ version: oldVersion, status: "connected" }),
    });
    assert.equal(statusReport.status, 200, await statusReport.text());
    assert.equal((await srv.built.tlonInstallations.list("alice@example.com"))[0]?.runtimeStatus, "connected");

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
