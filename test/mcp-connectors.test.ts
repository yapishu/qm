import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer as SdkMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { fromJSONSchema } from "zod";
import { createAuditLog } from "../src/audit/audit-log.ts";
import {
  createMcpClient,
  mcpResultText,
  normalizeMcpInputSchema,
  validateMcpServerUrl,
  type McpFetch,
} from "../src/mcp/mcp-client.ts";
import {
  createMcpServerStore,
  isValidMcpServerId,
  type McpServer,
  type StoredMcpServer,
} from "../src/mcp/mcp-server-store.ts";
import { createMcpToolService } from "../src/mcp/mcp-tool-service.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

function jsonResponse(body: unknown, status = 200, contentType = "application/json") {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? contentType : null) },
  };
}

function sessionResponse(body: unknown, sessionId: string) {
  return {
    ...jsonResponse(body),
    headers: {
      get(name: string) {
        if (name.toLowerCase() === "mcp-session-id") return sessionId;
        if (name.toLowerCase() === "content-type") return "application/json";
        return null;
      },
    },
  };
}

const TOOLS = [
  { name: "query", description: "Run a query", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
  { name: "update", description: "Write a record", inputSchema: { type: "object", properties: {} } },
];

function fakeServerFetch(opts?: { requireApiKey?: string; requireBearer?: string; sse?: boolean }): {
  fetch: McpFetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fetch: McpFetch = async (url, init) => {
    calls.push(url);
    if (opts?.requireApiKey && init.headers["x-api-key"] !== opts.requireApiKey) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }
    if (opts?.requireBearer && init.headers.authorization !== `Bearer ${opts.requireBearer}`) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }
    const req = JSON.parse(init.body) as { id: number; method: string; params: { name?: string } };
    const result =
      req.method === "tools/list" ? { tools: TOOLS } : { content: [{ type: "text", text: `ran ${req.params.name}` }] };
    const envelope = { jsonrpc: "2.0", id: req.id, result };
    if (opts?.sse) {
      return jsonResponse(`event: message\ndata: ${JSON.stringify(envelope)}\n\n`, 200, "text/event-stream");
    }
    return jsonResponse(envelope);
  };
  return { fetch, calls };
}

function server(partial?: Partial<McpServer>): McpServer {
  return {
    id: "crm",
    name: "CRM",
    url: "https://mcp.example.com/mcp",
    auth: "none",
    readOnly: true,
    enabled: true,
    updatedAt: 0,
    updatedBy: "internal:admin",
    ...partial,
  };
}

test("mcp client lists tools and calls one over plain JSON", async () => {
  const { fetch } = fakeServerFetch();
  const client = createMcpClient({ url: "https://mcp.example.com/mcp", auth: { mode: "none" }, fetchImpl: fetch });
  const tools = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name),
    ["query", "update"],
  );
  const result = await client.callTool("query", { q: "hi" });
  assert.equal(mcpResultText(result), "ran query");
});

test("mcp client parses SSE-framed responses", async () => {
  const { fetch } = fakeServerFetch({ sse: true });
  const client = createMcpClient({ url: "https://mcp.example.com/mcp", auth: { mode: "none" }, fetchImpl: fetch });
  const tools = await client.listTools();
  assert.equal(tools.length, 2);
});

test("mcp client initializes an official stateful Streamable HTTP transport", async () => {
  const sdkServer = new SdkMcpServer({ name: "test-server", version: "1.0.0" });
  sdkServer.registerTool("ping", { description: "Ping" }, async () => ({
    content: [{ type: "text", text: "pong" }],
  }));
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => "test-session",
    enableJsonResponse: true,
  });
  await sdkServer.connect(transport);
  const calls: string[] = [];
  const methods: string[] = [];
  const fetch: McpFetch = async (url, init) => {
    calls.push(url);
    methods.push(init.method);
    return transport.handleRequest(
      new Request(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: init.signal,
      }),
    );
  };
  try {
    const endpoint = "https://mcp.example.com/api/v1";
    const client = createMcpClient({ url: endpoint, auth: { mode: "none" }, fetchImpl: fetch });
    assert.deepEqual(
      (await client.listTools()).map((tool) => tool.name),
      ["ping"],
    );
    assert.equal(mcpResultText(await client.callTool("ping", {})), "pong");
    assert.ok(calls.every((url) => url === endpoint));
    await client.close();
    assert.equal(methods.at(-1), "DELETE");
  } finally {
    await sdkServer.close();
  }
});

