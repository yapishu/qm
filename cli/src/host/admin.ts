import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { capture } from "../util.ts";
import { CliError, errMessage, note } from "../log.ts";
import { loadTenantHostConfig, type TenantHostConfig } from "./config.ts";
import { downTenant, findTenant, reconcileTenantGateway, tenantHostStatus, upTenant } from "./manager.ts";

interface AdminListen {
  host: string;
  port: number;
}

const assets = new Map<string, { type: string; body: Buffer }>();

function assetPath(name: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "../../templates/host-admin", name),
    join(here, "../../../templates/host-admin", name),
  ];
  const found = candidates.find(existsSync);
  if (!found) throw new CliError(`host admin asset is missing: ${name}`);
  return found;
}

function asset(name: string, type: string): { type: string; body: Buffer } {
  const cached = assets.get(name);
  if (cached) return cached;
  const loaded = { type, body: readFileSync(assetPath(name)) };
  assets.set(name, loaded);
  return loaded;
}

function parseListen(value: string | undefined): AdminListen {
  const raw = value?.trim() || "127.0.0.1:9080";
  const index = raw.lastIndexOf(":");
  if (index < 1) throw new CliError("QM_HOST_ADMIN_LISTEN must be host:port");
  const host = raw.slice(0, index);
  const port = Number(raw.slice(index + 1));
  if ((host !== "127.0.0.1" && host !== "::1") || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CliError("QM_HOST_ADMIN_LISTEN must use loopback and a port from 1 through 65535");
  }
  return { host, port };
}

function adminToken(value: string | undefined): string {
  const token = value?.trim() ?? "";
  if (token.length < 32) throw new CliError("QM_HOST_ADMIN_TOKEN must contain at least 32 characters");
  return token;
}

function assertAdminPortAvailable(host: TenantHostConfig, port: number): void {
  if (host.tenants.some((tenant) => tenant.exposedPorts.includes(port)) || port === 80 || port === 443) {
    throw new CliError(`host admin port ${port} conflicts with a tenant service or the HTTPS gateway`);
  }
}

function authorized(request: IncomingMessage, token: string): boolean {
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  const a = Buffer.from(supplied);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function headers(response: ServerResponse, contentType: string): void {
  response.setHeader("content-type", contentType);
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader(
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  );
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  headers(response, "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function staticResponse(response: ServerResponse, name: string, type: string): void {
  const loaded = asset(name, type);
  response.statusCode = 200;
  headers(response, loaded.type);
  response.end(loaded.body);
}

function tenantLogs(host: TenantHostConfig, orgId: string, service: string, tail: number): string {
  const tenant = findTenant(host, orgId);
  const allowed = new Set([
    "core",
    "web-ui",
    "admin",
    "portal",
    "auth",
    "slack",
    "pg",
    ...tenant.config.plugins.map((plugin) => plugin.name),
  ]);
  if (!allowed.has(service)) throw new CliError(`unknown service ${JSON.stringify(service)}`);
  const resolved = service === "slack" ? "core" : service;
  return capture("docker", ["logs", "--tail", String(tail), `qm-${orgId}-${resolved}`]);
}

export async function serveTenantHostAdmin(
  host: TenantHostConfig,
  options: { listen?: string; token?: string } = {},
): Promise<Server> {
  const listen = parseListen(options.listen ?? process.env.QM_HOST_ADMIN_LISTEN);
  const token = adminToken(options.token ?? process.env.QM_HOST_ADMIN_TOKEN);
  assertAdminPortAvailable(host, listen.port);
  const active = new Set<string>();
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        staticResponse(response, "index.html", "text/html; charset=utf-8");
        return;
      }
      if (request.method === "GET" && url.pathname === "/app.js") {
        staticResponse(response, "app.js", "text/javascript; charset=utf-8");
        return;
      }
      if (request.method === "GET" && url.pathname === "/style.css") {
        staticResponse(response, "style.css", "text/css; charset=utf-8");
        return;
      }
      if (request.method === "GET" && url.pathname === "/healthz") {
        json(response, 200, { ok: true });
        return;
      }
      if (!url.pathname.startsWith("/api/")) {
        json(response, 404, { error: "not found" });
        return;
      }
      if (!authorized(request, token)) {
        json(response, 401, { error: "unauthorized" });
        return;
      }
      const currentHost = loadTenantHostConfig(host.path);
      assertAdminPortAvailable(currentHost, listen.port);
      if (request.method === "GET" && url.pathname === "/api/status") {
        json(response, 200, tenantHostStatus(currentHost));
        return;
      }
      const logs = /^\/api\/tenants\/([^/]+)\/logs$/.exec(url.pathname);
      if (request.method === "GET" && logs) {
        const tailValue = Number(url.searchParams.get("tail") ?? "200");
        const tail = Number.isInteger(tailValue) ? Math.max(1, Math.min(2000, tailValue)) : 200;
        json(response, 200, {
          logs: tenantLogs(currentHost, decodeURIComponent(logs[1]!), url.searchParams.get("service") ?? "core", tail),
        });
        return;
      }
      if (request.method !== "POST") {
        json(response, 405, { error: "method not allowed" });
        return;
      }
      const action = /^\/api\/tenants\/([^/]+)\/(up|down)$/.exec(url.pathname);
      const operation = action ? decodeURIComponent(action[1]!) : url.pathname;
      if (active.has(operation)) {
        json(response, 409, { error: "operation already running" });
        return;
      }
      active.add(operation);
      try {
        if (url.pathname === "/api/gateway/reconcile") {
          reconcileTenantGateway(currentHost);
        } else if (action) {
          const tenant = findTenant(currentHost, decodeURIComponent(action[1]!));
          if (action[2] === "up") await upTenant(tenant);
          else await downTenant(tenant);
        } else {
          json(response, 404, { error: "not found" });
          return;
        }
      } finally {
        active.delete(operation);
      }
      json(response, 200, { ok: true, status: tenantHostStatus(currentHost) });
    } catch (error) {
      console.error(`[tenant-host-admin] ${errMessage(error)}`);
      json(response, error instanceof CliError ? 400 : 500, {
        error: error instanceof CliError ? error.message : "operation failed; inspect host admin logs",
      });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(listen.port, listen.host, () => resolve());
  });
  const address = isIP(listen.host) === 6 ? `[${listen.host}]` : listen.host;
  note(`tenant host admin listening on http://${address}:${listen.port}`);
  return server;
}
