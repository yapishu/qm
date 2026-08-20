import type { DurableMap } from "../persistence/durable-map.ts";
import { createHash } from "node:crypto";
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
  operationLeases?: Record<string, number>;
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

export interface TlonInboundMessage {
  accountId: string;
  installationVersion: string;
  principalId: string;
  messageId: string;
  senderShip: string;
  text: string;
  content?: unknown;
  blob?: string;
  kind: "dm" | "channel";
  target: string;
  threadRoot?: string;
  parentAuthor?: string;
}

export interface TlonInboundRecord {
  id: string;
  message: TlonInboundMessage;
  previousId?: string;
  createdAt: number;
  claimToken?: string;
}

interface StoredTlonInbound extends TlonInboundRecord {
  orgId: string;
  claimUntil?: number;
  claimToken?: string;
}

export interface TlonInstallationStore {
  list(principalId: string): Promise<TlonConnectionStatus[]>;
  runtime(): Promise<TlonRuntimeConnection[]>;
  runtimeVersions(): Promise<Array<{ id: string; version: string }>>;
  create(principalId: string, input: TlonConnectionInput): Promise<TlonConnectionStatus>;
  update(principalId: string, id: string, input: TlonConnectionInput): Promise<TlonConnectionStatus | null>;
  delete(principalId: string, id: string): Promise<boolean>;
  report(id: string, input: { version: string; status: TlonRuntimeStatus; message?: string }): Promise<boolean>;
  acquire(id: string, version: string, ttlMs: number): Promise<string | null>;
  release(id: string, version: string, token: string): Promise<boolean>;
  enqueueInbound(message: TlonInboundMessage, previousId?: string): Promise<TlonInboundRecord>;
  claimInbound(ttlMs: number, limit: number): Promise<TlonInboundRecord[]>;
  releaseInbound(id: string, claimToken: string): Promise<boolean>;
  ackInbound(id: string, claimToken: string): Promise<boolean>;
}

const SHIP = /^~[a-z-]+$/;

export class TlonInstallationBusyError extends Error {}

function hasActiveLease(record: StoredTlonConnection): boolean {
  return Object.values(record.operationLeases ?? {}).some((expiresAt) => expiresAt > Date.now());
}