test("mcp client sends bearer auth", async () => {
  const { fetch } = fakeServerFetch({ requireBearer: "sekret" });
  const client = createMcpClient({
    url: "https://mcp.example.com/mcp",
    auth: { mode: "bearer", token: "sekret" },
    fetchImpl: fetch,
  });
  assert.equal((await client.listTools()).length, 2);
  const bad = createMcpClient({ url: "https://mcp.example.com/mcp", auth: { mode: "none" }, fetchImpl: fetch });
  await assert.rejects(() => bad.listTools(), /HTTP 401/);
});

test("mcp client sends x-api-key auth", async () => {
  const { fetch } = fakeServerFetch({ requireApiKey: "shared-secret" });
  const client = createMcpClient({
    url: "https://mcp.example.com/mcp",
    auth: { mode: "api-key", apiKey: "shared-secret" },
    fetchImpl: fetch,
  });
  assert.equal((await client.listTools()).length, 2);
});

test("mcp requests reject redirects and carry a bounded abort signal", async () => {
  let seen: Parameters<McpFetch>[1] | undefined;
  const fetch: McpFetch = async (_url, init) => {
    seen = init;
    return jsonResponse({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
  };
  const client = createMcpClient({ url: "https://mcp.example.com/mcp", auth: { mode: "none" }, fetchImpl: fetch });
  await client.listTools();
  assert.equal(seen?.redirect, "error");
  assert.ok(seen?.signal instanceof AbortSignal);

  const hanging: McpFetch = async (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  const bounded = createMcpClient({
    url: "https://mcp.example.com/mcp",
    auth: { mode: "none" },
    fetchImpl: hanging,
    timeoutMs: 5,
  });
  const keepAlive = setTimeout(() => {}, 100);
  try {
    await assert.rejects(() => bounded.listTools(), /timeout|aborted/i);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("mcp destinations require public HTTPS addresses", async () => {
  assert.throws(() => createMcpClient({ url: "http://mcp.example.com", auth: { mode: "none" } }), /HTTPS/);
  await assert.rejects(
    () => validateMcpServerUrl("https://mcp.example.com", async () => [{ address: "127.0.0.1", family: 4 }]),
    /public network/,
  );
  await assert.rejects(
    () =>
      validateMcpServerUrl("https://mcp.example.com", async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ]),
    /public network/,
  );
  await assert.rejects(
    () => validateMcpServerUrl("https://mcp.example.com", async () => [{ address: "::ffff:7f00:1", family: 6 }]),
    /public network/,
  );
  await validateMcpServerUrl("https://mcp.example.com", async () => [{ address: "8.8.8.8", family: 4 }]);
});

test("mcp responses are size bounded and remote errors are opaque", async () => {
  const oversized = createMcpClient({
    url: "https://mcp.example.com/mcp",
    auth: { mode: "none" },
    fetchImpl: async () => jsonResponse("x".repeat(1024 * 1024 + 1)),
  });
  await assert.rejects(() => oversized.listTools(), /size limit/);

  const remoteError = createMcpClient({
    url: "https://mcp.example.com/mcp",
    auth: { mode: "api-key", apiKey: "top-secret" },
    fetchImpl: async (_url, init) => {
      const req = JSON.parse(init.body) as { id: number; method: string };
      return jsonResponse({ jsonrpc: "2.0", id: req.id, error: { message: `echo ${init.headers["x-api-key"]}` } });
    },
  });
  await assert.rejects(
    () => remoteError.listTools(),
    (error: Error) => {
      assert.doesNotMatch(error.message, /top-secret/);
      assert.match(error.message, /returned an error/);
      return true;
    },
  );
});

test("server id validation", () => {
  assert.ok(isValidMcpServerId("salesforce"));
  assert.ok(isValidMcpServerId("crm-2"));
  assert.ok(!isValidMcpServerId("Nope"));
  assert.ok(!isValidMcpServerId("x"));
  assert.ok(!isValidMcpServerId("has space"));
});

test("the tenant MCP server cap is atomic across concurrent registrations", async () => {
  const store = createMcpServerStore({
    backing: createMemoryMap<StoredMcpServer>(),
    keyMaterial: "mcp-test-key",
  });
  const inserted = await Promise.all(Array.from({ length: 32 }, (_, index) => store.put(server({ id: `s${index}` }))));
  assert.equal(inserted.filter((result) => result === "stored").length, 16);
  assert.equal((await store.list()).length, 16);
});

test("tool service exposes namespaced tools and calls through", async () => {
  const store = createMcpServerStore({
    backing: createMemoryMap<StoredMcpServer>(),
    keyMaterial: "mcp-test-key",
  });
  const { fetch } = fakeServerFetch();
  const service = createMcpToolService({ servers: store, fetchImpl: fetch, refreshIntervalMs: 3600_000 });
  await store.put(server());
  await service.refresh();
  const defs = service.toolDefs();
  assert.deepEqual(defs.map((d) => d.name).sort(), ["mcp_crm_query", "mcp_crm_update"]);
  assert.ok(defs.every((d) => !d.readOnly));
  const out = await service.call("mcp_crm_query", { q: "hello" }, "internal:U1");
  assert.equal(out, "ran query");
  service.close();
});

test("disabled server's tools disappear and calls fail", async () => {
  const store = createMcpServerStore({
    backing: createMemoryMap<StoredMcpServer>(),
    keyMaterial: "mcp-test-key",
  });
  const { fetch } = fakeServerFetch();
  const service = createMcpToolService({ servers: store, fetchImpl: fetch, refreshIntervalMs: 3600_000 });
  await store.put(server());
  await service.refresh();
  assert.equal(service.toolDefs().length, 2);
  await store.put(server({ enabled: false }));
  await service.refresh();
  assert.equal(service.toolDefs().length, 0);
  service.close();
});

test("unknown tool call rejects", async () => {
  const store = createMcpServerStore({
    backing: createMemoryMap<StoredMcpServer>(),
    keyMaterial: "mcp-test-key",
  });
  const service = createMcpToolService({ servers: store, refreshIntervalMs: 3600_000 });
  await assert.rejects(() => service.call("nope_tool", {}), /unknown MCP tool/);
  service.close();
});

test("mcp tool names cannot collide with built-ins and stale configurations fail closed", async () => {
  const store = createMcpServerStore({
    backing: createMemoryMap<StoredMcpServer>(),
    keyMaterial: "mcp-test-key",
  });
  const fetch: McpFetch = async (_url, init) => {
    const req = JSON.parse(init.body) as { id: number; method: string; params: { name?: string } };
    const result =
      req.method === "tools/list"
        ? { tools: [{ name: "exec", inputSchema: { type: "object" } }] }
        : { content: [{ type: "text", text: "ran" }] };
    return jsonResponse({ jsonrpc: "2.0", id: req.id, result });
  };
  const service = createMcpToolService({ servers: store, fetchImpl: fetch, refreshIntervalMs: 3600_000 });
  await store.put(server({ id: "credential" }));
  await service.refresh();
  assert.deepEqual(
    service.toolDefs().map((tool) => tool.name),
    ["mcp_credential_exec"],
  );
  await store.put(server({ id: "credential", readOnly: false, updatedAt: 1 }));
  await assert.rejects(() => service.call("mcp_credential_exec", {}), /configuration changed/);
  service.close();
});

test("mcp refreshes coalesce and publish the newest server configuration", async () => {
  const store = createMcpServerStore({
    backing: createMemoryMap<StoredMcpServer>(),
    keyMaterial: "mcp-test-key",
  });
  let releaseOld!: () => void;
  let oldStarted!: () => void;
  const oldEntered = new Promise<void>((resolve) => {
    oldStarted = resolve;
  });
  const oldGate = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  let active = 0;
  let maxActive = 0;
  const fetch: McpFetch = async (url, init) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      if (url.includes("old.example.com")) {
        oldStarted();
        await oldGate;
      }
      const req = JSON.parse(init.body) as { id: number };
      const name = url.includes("new.example.com") ? "new" : "old";
      return jsonResponse({ jsonrpc: "2.0", id: req.id, result: { tools: [{ name }] } });
    } finally {
      active -= 1;
    }
  };
  const service = createMcpToolService({ servers: store, fetchImpl: fetch, refreshIntervalMs: 3600_000 });
  await service.refresh();
  await store.put(server({ url: "https://old.example.com/mcp", updatedAt: 1 }));
  const oldRefresh = service.refresh();
  await oldEntered;
  await store.put(server({ url: "https://new.example.com/mcp", updatedAt: 2 }));
  const newRefresh = service.refresh();
  releaseOld();
  await Promise.all([oldRefresh, newRefresh]);
  assert.equal(maxActive, 1);
  assert.deepEqual(
    service.toolDefs().map((tool) => tool.name),
    ["mcp_crm_new"],
  );
  service.close();
});

test("remote MCP errors never persist reflected credentials in audit", async () => {
  const store = createMcpServerStore({
    backing: createMemoryMap<StoredMcpServer>(),
    keyMaterial: "mcp-test-key",
  });
  const audit = createAuditLog();
  const fetch: McpFetch = async (_url, init) => {
    const req = JSON.parse(init.body) as { id: number; method: string };
    if (req.method === "initialize") {
      return jsonResponse({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: "2025-06-18" } });
    }
    if (req.method === "notifications/initialized") return jsonResponse({}, 202);
    return req.method === "tools/list"
      ? jsonResponse({ jsonrpc: "2.0", id: req.id, result: { tools: [{ name: "query" }] } })
      : jsonResponse({ jsonrpc: "2.0", id: req.id, error: { message: `echo ${init.headers["x-api-key"]}` } });
  };
  const service = createMcpToolService({ servers: store, fetchImpl: fetch, audit, refreshIntervalMs: 3600_000 });
  await store.put(server({ auth: "api-key", apiKey: "top-secret" }));
  await service.refresh();
  await assert.rejects(() => service.call("mcp_crm_query", {}), /returned an error/);
  assert.doesNotMatch(JSON.stringify(await audit.events()), /top-secret/);
  service.close();
});

test("MCP tool catalogs periodically refresh without repeated discovery on every registry poll", async () => {
  const store = createMcpServerStore({
    backing: createMemoryMap<StoredMcpServer>(),
    keyMaterial: "mcp-test-key",
  });
  let now = 0;
  let remoteName = "first";
  let lists = 0;
  const fetch: McpFetch = async (_url, init) => {
    const req = JSON.parse(init.body) as { id: number; method: string };
    if (req.method === "tools/list") lists += 1;
    return jsonResponse({ jsonrpc: "2.0", id: req.id, result: { tools: [{ name: remoteName }] } });
  };
  const service = createMcpToolService({
    servers: store,
    fetchImpl: fetch,
    now: () => now,
    refreshIntervalMs: 3600_000,
  });
  await store.put(server());
  await service.refresh();
  assert.deepEqual(
    service.toolDefs().map((tool) => tool.name),
    ["mcp_crm_first"],
  );
  remoteName = "second";
  await service.refresh();
  assert.equal(lists, 1);
  now = 5 * 60_000 + 1;
  await service.refresh();
  assert.equal(lists, 2);
  assert.deepEqual(
    service.toolDefs().map((tool) => tool.name),
    ["mcp_crm_second"],
  );
  service.close();
});

test("closing the MCP tool service aborts an active remote call", async () => {
  const store = createMcpServerStore({
    backing: createMemoryMap<StoredMcpServer>(),
    keyMaterial: "mcp-test-key",
  });
  let callStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    callStarted = resolve;
  });
  const fetch: McpFetch = async (_url, init) => {
    const req = JSON.parse(init.body) as { id: number; method: string };
    if (req.method === "initialize") {
      return jsonResponse({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: "2025-06-18" } });
    }
    if (req.method === "notifications/initialized") return jsonResponse({}, 202);
    if (req.method === "tools/list") {
      return jsonResponse({ jsonrpc: "2.0", id: req.id, result: { tools: [{ name: "query" }] } });
    }
    callStarted();
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  };
  const service = createMcpToolService({ servers: store, fetchImpl: fetch, refreshIntervalMs: 3600_000 });
  await store.put(server());
  await service.refresh();
  const calling = service.call("mcp_crm_query", {});
  await started;
  service.close();
  await assert.rejects(() => calling, /abort/i);
});

