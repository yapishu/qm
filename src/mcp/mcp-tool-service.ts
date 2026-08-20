import { createHash } from "node:crypto";
import type { AuditLog } from "../audit/audit-log.ts";
import { errMessage } from "../util/errors.ts";
import { createMcpClient, mcpResultText, type McpAuth, type McpClient, type McpFetch } from "./mcp-client.ts";
import { MAX_MCP_SERVERS, type McpServer, type McpServerStore } from "./mcp-server-store.ts";

const REFRESH_INTERVAL_MS = 5_000;
const REMOTE_REFRESH_INTERVAL_MS = 5 * 60_000;
const MAX_TOOLS_PER_SERVER = 32;
const MAX_TENANT_TOOLS = 128;
const MAX_TENANT_CATALOG_BYTES = 512 * 1024;
const MAX_RESULT_CHARS = 60_000;

export interface McpToolDescriptor {
  name: string;
  serverId: string;
  remoteName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  configVersion: string;
}

export interface McpToolService {
  toolDefs(): McpToolDescriptor[];
  call(name: string, args: Record<string, unknown>, principalId?: string): Promise<string>;
  refresh(): Promise<void>;
  probe(server: McpServer): Promise<string[]>;
  close(): Promise<void> | void;
}

function versionOf(server: McpServer): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        server.id,
        server.name,
        server.url,
        server.auth,
        server.apiKey ?? "",
        server.bearerToken ?? "",
        server.readOnly,
        server.enabled,
        server.updatedAt,
        server.updatedBy,
      ]),
    )
    .digest("hex");
}

function authOf(server: McpServer): McpAuth {
  if (server.auth === "api-key") return { mode: "api-key", apiKey: server.apiKey ?? "" };
  if (server.auth === "bearer") return { mode: "bearer", token: server.bearerToken ?? "" };
  if (server.auth === "none") return { mode: "none" };
  throw new Error(`unsupported MCP authentication mode: ${String(server.auth)}`);
}

function toolName(serverId: string, remoteName: string): string {
  const encoded = Array.from(Buffer.from(remoteName), (byte) => {
    const char = String.fromCharCode(byte);
    return /[a-zA-Z0-9]/.test(char) ? char : `_${byte.toString(16).padStart(2, "0")}`;
  }).join("");
  const prefix = `mcp_${serverId}_`;
  const plain = `${prefix}${encoded}`;
  if (plain.length <= 64) return plain;
  const suffix = createHash("sha256").update(remoteName).digest("hex").slice(0, 12);
  return `${prefix}${encoded.slice(0, 64 - prefix.length - suffix.length - 1)}_${suffix}`;
}

