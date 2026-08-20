import type { DeliveryTarget } from "./types.ts";

export function encodeDeliveryTarget(target: DeliveryTarget): string {
  return Buffer.from(JSON.stringify(target)).toString("base64url");
}

export function decodeDeliveryTarget(value: string): DeliveryTarget {
  const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<DeliveryTarget>;
  if (
    typeof parsed.accountId !== "string" ||
    (parsed.kind !== "dm" && parsed.kind !== "channel") ||
    typeof parsed.target !== "string"
  ) {
    throw new Error("invalid Tlon delivery target");
  }
  return {
    accountId: parsed.accountId,
    ...(typeof parsed.accountVersion === "string" ? { accountVersion: parsed.accountVersion } : {}),
    kind: parsed.kind,
    target: parsed.target,
    ...(typeof parsed.replyTo === "string" ? { replyTo: parsed.replyTo } : {}),
    ...(typeof parsed.parentAuthor === "string" ? { parentAuthor: parsed.parentAuthor } : {}),
  };
}
