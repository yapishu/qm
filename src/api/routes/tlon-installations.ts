import { sendJson } from "../http.ts";
import { errMessage } from "../../util/errors.ts";
import { audit, isObj } from "./shared.ts";
import type { ApiCtx, Route } from "./route.ts";
import type { TlonConnectionInput, TlonRuntimeStatus } from "../../surfaces/tlon-installation.ts";

const RUNTIME_STATUSES = new Set<TlonRuntimeStatus>(["pending", "connecting", "connected", "error", "stopped"]);

function principal(ctx: ApiCtx): string {
  return ctx.actor?.p ?? ctx.capability?.actorId ?? "";
}

function input(body: Record<string, unknown>): TlonConnectionInput {
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  return {
    ship: text(body.ship),
    url: text(body.url),
    code: text(body.code),
    ownerShip: text(body.ownerShip),
    channels: Array.isArray(body.channels)
      ? body.channels.filter((value): value is string => typeof value === "string")
      : [],
    respondWithoutMention: body.respondWithoutMention === true,
  };
}

function auditConnection(ctx: ApiCtx, actorId: string, action: string, resource: string): void {
  audit(ctx.deps, { principalId: actorId, action, resource, scopeLabel: `personal:${actorId}` });
}

async function listConnections(ctx: ApiCtx): Promise<void> {
  if (!ctx.deps.tlonInstallations) return sendJson(ctx.res, 404, { error: "not_configured" });
  const actorId = principal(ctx);
  if (!actorId) return sendJson(ctx.res, 401, { error: "unauthorized" });
  auditConnection(ctx, actorId, "tlon.connection.read", "tlon");
  return sendJson(ctx.res, 200, { connections: await ctx.deps.tlonInstallations.list(actorId) });
}

async function createConnection(ctx: ApiCtx): Promise<void> {
  if (!ctx.deps.tlonInstallations) return sendJson(ctx.res, 404, { error: "not_configured" });
  const actorId = principal(ctx);
  if (!actorId) return sendJson(ctx.res, 401, { error: "unauthorized" });
  if (!isObj(ctx.body)) return sendJson(ctx.res, 400, { error: "bad_request", message: "object required" });
  try {
    const connection = await ctx.deps.tlonInstallations.create(actorId, input(ctx.body));
    auditConnection(ctx, actorId, "tlon.connection.create", connection.id);
    return sendJson(ctx.res, 201, { connection });
  } catch (error) {
    return sendJson(ctx.res, 400, { error: "invalid_tlon_connection", message: errMessage(error) });
  }
}

async function updateConnection(ctx: ApiCtx): Promise<void> {
  if (!ctx.deps.tlonInstallations) return sendJson(ctx.res, 404, { error: "not_configured" });
  const actorId = principal(ctx);
  if (!actorId) return sendJson(ctx.res, 401, { error: "unauthorized" });
  if (!isObj(ctx.body)) return sendJson(ctx.res, 400, { error: "bad_request", message: "object required" });
  try {
    const connection = await ctx.deps.tlonInstallations.update(actorId, ctx.params.id ?? "", input(ctx.body));
    if (!connection) return sendJson(ctx.res, 404, { error: "not_found" });
    auditConnection(ctx, actorId, "tlon.connection.update", connection.id);
    return sendJson(ctx.res, 200, { connection });
  } catch (error) {
    return sendJson(ctx.res, 400, { error: "invalid_tlon_connection", message: errMessage(error) });
  }
}

async function deleteConnection(ctx: ApiCtx): Promise<void> {
  if (!ctx.deps.tlonInstallations) return sendJson(ctx.res, 404, { error: "not_configured" });
  const actorId = principal(ctx);
  if (!actorId) return sendJson(ctx.res, 401, { error: "unauthorized" });
  const id = ctx.params.id ?? "";
  if (!(await ctx.deps.tlonInstallations.delete(actorId, id))) return sendJson(ctx.res, 404, { error: "not_found" });
  auditConnection(ctx, actorId, "tlon.connection.delete", id);
  return sendJson(ctx.res, 200, { ok: true });
}

async function listRuntimeInstallations(ctx: ApiCtx): Promise<void> {
  if (!ctx.deps.tlonInstallations) return sendJson(ctx.res, 404, { error: "not_configured" });
  return sendJson(ctx.res, 200, { installations: await ctx.deps.tlonInstallations.runtime() });
}

async function reportRuntimeStatus(ctx: ApiCtx): Promise<void> {
  if (!ctx.deps.tlonInstallations) return sendJson(ctx.res, 404, { error: "not_configured" });
  if (!isObj(ctx.body)) return sendJson(ctx.res, 400, { error: "bad_request" });
  const version = typeof ctx.body.version === "string" ? ctx.body.version : "";
  const status = typeof ctx.body.status === "string" ? ctx.body.status : "";
  const message = typeof ctx.body.message === "string" ? ctx.body.message : undefined;
  if (!version || !RUNTIME_STATUSES.has(status as TlonRuntimeStatus)) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "version and valid status required" });
  }
  const updated = await ctx.deps.tlonInstallations.report(ctx.params.id ?? "", {
    version,
    status: status as TlonRuntimeStatus,
    ...(message ? { message } : {}),
  });
  return updated ? sendJson(ctx.res, 200, { ok: true }) : sendJson(ctx.res, 409, { error: "stale_installation" });
}

export const tlonInstallationRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/tlon/connections", auth: "either", handle: listConnections },
  { method: "POST", path: "/v1/tlon/connections", auth: "either", handle: createConnection },
  { method: "PUT", path: "/v1/tlon/connections/:id", auth: "either", handle: updateConnection },
  { method: "DELETE", path: "/v1/tlon/connections/:id", auth: "either", handle: deleteConnection },
  { method: "GET", path: "/v1/tlon/installations", auth: "source", handle: listRuntimeInstallations },
  { method: "POST", path: "/v1/tlon/installations/:id/status", auth: "source", handle: reportRuntimeStatus },
];