test("mcp server credentials are encrypted at rest and legacy plaintext migrates on read", async () => {
  const backing = createMemoryMap<StoredMcpServer>();
  const store = createMcpServerStore({ backing, keyMaterial: "mcp-test-key" });
  await store.put(server({ auth: "api-key", apiKey: "shared-secret" }));
  const stored = await backing.get("crm");
  assert.equal(stored?.apiKey, undefined);
  assert.match(stored?.apiKeyEnc ?? "", /^v2:/);
  assert.equal((await store.get("crm"))?.apiKey, "shared-secret");

  await backing.put("legacy", {
    ...server({ id: "legacy", auth: "bearer", bearerToken: "old-secret" }),
  });
  assert.equal((await store.get("legacy"))?.bearerToken, "old-secret");
  const migrated = await backing.get("legacy");
  assert.equal(migrated?.bearerToken, undefined);
  assert.match(migrated?.bearerTokenEnc ?? "", /^v2:/);

  await backing.put("oauth-legacy", {
    id: "oauth-legacy",
    name: "Legacy OAuth server",
    url: "https://legacy.example.com/mcp",
    auth: "client-credentials",
    clientId: "tenant-client",
    clientSecret: "SUPER-SECRET-LEGACY",
    readOnly: false,
    enabled: true,
    updatedAt: 1,
    updatedBy: "internal:admin",
  });
  const quarantined = await store.get("oauth-legacy");
  assert.equal(quarantined?.auth, "none");
  assert.equal(quarantined?.enabled, false);
  assert.doesNotMatch(JSON.stringify(quarantined), /tenant-client|SUPER-SECRET-LEGACY/);
  const sanitized = await backing.get("oauth-legacy");
  assert.equal(sanitized?.auth, "none");
  assert.equal(sanitized?.enabled, false);
  assert.equal(sanitized?.clientId, undefined);
  assert.equal(sanitized?.clientSecret, undefined);
});

