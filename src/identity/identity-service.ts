import type { ActorAssertion, Principal } from "../types.ts";
import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";
import { personKey } from "../directory/person.ts";

interface IdentityProvider {
  resolve(actor: ActorAssertion): Principal;
  classify(externalId: string, isExternalGuest?: boolean): Principal;
}

type DeactivationSource = "manual" | "directory-sync";

export interface DeactivationRecord {
  principalId: string;
  source: DeactivationSource;
  at: number;
}

interface DirectorySyncOutcome {
  deactivated: string[];
  reactivated: string[];
}

export interface IdentityService extends IdentityProvider {
  isInternal(p: Principal): boolean;
  audienceIsAllInternal(audience: Principal[]): boolean;
  deactivate(externalId: string, source?: DeactivationSource): Promise<void>;
  reactivate(externalId: string): Promise<void>;
  recordDirectorySync(removedIds: string[], presentIds: string[]): Promise<DirectorySyncOutcome>;
  hydrate(): Promise<void>;
  refresh(force?: boolean): Promise<void>;
}

export function createIdentityService(backing?: DurableMap<DeactivationRecord>): IdentityService {
  const store = backing ?? createMemoryMap<DeactivationRecord>();
  const deactivated = new Map<string, DeactivationRecord>();
  const REFRESH_TTL_MS = 10_000;
  let refreshedAt = 0;
  let refreshP: Promise<void> | null = null;
  let hydrateP: Promise<void> | null = null;
  let mutationGeneration = 0;
  let mutations = 0;

  function classify(externalId: string, isExternalGuest?: boolean): Principal {
    const type: Principal["type"] = deactivated.has(personKey(externalId)) || isExternalGuest ? "guest" : "internal";
    return { id: externalId, type };
  }

  async function deactivate(externalId: string, source: DeactivationSource = "manual"): Promise<void> {
    const key = personKey(externalId);
    const existing = deactivated.get(key);
    if (existing && (existing.source === "manual" || existing.source === source)) return;
    const record: DeactivationRecord = { principalId: externalId, source, at: Date.now() };
    mutationGeneration++;
    mutations++;
    deactivated.set(key, record);
    try {
      await store.put(key, record);
      deactivated.set(key, record);
    } finally {
      mutations--;
      mutationGeneration++;
    }
  }

  async function reactivate(externalId: string): Promise<void> {
    const key = personKey(externalId);
    mutationGeneration++;
    mutations++;
    deactivated.delete(key);
    try {
      await store.delete(key);
      deactivated.delete(key);
    } finally {
      mutations--;
      mutationGeneration++;
    }
  }

  return {
    classify,
    deactivate,
    reactivate,
    async recordDirectorySync(removedIds: string[], presentIds: string[]): Promise<DirectorySyncOutcome> {
      const outcome: DirectorySyncOutcome = { deactivated: [], reactivated: [] };
      for (const id of removedIds) {
        if (deactivated.has(personKey(id))) continue;
        await deactivate(id, "directory-sync");
        outcome.deactivated.push(id);
      }
      for (const id of presentIds) {
        if (deactivated.get(personKey(id))?.source !== "directory-sync") continue;
        await reactivate(id);
        outcome.reactivated.push(id);
      }
      return outcome;
    },
    hydrate(): Promise<void> {
      if (!hydrateP) {
        const generation = mutationGeneration;
        hydrateP = store.all().then((records) => {
          if (mutations || generation !== mutationGeneration) return;
          for (const r of records) {
            const key = personKey(r.principalId);
            if (!deactivated.has(key)) deactivated.set(key, r);
          }
        });
      }
      return hydrateP;
    },
    async refresh(force = false): Promise<void> {
      const now = Date.now();
      if (refreshP) return refreshP;
      if (!force && now - refreshedAt < REFRESH_TTL_MS) return;
      const generation = mutationGeneration;
      refreshP = store
        .all()
        .then((records) => {
          if (mutations || generation !== mutationGeneration) return;
          deactivated.clear();
          for (const record of records) deactivated.set(personKey(record.principalId), record);
          refreshedAt = Date.now();
        })
        .finally(() => {
          refreshP = null;
        });
      return refreshP;
    },
    resolve(actor: ActorAssertion): Principal {
      const p = classify(actor.externalId, actor.isExternalGuest);
      return {
        ...p,
        ...(actor.teamIds ? { teamIds: actor.teamIds } : {}),
        ...(actor.displayName ? { displayName: actor.displayName } : {}),
      };
    },
    isInternal(p: Principal): boolean {
      return p.type === "internal";
    },
    audienceIsAllInternal(audience: Principal[]): boolean {
      return audience.length > 0 && audience.every((p) => p.type === "internal");
    },
  };
}
