import { randomUUID } from "node:crypto";
import { hashId } from "../util/crypto.ts";

export function commandApprovalId(sessionId: string, command: string): string {
  return hashId([sessionId, command]);
}

export function commandApprovalControlId(runId: string | undefined, requestId: string): string {
  return hashId([runId ?? randomUUID(), requestId]);
}
