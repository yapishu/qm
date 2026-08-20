import type { Destination, OutgoingAttachment, PendingApproval, PendingApprovalRecord } from "../types.ts";
import type { Run, RunStore } from "../runs/run-store.ts";
import type { DeliveryStore } from "./delivery-store.ts";
import type { Task, TaskStore } from "../tasks/task-store.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { SECURITY_QUARANTINE_REFUSAL_TEXT } from "../../plugins/chassis/src/security-quarantine.ts";
import { resolveTurnOrigin } from "../core/turn-origin.ts";
import { commandApprovalControlId } from "../core/approval-id.ts";
import { errMessage } from "../util/errors.ts";
import type { TlonInstallationStore } from "../surfaces/tlon-installation.ts";
import { decodeTlonDeliveryTarget } from "../surfaces/tlon-delivery-target.ts";

export interface RunResultDelivery {
  destination: Destination;
  text: string;
  attachments?: OutgoingAttachment[];
  idempotencyKey: string;
}

function sameApprovalOccurrence(current: PendingApprovalRecord, snapshot: PendingApprovalRecord): boolean {
  return (
    current.sessionId === snapshot.sessionId &&
    current.sourceRunId === snapshot.sourceRunId &&
    current.controlId === snapshot.controlId &&
    current.command === snapshot.command &&
    current.createdAt === snapshot.createdAt &&
    current.request?.idempotencyKey === snapshot.request?.idempotencyKey &&
    current.request?.deliveryTarget === snapshot.request?.deliveryTarget &&
    current.request?.approvalDeliveryTarget === snapshot.request?.approvalDeliveryTarget
  );
}

function approvalText(approval: PendingApproval): string {
  const lines = ["🔒 **Approval needed**"];
  if (approval.summary) lines.push(approval.summary.slice(0, 400));
  if (approval.purpose) lines.push(`**Why:** ${approval.purpose.slice(0, 400)}`);
  lines.push(`**Command:** \`${approval.command.replace(/`/g, "'").slice(0, 2_000)}\``);
  lines.push(`**Flagged as:** ${approval.reason.slice(0, 200)}`);
  lines.push("");
  const control = `${approval.requestId}:${approval.controlId}`;
  lines.push(`Use the buttons below, or reply \`/qm approve ${control} once\` or \`/qm deny ${control}\`.`);
  return lines.join("\n");
}

function tlonApprovalDelivery(
  runId: string,
  request: {
    surface?: string;
    scopeVersion?: string;
    approvalDeliveryTarget?: string;
    approvalDeliveryQueueKey?: string;
  },
  approval: PendingApproval,
): RunResultDelivery | null {
  if (
    request.surface !== "tlon" ||
    !request.approvalDeliveryTarget ||
    typeof approval.controlId !== "string" ||
    !/^[a-f0-9]{16}$/.test(approval.controlId)
  )
    return null;
  return {
    destination: {
      type: "tlon",
      target: request.approvalDeliveryTarget,
      ...(request.approvalDeliveryQueueKey ? { queueKey: request.approvalDeliveryQueueKey } : {}),
      ...(request.scopeVersion ? { scopeVersion: request.scopeVersion } : {}),
      approvalRequests: [approval],
    },
    text: approvalText(approval),
    idempotencyKey: `approval:${runId}:${approval.controlId}`,
  };
}

export function runApprovalDeliveries(run: Run): RunResultDelivery[] {
  return (run.result?.pendingApprovals ?? [])
    .map((approval) => tlonApprovalDelivery(run.id, run.request, approval))
    .filter((delivery): delivery is RunResultDelivery => delivery !== null);
}