test("legacy MCP credential migration cannot overwrite a concurrent admin update", async () => {
  const inner = createMemoryMap<StoredMcpServer>();
  let migrationStarted!: () => void;
  let releaseMigration!: () => void;
  const started = new Promise<void>((resolve) => {
    migrationStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseMigration = resolve;
  });
  const backing = {
    ...inner,
    async update(id: string, fn: (value: StoredMcpServer) => StoredMcpServer) {
      migrationStarted();
      await gate;
      return inner.update!(id, fn);
    },
  };
  await backing.put("crm", server({ auth: "api-key", apiKey: "old-secret" }));
  const store = createMcpServerStore({ backing, keyMaterial: "mcp-test-key" });
  const migrating = store.get("crm");
  await started;
  await store.put(server({ url: "https://new.example.com/mcp", auth: "api-key", apiKey: "new-secret", updatedAt: 1 }));
  releaseMigration();
  await migrating;
  const current = await store.get("crm");
  assert.equal(current?.url, "https://new.example.com/mcp");
  assert.equal(current?.apiKey, "new-secret");
});

test("a blank stale admin edit cannot restore an older MCP credential", async () => {
  const store = createMcpServerStore({
    backing: createMemoryMap<StoredMcpServer>(),
    keyMaterial: "mcp-test-key",
  });
  await store.put(server({ auth: "api-key", apiKey: "old-secret" }));
  const staleEdit = server({ auth: "api-key", apiKey: undefined, name: "Stale metadata edit", updatedAt: 2 });
  await store.put(server({ auth: "api-key", apiKey: "new-secret", updatedAt: 1 }));
  assert.equal(await store.put(staleEdit), "stored");
  assert.equal((await store.get("crm"))?.apiKey, "new-secret");
  assert.equal(
    await store.put(server({ url: "https://attacker.example.com/mcp", auth: "api-key", apiKey: undefined })),
    "invalid",
  );
  assert.equal((await store.get("crm"))?.url, "https://mcp.example.com/mcp");
});

