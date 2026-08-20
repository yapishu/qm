import { validateMcpServerUrl } from "../../../mcp/mcp-client.ts";
import {
  isValidMcpServerId,
  MAX_MCP_SERVERS,
  MIN_MCP_SECRET_CHARS,
  type McpServer,
  type McpServerAuthMode,
} from "../../../mcp/mcp-server-store.ts";
import { sendJson } from "../../http.ts";
import type { ApiCtx } from "../route.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";

const AUTH_MODES: McpServerAuthMode[] = ["none", "api-key", "bearer"];

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

async function actor(ctx: ApiCtx) {
  const scope = orgScope(ctx.deps);
  return authorizeAdmin(ctx, scope);
}

function redact(server: McpServer): Omit<McpServer, "apiKey" | "bearerToken"> & {
  hasApiKey: boolean;
  hasBearerToken: boolean;
} {
  const { apiKey, bearerToken, ...rest } = server;
  return { ...rest, hasApiKey: !!apiKey, hasBearerToken: !!bearerToken };
}

export async function getMcpServers(ctx: ApiCtx): Promise<void> {
  const authorized = await actor(ctx);
  if (!authorized) return;
  if (!ctx.deps.mcpServers) return sendJson(ctx.res, 404, { error: "not_found" });
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "mcp-servers.read",
    resource: "mcp-servers",
    scopeLabel: orgScope(ctx.deps),
  });
  const servers = await ctx.deps.mcpServers.list();
  return sendJson(ctx.res, 200, {
    servers: servers.map(redact),
    tools: ctx.deps.mcpToolService?.toolDefs().map(({ name, serverId, description, readOnly }) => ({
      name,
      serverId,
      description,
      readOnly,
    })),
  });
}

export async function putMcpServer(ctx: ApiCtx): Promise<void> {
  const authorized = await actor(ctx);
  if (!authorized) return;
  if (!ctx.deps.mcpServers) return sendJson(ctx.res, 404, { error: "not_found" });
  const id = ctx.params.id ?? "";
  if (!isValidMcpServerId(id)) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "id must be 2-40 chars: lowercase letters, digits, hyphens, starting with a letter",
    });
  }
  const b = ctx.body as Partial<McpServer> & { validate?: boolean; expectedUpdatedAt?: number | null };
  const url = typeof b.url === "string" ? b.url.trim() : "";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "url must be a valid URL" });
  }
  if (parsed.protocol !== "https:") {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "url must use https" });
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "url must not carry credentials, query, or fragment",
    });
  }
  const auth = (b.auth ?? "none") as McpServerAuthMode;
  if (!AUTH_MODES.includes(auth)) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: `auth must be one of ${AUTH_MODES.join(", ")}` });
  }
  const existing = await ctx.deps.mcpServers.get(id);
  const enabled = b.enabled !== false;
  const sameCredentialEndpoint = existing?.auth === auth && existing.url === url;
  const apiKey = nonEmptyString(b.apiKey) ?? (sameCredentialEndpoint ? existing?.apiKey : undefined);
  const bearerToken = nonEmptyString(b.bearerToken) ?? (sameCredentialEndpoint ? existing?.bearerToken : undefined);
  const server: McpServer = {
    id,
    name: typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 80) : id,
    url,
    auth,
    ...(auth === "api-key" ? { apiKey } : {}),
    ...(auth === "bearer" ? { bearerToken } : {}),
    readOnly: false,
    enabled,
    updatedAt: Math.max(Date.now(), (existing?.updatedAt ?? 0) + 1),
    updatedBy: authorized.id,
  };
  if (auth === "api-key" && (server.apiKey?.length ?? 0) < MIN_MCP_SECRET_CHARS) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: `api-key auth requires an API key of at least ${MIN_MCP_SECRET_CHARS} characters`,
    });
  }
  if (auth === "bearer" && (server.bearerToken?.length ?? 0) < MIN_MCP_SECRET_CHARS) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: `bearer auth requires a token of at least ${MIN_MCP_SECRET_CHARS} characters`,
    });
  }
  if (enabled) {
    try {
      await validateMcpServerUrl(url);
    } catch (e) {
      return sendJson(ctx.res, 400, {
        error: "bad_request",
        message: e instanceof Error ? e.message : "MCP server URL is not allowed",
      });
    }
  }
  let toolNames: string[] | undefined;
  if (enabled && b.validate !== false && ctx.deps.mcpToolService) {
    try {
      toolNames = await ctx.deps.mcpToolService.probe(server);
    } catch {
      return sendJson(ctx.res, 400, {
        error: "unreachable",
        message: `tools/list against ${parsed.host} failed`,
      });
    }
  }
  const storedServer: McpServer = { ...server };
  if (auth === "api-key" && !(typeof b.apiKey === "string" && b.apiKey)) delete storedServer.apiKey;
  if (auth === "bearer" && !(typeof b.bearerToken === "string" && b.bearerToken)) delete storedServer.bearerToken;
  const expectedUpdatedAt =
    b.expectedUpdatedAt === null || Number.isSafeInteger(b.expectedUpdatedAt) ? b.expectedUpdatedAt : null;
  const putResult = await ctx.deps.mcpServers.put(storedServer, expectedUpdatedAt);
  if (putResult === "limit") {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: `at most ${MAX_MCP_SERVERS} MCP servers are allowed`,
    });
  }
  if (putResult === "invalid" || putResult === "conflict") {
    return sendJson(ctx.res, 409, {
      error: "conflict",
      message: "MCP server changed; reload it and try again",
    });
  }
  await ctx.deps.mcpToolService?.refresh();
  if (enabled && ctx.deps.mcpToolService) {
    toolNames = ctx.deps.mcpToolService
      .toolDefs()
      .filter((tool) => tool.serverId === id)
      .map((tool) => tool.remoteName);
  }
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "mcp-servers.update",
    resource: id,
    scopeLabel: orgScope(ctx.deps),
  });
  return sendJson(ctx.res, 200, { ok: true, server: redact(server), ...(toolNames ? { tools: toolNames } : {}) });
}

export async function deleteMcpServer(ctx: ApiCtx): Promise<void> {
  const authorized = await actor(ctx);
  if (!authorized) return;
  if (!ctx.deps.mcpServers) return sendJson(ctx.res, 404, { error: "not_found" });
  const id = ctx.params.id ?? "";
  const rawExpectedUpdatedAt = ctx.url.searchParams.get("expectedUpdatedAt");
  const expectedUpdatedAt =
    rawExpectedUpdatedAt === null || rawExpectedUpdatedAt === "" ? NaN : Number(rawExpectedUpdatedAt);
  if (!Number.isSafeInteger(expectedUpdatedAt)) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "expectedUpdatedAt is required" });
  }
  const result = await ctx.deps.mcpServers.delete(id, expectedUpdatedAt);
  if (result === "not_found") return sendJson(ctx.res, 404, { error: "not_found" });
  if (result === "conflict") {
    return sendJson(ctx.res, 409, { error: "conflict", message: "MCP server changed; reload it and try again" });
  }
  await ctx.deps.mcpToolService?.refresh();
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "mcp-servers.delete",
    resource: id,
    scopeLabel: orgScope(ctx.deps),
  });
  return sendJson(ctx.res, 200, { ok: true });
}
