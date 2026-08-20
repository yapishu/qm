import type { DurableMap } from "../persistence/durable-map.ts";
import { createHash, createHmac } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { decryptSecret, deriveConnectorKey, encryptSecret } from "../connectors/connector-client-store.ts";
import { personKey, samePerson } from "../directory/person.ts";
import { createNoopAdvisoryLock, type AdvisoryLock } from "../persistence/advisory-lock.ts";

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
  verifiedChannels?: string[];
  verifiedAt?: number;
  ownerVerifiedVersion?: string;
  principalActive?: boolean;
  blockedChannels?: string[];
  pendingRevocations?: Record<string, "block" | "remove" | "stale">;
  rosterEpoch?: number;
  channelEpochs?: Record<string, number>;
  pendingReconciliations?: string[];
  deletedAt?: number;
  respondWithoutMention: boolean;
  updatedAt: number;
  version: string;
  runtimeStatus: TlonRuntimeStatus;
  runtimeMessage?: string;
  runtimeSeenAt?: number;
  operationLeases?: Record<string, number>;
  channelLeases?: Record<string, { channel: string; scopeVersion: string; expiresAt: number }>;
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
  ownerVerified: boolean;
  ownerVerificationCode?: string;
  sharedChannelsEnabled: boolean;
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

export interface TlonChannelMember {
  principalId: string;
  displayName: string;
}

export interface TlonChannelSummary {
  channelId: string;
  name: string;
  isPrivate: true;
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
  scopeVersion?: string;
}

export interface TlonInboundRecord {
  id: string;
  queueKey: string;
  message: TlonInboundMessage;
  previousId?: string;
  createdAt: number;
  claimToken?: string;
}

interface StoredTlonInbound extends TlonInboundRecord {
  orgId: string;
  standby?: boolean;
  observations?: Record<string, { version: string; message: TlonInboundMessage; previousId?: string }>;
  claimUntil?: number;
  claimToken?: string;
}

export interface TlonInstallationStore {
  list(principalId: string): Promise<TlonConnectionStatus[]>;
  runtime(): Promise<TlonRuntimeConnection[]>;
  runtimeVersions(): Promise<Array<{ id: string; version: string }>>;
  recognizes(channelId: string): boolean;
  membership(channelId: string, principalId: string): Promise<boolean | undefined>;
  members(channelId: string): Promise<string[] | undefined>;
  channelMembers(channelId: string): Promise<TlonChannelMember[] | undefined>;
  channelsFor(principalId: string): Promise<TlonChannelSummary[]>;
  version(channelId: string): Promise<string | undefined>;
  withVersion<T>(channelId: string, version: string | undefined, fn: () => Promise<T>): Promise<T | undefined>;
  create(principalId: string, input: TlonConnectionInput): Promise<TlonConnectionStatus>;
  update(principalId: string, id: string, input: TlonConnectionInput): Promise<TlonConnectionStatus | null>;
  delete(principalId: string, id: string): Promise<boolean>;
  report(
    id: string,
    input: { version: string; status: TlonRuntimeStatus; message?: string; verifiedChannels?: string[] },
  ): Promise<boolean>;
  acquire(id: string, version: string, ttlMs: number, channel?: string, scopeVersion?: string): Promise<string | null>;
  release(id: string, version: string, token: string): Promise<boolean>;
  enqueueInbound(message: TlonInboundMessage, previousId?: string): Promise<TlonInboundRecord>;
  claimInbound(ttlMs: number, limit: number): Promise<TlonInboundRecord[]>;
  releaseInbound(id: string, claimToken: string): Promise<boolean>;
  ackInbound(id: string, claimToken: string): Promise<boolean>;
}

const SHIP = /^~[a-z-]+$/;
const MAX_TLON_CHANNELS = 100;
const MAX_TLON_CHANNEL_LENGTH = 600;
const TLON_RUNTIME_FRESH_MS = 20_000;
const TLON_MEMBERSHIP_FRESH_MS = 120_000;

export class TlonInstallationBusyError extends Error {}

function hasActiveLease(record: StoredTlonConnection): boolean {
  const now = Date.now();
  return (
    Object.values(record.operationLeases ?? {}).some((expiresAt) => expiresAt > now) ||
    Object.values(record.channelLeases ?? {}).some((lease) => lease.expiresAt > now)
  );
}

