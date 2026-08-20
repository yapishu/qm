import { randomUUID } from "node:crypto";
import type { Delivery, DeliveryProvenance, Destination, OutgoingAttachment } from "../types.ts";
import { cronIdOf } from "../sessions/session-store.ts";

export interface DeliveryStore {
  enqueue(input: {
    destination: Destination;
    text: string;
    attachments?: OutgoingAttachment[];
    provenance?: DeliveryProvenance;
    idempotencyKey: string;
    shadow?: boolean;
  }): Promise<Delivery>;
  pending(type: string): Promise<Delivery[]>;
  claimPending(type: string, ttlMs: number, limit?: number, grouped?: boolean): Promise<Delivery[]>;
  reserveConnectorRef(id: string, claimToken: string): Promise<number | null>;
  releaseClaim(id: string, claimToken: string): Promise<boolean>;
  listShadow(opts?: { limit?: number }): Promise<Delivery[]>;
  ack(id: string, at: number, slackApiMs?: number): Promise<void>;
  ackByKey(idempotencyKey: string, at: number): Promise<void>;
  setEditRefByKey(idempotencyKey: string, editRef: string): Promise<void>;
  get(id: string): Promise<Delivery | null>;
  recordRecipientThread(id: string, recipientThreadRef: string, at: number): Promise<void>;
  listByRecipientThread(recipientThreadRef: string, opts?: { limit?: number }): Promise<Delivery[]>;
  listBySourceSession(sourceSessionId: string, sourceThreadRef: string, opts?: { limit?: number }): Promise<Delivery[]>;
  sentCountsBySourceSessions(sources: Array<{ sessionId: string; threadRef: string }>): Promise<Map<string, number>>;
  sentRunCountsByCron(cronIds: string[]): Promise<Map<string, number>>;
  onEnqueue(listener: () => void): () => void;
}

