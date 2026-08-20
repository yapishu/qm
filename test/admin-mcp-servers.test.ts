import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };

test("admin manages an x-api-key MCP server without exposing its secret", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "admin-mcp-")) }));
  let refreshes = 0;
  let probeFails = false;
  const mcpToolService = {
    toolDefs: () => [],
    async call() {
      return "";
    },
    async refresh() {
      refreshes += 1;
    },
    async probe() {
      if (probeFails) throw new Error("offline");
      return [];
    },
    close() {},
  };
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    auditLog: built.auditLog,
    mcpServers: built.mcpServers,
    mcpToolService,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const api = (path: string, init?: RequestInit) => fetch(`${base}${path}`, { headers: ADMIN, ...init });

  try {
    const denied = await fetch(`${base}/v1/admin/mcp-servers/team-tools`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-admin-actor": "ordinary-user@default-org" },
      body: JSON.stringify({
        name: "Team tools",
        url: "https://8.8.8.8/mcp",
        auth: "api-key",
        apiKey: "top-secret",
        validate: false,
        expectedUpdatedAt: null,
      }),
    });
    assert.equal(denied.status, 403);
    assert.equal(await built.mcpServers.get("team-tools"), null);

    for (const url of ["http://8.8.8.8/mcp", "https://127.0.0.1/mcp"]) {
      const rejected = await api("/v1/admin/mcp-servers/team-tools", {
        method: "PUT",
        body: JSON.stringify({ name: "Team tools", url, auth: "api-key", apiKey: "top-secret", validate: false }),
      });
      assert.equal(rejected.status, 400, `${url}: ${await rejected.text()}`);
    }

    const created = await api("/v1/admin/mcp-servers/team-tools", {
      method: "PUT",
      body: JSON.stringify({
        name: "Team tools",
        url: "https://8.8.8.8/mcp",
        auth: "api-key",
        apiKey: "top-secret",
        readOnly: false,
        validate: false,
        expectedUpdatedAt: null,
      }),
    });
    const createdText = await created.text();
    assert.equal(created.status, 200, createdText);
    assert.equal(refreshes, 1);
    assert.doesNotMatch(createdText, /top-secret/);
    const createdServer = (JSON.parse(createdText) as { server: { hasApiKey: boolean; updatedAt: number } }).server;
    assert.equal(createdServer.hasApiKey, true);

    const listed = await api("/v1/admin/mcp-servers");
    assert.equal(listed.status, 200);
    const listedText = await listed.text();
    assert.doesNotMatch(listedText, /top-secret/);
    assert.equal((JSON.parse(listedText) as { servers: Array<{ auth: string }> }).servers[0]?.auth, "api-key");

    const edited = await api("/v1/admin/mcp-servers/team-tools", {
      method: "PUT",
      body: JSON.stringify({
        name: "Renamed tools",
        url: "https://8.8.8.8/mcp",
        auth: "api-key",
        apiKey: "",
        validate: false,
        expectedUpdatedAt: createdServer.updatedAt,
      }),
    });
    assert.equal(edited.status, 200, await edited.text());
    assert.equal((await built.mcpServers.get("team-tools"))?.apiKey, "top-secret");

    const stale = await api("/v1/admin/mcp-servers/team-tools", {
      method: "PUT",
      body: JSON.stringify({
        name: "Stale edit",
        url: "https://8.8.8.8/mcp",
        auth: "api-key",
        apiKey: "",
        validate: false,
        expectedUpdatedAt: createdServer.updatedAt,
      }),
    });
    assert.equal(stale.status, 409, await stale.text());
    assert.equal((await built.mcpServers.get("team-tools"))?.name, "Renamed tools");

    const editedServer = await built.mcpServers.get("team-tools");

    const rebound = await api("/v1/admin/mcp-servers/team-tools", {
      method: "PUT",
      body: JSON.stringify({
        name: "Attacker endpoint",
        url: "https://1.1.1.1/mcp",
        auth: "api-key",
        apiKey: "",
        validate: false,
        expectedUpdatedAt: editedServer?.updatedAt,
      }),
    });
    assert.equal(rebound.status, 400, await rebound.text());
    assert.equal((await built.mcpServers.get("team-tools"))?.url, "https://8.8.8.8/mcp");

    probeFails = true;
    const disabled = await api("/v1/admin/mcp-servers/team-tools", {
      method: "PUT",
      body: JSON.stringify({
        name: "Renamed tools",
        url: "https://8.8.8.8/mcp",
        auth: "api-key",
        apiKey: "",
        enabled: false,
        expectedUpdatedAt: editedServer?.updatedAt,
      }),
    });
    assert.equal(disabled.status, 200, await disabled.text());
    assert.equal((await built.mcpServers.get("team-tools"))?.enabled, false);

    const disabledServer = await built.mcpServers.get("team-tools");
    const unfencedDelete = await api("/v1/admin/mcp-servers/team-tools", { method: "DELETE" });
    assert.equal(unfencedDelete.status, 400, await unfencedDelete.text());
    const removed = await api(`/v1/admin/mcp-servers/team-tools?expectedUpdatedAt=${disabledServer?.updatedAt}`, {
      method: "DELETE",
    });
    assert.equal(removed.status, 200);
    assert.equal(refreshes, 4);
    assert.equal(await built.mcpServers.get("team-tools"), null);
  } finally {
    built.mcpToolService.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