test("MCP server writes reject stale admin snapshots", async () => {
  const store = createMcpServerStore({
    backing: createMemoryMap<StoredMcpServer>(),
    keyMaterial: "mcp-test-key",
  });
  await store.put(server({ updatedAt: 1 }));
  assert.equal(await store.put(server({ name: "First", updatedAt: 2 }), 1), "stored");
  assert.equal(await store.put(server({ name: "Stale", updatedAt: 3 }), 1), "conflict");
  assert.equal((await store.get("crm"))?.name, "First");
});

test("unsupported MCP schemas become safe object schemas", () => {
  const deep: Record<string, unknown> = { type: "object" };
  let cursor = deep;
  for (let index = 0; index < 30; index += 1) {
    const child: Record<string, unknown> = { type: "object" };
    cursor.properties = { child };
    cursor = child;
  }
  for (const schema of [
    { $ref: "https://schemas.example/input" },
    { type: "wat" },
    deep,
    { type: "object", properties: { q: { type: "string" } } },
  ]) {
    const normalized = normalizeMcpInputSchema(schema);
    const converted = fromJSONSchema(normalized as Parameters<typeof fromJSONSchema>[0]);
    assert.equal(typeof (converted as { shape?: unknown }).shape, "object");
  }
});

test("successful MCP responses cannot reflect configured credentials", async () => {
  const secret = "TOP-SECRET-API-KEY";
  const fetch: McpFetch = async (_url, init) => {
    const req = JSON.parse(init.body) as { id: number; method: string };
    const result =
      req.method === "tools/list"
        ? {
            tools: [
              {
                name: "query",
                description: `Use credential ${secret}`,
                inputSchema: { type: "object", properties: { [secret]: { const: secret } } },
              },
            ],
          }
        : {
            content: [{ type: "text", text: `result credential ${secret}` }],
            structuredContent: { [secret]: "visible", secret },
          };
    return jsonResponse({ jsonrpc: "2.0", id: req.id, result });
  };
  const client = createMcpClient({
    url: "https://mcp.example.com/mcp",
    auth: { mode: "api-key", apiKey: secret },
    fetchImpl: fetch,
  });
  const tools = await client.listTools();
  assert.doesNotMatch(JSON.stringify(tools), new RegExp(secret));
  const result = await client.callTool("query", {});
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

test("credential redaction cannot reproduce marker-shaped credentials", async () => {
  for (const secret of ["redacted", "[redacted]"]) {
    const fetch: McpFetch = async (_url, init) => {
      const req = JSON.parse(init.body) as { id?: number; method: string };
      if (req.method === "initialize") {
        return jsonResponse({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: "2025-06-18" } });
      }
      if (req.method === "notifications/initialized") return jsonResponse({}, 202);
      if (req.method === "tools/list") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: req.id,
          result: { tools: [{ name: "query", description: secret }] },
        });
      }
      return jsonResponse({
        jsonrpc: "2.0",
        id: req.id,
        result: { content: [{ type: "text", text: secret }] },
      });
    };
    const client = createMcpClient({
      url: "https://mcp.example.com/mcp",
      auth: { mode: "api-key", apiKey: secret },
      fetchImpl: fetch,
    });
    assert.ok(!JSON.stringify(await client.listTools()).includes(secret));
    assert.ok(!JSON.stringify(await client.callTool("query", {})).includes(secret));
  }
});

