import type { DurableMap } from "../persistence/durable-map.ts";
import { decryptSecret, deriveConnectorKey, encryptSecret } from "../connectors/connector-client-store.ts";
import { personKey, samePerson } from "../directory/person.ts";

export type TlonRuntimeStatus = "pending" | "connecting" | "connected" | "error" | "stopped";

interface StoredTlonConnection {
  orgId: string;
  id: string;
  principalId: string;
  ship: string;
  url: string;
  codeEnc: string;
  ownerShip: string;
  channels: string[];
  respondWithoutMention: boolean;
  updatedAt: number;
  version: string;
  runtimeStatus: TlonRuntimeStatus;
  runtimeMessage?: string;
  runtimeSeenAt?: number;
}

export interface TlonConnectionStatus {
  id: string;
  ship: string;
  url: string;
  ownerShip: string;
  channels: string[];
  respondWithoutMention: boolean;
  updatedAt: number;
  version: string;
  runtimeStatus: TlonRuntimeStatus;
  runtimeMessage?: string;
  runtimeSeenAt?: number;
}

export interface TlonRuntimeConnection extends TlonConnectionStatus {
  principalId: string;
  code: string;
}

export interface TlonConnectionInput {
  ship: string;
  url: string;
  code: string;
  ownerShip: string;
  channels?: string[];
  respondWithoutMention?: boolean;
}

export interface TlonInstallationStore {
  list(principalId: string): Promise<TlonConnectionStatus[]>;
  runtime(): Promise<TlonRuntimeConnection[]>;
  create(principalId: string, input: TlonConnectionInput): Promise<TlonConnectionStatus>;
  update(principalId: string, id: string, input: TlonConnectionInput): Promise<TlonConnectionStatus | null>;
  delete(principalId: string, id: string): Promise<boolean>;
  report(id: string, input: { version: string; status: TlonRuntimeStatus; message?: string }): Promise<boolean>;
}

const SHIP = /^~[a-z-]+$/;

function normalizedShip(value: string, field: string): string {
  const ship = value.trim().toLowerCase();
  const normalized = ship.startsWith("~") ? ship : `~${ship}`;
  if (!SHIP.test(normalized)) throw new Error(`${field} must be a valid ship name`);
  return normalized;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizedChannel(value: string): string {
  const parts = value.trim().split("/");
  const prefix = parts[0]?.toLowerCase();
  if (parts.length !== 3 || !prefix || !["chat", "heap", "diary"].includes(prefix)) {
    throw new Error("channels must use chat/~host/name, heap/~host/name, or diary/~host/name");
  }
  const host = normalizedShip(parts[1] ?? "", "channels");
  const name = parts[2]?.trim() ?? "";
  if (!/^[^/\s]+$/.test(name)) {
    throw new Error("channels must use chat/~host/name, heap/~host/name, or diary/~host/name");
  }
  return `${prefix}/${host}/${name}`;
}

function publicStatus(record: StoredTlonConnection): TlonConnectionStatus {
  const runtimeStatus =
    record.runtimeSeenAt &&
    Date.now() - record.runtimeSeenAt > 20_000 &&
    (record.runtimeStatus === "connected" || record.runtimeStatus === "connecting")
      ? "stopped"
      : record.runtimeStatus;
  return {
    id: record.id,
    ship: record.ship,
    url: record.url,
    ownerShip: record.ownerShip,
    channels: record.channels,
    respondWithoutMention: record.respondWithoutMention,
    updatedAt: record.updatedAt,
    version: record.version,
    runtimeStatus,
    ...(record.runtimeMessage ? { runtimeMessage: record.runtimeMessage } : {}),
    ...(record.runtimeSeenAt ? { runtimeSeenAt: record.runtimeSeenAt } : {}),
  };
}

function normalizedInput(
  input: TlonConnectionInput,
): Omit<StoredTlonConnection, "orgId" | "id" | "principalId" | "codeEnc"> & { code: string } {
  const ship = normalizedShip(input.ship, "ship");
  const ownerShip = normalizedShip(input.ownerShip, "ownerShip");
  const channels = unique((input.channels ?? []).filter((value) => value.trim()).map(normalizedChannel));
  const url = new URL(input.url.trim());
  if (url.protocol !== "https:") throw new Error("url must use https");
  if (url.pathname !== "/") throw new Error("url must be an origin without a path");
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("url must not include credentials, query, or fragment");
  }
  const updatedAt = Date.now();
  return {
    ship,
    url: url.toString().replace(/\/$/, ""),
    code: input.code?.trim() ?? "",
    ownerShip,
    channels,
    respondWithoutMention: input.respondWithoutMention === true,
    updatedAt,
    version: `${updatedAt}:${crypto.randomUUID()}`,
    runtimeStatus: "pending",
  };
}

export function createTlonInstallationStore(
  orgId: string,
  map: DurableMap<StoredTlonConnection>,
  keyMaterial: Buffer | string,
): TlonInstallationStore {
  const key = deriveConnectorKey(keyMaterial, "tlon-installations");
  const mapKey = (id: string): string => `${orgId}:${id}`;
  const records = async (): Promise<StoredTlonConnection[]> =>
    (await map.all()).filter((record) => record.orgId === orgId).sort((a, b) => a.ship.localeCompare(b.ship));
  return {
    async list(principalId) {
      return (await records()).filter((record) => samePerson(record.principalId, principalId)).map(publicStatus);
    },
    async runtime() {
      return (await records()).map((record) => ({
        ...publicStatus(record),
        principalId: record.principalId,
        code: decryptSecret(record.codeEnc, key),
      }));
    },
    async create(principalId, input) {
      const owner = personKey(principalId);
      if (!owner) throw new Error("principal is required");
      const { code, ...normalized } = normalizedInput(input);
      if (!code) throw new Error("code is required");
      for (;;) {
        const id = crypto.randomUUID();
        const record: StoredTlonConnection = {
          orgId,
          id,
          principalId: owner,
          ...normalized,
          codeEnc: encryptSecret(code, key),
        };
        const stored = await map.putIfAbsent(mapKey(id), record);
        if (stored.version === record.version) return publicStatus(record);
      }
    },
    async update(principalId, id, input) {
      const { code, ...normalized } = normalizedInput(input);
      let owned = false;
      const updated = await map.update?.(mapKey(id), (record) => {
        if (record.orgId !== orgId || !samePerson(record.principalId, principalId)) return record;
        owned = true;
        return {
          ...record,
          ...normalized,
          codeEnc: code ? encryptSecret(code, key) : record.codeEnc,
        };
      });
      return owned && updated ? publicStatus(updated) : null;
    },
    async delete(principalId, id) {
      return (
        (await map.deleteIf?.(
          mapKey(id),
          (record) => record.orgId === orgId && samePerson(record.principalId, principalId),
        )) ?? false
      );
    },
    async report(id, input) {
      let accepted = false;
      const updated = await map.update?.(mapKey(id), (record) => {
        if (record.orgId !== orgId || record.version !== input.version) return record;
        accepted = true;
        return {
          ...record,
          runtimeStatus: input.status,
          runtimeSeenAt: Date.now(),
          ...(input.message ? { runtimeMessage: input.message.slice(0, 500) } : { runtimeMessage: undefined }),
        };
      });
      return accepted && updated?.runtimeStatus === input.status;
    },
  };
}