export function createDeliveryStore(): DeliveryStore {
  const deliveries = new Map<string, Delivery>();
  const byKey = new Map<string, string>();
  const claimedUntil = new Map<string, number>();
  const claimTokens = new Map<string, string>();
  const enqueueListeners = new Set<() => void>();
  let connectorClock = Date.now();
  let enqueueSeq = 0;

  return {
    async enqueue(input) {
      const existingId = byKey.get(input.idempotencyKey);
      if (existingId) return deliveries.get(existingId)!;
      const delivery: Delivery = {
        id: randomUUID(),
        enqueueSeq: ++enqueueSeq,
        destination: input.destination,
        text: input.text,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        ...(input.provenance ? { provenance: input.provenance } : {}),
        idempotencyKey: input.idempotencyKey,
        createdAt: Date.now(),
        deliveredAt: null,
        ...(input.shadow ? { shadow: true } : {}),
      };
      deliveries.set(delivery.id, delivery);
      byKey.set(delivery.idempotencyKey, delivery.id);
      if (!delivery.shadow) for (const l of enqueueListeners) l();
      return delivery;
    },
    async pending(type) {
      return [...deliveries.values()].filter((d) => d.deliveredAt === null && !d.shadow && d.destination.type === type);
    },
    async claimPending(type, ttlMs, limit, grouped) {
      const now = Date.now();
      const rowLimit =
        typeof limit === "number" && Number.isInteger(limit) && limit > 0 ? limit : Number.MAX_SAFE_INTEGER;
      const pending = [...deliveries.values()]
        .filter((d) => d.deliveredAt === null && !d.shadow && d.destination.type === type)
        .sort((a, b) => a.enqueueSeq! - b.enqueueSeq!);
      const candidates = grouped
        ? [
            ...pending
              .reduce((heads, delivery) => {
                const key = delivery.destination.queueKey ?? "";
                if (!heads.has(key)) heads.set(key, delivery);
                return heads;
              }, new Map<string, Delivery>())
              .values(),
          ]
        : pending;
      const rows = candidates.filter((d) => (claimedUntil.get(d.id) ?? 0) <= now).slice(0, rowLimit);
      return rows.map((delivery) => {
        const claimToken = randomUUID();
        claimedUntil.set(delivery.id, now + ttlMs);
        claimTokens.set(delivery.id, claimToken);
        return { ...delivery, claimToken };
      });
    },
    async releaseClaim(id, claimToken) {
      if (claimTokens.get(id) !== claimToken) return false;
      claimTokens.delete(id);
      claimedUntil.delete(id);
      return true;
    },
    async reserveConnectorRef(id, claimToken) {
      const delivery = deliveries.get(id);
      if (!delivery || claimTokens.get(id) !== claimToken) return null;
      if (delivery.connectorRef !== undefined) return delivery.connectorRef;
      connectorClock = Math.max(connectorClock + 1, Date.now());
      delivery.connectorRef = connectorClock;
      return connectorClock;
    },
    async listShadow(opts) {
      const limit = Math.max(1, opts?.limit ?? 100);
      return [...deliveries.values()]
        .filter((d) => d.shadow && d.deliveredAt === null)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit);
    },
    async ack(id, at, slackApiMs) {
      const d = deliveries.get(id);
      if (d && d.deliveredAt === null) {
        d.deliveredAt = at;
        claimTokens.delete(id);
        claimedUntil.delete(id);
        d.deliverLatencyMs = Math.max(0, at - d.createdAt);
        if (slackApiMs !== undefined) d.slackApiMs = slackApiMs;
      }
    },
    async ackByKey(idempotencyKey, at) {
      const existingId = byKey.get(idempotencyKey);
      if (existingId) {
        const d = deliveries.get(existingId);
        if (d && d.deliveredAt === null) {
          d.deliveredAt = at;
          claimTokens.delete(existingId);
          claimedUntil.delete(existingId);
        }
        return;
      }
      const tombstone: Delivery = {
        id: randomUUID(),
        enqueueSeq: ++enqueueSeq,
        destination: { type: "ack-tombstone", target: "" },
        text: "",
        idempotencyKey,
        createdAt: at,
        deliveredAt: at,
      };
      deliveries.set(tombstone.id, tombstone);
      byKey.set(idempotencyKey, tombstone.id);
    },
    async setEditRefByKey(idempotencyKey, editRef) {
      const existingId = byKey.get(idempotencyKey);
      const d = existingId ? deliveries.get(existingId) : undefined;
      if (d && d.deliveredAt === null) d.destination = { ...d.destination, editRef };
    },
    async get(id) {
      return deliveries.get(id) ?? null;
    },
    async recordRecipientThread(id, recipientThreadRef, at) {
      const d = deliveries.get(id);
      if (!d || d.destination.type !== "principal") return;
      d.recipientThreadRef = recipientThreadRef;
      if (d.deliveredAt === null) {
        d.deliveredAt = at;
        claimTokens.delete(id);
        claimedUntil.delete(id);
      }
    },
    async listByRecipientThread(recipientThreadRef, opts) {
      const limit = Math.max(1, opts?.limit ?? 20);
      return [...deliveries.values()]
        .filter((d) => d.recipientThreadRef === recipientThreadRef && d.destination.type === "principal")
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(-limit);
    },
    async listBySourceSession(sourceSessionId, sourceThreadRef, opts) {
      const limit = Math.max(1, opts?.limit ?? 20);
      return [...deliveries.values()]
        .filter(
          (d) => d.provenance?.sourceSessionId === sourceSessionId || d.provenance?.sourceThreadRef === sourceThreadRef,
        )
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(-limit);
    },
    async sentCountsBySourceSessions(sources) {
      const counts = new Map<string, number>();
      const byId = new Set(sources.map((s) => s.sessionId));
      const byThreadRef = new Map(sources.map((s) => [s.threadRef, s.sessionId]));
      for (const d of deliveries.values()) {
        if (d.shadow || !d.provenance) continue;
        let id: string | undefined;
        if (d.provenance.sourceSessionId) {
          if (byId.has(d.provenance.sourceSessionId)) id = d.provenance.sourceSessionId;
        } else if (d.provenance.sourceThreadRef) {
          id = byThreadRef.get(d.provenance.sourceThreadRef);
        }
        if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      return counts;
    },
    async sentRunCountsByCron(cronIds) {
      const wanted = new Set(cronIds);
      const runs = new Map<string, Set<string>>();
      for (const d of deliveries.values()) {
        if (d.shadow || !d.provenance?.sourceThreadRef) continue;
        const cronId = cronIdOf(d.provenance.sourceThreadRef);
        if (!cronId || !wanted.has(cronId)) continue;
        let set = runs.get(cronId);
        if (!set) runs.set(cronId, (set = new Set()));
        set.add(d.provenance.sourceSessionId ?? d.provenance.sourceThreadRef);
      }
      return new Map([...runs].map(([k, v]) => [k, v.size]));
    },
    onEnqueue(listener) {
      enqueueListeners.add(listener);
      return () => enqueueListeners.delete(listener);
    },
  };
}