test("redacted key collisions cannot reconstruct credentials", async () => {
  const secret = "abcdef-2";
  const fetch: McpFetch = async (_url, init) => {
    const req = JSON.parse(init.body) as { id?: number; method: string };
    if (req.method === "initialize") {
      return jsonResponse({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: "2025-06-18" } });
    }
    if (req.method === "notifications/initialized") return jsonResponse({}, 202);
    if (req.method === "tools/list") {
      return jsonResponse({ jsonrpc: "2.0", id: req.id, result: { tools: [{ name: "query" }] } });
    }
    return jsonResponse({
      jsonrpc: "2.0",
      id: req.id,
      result: { structuredContent: { [secret]: "first", abcdef: "second" } },
    });
  };
  const client = createMcpClient({
    url: "https://mcp.example.com/mcp",
    auth: { mode: "api-key", apiKey: secret },
    fetchImpl: fetch,
  });
  assert.doesNotMatch(JSON.stringify(await client.callTool("query", {})), new RegExp(secret));
});

test("MCP tool names are injective across accepted remote punctuation", async () => {
  const store = createMcpServerStore({
    backing: createMemoryMap<StoredMcpServer>(),
    keyMaterial: "mcp-test-key",
  });
  const fetch: McpFetch = async (_url, init) => {
    const req = JSON.parse(init.body) as { id: number };
    return jsonResponse({
      jsonrpc: "2.0",
      id: req.id,
      result: { tools: ["a.b", "a:b", "a_b"].map((name) => ({ name, inputSchema: { type: "object" } })) },
    });
  };
  const service = createMcpToolService({ servers: store, fetchImpl: fetch, refreshIntervalMs: 3600_000 });
  await store.put(server());
  await service.refresh();
  assert.deepEqual(
    service.toolDefs().map((tool) => tool.name),
    ["mcp_crm_a_2eb", "mcp_crm_a_3ab", "mcp_crm_a_5fb"],
  );
  service.close();
});

