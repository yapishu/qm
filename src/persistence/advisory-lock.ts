import type { PgPool, PoolClient } from "./pg-pool.ts";
import { createKeyedQueue, sleep } from "../util/async.ts";

export interface AdvisoryLock {
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
  withLocks?<T>(keys: readonly string[], fn: () => Promise<T>): Promise<T>;
  tryWithLock?<T>(key: string, fn: () => Promise<T>): Promise<T | null>;
}

const DEFAULT_ADVISORY_LOCK_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_ADVISORY_LOCK_POLL_MS = 300;

export function createNoopAdvisoryLock(): AdvisoryLock {
  return {
    async withLock<T>(_key: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    async withLocks<T>(_keys: readonly string[], fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    async tryWithLock<T>(_key: string, fn: () => Promise<T>): Promise<T | null> {
      return fn();
    },
  };
}

export function createMemoryAdvisoryLock(): AdvisoryLock {
  const queue = createKeyedQueue<string>();
  const held = new Set<string>();
  const withLock = <T>(key: string, fn: () => Promise<T>): Promise<T> =>
    queue(key, async () => {
      held.add(key);
      try {
        return await fn();
      } finally {
        held.delete(key);
      }
    });
  return {
    withLock,
    withLocks<T>(keys: readonly string[], fn: () => Promise<T>): Promise<T> {
      const ordered = [...new Set(keys)].sort();
      const acquire = (index: number): Promise<T> => {
        const key = ordered[index];
        return key ? withLock(key, () => acquire(index + 1)) : fn();
      };
      return acquire(0);
    },
    async tryWithLock(key, fn) {
      if (held.has(key)) return null;
      return withLock(key, fn);
    },
  };
}

export function createPostgresAdvisoryLock(
  pg: PgPool,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): AdvisoryLock {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_ADVISORY_LOCK_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_ADVISORY_LOCK_POLL_MS;
  let activeClients = 0;
  const clientWaiters: Array<() => void> = [];
  const reserveClient = async (max: number): Promise<void> => {
    const capacity = Math.max(1, max - 1);
    if (activeClients < capacity) {
      activeClients++;
      return;
    }
    await new Promise<void>((resolve) => clientWaiters.push(resolve));
  };
  const releaseClient = (): void => {
    const waiter = clientWaiters.shift();
    if (waiter) waiter();
    else activeClients--;
  };
  const withLocks = async <T>(keys: readonly string[], fn: () => Promise<T>): Promise<T> => {
    const ordered = [...new Set(keys)].sort();
    if (!ordered.length) return fn();
    const deadline = Date.now() + timeoutMs;
    const pool = await pg.pool();
    for (;;) {
      await reserveClient(pool.options.max ?? 10);
      let client: PoolClient;
      try {
        client = await pool.connect();
      } catch (error) {
        releaseClient();
        throw error;
      }
      const acquired: string[] = [];
      let ready = true;
      try {
        for (const key of ordered) {
          const res = await client.query<{ locked: boolean }>(
            "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
            [key],
          );
          if (res.rows[0]?.locked !== true) {
            ready = false;
            break;
          }
          acquired.push(key);
        }
        if (ready) return await fn();
      } finally {
        try {
          for (const key of acquired.reverse()) {
            await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
          }
        } finally {
          client.release();
          releaseClient();
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(
          ordered.length === 1
            ? `timeout acquiring advisory lock for ${ordered[0]}`
            : `timeout acquiring advisory locks for ${ordered.join(", ")}`,
        );
      }
      await sleep(pollMs);
    }
  };

  return {
    withLock: (key, fn) => withLocks([key], fn),
    withLocks,

    async tryWithLock<T>(key: string, fn: () => Promise<T>): Promise<T | null> {
      const pool = await pg.pool();
      await reserveClient(pool.options.max ?? 10);
      let client: PoolClient;
      try {
        client = await pool.connect();
      } catch (error) {
        releaseClient();
        throw error;
      }
      try {
        const res = await client.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
          [key],
        );
        if (res.rows[0]?.locked !== true) return null;
        try {
          return await fn();
        } finally {
          await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
        }
      } finally {
        client.release();
        releaseClient();
      }
    },
  };
}
