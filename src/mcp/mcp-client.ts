import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { fromJSONSchema } from "zod";
import { isPrivateNetworkIp } from "../util/network.ts";

const MCP_ACCEPT = "application/json, text/event-stream";
const MCP_TIMEOUT_MS = 30_000;
const MCP_RPC_RESPONSE_BYTES = 1024 * 1024;
const MCP_TOOL_NAME = /^[a-zA-Z0-9_.:-]{1,128}$/;
const MCP_TOOL_DESCRIPTION_CHARS = 4000;
const MCP_TOOL_SCHEMA_CHARS = 32 * 1024;
const MCP_TOOL_SCHEMA_NODES = 512;
const MCP_TOOL_SCHEMA_DEPTH = 20;
const EMPTY_INPUT_SCHEMA = { type: "object", properties: {} } as const;
const MCP_PROTOCOL_VERSION = "2025-06-18";
const MCP_CLOSE_TIMEOUT_MS = 2_000;

export type McpLookup = (hostname: string, options: { all: true; verbatim: true }) => Promise<LookupAddress[]>;

interface McpHttpResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  headers?: { get(name: string): string | null };
}

export type McpFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    redirect: "error";
    signal: AbortSignal;
    maxResponseBytes: number;
  },
) => Promise<McpHttpResponse>;

function pinnedLookup(addresses: LookupAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const family = options.family ?? 0;
    const eligible =
      family === 4 || family === 6 ? addresses.filter((address) => address.family === family) : addresses;
    if (!eligible.length) {
      const error = new Error("MCP server has no public address for the requested family") as NodeJS.ErrnoException;
      error.code = "ENOTFOUND";
      callback(error, "", 0);
      return;
    }
    if (options.all) callback(null, eligible);
    else callback(null, eligible[0]!.address, eligible[0]!.family);
  };
}

async function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}

async function publicAddresses(url: URL, lookup: McpLookup, signal: AbortSignal): Promise<LookupAddress[]> {
  const rawHostname = url.hostname;
  const hostname = rawHostname.startsWith("[") && rawHostname.endsWith("]") ? rawHostname.slice(1, -1) : rawHostname;
  let addresses: LookupAddress[];
  try {
    addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) as 4 | 6 }]
      : await withSignal(lookup(hostname, { all: true, verbatim: true }), signal);
  } catch {
    throw new Error("MCP server hostname could not be resolved");
  }
  if (!addresses.length || addresses.some((address) => isPrivateNetworkIp(address.address))) {
    throw new Error("MCP server must resolve only to public network addresses");
  }
  return addresses;
}

function mcpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("MCP server URL must use HTTPS");
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) {
    throw new Error("MCP server URL must use credential-free HTTPS");
  }
  return url;
}

export async function validateMcpServerUrl(
  raw: string,
  lookup: McpLookup = dnsLookup,
  signal: AbortSignal = AbortSignal.timeout(MCP_TIMEOUT_MS),
): Promise<void> {
  await publicAddresses(mcpUrl(raw), lookup, signal);
}

function createRealFetch(lookup: McpLookup): McpFetch {
  return async (raw, init) => {
    const url = mcpUrl(raw);
    const addresses = await publicAddresses(url, lookup, init.signal);
    return new Promise<McpHttpResponse>((resolve, reject) => {
      const req = httpsRequest(
        url,
        {
          method: init.method,
          headers: init.headers,
          lookup: pinnedLookup(addresses),
          signal: init.signal,
          agent: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer | string) => {
            const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += part.length;
            if (size > init.maxResponseBytes) {
              res.destroy(new Error("MCP server response exceeded the size limit"));
              return;
            }
            chunks.push(part);
          });
          res.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            resolve({
              ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
              status: res.statusCode ?? 0,
              text: async () => body,
              headers: {
                get(name) {
                  const value = res.headers[name.toLowerCase()];
                  if (Array.isArray(value)) return value.join(", ");
                  return value === undefined ? null : String(value);
                },
              },
            });
          });
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end(init.body);
    });
  };
}