test("tenant MCP catalog has deterministic count and byte budgets", async () => {
  const store = createMcpServerStore({
    backing: createMemoryMap<StoredMcpServer>(),
    keyMaterial: "mcp-test-key",
  });
  const fetch: McpFetch = async (url, init) => {
    const req = JSON.parse(init.body) as { id: number };
    const host = new URL(url).hostname.replace(/\./g, "-");
    return jsonResponse({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        tools: Array.from({ length: 64 }, (_, index) => ({
          name: `tool-${index}`,
          description: `${host}-${"x".repeat(4000)}`,
          inputSchema: { type: "object", properties: {} },
        })),
      },
    });
  };
  const service = createMcpToolService({ servers: store, fetchImpl: fetch, refreshIntervalMs: 3600_000 });
  for (let index = 0; index < 16; index += 1) {
    await store.put(server({ id: `s${index}`, url: `https://s${index}.example.com/mcp` }));
  }
  await service.refresh();
  const defs = service.toolDefs();
  assert.ok(defs.length <= 128);
  assert.ok(Buffer.byteLength(JSON.stringify(defs)) <= 512 * 1024);
  service.close();
});

test("a successful admin probe seeds the committed tool refresh", async () => {
  const store = createMcpServerStore({
    backing: createMemoryMap<StoredMcpServer>(),
    keyMaterial: "mcp-test-key",
  });
  let lists = 0;
  const fetch: McpFetch = async (_url, init) => {
    const req = JSON.parse(init.body) as { id: number; method: string };
    if (req.method === "tools/list") lists += 1;
    return jsonResponse({
      jsonrpc: "2.0",
      id: req.id,
      result: { tools: [{ name: "query", inputSchema: { type: "object" } }] },
    });
  };
  const service = createMcpToolService({ servers: store, fetchImpl: fetch, refreshIntervalMs: 3600_000 });
  await service.refresh();
  const config = server({ updatedAt: 42 });
  assert.deepEqual(await service.probe(config), ["query"]);
  await store.put(config);
  await service.refresh();
  assert.equal(lists, 1);
  assert.deepEqual(
    service.toolDefs().map((tool) => tool.name),
    ["mcp_crm_query"],
  );
  service.close();
});

test("long MCP tool names stay provider-safe and collision resistant", async () => {
  const store = createMcpServerStore({
    backing: createMemoryMap<StoredMcpServer>(),
    keyMaterial: "mcp-test-key",
  });
  const names = [`${"a".repeat(127)}.`, `${"a".repeat(127)}:`];
  const fetch: McpFetch = async (_url, init) => {
    const req = JSON.parse(init.body) as { id: number };
    return jsonResponse({
      jsonrpc: "2.0",
      id: req.id,
      result: { tools: names.map((name) => ({ name, inputSchema: { type: "object" } })) },
    });
  };
  const service = createMcpToolService({ servers: store, fetchImpl: fetch, refreshIntervalMs: 3600_000 });
  await store.put(server({ id: `s${"x".repeat(38)}` }));
  await service.refresh();
  const exposed = service.toolDefs().map((tool) => tool.name);
  assert.equal(exposed.length, 2);
  assert.ok(exposed.every((name) => name.length <= 64 && /^[a-zA-Z0-9_-]+$/.test(name)));
  assert.notEqual(exposed[0], exposed[1]);
  service.close();
});

test("concurrent expired-session responses share one replacement session", async () => {
  let initializations = 0;
  let expiredCalls = 0;
  let enteredExpired!: () => void;
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  let replacementReady!: () => void;
  const bothExpired = new Promise<void>((resolve) => {
    enteredExpired = resolve;
  });
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const secondGate = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const replacement = new Promise<void>((resolve) => {
    replacementReady = resolve;
  });
  const fetch: McpFetch = async (_url, init) => {
    const req = JSON.parse(init.body) as { id?: number; method: string };
    if (req.method === "initialize") {
      initializations += 1;
      if (initializations === 2) replacementReady();
      return sessionResponse(
        {
          jsonrpc: "2.0",
          id: req.id,
          result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "test", version: "1" } },
        },
        `session-${initializations}`,
      );
    }
    if (req.method === "notifications/initialized") return jsonResponse({}, 202);
    if (req.method === "tools/list") {
      return jsonResponse({ jsonrpc: "2.0", id: req.id, result: { tools: [{ name: "query" }] } });
    }
    if (init.headers["mcp-session-id"] === "session-1") {
      expiredCalls += 1;
      if (expiredCalls === 2) enteredExpired();
      await (expiredCalls === 1 ? firstGate : secondGate);
      return jsonResponse({}, 404);
    }
    return jsonResponse({
      jsonrpc: "2.0",
      id: req.id,
      result: { content: [{ type: "text", text: "ok" }] },
    });
  };
  const client = createMcpClient({ url: "https://mcp.example.com/mcp", auth: { mode: "none" }, fetchImpl: fetch });
  await client.listTools();
  const calls = [client.callTool("query", {}), client.callTool("query", {})];
  await bothExpired;
  releaseFirst();
  await replacement;
  releaseSecond();
  assert.deepEqual((await Promise.all(calls)).map(mcpResultText), ["ok", "ok"]);
  assert.equal(initializations, 2);
});

