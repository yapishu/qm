export interface TlonDeliveryTarget {
  accountId: string;
  accountVersion: string;
  kind: "dm" | "channel";
  target: string;
}

export function decodeTlonDeliveryTarget(value: string | undefined): TlonDeliveryTarget | null {
  if (!value) return null;
  try {
    const target = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      typeof target.accountId !== "string" ||
      typeof target.accountVersion !== "string" ||
      (target.kind !== "dm" && target.kind !== "channel") ||
      typeof target.target !== "string"
    )
      return null;
    return {
      accountId: target.accountId,
      accountVersion: target.accountVersion,
      kind: target.kind,
      target: target.target,
    };
  } catch {
    return null;
  }
}