export async function reconcileTlonApprovalDeliveries(
  approvals: DurableMap<PendingApprovalRecord>,
  deliveries: DeliveryStore,
  runs?: RunStore,
  tlonInstallations?: Pick<TlonInstallationStore, "runtimeVersions">,
): Promise<void> {
  const entries = await approvals.entries();
  const runtimeVersions = tlonInstallations
    ? new Map(
        (await tlonInstallations.runtimeVersions()).map((installation) => [installation.id, installation.version]),
      )
    : null;
  const legacy = new Set(
    entries.filter(([, record]) => !record.sourceRunId || !record.controlId).map(([requestId]) => requestId),
  );
  const origins = new Map<string, Run>();
  const activeLegacySessions = new Set<string>();
  if (legacy.size && runs) {
    for (const run of await runs.listActive()) activeLegacySessions.add(run.sessionId);
    for (const run of await runs.list({ limit: 200 })) {
      for (const approval of run.result?.pendingApprovals ?? []) {
        if (legacy.has(approval.requestId) && !origins.has(approval.requestId)) origins.set(approval.requestId, run);
      }
    }
  }
  for (const [requestId, stored] of entries) {
    let record = stored;
    const origin = origins.get(requestId);
    if (legacy.has(requestId) && record.request?.surface === "tlon" && !origin) {
      if (activeLegacySessions.has(record.sessionId)) continue;
      await approvals.deleteIf?.(
        requestId,
        (current) => sameApprovalOccurrence(current, record) && (!current.sourceRunId || !current.controlId),
      );
      continue;
    }
    if (legacy.has(requestId) && record.request?.surface === "tlon") {
      const legacyTarget = decodeTlonDeliveryTarget(
        record.request.approvalDeliveryTarget ?? record.request.deliveryTarget,
      );
      if (legacyTarget?.kind !== "dm") {
        await approvals.deleteIf?.(
          requestId,
          (current) => sameApprovalOccurrence(current, record) && (!current.sourceRunId || !current.controlId),
        );
        continue;
      }
    }
    if (record.request?.surface === "tlon" && runtimeVersions) {
      const targetValue = record.request.approvalDeliveryTarget ?? record.request.deliveryTarget;
      const target = decodeTlonDeliveryTarget(targetValue);
      if (!target || runtimeVersions.get(target.accountId) !== target.accountVersion) {
        await approvals.deleteIf?.(
          requestId,
          (current) =>
            sameApprovalOccurrence(current, record) &&
            (current.request?.approvalDeliveryTarget ?? current.request?.deliveryTarget) === targetValue,
        );
        continue;
      }
    }
    if (
      origin &&
      approvals.update &&
      origin.sessionId === record.sessionId &&
      origin.result?.pendingApprovals?.some(
        (approval) => approval.requestId === requestId && approval.command === record.command,
      )
    ) {
      record =
        (await approvals.update(requestId, (current) =>
          sameApprovalOccurrence(current, record) && (!current.sourceRunId || !current.controlId)
            ? {
                ...current,
                sourceRunId: origin.id,
                controlId: commandApprovalControlId(origin.id, requestId),
                ...(current.request
                  ? {
                      request: {
                        ...current.request,
                        approvalDeliveryTarget:
                          current.request.approvalDeliveryTarget ?? current.request.deliveryTarget,
                        approvalDeliveryQueueKey:
                          current.request.approvalDeliveryQueueKey ?? current.request.deliveryQueueKey,
                      },
                    }
                  : {}),
              }
            : current,
        )) ?? record;
    }
    if (!record.sourceRunId || !record.request || !record.controlId) continue;
    const approval: PendingApproval = {
      requestId,
      controlId: record.controlId,
      command: record.command,
      reason: record.reason ?? "requires approval",
      ...(record.matched ? { matched: record.matched } : {}),
      ...(record.purpose ? { purpose: record.purpose } : {}),
      ...(record.summary ? { summary: record.summary } : {}),
      ...(record.approvalKey ? { approvalKey: record.approvalKey } : {}),
      ...(record.grantModes ? { grantModes: record.grantModes } : {}),
      blocksInput: record.blocksInput !== false,
      ...(record.kind === "approval" ? { kind: record.kind } : {}),
    };
    const delivery = tlonApprovalDelivery(record.sourceRunId, record.request, approval);
    if (delivery) await deliveries.enqueue(delivery);
  }
}

export function runResultDelivery(run: Run, taskList: Task[] = []): RunResultDelivery | null {
  const target = run.request.deliveryTarget;
  const surface = run.request.surface;
  if (!target || !surface) return null;
  const editRef = run.deliveryState?.editRef;
  const destination: Destination = {
    type: surface,
    target,
    ...(run.request.deliveryQueueKey ? { queueKey: run.request.deliveryQueueKey } : {}),
    ...(surface === "tlon" && run.request.scopeVersion ? { scopeVersion: run.request.scopeVersion } : {}),
    ...(editRef ? { editRef } : {}),
    ...(taskList.length ? { taskList: taskList.map(({ id, title, status }) => ({ id, title, status })) } : {}),
  };
  const idempotencyKey = `run:${run.id}`;
  if (
    surface === "slack" &&
    run.result?.status === "refused" &&
    run.result.refusalKind === "security_quarantine" &&
    run.request.addressed
  ) {
    return { destination, text: SECURITY_QUARANTINE_REFUSAL_TEXT, idempotencyKey };
  }
  if (run.request.surfaceTools && run.result?.status !== "failed" && !run.result?.attachments?.length) return null;
  if (run.status === "failed") {
    if (resolveTurnOrigin(run.request).kind === "ambient") return null;
    const reason = run.result?.reason ?? "unknown error";
    return { destination, text: `⚠️ I couldn't finish that turn: ${reason}`, idempotencyKey };
  }
  if (run.result?.status === "ok" && (run.result.reply || run.result.attachments?.length)) {
    return {
      destination,
      text: run.result.reply ?? "",
      ...(run.result.attachments?.length ? { attachments: run.result.attachments } : {}),
      idempotencyKey,
    };
  }
  return null;
}

export function wireRunResultDeliveries(runs: RunStore, deliveries: DeliveryStore, tasks?: TaskStore): void {
  const terminal = async (run: Run): Promise<void> => {
    const current = (await runs.get(run.id)) ?? run;
    const taskList = tasks ? await tasks.list({ originRunId: current.id }) : [];
    const delivery = runResultDelivery(current, taskList);
    const approvals = runApprovalDeliveries(current);
    await Promise.all([...(delivery ? [delivery] : []), ...approvals].map((item) => deliveries.enqueue(item)));
  };
  runs.onTerminal((run) => {
    void terminal(run).catch((err) =>
      console.error(`[delivery] failed to enqueue recovery delivery for run ${run.id}:`, errMessage(err)),
    );
  });
}