test("a failed initialized notification leaves the next request able to reconnect", async () => {
  let initializations = 0;
  let deletes = 0;
  const deleteProtocols: string[] = [];
  const fetch: McpFetch = async (_url, init) => {
    if (init.method === "DELETE") {
      deletes += 1;
      deleteProtocols.push(init.headers["mcp-protocol-version"] ?? "");
      return jsonResponse({}, 200);
    }
    const req = JSON.parse(init.body) as { id?: number; method: string };
    if (req.method === "initialize") {
      initializations += 1;
      return sessionResponse(
        { jsonrpc: "2.0", id: req.id, result: { protocolVersion: "2024-11-05" } },
        `session-${initializations}`,
      );
    }
    if (req.method === "notifications/initialized" && initializations === 1) return jsonResponse({}, 500);
    if (req.method === "notifications/initialized") return jsonResponse({}, 202);
    return jsonResponse({ jsonrpc: "2.0", id: req.id, result: { tools: [] } });
  };
  const client = createMcpClient({ url: "https://mcp.example.com/mcp", auth: { mode: "none" }, fetchImpl: fetch });
  await assert.rejects(() => client.listTools(), /notifications\/initialized/);
  assert.deepEqual(await client.listTools(), []);
  assert.equal(initializations, 2);
  assert.equal(deletes, 1);
  assert.deepEqual(deleteProtocols, ["2024-11-05"]);
});

test("concurrent cold-start calls wait for initialized notification completion", async () => {
  const methods: string[] = [];
  let notificationStarted!: () => void;
  let releaseNotification!: () => void;
  const started = new Promise<void>((resolve) => {
    notificationStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseNotification = resolve;
  });
  const fetch: McpFetch = async (_url, init) => {
    const req = JSON.parse(init.body) as { id?: number; method: string };
    methods.push(req.method);
    if (req.method === "initialize") {
      return sessionResponse({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: "2025-06-18" } }, "session-1");
    }
    if (req.method === "notifications/initialized") {
      notificationStarted();
      await gate;
      return jsonResponse({}, 202);
    }
    if (req.method === "tools/list") {
      return jsonResponse({ jsonrpc: "2.0", id: req.id, result: { tools: [] } });
    }
    return jsonResponse({ jsonrpc: "2.0", id: req.id, result: { content: [] } });
  };
  const client = createMcpClient({ url: "https://mcp.example.com/mcp", auth: { mode: "none" }, fetchImpl: fetch });
  const listing = client.listTools();
  await started;
  const calling = client.callTool("query", {});
  await Promise.resolve();
  assert.deepEqual(methods, ["initialize", "notifications/initialized"]);
  releaseNotification();
  await Promise.all([listing, calling]);
  assert.deepEqual(methods.slice(0, 2), ["initialize", "notifications/initialized"]);
});

test("closing a client prevents an in-flight expired request from reconnecting", async () => {
  let initializations = 0;
  let calls = 0;
  let callStarted!: () => void;
  let releaseCall!: () => void;
  const started = new Promise<void>((resolve) => {
    callStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseCall = resolve;
  });
  const fetch: McpFetch = async (_url, init) => {
    if (init.method === "DELETE") return jsonResponse({}, 200);
    const req = JSON.parse(init.body) as { id?: number; method: string };
    if (req.method === "initialize") {
      initializations += 1;
      return sessionResponse(
        { jsonrpc: "2.0", id: req.id, result: { protocolVersion: "2025-06-18" } },
        `session-${initializations}`,
      );
    }
    if (req.method === "notifications/initialized") return jsonResponse({}, 202);
    if (req.method === "tools/list") {
      return jsonResponse({ jsonrpc: "2.0", id: req.id, result: { tools: [{ name: "query" }] } });
    }
    calls += 1;
    callStarted();
    await gate;
    return jsonResponse({}, 404);
  };
  const client = createMcpClient({ url: "https://mcp.example.com/mcp", auth: { mode: "none" }, fetchImpl: fetch });
  await client.listTools();
  const calling = client.callTool("query", {});
  await started;
  await client.close();
  releaseCall();
  await assert.rejects(() => calling, /closed/);
  assert.equal(initializations, 1);
  assert.equal(calls, 1);
});
