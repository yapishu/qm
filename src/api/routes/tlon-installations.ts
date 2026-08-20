import { sendJson } from "../http.ts";
import { errMessage } from "../../util/errors.ts";
import { audit, isObj } from "./shared.ts";
import type { ApiCtx, Route } from "./route.ts";
import {
  TlonInstallationBusyError,
  type TlonConnectionInput,
  type TlonInboundMessage,
  type TlonRuntimeStatus,
} from "../../surfaces/tlon-installation.ts";
import type { Run } from "../../runs/run-store.ts";
import type { RunActivityEntry } from "../../runs/run-activity-store.ts";

const RUNTIME_STATUSES = new Set<TlonRuntimeStatus>(["pending", "connecting", "connected", "error", "stopped"]);

interface TlonRunTarget {
  accountId: string;
  accountVersion: string;
  conversationId: string;
}

function tlonRunTarget(run: Run): TlonRunTarget | null {
  if (run.request.surface !== "tlon" || !run.request.deliveryTarget) return null;
  try {
    const target = JSON.parse(Buffer.from(run.request.deliveryTarget, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    if (
      typeof target.accountId !== "string" ||
      typeof target.accountVersion !== "string" ||
      (target.kind !== "dm" && target.kind !== "channel") ||
      typeof target.target !== "string"
    )
      return null;
    return { accountId: target.accountId, accountVersion: target.accountVersion, conversationId: target.target };
  } catch {
    return null;
  }
}

function presenceToolName(value: unknown): string {
  if (value === "execute" || value === "exec") return "exec";
  if (value === "read") return "read";
  if (value === "web" || value === "web_fetch") return "web_fetch";
  return "tool";
}

function activePresenceTools(activity: RunActivityEntry[]): string[] {
  const active = new Map<string, string>();
  for (const entry of activity) {
    const payload = isObj(entry.payload) ? entry.payload : {};
    const callId = typeof payload.callId === "string" && payload.callId ? payload.callId : "";
    if (entry.type === "tool_call") active.set(callId || `seq:${entry.seq}`, presenceToolName(payload.tool));
    else if (entry.type === "tool_result") {
      if (callId) active.delete(callId);
      else active.clear();
    }
  }
  return [...new Set(active.values())];
}

async function presenceRun(ctx: ApiCtx, run: Run, target: TlonRunTarget): Promise<Record<string, unknown>> {
  const activity = await ctx.deps.runActivity?.list(run.id);
  return {
    runId: run.id,
    accountId: target.accountId,
    accountVersion: target.accountVersion,
    conversationId: target.conversationId,
    status: run.status,
    activeTools: activePresenceTools(activity ?? []),
  };
}

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

function inboundMessage(body: unknown): TlonInboundMessage | null {
  if (!isObj(body)) return null;
  const required = [
    "accountId",
    "installationVersion",
    "principalId",
    "messageId",
    "senderShip",
    "text",
    "target",
  ] as const;
  if (required.some((field) => typeof body[field] !== "string")) return null;
  if (body.kind !== "dm" && body.kind !== "channel") return null;
  const bounded = (field: (typeof required)[number], max: number): boolean =>
    (body[field] as string).length > 0 && (body[field] as string).length <= max;
  if (
    !bounded("accountId", 200) ||
    !bounded("principalId", 500) ||
    !bounded("messageId", 500) ||
    !bounded("senderShip", 200) ||
    (body.text as string).length > 200_000 ||
    !bounded("target", 600)
  )
    return null;
  if (body.blob !== undefined && (typeof body.blob !== "string" || body.blob.length > 100_000)) return null;
  const optional = (field: "threadRoot" | "parentAuthor"): string | undefined =>
    typeof body[field] === "string" && body[field].length <= 500 ? body[field] : undefined;
  return {
    accountId: body.accountId as string,
    installationVersion: body.installationVersion as string,
    principalId: body.principalId as string,
    messageId: body.messageId as string,
    senderShip: body.senderShip as string,
    text: body.text as string,
    ...(body.content !== undefined ? { content: body.content } : {}),
    ...(typeof body.blob === "string" ? { blob: body.blob } : {}),
    kind: body.kind,
    target: body.target as string,
    ...(optional("threadRoot") ? { threadRoot: optional("threadRoot") } : {}),
    ...(optional("parentAuthor") ? { parentAuthor: optional("parentAuthor") } : {}),
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
    if (error instanceof TlonInstallationBusyError) {
      return sendJson(ctx.res, 409, { error: "connection_busy", message: error.message });
    }
    return sendJson(ctx.res, 400, { error: "invalid_tlon_connection", message: errMessage(error) });
  }
}

async function deleteConnection(ctx: ApiCtx): Promise<void> {
  if (!ctx.deps.tlonInstallations) return sendJson(ctx.res, 404, { error: "not_configured" });
  const actorId = principal(ctx);
  if (!actorId) return sendJson(ctx.res, 401, { error: "unauthorized" });
  const id = ctx.params.id ?? "";
  try {
    if (!(await ctx.deps.tlonInstallations.delete(actorId, id))) return sendJson(ctx.res, 404, { error: "not_found" });
    auditConnection(ctx, actorId, "tlon.connection.delete", id);
    return sendJson(ctx.res, 200, { ok: true });
  } catch (error) {
    if (error instanceof TlonInstallationBusyError) {
      return sendJson(ctx.res, 409, { error: "connection_busy", message: error.message });
    }
    throw error;
  }
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

async function acquireOperationLease(ctx: ApiCtx): Promise<void> {
  const store = ctx.deps.tlonInstallations;
  if (!store) return sendJson(ctx.res, 404, { error: "not_configured" });
  if (!isObj(ctx.body) || typeof ctx.body.version !== "string") {
    return sendJson(ctx.res, 400, { error: "bad_request" });
  }
  const token = await store.acquire(ctx.params.id ?? "", ctx.body.version, 120_000);
  return sendJson(ctx.res, 200, { token });
}

async function releaseOperationLease(ctx: ApiCtx): Promise<void> {
  const store = ctx.deps.tlonInstallations;
  if (!store) return sendJson(ctx.res, 404, { error: "not_configured" });
  if (!isObj(ctx.body) || typeof ctx.body.version !== "string" || typeof ctx.body.token !== "string") {
    return sendJson(ctx.res, 400, { error: "bad_request" });
  }
  const released = await store.release(ctx.params.id ?? "", ctx.body.version, ctx.body.token);
  return released ? sendJson(ctx.res, 200, { ok: true }) : sendJson(ctx.res, 404, { error: "not_found" });
}

async function enqueueInbound(ctx: ApiCtx): Promise<void> {
  const store = ctx.deps.tlonInstallations;
  if (!store) return sendJson(ctx.res, 404, { error: "not_configured" });
  const envelope = isObj(ctx.body) && isObj(ctx.body.message) ? ctx.body : null;
  const message = inboundMessage(envelope?.message);
  const previousId = typeof envelope?.previousId === "string" && envelope.previousId ? envelope.previousId : undefined;
  if (!message) return sendJson(ctx.res, 400, { error: "bad_request" });
  try {
    const record = await store.enqueueInbound(message, previousId);
    return sendJson(ctx.res, 202, { id: record.id });
  } catch {
    return sendJson(ctx.res, 404, { error: "not_found" });
  }
}

async function claimInbound(ctx: ApiCtx): Promise<void> {
  const store = ctx.deps.tlonInstallations;
  if (!store) return sendJson(ctx.res, 404, { error: "not_configured" });
  const rawTtl = Number(ctx.url.searchParams.get("claimMs") ?? 0);
  const ttlMs = Number.isFinite(rawTtl) ? Math.min(300_000, Math.max(1_000, rawTtl)) : 30_000;
  return sendJson(ctx.res, 200, { records: await store.claimInbound(ttlMs, 2) });
}

async function ackInbound(ctx: ApiCtx): Promise<void> {
  const store = ctx.deps.tlonInstallations;
  if (!store) return sendJson(ctx.res, 404, { error: "not_configured" });
  const claimToken = isObj(ctx.body) && typeof ctx.body.claimToken === "string" ? ctx.body.claimToken : "";
  if (!claimToken) return sendJson(ctx.res, 400, { error: "bad_request" });
  return (await store.ackInbound(ctx.params.id ?? "", claimToken))
    ? sendJson(ctx.res, 200, { ok: true })
    : sendJson(ctx.res, 404, { error: "not_found" });
}

async function releaseInbound(ctx: ApiCtx): Promise<void> {
  const store = ctx.deps.tlonInstallations;
  if (!store) return sendJson(ctx.res, 404, { error: "not_configured" });
  const claimToken = isObj(ctx.body) && typeof ctx.body.claimToken === "string" ? ctx.body.claimToken : "";
  if (!claimToken) return sendJson(ctx.res, 400, { error: "bad_request" });
  return (await store.releaseInbound(ctx.params.id ?? "", claimToken))
    ? sendJson(ctx.res, 200, { ok: true })
    : sendJson(ctx.res, 404, { error: "not_found" });
}

async function listRunPresence(ctx: ApiCtx): Promise<void> {
  if (!ctx.deps.tlonInstallations || !ctx.deps.runs || !ctx.deps.runActivity) {
    return sendJson(ctx.res, 404, { error: "not_configured" });
  }
  const installationVersions = new Map(
    (await ctx.deps.tlonInstallations.runtimeVersions()).map(({ id, version }) => [id, version]),
  );
  const runs = await ctx.deps.runs.listActive();
  const snapshots = await Promise.all(
    runs.flatMap((run) => {
      const target = tlonRunTarget(run);
      return target && installationVersions.get(target.accountId) === target.accountVersion
        ? [presenceRun(ctx, run, target)]
        : [];
    }),
  );
  return sendJson(ctx.res, 200, { runs: snapshots });
}

async function getRunPresence(ctx: ApiCtx): Promise<void> {
  if (!ctx.deps.tlonInstallations || !ctx.deps.runs || !ctx.deps.runActivity) {
    return sendJson(ctx.res, 404, { error: "not_configured" });
  }
  const accountId = ctx.params.accountId ?? "";
  const version = (await ctx.deps.tlonInstallations.runtimeVersions()).find(({ id }) => id === accountId)?.version;
  if (!version) {
    return sendJson(ctx.res, 404, { error: "not_found" });
  }
  const run = await ctx.deps.runs.get(ctx.params.runId ?? "");
  const target = run ? tlonRunTarget(run) : null;
  if (!run || !target || target.accountId !== accountId || target.accountVersion !== version) {
    return sendJson(ctx.res, 404, { error: "not_found" });
  }
  return sendJson(ctx.res, 200, await presenceRun(ctx, run, target));
}

export const tlonInstallationRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/tlon/connections", auth: "either", handle: listConnections },
  { method: "POST", path: "/v1/tlon/connections", auth: "either", handle: createConnection },
  { method: "PUT", path: "/v1/tlon/connections/:id", auth: "either", handle: updateConnection },
  { method: "DELETE", path: "/v1/tlon/connections/:id", auth: "either", handle: deleteConnection },
  { method: "GET", path: "/v1/tlon/installations", auth: "source", handle: listRuntimeInstallations },
  { method: "POST", path: "/v1/tlon/installations/:id/status", auth: "source", handle: reportRuntimeStatus },
  { method: "POST", path: "/v1/tlon/installations/:id/lease", auth: "source", handle: acquireOperationLease },
  { method: "POST", path: "/v1/tlon/installations/:id/release", auth: "source", handle: releaseOperationLease },
  { method: "POST", path: "/v1/tlon/inbound", auth: "source", handle: enqueueInbound },
  { method: "GET", path: "/v1/tlon/inbound", auth: "source", handle: claimInbound },
  { method: "POST", path: "/v1/tlon/inbound/:id/ack", auth: "source", handle: ackInbound },
  { method: "POST", path: "/v1/tlon/inbound/:id/release", auth: "source", handle: releaseInbound },
  { method: "GET", path: "/v1/tlon/presence/runs", auth: "source", handle: listRunPresence },
  { method: "GET", path: "/v1/tlon/presence/runs/:accountId/:runId", auth: "source", handle: getRunPresence },
];