export function createMcpToolService(opts: {
  servers: McpServerStore;
  audit?: AuditLog;
  fetchImpl?: McpFetch;
  now?: () => number;
  refreshIntervalMs?: number;
}): McpToolService {
  const now = opts.now ?? (() => Date.now());
  const clients = new Map<string, { client: McpClient; server: McpServer }>();
  const cachedDefs = new Map<string, { version: string; checkedAt: number; defs: McpToolDescriptor[] }>();
  const validatedDefs = new Map<string, { version: string; checkedAt: number; defs: McpToolDescriptor[] }>();
  const abort = new AbortController();
  let snapshot: McpToolDescriptor[] = [];
  let refreshActive: Promise<void> | null = null;
  let refreshRequested = false;
  let closed = false;

  function record(action: string, resource: string, status: string, principalId?: string): void {
    opts.audit?.record({
      at: now(),
      principalId: principalId || "system",
      action: `mcp.${action}`,
      resource,
      scopeLabel: "mcp-connectors",
      status,
    });
  }

  function clientFor(server: McpServer): McpClient {
    const cached = clients.get(server.id);
    if (cached && JSON.stringify(cached.server) === JSON.stringify(server)) return cached.client;
    if (cached) void cached.client.close().catch(() => {});
    const client = createMcpClient({
      url: server.url,
      auth: authOf(server),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      signal: abort.signal,
    });
    clients.set(server.id, { client, server });
    return client;
  }

  function descriptors(server: McpServer, tools: Awaited<ReturnType<McpClient["listTools"]>>): McpToolDescriptor[] {
    const configVersion = versionOf(server);
    return tools.slice(0, MAX_TOOLS_PER_SERVER).map((tool) => ({
      name: toolName(server.id, tool.name),
      serverId: server.id,
      remoteName: tool.name,
      description: tool.description || `${tool.name} on ${server.name}`,
      inputSchema: tool.inputSchema,
      readOnly: false,
      configVersion,
    }));
  }

  async function refreshOnce(): Promise<void> {
    let servers: McpServer[];
    try {
      servers = (await opts.servers.list()).filter((server) => server.enabled).slice(0, MAX_MCP_SERVERS);
    } catch (e) {
      record("refresh", "registry", `error: ${errMessage(e)}`);
      return;
    }
    const resolved = await Promise.all(
      servers.map(async (server) => {
        const version = versionOf(server);
        const validated = validatedDefs.get(server.id);
        if (validated?.version === version && now() - validated.checkedAt < REMOTE_REFRESH_INTERVAL_MS)
          return validated;
        const cached = cachedDefs.get(server.id);
        if (cached?.version === version && now() - cached.checkedAt < REMOTE_REFRESH_INTERVAL_MS) return cached;
        try {
          const tools = await clientFor(server).listTools();
          const defs = descriptors(server, tools);
          record("list", server.id, `ok tools=${tools.length}`);
          return { version, checkedAt: now(), defs };
        } catch (e) {
          record("list", server.id, `error: ${errMessage(e)}`);
          return null;
        }
      }),
    );
    if (closed) return;
    cachedDefs.clear();
    for (let index = 0; index < servers.length; index += 1) {
      const cached = resolved[index];
      if (cached) {
        const id = servers[index]!.id;
        cachedDefs.set(id, cached);
        if (validatedDefs.get(id)?.version === cached.version) validatedDefs.delete(id);
      }
    }
    const seen = new Set<string>();
    const next: McpToolDescriptor[] = [];
    let catalogBytes = 2;
    for (const cached of resolved) {
      for (const def of cached?.defs ?? []) {
        if (seen.has(def.name)) continue;
        const bytes = Buffer.byteLength(JSON.stringify(def)) + (next.length ? 1 : 0);
        if (catalogBytes + bytes > MAX_TENANT_CATALOG_BYTES) continue;
        seen.add(def.name);
        catalogBytes += bytes;
        next.push(def);
        if (next.length >= MAX_TENANT_TOOLS) break;
      }
      if (next.length >= MAX_TENANT_TOOLS) break;
    }
    snapshot = next;
    const activeIds = new Set(servers.map((server) => server.id));
    for (const [id, client] of clients) {
      if (!activeIds.has(id)) {
        clients.delete(id);
        void client.client.close().catch(() => {});
      }
    }
    for (const [id, validated] of validatedDefs) {
      if (now() - validated.checkedAt >= REMOTE_REFRESH_INTERVAL_MS) validatedDefs.delete(id);
    }
  }

  function refresh(): Promise<void> {
    if (closed) return Promise.resolve();
    refreshRequested = true;
    if (!refreshActive) {
      refreshActive = (async () => {
        while (refreshRequested && !closed) {
          refreshRequested = false;
          await refreshOnce();
        }
      })().finally(() => {
        refreshActive = null;
      });
    }
    return refreshActive;
  }

  const timer = setInterval(() => {
    if (!closed) void refresh();
  }, opts.refreshIntervalMs ?? REFRESH_INTERVAL_MS);
  timer.unref?.();
  void refresh();

  return {
    toolDefs: () => snapshot,
    async call(name, args, principalId) {
      const def = snapshot.find((t) => t.name === name);
      if (!def) throw new Error(`unknown MCP tool: ${name}`);
      const server = await opts.servers.get(def.serverId);
      if (!server || !server.enabled) throw new Error(`MCP server ${def.serverId} is not available`);
      if (versionOf(server) !== def.configVersion) throw new Error(`MCP server ${def.serverId} configuration changed`);
      try {
        const result = await clientFor(server).callTool(def.remoteName, args);
        record("call", `${def.serverId}/${def.remoteName}`, "ok", principalId);
        const text = mcpResultText(result) || JSON.stringify(result.structuredContent ?? "") || "";
        return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n[truncated]` : text;
      } catch (e) {
        record("call", `${def.serverId}/${def.remoteName}`, `error: ${errMessage(e)}`, principalId);
        throw e;
      }
    },
    refresh,
    async probe(server) {
      const client = createMcpClient({
        url: server.url,
        auth: authOf(server),
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        signal: abort.signal,
      });
      try {
        const tools = await client.listTools();
        validatedDefs.set(server.id, {
          version: versionOf(server),
          checkedAt: now(),
          defs: descriptors(server, tools),
        });
        return tools.map((t) => t.name);
      } finally {
        await client.close().catch(() => {});
      }
    },
    async close() {
      closed = true;
      refreshRequested = false;
      clearInterval(timer);
      const closing = Array.from(clients.values(), (client) => client.client.close());
      clients.clear();
      abort.abort();
      await Promise.allSettled(closing);
    },
  };
}