function hostOf(base: string): string {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function redactionSentinel(secrets: string[]): string {
  const used = new Set<string>();
  for (const secret of secrets) for (const character of secret) used.add(character);
  for (let codePoint = 0xe000; codePoint <= 0x10ffff; codePoint += 1) {
    const character = String.fromCodePoint(codePoint);
    if (!used.has(character)) return character;
  }
  throw new Error("MCP credential alphabet exhausted");
}

function scrubSecrets(value: string, secrets: string[], sentinel: string): string {
  let scrubbed = value;
  for (const secret of secrets) scrubbed = scrubbed.replaceAll(secret, sentinel);
  return scrubbed;
}

function redactSecrets(value: unknown, secrets: string[]): unknown {
  const sentinel = redactionSentinel(secrets);
  if (!value || typeof value !== "object") {
    if (typeof value !== "string") return value;
    return scrubSecrets(value, secrets, sentinel);
  }
  const root: unknown[] | Record<string, unknown> = Array.isArray(value) ? [] : Object.create(null);
  const pending: Array<{ source: unknown[] | Record<string, unknown>; target: unknown[] | Record<string, unknown> }> = [
    { source: value as unknown[] | Record<string, unknown>, target: root },
  ];
  while (pending.length) {
    const current = pending.pop()!;
    for (const [rawKey, child] of Object.entries(current.source)) {
      const key = scrubSecrets(rawKey, secrets, sentinel);
      if (Object.hasOwn(current.target, key)) continue;
      if (child && typeof child === "object") {
        const next: unknown[] | Record<string, unknown> = Array.isArray(child) ? [] : Object.create(null);
        Object.defineProperty(current.target, key, { value: next, enumerable: true, configurable: true });
        pending.push({ source: child as unknown[] | Record<string, unknown>, target: next });
      } else {
        Object.defineProperty(current.target, key, {
          value: typeof child === "string" ? scrubSecrets(child, secrets, sentinel) : child,
          enumerable: true,
          configurable: true,
        });
      }
    }
  }
  return root;
}

function boundedSchema(schema: Record<string, unknown>): boolean {
  const seen = new Set<object>();
  const pending: Array<{ value: unknown; depth: number }> = [{ value: schema, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (!value || typeof value !== "object") continue;
    if (depth > MCP_TOOL_SCHEMA_DEPTH || ++nodes > MCP_TOOL_SCHEMA_NODES || seen.has(value)) return false;
    seen.add(value);
    for (const child of Object.values(value)) pending.push({ value: child, depth: depth + 1 });
  }
  return true;
}

export function normalizeMcpInputSchema(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...EMPTY_INPUT_SCHEMA };
  const schema = input as Record<string, unknown>;
  if (schema.type !== "object" || !boundedSchema(schema)) return { ...EMPTY_INPUT_SCHEMA };
  try {
    if (JSON.stringify(schema).length > MCP_TOOL_SCHEMA_CHARS) return { ...EMPTY_INPUT_SCHEMA };
    const converted = fromJSONSchema(schema as Parameters<typeof fromJSONSchema>[0]);
    if (!("shape" in converted) || typeof converted.shape !== "object") return { ...EMPTY_INPUT_SCHEMA };
    return schema;
  } catch {
    return { ...EMPTY_INPUT_SCHEMA };
  }
}

async function responseText(response: McpHttpResponse, maxBytes: number): Promise<string> {
  const body = await response.text();
  if (Buffer.byteLength(body) > maxBytes) throw new Error("MCP server response exceeded the size limit");
  return body;
}

interface McpEnvelope {
  result?: unknown;
  error?: { message?: string };
  id?: unknown;
}

function parseSseEnvelopes(body: string): McpEnvelope[] {
  const out: McpEnvelope[] = [];
  for (const frame of body.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    const parsed = safeJson(data) as McpEnvelope | null;
    if (parsed) out.push(parsed);
  }
  return out;
}

function parseMcpEnvelope(text: string, contentType: string | null | undefined, id?: unknown): McpEnvelope | null {
  const isSse = !!contentType && contentType.toLowerCase().includes("text/event-stream");
  if (isSse) {
    const envelopes = parseSseEnvelopes(text);
    const carries = (e: McpEnvelope): boolean => e.result !== undefined || e.error !== undefined;
    return (
      (id !== undefined ? envelopes.find((e) => e.id === id && carries(e)) : undefined) ??
      envelopes.find(carries) ??
      null
    );
  }
  return safeJson(text) as McpEnvelope | null;
}

export interface McpToolResult {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

export function mcpResultText(result: McpToolResult): string {
  if (!Array.isArray(result.content)) return "";
  return result.content
    .filter((c) => c?.type === "text")
    .map((c) => String(c.text ?? ""))
    .join("\n")
    .trim();
}

interface McpRemoteTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type McpAuth = { mode: "none" } | { mode: "api-key"; apiKey: string } | { mode: "bearer"; token: string };

export interface McpClient {
  readonly base: string;
  readonly host: string;
  listTools(): Promise<McpRemoteTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
  close(): Promise<void>;
}

export function createMcpClient(opts: {
  url: string;
  auth: McpAuth;
  fetchImpl?: McpFetch;
  timeoutMs?: number;
  lookup?: McpLookup;
  signal?: AbortSignal;
}): McpClient {
  const fetchImpl = opts.fetchImpl ?? createRealFetch(opts.lookup ?? dnsLookup);
  const base = mcpUrl(opts.url).toString();
  const host = hostOf(base);
  const timeoutMs = opts.timeoutMs ?? MCP_TIMEOUT_MS;
  let rpcId = 0;
  let sessionId = "";
  let protocolVersion = MCP_PROTOCOL_VERSION;
  let initialized = false;
  let initializing: Promise<void> | null = null;
  let closed = false;
  const clientAbort = new AbortController();

  const operationSignal = () =>
    AbortSignal.any(
      [AbortSignal.timeout(timeoutMs), opts.signal, clientAbort.signal].filter(
        (signal): signal is AbortSignal => signal !== undefined,
      ),
    );

  function authHeaders(): Record<string, string> {
    const auth = opts.auth;
    if (auth.mode === "none") return {};
    if (auth.mode === "api-key") return { "x-api-key": auth.apiKey };
    return { authorization: `Bearer ${auth.token}` };
  }

  async function post(message: Record<string, unknown>) {
    if (closed) throw new Error("MCP client is closed");
    const signal = operationSignal();
    const authHeadersForRequest = authHeaders();
    const requestSessionId = sessionId;
    const res = await fetchImpl(base, {
      method: "POST",
      headers: {
        ...authHeadersForRequest,
        "content-type": "application/json",
        accept: MCP_ACCEPT,
        ...(requestSessionId ? { "mcp-session-id": requestSessionId } : {}),
        ...(initialized ? { "mcp-protocol-version": protocolVersion } : {}),
      },
      body: JSON.stringify(message),
      redirect: "error",
      signal,
      maxResponseBytes: MCP_RPC_RESPONSE_BYTES,
    });
    if (closed) {
      const lateSession = res.headers?.get("mcp-session-id") ?? "";
      if (lateSession) void terminateSession(lateSession).catch(() => {});
      throw new Error("MCP client is closed");
    }
    if (!res.ok) {
      return { res, secrets: [] as string[], requestSessionId };
    }
    const auth = opts.auth;
    const secrets = Array.from(
      new Set(
        [
          auth.mode === "api-key" ? auth.apiKey : "",
          auth.mode === "bearer" ? auth.token : "",
          authHeadersForRequest["x-api-key"] ?? "",
          authHeadersForRequest.authorization?.replace(/^Bearer /, "") ?? "",
        ].filter((secret) => secret.length > 0),
      ),
    ).sort((left, right) => right.length - left.length);
    return { res, secrets, requestSessionId };
  }

  async function resultOf(res: McpHttpResponse, secrets: string[], id: number, method: string): Promise<unknown> {
    if (closed) throw new Error("MCP client is closed");
    if (!res.ok) throw new Error(`mcp ${method} failed (HTTP ${res.status})`);
    const parsed = parseMcpEnvelope(
      await responseText(res, MCP_RPC_RESPONSE_BYTES),
      res.headers?.get("content-type"),
      id,
    );
    if (!parsed) throw new Error(`mcp ${method} returned non-JSON`);
    if (parsed.error) throw new Error(`mcp ${method} returned an error`);
    return redactSecrets(parsed.result ?? {}, secrets);
  }

  async function initialize(): Promise<void> {
    let allocatedSession = "";
    let negotiatedProtocol = MCP_PROTOCOL_VERSION;
    const id = ++rpcId;
    try {
      const initializedResponse = await post({
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "qm", version: "0.1.0" },
        },
      });
      allocatedSession = initializedResponse.res.headers?.get("mcp-session-id") ?? "";
      const result = (await resultOf(initializedResponse.res, initializedResponse.secrets, id, "initialize")) as {
        protocolVersion?: unknown;
      };
      negotiatedProtocol = typeof result.protocolVersion === "string" ? result.protocolVersion : MCP_PROTOCOL_VERSION;
      sessionId = allocatedSession;
      protocolVersion = negotiatedProtocol;
      initialized = true;
      const notification = await post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
      if (!notification.res.ok)
        throw new Error(`mcp notifications/initialized failed (HTTP ${notification.res.status})`);
    } catch (error) {
      sessionId = "";
      protocolVersion = MCP_PROTOCOL_VERSION;
      initialized = false;
      if (allocatedSession) await terminateSession(allocatedSession, negotiatedProtocol).catch(() => {});
      throw error;
    }
  }

  async function ensureInitialized(): Promise<void> {
    if (initializing) return initializing;
    if (initialized) return;
    if (!initializing) {
      initializing = initialize().finally(() => {
        initializing = null;
      });
    }
    await initializing;
  }

  async function rpc(method: string, params: Record<string, unknown>, sessionRetried = false): Promise<unknown> {
    await ensureInitialized();
    const id = ++rpcId;
    const response = await post({ jsonrpc: "2.0", id, method, params });
    if (response.res.status === 404 && response.requestSessionId && !sessionRetried) {
      if (sessionId === response.requestSessionId) {
        sessionId = "";
        initialized = false;
      }
      await ensureInitialized();
      return rpc(method, params, true);
    }
    return resultOf(response.res, response.secrets, id, method);
  }

  async function terminateSession(closingSession: string, closingProtocol: string = protocolVersion): Promise<void> {
    const signal = AbortSignal.timeout(MCP_CLOSE_TIMEOUT_MS);
    const headers = authHeaders();
    const response = await fetchImpl(base, {
      method: "DELETE",
      headers: {
        ...headers,
        accept: MCP_ACCEPT,
        "mcp-session-id": closingSession,
        "mcp-protocol-version": closingProtocol,
      },
      body: "",
      redirect: "error",
      signal,
      maxResponseBytes: MCP_RPC_RESPONSE_BYTES,
    });
    if (!response.ok && response.status !== 404 && response.status !== 405) {
      throw new Error(`mcp session close failed (HTTP ${response.status})`);
    }
  }

  return {
    base,
    host,
    async listTools() {
      const result = (await rpc("tools/list", {})) as { tools?: unknown };
      if (!Array.isArray(result.tools)) return [];
      const out: McpRemoteTool[] = [];
      for (const raw of result.tools) {
        const t = raw as { name?: unknown; description?: unknown; inputSchema?: unknown };
        if (typeof t.name !== "string" || !MCP_TOOL_NAME.test(t.name)) continue;
        out.push({
          name: t.name,
          description: typeof t.description === "string" ? t.description.slice(0, MCP_TOOL_DESCRIPTION_CHARS) : "",
          inputSchema: normalizeMcpInputSchema(t.inputSchema),
        });
      }
      return out;
    },
    async callTool(name, args) {
      const result = (await rpc("tools/call", { name, arguments: args })) as McpToolResult;
      if (result.isError) throw new Error(`mcp tool ${name} returned an error`);
      return result;
    },
    async close() {
      if (closed) return;
      closed = true;
      clientAbort.abort();
      const closingSession = sessionId;
      sessionId = "";
      initialized = false;
      if (!closingSession) return;
      await terminateSession(closingSession);
    },
  };
}