function normalizedShip(value: string, field: string): string {
  const ship = value.trim().toLowerCase();
  const normalized = ship.startsWith("~") ? ship : `~${ship}`;
  if (!SHIP.test(normalized)) throw new Error(`${field} must be a valid ship name`);
  return normalized;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function shipMentionPattern(ship: string, flags: string): RegExp {
  const escaped = ship.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9-])${escaped}(?=$|[^a-z0-9-])`, flags);
}

function hasShipMention(text: string, ship: string): boolean {
  return shipMentionPattern(ship, "i").test(text);
}

function stripShipMention(text: string, ship: string): string {
  return text.replace(shipMentionPattern(ship, "gi"), "$1").trim();
}

function connectionId(orgId: string, principalId: string, ship: string): string {
  return createHash("sha256").update(`${orgId}\u0000${principalId}\u0000${ship}`).digest("hex").slice(0, 32);
}

export function normalizeTlonChannel(value: string): string {
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
  const channel = `${prefix}/${host}/${name}`;
  if (channel.length > MAX_TLON_CHANNEL_LENGTH) throw new Error("channels must be at most 600 characters");
  return channel;
}

export function tlonChannelRef(channel: string): string {
  return `tlon:${encodeURIComponent(normalizeTlonChannel(channel))}`;
}

export function tlonChannelFromRef(channelId: string): string | null {
  if (!channelId.startsWith("tlon:")) return null;
  try {
    const channel = normalizeTlonChannel(decodeURIComponent(channelId.slice("tlon:".length)));
    return tlonChannelRef(channel) === channelId ? channel : null;
  } catch {
    return null;
  }
}

function publicStatus(record: StoredTlonConnection, ownerVerificationCode?: string): TlonConnectionStatus {
  const runtimeStatus =
    record.runtimeSeenAt &&
    Date.now() - record.runtimeSeenAt > TLON_RUNTIME_FRESH_MS &&
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
    ownerVerified: record.ownerVerifiedVersion === record.version,
    ...(record.ownerVerifiedVersion === record.version || !ownerVerificationCode ? {} : { ownerVerificationCode }),
    sharedChannelsEnabled: trustedSharedOrigin(record),
  };
}

function trustedSharedOrigin(record: Pick<StoredTlonConnection, "ship" | "url">): boolean {
  const url = new URL(record.url);
  return url.port === "" && url.hostname === `${record.ship.slice(1)}.tlon.network`;
}

function normalizedInput(
  input: TlonConnectionInput,
): Omit<StoredTlonConnection, "orgId" | "id" | "principalId" | "codeEnc"> & { code: string } {
  const ship = normalizedShip(input.ship, "ship");
  const ownerShip = normalizedShip(input.ownerShip, "ownerShip");
  const requestedChannels = (input.channels ?? []).filter((value) => value.trim());
  if (requestedChannels.length > MAX_TLON_CHANNELS) throw new Error("at most 100 channels can be configured");
  const channels = unique(requestedChannels.map(normalizeTlonChannel));
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
    verifiedChannels: [],
    rosterEpoch: 0,
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
  advisoryLock: AdvisoryLock = createNoopAdvisoryLock(),
  onMembershipChange?: (channelId: string, previous: string[], current: string[]) => Promise<void>,
  activePrincipal: (principalId: string) => boolean = () => true,
  refreshPrincipalState: () => Promise<void> = async () => {},
): TlonInstallationStore {
  const key = deriveConnectorKey(keyMaterial, "tlon-installations");
  const mapKey = (id: string): string => `${orgId}:${id}`;
  const storedRecords = async (): Promise<StoredTlonConnection[]> =>
    (await map.all()).filter((record) => record.orgId === orgId).sort((a, b) => a.ship.localeCompare(b.ship));
  const records = async (): Promise<StoredTlonConnection[]> =>
    (await storedRecords()).filter((record) => !record.deletedAt);
  const rosterContext = new AsyncLocalStorage<boolean>();
  const channelLockContext = new AsyncLocalStorage<Set<string>>();
  const withRosterLock = <T>(fn: () => Promise<T>): Promise<T> =>
    rosterContext.getStore() ? fn() : advisoryLock.withLock(`tlon-roster:${orgId}`, () => rosterContext.run(true, fn));
  const withChannelLocks = async <T>(channels: readonly string[], fn: () => Promise<T>): Promise<T> => {
    const held = channelLockContext.getStore() ?? new Set<string>();
    const keys = unique(channels)
      .sort()
      .map((channel) => `tlon-channel:${orgId}:${channel}`)
      .filter((key) => !held.has(key));
    if (advisoryLock.withLocks) {
      return advisoryLock.withLocks(keys, () => channelLockContext.run(new Set([...held, ...keys]), fn));
    }
    const acquire = async (index: number): Promise<T> => {
      const key = keys[index];
      if (!key) return fn();
      return advisoryLock.withLock(key, () =>
        channelLockContext.run(new Set([...held, key]), () => acquire(index + 1)),
      );
    };
    return acquire(0);
  };
  const ownerVerificationCode = (record: StoredTlonConnection): string =>
    createHmac("sha256", key.current)
      .update(`${record.id}\u0000${record.version}\u0000${record.ownerShip}`)
      .digest("hex")
      .slice(0, 12)
      .toUpperCase();
  const status = (record: StoredTlonConnection): TlonConnectionStatus =>
    publicStatus(record, ownerVerificationCode(record));
  const verifiedFor = (record: StoredTlonConnection, channel: string): boolean =>
    !record.deletedAt &&
    record.principalActive !== false &&
    record.blockedChannels?.includes(channel) !== true &&
    record.ownerVerifiedVersion === record.version &&
    trustedSharedOrigin(record) &&
    record.verifiedChannels?.includes(channel) === true;
  const memberIdsForChannel = async (channel: string): Promise<string[]> =>
    unique(
      (await records()).filter((record) => verifiedFor(record, channel)).map((record) => personKey(record.principalId)),
    ).sort();
  const inboundQueueKey = (message: TlonInboundMessage): string =>
    message.kind === "channel"
      ? `channel:${normalizeTlonChannel(message.target)}`
      : `dm:${message.accountId}:${message.installationVersion}:${message.target}`;
  const activeLeasedChannels = async (channels: readonly string[]): Promise<Set<string>> => {
    const selected = new Set(channels);
    const leased = new Set<string>();
    const now = Date.now();
    for (const record of await records()) {
      for (const lease of Object.values(record.channelLeases ?? {})) {
        if (lease.expiresAt > now && selected.has(lease.channel)) leased.add(lease.channel);
      }
    }
    return leased;
  };
  const hasActiveChannelLease = async (channels: readonly string[]): Promise<boolean> =>
    (await activeLeasedChannels(channels)).size > 0;
  const purgeInboundGeneration = async (id: string, version: string): Promise<void> => {
    for (const [key, record] of await inbound.entries()) {
      if (record.orgId !== orgId) continue;
      if (record.message.accountId === id && record.message.installationVersion === version) {
        await inbound.deleteIf?.(
          key,
          (current) =>
            current.orgId === orgId &&
            current.message.accountId === id &&
            current.message.installationVersion === version,
        );
        continue;
      }
      if (record.observations?.[id]?.version !== version) continue;
      if (record.standby && Object.keys(record.observations).length === 1) {
        await inbound.deleteIf?.(
          key,
          (current) =>
            current.orgId === orgId &&
            current.standby === true &&
            current.observations?.[id]?.version === version &&
            Object.keys(current.observations).length === 1,
        );
        continue;
      }
      const updated = await inbound.update?.(key, (current) => {
        if (current.observations?.[id]?.version !== version) return current;
        const observations = { ...current.observations };
        delete observations[id];
        return { ...current, observations };
      });
      if (updated?.standby && Object.keys(updated.observations ?? {}).length === 0) {
        await inbound.deleteIf?.(
          key,
          (current) =>
            current.orgId === orgId && current.standby === true && !Object.keys(current.observations ?? {}).length,
        );
      }
    }
  };
  const bumpChannelEpochs = (record: StoredTlonConnection, channels: readonly string[]): StoredTlonConnection => {
    const channelEpochs = { ...record.channelEpochs };
    for (const channel of record.verifiedChannels ?? []) {
      channelEpochs[channel] ??= record.rosterEpoch ?? 0;
    }
    for (const channel of unique(channels)) {
      channelEpochs[channel] = (channelEpochs[channel] ?? record.rosterEpoch ?? 0) + 1;
    }
    return { ...record, channelEpochs, rosterEpoch: (record.rosterEpoch ?? 0) + 1 };
  };
  const conflictingOwnerChannels = async (
    record: StoredTlonConnection,
    channels: readonly string[],
  ): Promise<string[]> => {
    const all = await records();
    return channels.filter((channel) =>
      all.some(
        (other) =>
          other.id !== record.id &&
          other.ownerShip === record.ownerShip &&
          !samePerson(other.principalId, record.principalId) &&
          verifiedFor(other, channel),
      ),
    );
  };
  const queueReconciliations = (record: StoredTlonConnection, channels: readonly string[]): StoredTlonConnection => ({
    ...record,
    pendingReconciliations: unique([...(record.pendingReconciliations ?? []), ...channels]).sort(),
  });
  const queueRevocations = (
    record: StoredTlonConnection,
    channels: readonly string[],
    reason: "block" | "remove" | "stale",
  ): StoredTlonConnection => {
    const pendingRevocations = { ...record.pendingRevocations };
    for (const channel of channels) {
      const current = pendingRevocations[channel];
      if (reason === "remove" || !current || (reason === "block" && current === "stale")) {
        pendingRevocations[channel] = reason;
      }
    }
    return { ...record, pendingRevocations };
  };
  const reconcilePendingLocked = async (channels?: readonly string[]): Promise<boolean> => {
    const selected = channels ? new Set(channels) : undefined;
    const pending = unique((await storedRecords()).flatMap((record) => record.pendingReconciliations ?? []))
      .filter((channel) => !selected || selected.has(channel))
      .sort();
    for (const channel of pending) {
      try {
        await onMembershipChange?.(tlonChannelRef(channel), [], await memberIdsForChannel(channel));
      } catch {
        return false;
      }
      for (const record of await storedRecords()) {
        if (!record.pendingReconciliations?.includes(channel)) continue;
        await map.update?.(mapKey(record.id), (current) => ({
          ...current,
          pendingReconciliations: current.pendingReconciliations?.filter((value) => value !== channel),
        }));
      }
    }
    for (const record of await storedRecords()) {
      if (record.deletedAt && !record.pendingReconciliations?.length) {
        await map.deleteIf?.(mapKey(record.id), (current) => current.orgId === orgId && !!current.deletedAt);
      }
    }
    return true;
  };
  const expireStaleLocked = async (channels?: readonly string[]): Promise<void> => {
    const selected = channels ? new Set(channels) : undefined;
    const now = Date.now();
    for (const record of await records()) {
      if (
        !record.verifiedChannels?.length ||
        !record.verifiedAt ||
        now - record.verifiedAt <= TLON_MEMBERSHIP_FRESH_MS ||
        (selected && !record.verifiedChannels.some((channel) => selected.has(channel)))
      ) {
        continue;
      }
      const affected = (record.verifiedChannels ?? []).filter((channel) => !selected || selected.has(channel));
      const leased = await activeLeasedChannels(affected);
      const expired = affected.filter((channel) => !leased.has(channel));
      const deferred = affected.filter((channel) => leased.has(channel));
      if (deferred.length) {
        await map.update?.(mapKey(record.id), (current) =>
          current.deletedAt || current.version !== record.version || current.verifiedAt !== record.verifiedAt
            ? current
            : queueRevocations(current, deferred, "stale"),
        );
      }
      if (!expired.length) continue;
      await map.update?.(mapKey(record.id), (current) =>
        current.deletedAt || current.version !== record.version || current.verifiedAt !== record.verifiedAt
          ? current
          : queueReconciliations(
              bumpChannelEpochs(
                {
                  ...current,
                  verifiedChannels: (current.verifiedChannels ?? []).filter((channel) => !expired.includes(channel)),
                  verifiedAt: (current.verifiedChannels ?? []).some((channel) => !expired.includes(channel))
                    ? current.verifiedAt
                    : undefined,
                  blockedChannels: (current.blockedChannels ?? []).filter((channel) => !expired.includes(channel)),
                },
                expired,
              ),
              expired,
            ),
      );
    }
  };
  const syncPrincipalStateLocked = async (channels?: readonly string[]): Promise<void> => {
    const selected = channels ? new Set(channels) : undefined;
    for (const record of await records()) {
      const verified = (record.verifiedChannels ?? []).filter((channel) => !selected || selected.has(channel));
      const blocked = (record.blockedChannels ?? []).filter((channel) => !selected || selected.has(channel));
      if (!verified.length && !blocked.length) continue;
      const active = activePrincipal(record.principalId);
      if (active) {
        const restored = blocked;
        if (!restored.length && record.principalActive !== false) continue;
        const affected = restored.length ? restored : verified;
        await map.update?.(mapKey(record.id), (stored) =>
          queueReconciliations(
            bumpChannelEpochs(
              {
                ...stored,
                principalActive: true,
                blockedChannels: (stored.blockedChannels ?? []).filter((channel) => !affected.includes(channel)),
              },
              affected,
            ),
            affected,
          ),
        );
        continue;
      }
      const available = verified.filter((channel) => !(record.blockedChannels ?? []).includes(channel));
      const leased = await activeLeasedChannels(available);
      const revoked = available.filter((channel) => !leased.has(channel));
      const deferred = available.filter((channel) => leased.has(channel));
      if (deferred.length) {
        await map.update?.(mapKey(record.id), (stored) => queueRevocations(stored, deferred, "block"));
      }
      if (!revoked.length) continue;
      await map.update?.(mapKey(record.id), (stored) =>
        queueReconciliations(
          bumpChannelEpochs(
            {
              ...stored,
              principalActive: leased.size > 0,
              blockedChannels: unique([...(stored.blockedChannels ?? []), ...revoked]),
            },
            revoked,
          ),
          revoked,
        ),
      );
    }
  };
  const applyPendingRevocationsLocked = async (channels?: readonly string[]): Promise<void> => {
    const selected = channels ? new Set(channels) : undefined;
    for (const record of await records()) {
      const pending = Object.entries(record.pendingRevocations ?? {}).filter(
        ([channel]) => !selected || selected.has(channel),
      );
      if (!pending.length) continue;
      const leased = await activeLeasedChannels(pending.map(([channel]) => channel));
      const ready = pending.filter(([channel]) => !leased.has(channel));
      if (!ready.length) continue;
      await map.update?.(mapKey(record.id), (stored) => {
        const removed = ready.filter(([, reason]) => reason !== "block").map(([channel]) => channel);
        const blocked = ready.filter(([, reason]) => reason === "block").map(([channel]) => channel);
        const affected = [...removed, ...blocked];
        const verifiedChannels = (stored.verifiedChannels ?? []).filter((channel) => !removed.includes(channel));
        const blockedChannels = unique([...(stored.blockedChannels ?? []), ...blocked]).filter(
          (channel) => !removed.includes(channel),
        );
        const pendingRevocations = { ...stored.pendingRevocations };
        for (const channel of affected) delete pendingRevocations[channel];
        const remainingVerified = verifiedChannels.filter((channel) => !blockedChannels.includes(channel));
        return queueReconciliations(
          bumpChannelEpochs(
            {
              ...stored,
              principalActive: blocked.length ? remainingVerified.length > 0 : stored.principalActive,
              verifiedChannels,
              blockedChannels,
              pendingRevocations,
            },
            affected,
          ),
          affected,
        );
      });
    }
  };
  const resolveOwnerConflictsLocked = async (channels: readonly string[]): Promise<void> => {
    for (const channel of channels) {
      if (await hasActiveChannelLease([channel])) continue;
      const eligible = (await records()).filter((record) => verifiedFor(record, channel));
      const winners = new Map<string, string>();
      for (const record of eligible) {
        const principalId = personKey(record.principalId);
        const winner = winners.get(record.ownerShip);
        if (!winner || principalId.localeCompare(winner) < 0) winners.set(record.ownerShip, principalId);
      }
      for (const record of eligible) {
        if (samePerson(record.principalId, winners.get(record.ownerShip) ?? record.principalId)) continue;
        await map.update?.(mapKey(record.id), (current) =>
          !current.verifiedChannels?.includes(channel)
            ? current
            : queueReconciliations(
                bumpChannelEpochs(
                  {
                    ...current,
                    verifiedChannels: current.verifiedChannels.filter((value) => value !== channel),
                  },
                  [channel],
                ),
                [channel],
              ),
        );
      }
    }
  };
  const refreshRoster = async (required = false, selectedChannels?: readonly string[]): Promise<void> => {
    await refreshPrincipalState();
    const reconciled = await withRosterLock(async () => {
      const stored = await storedRecords();
      const selected = selectedChannels ? new Set(selectedChannels) : undefined;
      const principalWide = selected
        ? stored.filter((record) => {
            const touchesSelection = [
              ...(record.verifiedChannels ?? []),
              ...(record.blockedChannels ?? []),
              ...Object.keys(record.pendingRevocations ?? {}),
            ].some((channel) => selected.has(channel));
            if (!touchesSelection) return false;
            const active = activePrincipal(record.principalId);
            const stateChanged = active !== (record.principalActive !== false);
            const pendingBlock = Object.entries(record.pendingRevocations ?? {}).some(
              ([channel, reason]) => selected.has(channel) && reason === "block",
            );
            return stateChanged || pendingBlock;
          })
        : stored;
      const channels = selectedChannels
        ? unique([
            ...selectedChannels,
            ...principalWide.flatMap((record) => [
              ...(record.verifiedChannels ?? []),
              ...(record.blockedChannels ?? []),
              ...(record.pendingReconciliations ?? []),
              ...Object.keys(record.pendingRevocations ?? {}),
            ]),
          ])
        : unique(
            stored.flatMap((record) => [
              ...(record.verifiedChannels ?? []),
              ...(record.pendingReconciliations ?? []),
              ...Object.keys(record.pendingRevocations ?? {}),
            ]),
          );
      return withChannelLocks(channels, async () => {
        if (!(await reconcilePendingLocked(channels))) return false;
        await applyPendingRevocationsLocked(channels);
        if (!(await reconcilePendingLocked(channels))) return false;
        await syncPrincipalStateLocked(channels);
        await expireStaleLocked(channels);
        await resolveOwnerConflictsLocked(channels);
        return reconcilePendingLocked(channels);
      });
    });
    if (required && !reconciled) throw new Error("Tlon membership reconciliation is pending");
  };
  const channelVersion = async (channel: string): Promise<string | undefined> => {
    const members = (await records())
      .filter((record) => verifiedFor(record, channel))
      .map((record) => `${record.id}:${record.version}:${record.channelEpochs?.[channel] ?? record.rosterEpoch ?? 0}`)
      .sort();
    if (!members.length) return undefined;
    return createHash("sha256").update(members.join("\u0000")).digest("hex");
  };
  const channelMembers = async (channelId: string): Promise<TlonChannelMember[] | undefined> => {
    const channel = tlonChannelFromRef(channelId);
    if (!channel) return undefined;
    const members = new Map<string, TlonChannelMember>();
    for (const record of await records()) {
      if (!verifiedFor(record, channel)) continue;
      const principalId = personKey(record.principalId);
      if (!members.has(principalId)) members.set(principalId, { principalId, displayName: record.ownerShip });
    }
    return [...members.values()].sort((a, b) => a.principalId.localeCompare(b.principalId));
  };
  const runtimeRecords = async (): Promise<StoredTlonConnection[]> => {
    await refreshPrincipalState();
    let current = await records();
    if (
      current.some(
        (record) =>
          (record.principalActive ?? true) !== activePrincipal(record.principalId) ||
          (!!record.blockedChannels?.length && activePrincipal(record.principalId)),
      )
    ) {
      await refreshRoster(true);
      current = await records();
    }
    return current.filter((record) => activePrincipal(record.principalId));
  };
  return {
    async list(principalId) {
      await refreshRoster();
      return (await records()).filter((record) => samePerson(record.principalId, principalId)).map(status);
    },
    async runtime() {
      return (await runtimeRecords()).map((record) => ({
        ...status(record),
        principalId: record.principalId,
        code: decryptSecret(record.codeEnc, key),
      }));
    },
    async runtimeVersions() {
      return (await runtimeRecords()).map(({ id, version }) => ({ id, version }));
    },
    recognizes(channelId) {
      return tlonChannelFromRef(channelId) !== null;
    },
    async membership(channelId, principalId) {
      const channel = tlonChannelFromRef(channelId);
      if (!channel) return undefined;
      await refreshRoster(false, [channel]);
      return (await records()).some(
        (record) => samePerson(record.principalId, principalId) && verifiedFor(record, channel),
      );
    },
    async channelMembers(channelId) {
      const channel = tlonChannelFromRef(channelId);
      if (!channel) return undefined;
      await refreshRoster(false, [channel]);
      return channelMembers(channelId);
    },
    async members(channelId) {
      const channel = tlonChannelFromRef(channelId);
      if (!channel) return undefined;
      await refreshRoster(false, [channel]);
      return (await channelMembers(channelId))?.map((member) => member.principalId);
    },
    async channelsFor(principalId) {
      await refreshRoster();
      const channels = new Map<string, TlonChannelSummary>();
      for (const record of await records()) {
        if (!samePerson(record.principalId, principalId)) continue;
        for (const channel of (record.verifiedChannels ?? []).filter((value) => verifiedFor(record, value))) {
          const channelId = tlonChannelRef(channel);
          channels.set(channelId, {
            channelId,
            name: channel.split("/").at(-1) ?? channel,
            isPrivate: true,
          });
        }
      }
      return [...channels.values()].sort((a, b) => a.channelId.localeCompare(b.channelId));
    },
    async version(channelId) {
      const channel = tlonChannelFromRef(channelId);
      if (!channel) return undefined;
      await refreshRoster(false, [channel]);
      return channelVersion(channel);
    },
    async withVersion(channelId, version, fn) {
      const channel = tlonChannelFromRef(channelId);
      if (!channel) return undefined;
      await refreshRoster(true, [channel]);
      return withChannelLocks([channel], async () => ((await channelVersion(channel)) === version ? fn() : undefined));
    },
    async create(principalId, input) {
      await refreshRoster(true);
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
        principalActive: activePrincipal(owner),
        ...normalized,
        codeEnc: encryptSecret(code, key),
      };
      const stored = await map.putIfAbsent(mapKey(id), record);
      if (stored.version !== record.version) throw new Error("this ship is already connected");
      return status(record);
    },
    async update(principalId, id, input) {
      const { code, ...normalized } = normalizedInput(input);
      const existing = await map.get(mapKey(id));
      if (!existing || existing.deletedAt || existing.orgId !== orgId || !samePerson(existing.principalId, principalId))
        return null;
      await refreshRoster(true, unique([...(existing.verifiedChannels ?? []), ...normalized.channels]));
      const result = await withRosterLock(async () => {
        const current = await map.get(mapKey(id));
        const watched = unique([...(current?.verifiedChannels ?? []), ...normalized.channels]);
        return withChannelLocks(watched, async () => {
          if (await hasActiveChannelLease(watched)) {
            throw new TlonInstallationBusyError("shared channel is busy; try again");
          }
          let owned = false;
          let previousVersion = "";
          const updated = await map.update?.(mapKey(id), (record) => {
            if (record.deletedAt || record.orgId !== orgId || !samePerson(record.principalId, principalId))
              return record;
            if (hasActiveLease(record)) throw new TlonInstallationBusyError("connection is busy; try again");
            if (normalized.ship !== record.ship) throw new Error("ship cannot be changed; create a new connection");
            owned = true;
            previousVersion = record.version;
            const affected = unique([...(record.verifiedChannels ?? []), ...normalized.channels]);
            return queueReconciliations(
              bumpChannelEpochs(
                {
                  ...record,
                  ...normalized,
                  ownerVerifiedVersion:
                    record.ownerVerifiedVersion === record.version &&
                    normalized.ownerShip === record.ownerShip &&
                    normalized.url === record.url
                      ? normalized.version
                      : undefined,
                  blockedChannels: [],
                  codeEnc: code ? encryptSecret(code, key) : record.codeEnc,
                },
                affected,
              ),
              affected,
            );
          });
          if (owned && updated && previousVersion && updated.version !== previousVersion) {
            await purgeInboundGeneration(id, previousVersion);
          }
          await reconcilePendingLocked(watched);
          return owned && updated ? status(updated) : null;
        });
      });
      return result;
    },
    async delete(principalId, id) {
      const existing = await map.get(mapKey(id));
      if (!existing || existing.deletedAt || existing.orgId !== orgId || !samePerson(existing.principalId, principalId))
        return false;
      await refreshRoster(true, existing.verifiedChannels ?? []);
      let deleted = false;
      await withRosterLock(async () => {
        await withChannelLocks(existing.verifiedChannels ?? [], async () => {
          if (await hasActiveChannelLease(existing.verifiedChannels ?? [])) {
            throw new TlonInstallationBusyError("shared channel is busy; try again");
          }
          await map.update?.(mapKey(id), (record) => {
            if (record.deletedAt || record.orgId !== orgId || record.version !== existing.version) return record;
            if (!samePerson(record.principalId, principalId)) return record;
            if (hasActiveLease(record)) throw new TlonInstallationBusyError("connection is busy; try again");
            deleted = true;
            return queueReconciliations(
              bumpChannelEpochs(
                {
                  ...record,
                  deletedAt: Date.now(),
                  runtimeStatus: "stopped",
                  runtimeMessage: undefined,
                  verifiedChannels: [],
                  blockedChannels: [],
                },
                record.verifiedChannels ?? [],
              ),
              record.verifiedChannels ?? [],
            );
          });
          await reconcilePendingLocked(existing.verifiedChannels ?? []);
        });
      });
      if (!deleted) return false;
      await purgeInboundGeneration(id, existing.version);
      return true;
    },
    async report(id, input) {
      await refreshPrincipalState();
      const verifiedChannels = input.verifiedChannels?.map(normalizeTlonChannel);
      let fastAccepted = false;
      let requiresReconciliation = false;
      const fastUpdated = await map.update?.(mapKey(id), (record) => {
        if (record.deletedAt || record.orgId !== orgId || record.version !== input.version) return record;
        if (verifiedChannels) {
          if (verifiedChannels.length && input.status !== "connected") {
            throw new Error("verified channels require connected status");
          }
          if (verifiedChannels.some((channel) => !record.channels.includes(channel))) {
            throw new Error("verified channels must be configured on this connection");
          }
        }
        const nextVerified = unique(verifiedChannels ?? record.verifiedChannels ?? []);
        const changed =
          nextVerified.length !== (record.verifiedChannels ?? []).length ||
          nextVerified.some((channel) => !record.verifiedChannels?.includes(channel));
        requiresReconciliation =
          changed ||
          !!record.pendingReconciliations?.length ||
          !!Object.keys(record.pendingRevocations ?? {}).length ||
          (record.principalActive ?? true) !== activePrincipal(record.principalId) ||
          (!!record.blockedChannels?.length && activePrincipal(record.principalId));
        if (requiresReconciliation) return record;
        fastAccepted = true;
        return {
          ...record,
          runtimeStatus: input.status,
          runtimeSeenAt: Date.now(),
          verifiedChannels: nextVerified,
          ...(verifiedChannels ? { verifiedAt: Date.now() } : {}),
          ...(input.message ? { runtimeMessage: input.message.slice(0, 500) } : { runtimeMessage: undefined }),
        };
      });
      if (fastAccepted) return fastUpdated?.runtimeStatus === input.status;
      if (!requiresReconciliation) return false;
      const existing = await map.get(mapKey(id));
      if (!existing || existing.deletedAt || existing.orgId !== orgId || existing.version !== input.version)
        return false;
      await refreshRoster(true, unique([...(existing.verifiedChannels ?? []), ...(verifiedChannels ?? [])]));
      return withRosterLock(async () => {
        const current = await map.get(mapKey(id));
        const watched = unique([...(current?.verifiedChannels ?? []), ...(verifiedChannels ?? [])]);
        return withChannelLocks(watched, async () => {
          const nextVerified = unique(verifiedChannels ?? current?.verifiedChannels ?? []);
          const changed =
            nextVerified.length !== (current?.verifiedChannels ?? []).length ||
            nextVerified.some((channel) => !current?.verifiedChannels?.includes(channel));
          const changedChannels = unique([...(current?.verifiedChannels ?? []), ...nextVerified]).filter(
            (channel) => (current?.verifiedChannels?.includes(channel) ?? false) !== nextVerified.includes(channel),
          );
          if (changed && (await hasActiveChannelLease(changedChannels))) {
            const removed = changedChannels.filter(
              (channel) => current?.verifiedChannels?.includes(channel) && !nextVerified.includes(channel),
            );
            if (removed.length) {
              await map.update?.(mapKey(id), (record) => queueRevocations(record, removed, "remove"));
            }
            throw new TlonInstallationBusyError("shared channel is busy; try again");
          }
          const conflicts =
            current && current.ownerVerifiedVersion === current.version
              ? await conflictingOwnerChannels(current, nextVerified)
              : [];
          if (conflicts.length) throw new Error("this Tlon owner is already linked to another user in the channel");
          let accepted = false;
          const updated = await map.update?.(mapKey(id), (record) => {
            if (record.deletedAt || record.orgId !== orgId || record.version !== input.version) return record;
            if (verifiedChannels) {
              if (verifiedChannels.length && input.status !== "connected") {
                throw new Error("verified channels require connected status");
              }
              if (verifiedChannels.some((channel) => !record.channels.includes(channel))) {
                throw new Error("verified channels must be configured on this connection");
              }
            }
            accepted = true;
            const changed =
              nextVerified.length !== (record.verifiedChannels ?? []).length ||
              nextVerified.some((channel) => !record.verifiedChannels?.includes(channel));
            const next = {
              ...record,
              runtimeStatus: input.status,
              runtimeSeenAt: Date.now(),
              verifiedChannels: nextVerified,
              blockedChannels: (record.blockedChannels ?? []).filter((channel) => nextVerified.includes(channel)),
              pendingRevocations: Object.fromEntries(
                Object.entries(record.pendingRevocations ?? {}).filter(
                  ([channel, reason]) => reason !== "stale" || !verifiedChannels || !nextVerified.includes(channel),
                ),
              ),
              ...(verifiedChannels ? { verifiedAt: Date.now() } : {}),
              ...(input.message ? { runtimeMessage: input.message.slice(0, 500) } : { runtimeMessage: undefined }),
            };
            return queueReconciliations(changed ? bumpChannelEpochs(next, changedChannels) : next, changedChannels);
          });
          await reconcilePendingLocked(watched);
          return accepted && updated?.runtimeStatus === input.status;
        });
      });
    },
    async acquire(id, version, ttlMs, channel, scopeVersion) {
      const normalizedChannel = channel ? normalizeTlonChannel(channel) : undefined;
      if (normalizedChannel) await refreshRoster(true, [normalizedChannel]);
      else await refreshPrincipalState();
      const token = crypto.randomUUID();
      let accepted = false;
      const reserve = async (): Promise<void> => {
        const currentScopeVersion = normalizedChannel ? await channelVersion(normalizedChannel) : undefined;
        if (normalizedChannel && (!currentScopeVersion || (scopeVersion && scopeVersion !== currentScopeVersion)))
          return;
        await map.update?.(mapKey(id), (record) => {
          if (record.deletedAt || record.orgId !== orgId || record.version !== version) return record;
          if (!activePrincipal(record.principalId)) return record;
          if (normalizedChannel && !verifiedFor(record, normalizedChannel)) return record;
          accepted = true;
          const now = Date.now();
          const operationLeases = Object.fromEntries(
            Object.entries(record.operationLeases ?? {}).filter(([, expiresAt]) => expiresAt > now),
          );
          const channelLeases = Object.fromEntries(
            Object.entries(record.channelLeases ?? {}).filter(([, lease]) => lease.expiresAt > now),
          );
          operationLeases[token] = now + ttlMs;
          if (normalizedChannel && currentScopeVersion) {
            channelLeases[token] = {
              channel: normalizedChannel,
              scopeVersion: currentScopeVersion,
              expiresAt: now + ttlMs,
            };
          }
          return { ...record, operationLeases, channelLeases };
        });
      };
      if (normalizedChannel) await withChannelLocks([normalizedChannel], reserve);
      else await reserve();
      return accepted ? token : null;
    },
    async release(id, version, token) {
      let accepted = false;
      await map.update?.(mapKey(id), (record) => {
        if (
          record.deletedAt ||
          record.orgId !== orgId ||
          record.version !== version ||
          !record.operationLeases?.[token]
        )
          return record;
        accepted = true;
        const operationLeases = { ...record.operationLeases };
        const channelLeases = { ...record.channelLeases };
        delete operationLeases[token];
        delete channelLeases[token];
        return { ...record, operationLeases, channelLeases };
      });
      return accepted;
    },
    async enqueueInbound(message, previousId) {
      const rawQueueKey = inboundQueueKey(message);
      const storedConnection = await map.get(mapKey(message.accountId));
      await refreshRoster(true, storedConnection?.verifiedChannels ?? []);
      const connection = (await records()).find((record) => record.id === message.accountId);
      if (connection && !activePrincipal(connection.principalId)) {
        return {
          id: `${orgId}:principal-inactive:${connection.id}:${message.messageId}`,
          queueKey: rawQueueKey,
          message,
          createdAt: Date.now(),
        };
      }
      const matchesConnection =
        !!connection &&
        connection.version === message.installationVersion &&
        samePerson(connection.principalId, message.principalId);
      const ownerMessage = matchesConnection && connection.ownerShip === message.senderShip;
      if (
        ownerMessage &&
        message.kind === "dm" &&
        message.target === connection.ownerShip &&
        message.text.trim() === `/qm-link ${ownerVerificationCode(connection)}`
      ) {
        if (connection.ownerVerifiedVersion !== connection.version) {
          await withRosterLock(async () => {
            await withChannelLocks(connection.verifiedChannels ?? [], async () => {
              const current = await map.get(mapKey(connection.id));
              const conflicts = current ? await conflictingOwnerChannels(current, current.verifiedChannels ?? []) : [];
              if (!conflicts.length && !(await hasActiveChannelLease(connection.verifiedChannels ?? []))) {
                await map.update?.(mapKey(connection.id), (record) => {
                  if (record.deletedAt || record.version !== message.installationVersion) return record;
                  return queueReconciliations(
                    bumpChannelEpochs(
                      { ...record, ownerVerifiedVersion: record.version },
                      record.verifiedChannels ?? [],
                    ),
                    record.verifiedChannels ?? [],
                  );
                });
                await reconcilePendingLocked(connection.verifiedChannels ?? []);
              }
            });
          });
        }
        return {
          id: `${orgId}:owner-verified:${connection.id}:${connection.version}`,
          queueKey: rawQueueKey,
          message,
          createdAt: Date.now(),
        };
      }
      if (ownerMessage && connection.ownerVerifiedVersion !== connection.version) {
        return {
          id: `${orgId}:owner-unverified:${connection.id}:${message.messageId}`,
          queueKey: rawQueueKey,
          message,
          createdAt: Date.now(),
        };
      }
      if (matchesConnection && message.kind === "channel" && !trustedSharedOrigin(connection)) {
        return {
          id: `${orgId}:channel-untrusted:${connection.id}:${message.messageId}`,
          queueKey: rawQueueKey,
          message,
          createdAt: Date.now(),
        };
      }
      if (!matchesConnection || connection.ownerVerifiedVersion !== connection.version) {
        throw new Error("Tlon inbound message does not match its installation");
      }
      let acceptedMessage = message;
      if (message.kind === "dm") {
        if (!ownerMessage || message.target !== connection.ownerShip) {
          throw new Error("Tlon inbound message does not match its installation");
        }
      } else {
        if (!trustedSharedOrigin(connection) || !connection.channels.includes(message.target)) {
          throw new Error("Tlon inbound message does not match its installation");
        }
        const channelRecords = (await records()).filter((record) => verifiedFor(record, message.target));
        if (channelRecords.some((record) => record.ship === message.senderShip)) {
          return {
            id: `${orgId}:channel-bot:${connection.id}:${message.messageId}`,
            queueKey: rawQueueKey,
            message,
            createdAt: Date.now(),
          };
        }
        const rawText = message.text.trim();
        const actorConnections = channelRecords
          .filter((record) => record.ownerShip === message.senderShip)
          .sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id));
        const actorConnection =
          actorConnections.find((record) => hasShipMention(rawText, record.ship)) ??
          actorConnections.find((record) => record.respondWithoutMention);
        if (!actorConnection) {
          return {
            id: `${orgId}:channel-unaddressed:${connection.id}:${message.messageId}`,
            queueKey: rawQueueKey,
            message,
            createdAt: Date.now(),
          };
        }
        const text = hasShipMention(rawText, actorConnection.ship)
          ? stripShipMention(rawText, actorConnection.ship)
          : rawText;
        acceptedMessage = {
          ...message,
          accountId: actorConnection.id,
          installationVersion: actorConnection.version,
          principalId: actorConnection.principalId,
          text,
        };
      }
      const queueKey = inboundQueueKey(acceptedMessage);
      const digest = createHash("sha256")
        .update(
          acceptedMessage.kind === "channel"
            ? `${queueKey}\u0000${acceptedMessage.senderShip}\u0000${acceptedMessage.messageId}`
            : `${acceptedMessage.accountId}\u0000${acceptedMessage.installationVersion}\u0000${acceptedMessage.messageId}`,
        )
        .digest("hex");
      const id = `${orgId}:${digest}`;
      const receipt = (stored: StoredTlonInbound): TlonInboundRecord => ({
        id: stored.id,
        queueKey: stored.queueKey,
        message: stored.message,
        ...(stored.previousId ? { previousId: stored.previousId } : {}),
        createdAt: stored.createdAt,
      });
      const duplicate = await inbound.get(id);
      if (acceptedMessage.kind === "dm" && duplicate?.orgId === orgId && duplicate.queueKey === queueKey) {
        return receipt(duplicate);
      }
      if (acceptedMessage.kind === "dm" && previousId) {
        const previous = await inbound.get(previousId);
        if (previous && (previous.orgId !== orgId || previous.queueKey !== queueKey)) {
          throw new Error("Tlon inbound predecessor belongs to another conversation");
        }
      }
      const persist = async (stamped: TlonInboundMessage, standby = false): Promise<TlonInboundRecord> => {
        const stored = await inbound.putIfAbsent(id, {
          orgId,
          id,
          queueKey,
          message: stamped,
          ...(previousId ? { previousId } : {}),
          ...(standby
            ? {
                standby: true,
                observations: {
                  [message.accountId]: {
                    version: message.installationVersion,
                    message: stamped,
                    ...(previousId ? { previousId } : {}),
                  },
                },
              }
            : {}),
          createdAt: Date.now(),
        });
        const current = await map.get(mapKey(acceptedMessage.accountId));
        const observer = await map.get(mapKey(message.accountId));
        if (
          !current ||
          current.deletedAt ||
          current.version !== acceptedMessage.installationVersion ||
          current.ownerVerifiedVersion !== current.version ||
          !observer ||
          observer.deletedAt ||
          observer.version !== message.installationVersion ||
          (acceptedMessage.kind === "channel" &&
            (!verifiedFor(current, acceptedMessage.target) || !verifiedFor(observer, acceptedMessage.target)))
        ) {
          await inbound.deleteIf?.(id, (record) => record.orgId === orgId && record.queueKey === queueKey);
          throw new Error("Tlon installation changed during inbound handoff");
        }
        return receipt(stored);
      };
      if (acceptedMessage.kind === "dm") return persist(acceptedMessage);
      return withChannelLocks([acceptedMessage.target], async () => {
        const scopeVersion = (await channelVersion(acceptedMessage.target)) ?? "";
        const existing = await inbound.get(id);
        if (existing?.orgId === orgId && existing.queueKey === queueKey) {
          if (!existing.standby) return receipt(existing);
          const updated = await inbound.update?.(id, (record) => {
            if (!record.standby) return record;
            return {
              ...record,
              observations: {
                ...record.observations,
                [message.accountId]: {
                  version: message.installationVersion,
                  message: { ...acceptedMessage, scopeVersion },
                  ...(previousId ? { previousId } : {}),
                },
              },
            };
          });
          return receipt(updated ?? existing);
        }
        if (previousId) {
          const previous = await inbound.get(previousId);
          if (previous && (previous.orgId !== orgId || previous.queueKey !== queueKey)) {
            throw new Error("Tlon inbound predecessor belongs to another conversation");
          }
        }
        return persist({ ...acceptedMessage, scopeVersion }, true);
      });
    },
    async claimInbound(ttlMs, limit) {
      const now = Date.now();
      const standby = (await inbound.all()).filter(
        (record) => record.orgId === orgId && record.standby && record.message.kind === "channel",
      );
      const standbyChannels = unique(standby.map((record) => record.message.target));
      await withChannelLocks(standbyChannels, async () => {
        for (const record of standby) {
          let selected: [string, NonNullable<StoredTlonInbound["observations"]>[string]] | undefined;
          const invalid: string[] = [];
          for (const observation of Object.entries(record.observations ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
            const [observerId, observed] = observation;
            const observer = await map.get(mapKey(observerId));
            if (
              observer &&
              !observer.deletedAt &&
              observer.version === observed.version &&
              verifiedFor(observer, record.message.target)
            ) {
              selected = observation;
              break;
            }
            invalid.push(observerId);
          }
          if (!selected) {
            const invalidIds = new Set(invalid);
            const deleted = await inbound.deleteIf?.(
              record.id,
              (current) =>
                current.orgId === orgId &&
                current.standby === true &&
                Object.keys(current.observations ?? {}).every((observerId) => invalidIds.has(observerId)),
            );
            if (!deleted && invalid.length) {
              await inbound.update?.(record.id, (current) => {
                const observations = { ...current.observations };
                for (const observerId of invalid) delete observations[observerId];
                return { ...current, observations };
              });
            }
            continue;
          }
          const [, observed] = selected;
          await inbound.update?.(record.id, (current) =>
            current.standby
              ? {
                  ...current,
                  message: { ...observed.message, scopeVersion: current.message.scopeVersion },
                  ...(observed.previousId ? { previousId: observed.previousId } : { previousId: undefined }),
                  standby: false,
                  observations: undefined,
                }
              : current,
          );
        }
      });
      const pending = (await inbound.all())
        .filter((record) => record.orgId === orgId && !record.standby)
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
      const ids = new Set(pending.map((record) => record.id));
      const heads = pending.filter((record) => !record.previousId || !ids.has(record.previousId));
      const candidates: StoredTlonInbound[] = [];
      const queues = new Set<string>();
      for (const record of heads) {
        if (queues.has(record.queueKey)) continue;
        queues.add(record.queueKey);
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
            queueKey: updated.queueKey,
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
