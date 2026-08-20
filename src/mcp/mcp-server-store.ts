import type { DurableMap } from "../persistence/durable-map.ts";
import { createMemoryAdvisoryLock, type AdvisoryLock } from "../persistence/advisory-lock.ts";
import { decryptSecret, deriveConnectorKey, encryptSecret } from "../connectors/connector-client-store.ts";

export type McpServerAuthMode = "none" | "api-key" | "bearer";

export interface McpServer {
  id: string;
  name: string;
  url: string;
  auth: McpServerAuthMode;
  apiKey?: string;
  bearerToken?: string;
  readOnly: boolean;
  enabled: boolean;
  updatedAt: number;
  updatedBy: string;
}

export interface StoredMcpServer extends Omit<McpServer, "auth" | "apiKey" | "bearerToken"> {
  auth: McpServerAuthMode | "client-credentials";
  apiKeyEnc?: string;
  bearerTokenEnc?: string;
  apiKey?: string;
  bearerToken?: string;
  clientId?: string;
  clientSecretEnc?: string;
  clientSecret?: string;
}

const ID_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;
export const MAX_MCP_SERVERS = 16;
export const MIN_MCP_SECRET_CHARS = 8;
export type McpServerPutResult = "stored" | "limit" | "invalid" | "conflict";
export type McpServerDeleteResult = "deleted" | "not_found" | "conflict";

export function isValidMcpServerId(id: string): boolean {
  return ID_PATTERN.test(id);
}

export interface McpServerStore {
  list(): Promise<McpServer[]>;
  get(id: string): Promise<McpServer | null>;
  put(server: McpServer, expectedUpdatedAt?: number | null): Promise<McpServerPutResult>;
  delete(id: string, expectedUpdatedAt: number): Promise<McpServerDeleteResult>;
}

export function createMcpServerStore(input: {
  backing: DurableMap<StoredMcpServer>;
  keyMaterial: string | Buffer;
  lock?: AdvisoryLock;
}): McpServerStore {
  const { backing } = input;
  const lock = input.lock ?? createMemoryAdvisoryLock();
  const key = deriveConnectorKey(input.keyMaterial, "mcp-servers");
  const encode = (server: McpServer): StoredMcpServer => {
    const { apiKey, bearerToken, ...rest } = server;
    return {
      ...rest,
      ...(apiKey ? { apiKeyEnc: encryptSecret(apiKey, key) } : {}),
      ...(bearerToken ? { bearerTokenEnc: encryptSecret(bearerToken, key) } : {}),
    };
  };
  const decode = (stored: StoredMcpServer): McpServer => {
    const {
      apiKeyEnc,
      bearerTokenEnc,
      clientId: _clientId,
      clientSecretEnc: _clientSecretEnc,
      clientSecret: _clientSecret,
      auth,
      ...legacy
    } = stored;
    const apiKey = apiKeyEnc ? decryptSecret(apiKeyEnc, key) : legacy.apiKey;
    const bearerToken = bearerTokenEnc ? decryptSecret(bearerTokenEnc, key) : legacy.bearerToken;
    const { apiKey: _apiKey, bearerToken: _bearerToken, ...rest } = legacy;
    if (auth === "client-credentials") return { ...rest, auth: "none", enabled: false };
    return {
      ...rest,
      auth,
      ...(apiKey ? { apiKey } : {}),
      ...(bearerToken ? { bearerToken } : {}),
    };
  };
  const read = async (stored: StoredMcpServer): Promise<McpServer> => {
    const server = decode(stored);
    if (stored.apiKey || stored.bearerToken || stored.auth === "client-credentials") {
      await backing.update?.(server.id, (current) =>
        current.apiKey || current.bearerToken || current.auth === "client-credentials"
          ? encode(decode(current))
          : current,
      );
    }
    return server;
  };
  return {
    async list() {
      const entries = await backing.entries();
      return (await Promise.all(entries.map(([, value]) => read(value)))).sort((a, b) => a.id.localeCompare(b.id));
    },
    async get(id) {
      const stored = await backing.get(id);
      return stored ? read(stored) : null;
    },
    put: async (server, expectedUpdatedAt) => {
      return lock.withLock("mcp-servers", async () => {
        const stored = await backing.get(server.id);
        if (!stored && (await backing.entries()).length >= MAX_MCP_SERVERS) return "limit";
        const current = stored ? decode(stored) : null;
        if (expectedUpdatedAt !== undefined && (current?.updatedAt ?? null) !== expectedUpdatedAt) return "conflict";
        const merged: McpServer = {
          ...server,
          ...(server.auth === "api-key" &&
          !server.apiKey &&
          current?.auth === "api-key" &&
          current.url === server.url &&
          current.apiKey
            ? { apiKey: current.apiKey }
            : {}),
          ...(server.auth === "bearer" &&
          !server.bearerToken &&
          current?.auth === "bearer" &&
          current.url === server.url &&
          current.bearerToken
            ? { bearerToken: current.bearerToken }
            : {}),
        };
        if (merged.auth === "api-key" && (merged.apiKey?.length ?? 0) < MIN_MCP_SECRET_CHARS) return "invalid";
        if (merged.auth === "bearer" && (merged.bearerToken?.length ?? 0) < MIN_MCP_SECRET_CHARS) return "invalid";
        await backing.put(server.id, encode(merged));
        return "stored";
      });
    },
    delete: async (id, expectedUpdatedAt) => {
      return lock.withLock("mcp-servers", async () => {
        const stored = await backing.get(id);
        if (!stored) return "not_found";
        if (stored.updatedAt !== expectedUpdatedAt) return "conflict";
        await backing.delete(id);
        return "deleted";
      });
    },
  };
}