function normalizedShip(value: string, field: string): string {
  const ship = value.trim().toLowerCase();
  const normalized = ship.startsWith("~") ? ship : `~${ship}`;
  if (!SHIP.test(normalized)) throw new Error(`${field} must be a valid ship name`);
  return normalized;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function connectionId(orgId: string, principalId: string, ship: string): string {
  return createHash("sha256").update(`${orgId}\u0000${principalId}\u0000${ship}`).digest("hex").slice(0, 32);
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
  inbound: DurableMap<StoredTlonInbound>,
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
    async runtimeVersions() {
      return (await records()).map(({ id, version }) => ({ id, version }));
    },
    async create(principalId, input) {
      const owner = personKey(principalId);
      if (!owner) throw new Error("principal is required");
      const { code, ...normalized } = normalizedInput(input);
      if (!code) throw new Error("code is required");
      if (
        (await records()).some((record) => samePerson(record.principalId, owner) && record.ship === normalized.ship)
      ) {
        throw new Error("this ship is already connected");
      }
      const id = connectionId(orgId, owner, normalized.ship);
      const record: StoredTlonConnection = {
        orgId,
        id,
        principalId: owner,
        ...normalized,
        codeEnc: encryptSecret(code, key),
      };
      const stored = await map.putIfAbsent(mapKey(id), record);
      if (stored.version !== record.version) throw new Error("this ship is already connected");
      return publicStatus(record);
    },
    async update(principalId, id, input) {
      const { code, ...normalized } = normalizedInput(input);
      let owned = false;
      const updated = await map.update?.(mapKey(id), (record) => {
        if (record.orgId !== orgId || !samePerson(record.principalId, principalId)) return record;
        if (hasActiveLease(record)) throw new TlonInstallationBusyError("connection is busy; try again");
        if (normalized.ship !== record.ship) throw new Error("ship cannot be changed; create a new connection");
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
      const existing = await map.get(mapKey(id));
      if (!existing || existing.orgId !== orgId || !samePerson(existing.principalId, principalId)) return false;
      const deleted =
        (await map.deleteIf?.(mapKey(id), (record) => {
          if (record.orgId !== orgId || record.version !== existing.version) return false;
          if (!samePerson(record.principalId, principalId)) return false;
          if (hasActiveLease(record)) throw new TlonInstallationBusyError("connection is busy; try again");
          return true;
        })) ?? false;
      if (!deleted) return false;
      for (const [key, record] of await inbound.entries()) {
        if (
          record.orgId === orgId &&
          record.message.accountId === id &&
          record.message.installationVersion === existing.version
        ) {
          await inbound.deleteIf?.(
            key,
            (current) =>
              current.orgId === orgId &&
              current.message.accountId === id &&
              current.message.installationVersion === existing.version,
          );
        }
      }
      return true;
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
    async acquire(id, version, ttlMs) {
      const token = crypto.randomUUID();
      let accepted = false;
      await map.update?.(mapKey(id), (record) => {
        if (record.orgId !== orgId || record.version !== version) return record;
        accepted = true;
        const now = Date.now();
        const operationLeases = Object.fromEntries(
          Object.entries(record.operationLeases ?? {}).filter(([, expiresAt]) => expiresAt > now),
        );
        operationLeases[token] = now + ttlMs;
        return { ...record, operationLeases };
      });
      return accepted ? token : null;
    },
    async release(id, version, token) {
      let accepted = false;
      await map.update?.(mapKey(id), (record) => {
        if (record.orgId !== orgId || record.version !== version || !record.operationLeases?.[token]) return record;
        accepted = true;
        const operationLeases = { ...record.operationLeases };
        delete operationLeases[token];
        return { ...record, operationLeases };
      });
      return accepted;
    },
    async enqueueInbound(message, previousId) {
      const connection = (await records()).find((record) => record.id === message.accountId);
      const authorizedTarget =
        message.kind === "dm"
          ? message.target === connection?.ownerShip
          : connection?.channels.includes(message.target) === true;
      if (
        !connection ||
        connection.version !== message.installationVersion ||
        !samePerson(connection.principalId, message.principalId) ||
        connection.ownerShip !== message.senderShip ||
        !authorizedTarget
      ) {
        throw new Error("Tlon inbound message does not match its installation");
      }
      if (previousId) {
        const previous = await inbound.get(previousId);
        if (
          previous &&
          (previous.orgId !== orgId ||
            previous.message.accountId !== message.accountId ||
            previous.message.installationVersion !== message.installationVersion)
        ) {
          throw new Error("Tlon inbound predecessor belongs to another installation");
        }
      }
      const digest = createHash("sha256")
        .update(`${message.accountId}\u0000${message.installationVersion}\u0000${message.messageId}`)
        .digest("hex");
      const id = `${orgId}:${digest}`;
      const stored = await inbound.putIfAbsent(id, {
        orgId,
        id,
        message,
        ...(previousId ? { previousId } : {}),
        createdAt: Date.now(),
      });
      const current = await map.get(mapKey(message.accountId));
      if (!current || current.version !== message.installationVersion) {
        await inbound.deleteIf?.(
          id,
          (record) => record.orgId === orgId && record.message.installationVersion === message.installationVersion,
        );
        throw new Error("Tlon installation changed during inbound handoff");
      }
      return {
        id: stored.id,
        message: stored.message,
        ...(stored.previousId ? { previousId: stored.previousId } : {}),
        createdAt: stored.createdAt,
      };
    },
    async claimInbound(ttlMs, limit) {
      const now = Date.now();
      const pending = (await inbound.all())
        .filter((record) => record.orgId === orgId)
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
      const ids = new Set(pending.map((record) => record.id));
      const heads = pending.filter((record) => !record.previousId || !ids.has(record.previousId));
      const candidates: StoredTlonInbound[] = [];
      const accounts = new Set<string>();
      for (const record of heads) {
        if (accounts.has(record.message.accountId)) continue;
        accounts.add(record.message.accountId);
        if ((record.claimUntil ?? 0) <= now) candidates.push(record);
        if (candidates.length >= Math.max(1, limit)) break;
      }
      const claimed: TlonInboundRecord[] = [];
      for (const candidate of candidates) {
        const token = crypto.randomUUID();
        const updated = await inbound.update?.(candidate.id, (record) => {
          if (record.orgId !== orgId || (record.claimUntil ?? 0) > Date.now()) return record;
          return { ...record, claimUntil: Date.now() + ttlMs, claimToken: token };
        });
        if (updated?.claimToken === token) {
          claimed.push({
            id: updated.id,
            message: updated.message,
            ...(updated.previousId ? { previousId: updated.previousId } : {}),
            createdAt: updated.createdAt,
            claimToken: token,
          });
        }
      }
      return claimed;
    },
    async ackInbound(id, claimToken) {
      return (
        (await inbound.deleteIf?.(
          id,
          (record) =>
            record.orgId === orgId && record.claimToken === claimToken && (record.claimUntil ?? 0) > Date.now(),
        )) ?? false
      );
    },
    async releaseInbound(id, claimToken) {
      let accepted = false;
      await inbound.update?.(id, (record) => {
        if (record.orgId !== orgId || record.claimToken !== claimToken) return record;
        accepted = true;
        const { claimToken: _claimToken, claimUntil: _claimUntil, ...released } = record;
        return released;
      });
      return accepted;
    },
  };
}
