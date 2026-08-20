import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createPostgresDeliveryStore } from "../src/delivery/postgres-delivery-store.ts";
import { exerciseDeliveryStore } from "./delivery-store-contract.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres delivery-store tests";

before(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query("DROP TABLE IF EXISTS deliveries CASCADE");
  await p.query("DROP SEQUENCE IF EXISTS deliveries_enqueue_seq_seq");
  await p.end();
});

test("pg delivery store: migration preserves legacy created-at ordering", { skip }, async () => {
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: URL });
  await pool.query(`CREATE TABLE deliveries(
    id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    destination JSONB NOT NULL,
    text TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    delivered_at BIGINT
  )`);
  await pool.query(
    `INSERT INTO deliveries(id, idempotency_key, destination, text, created_at, delivered_at)
     VALUES ('later', 'legacy-later', '{"type":"slack","target":"C1"}', 'later', 200, NULL),
            ('earlier', 'legacy-earlier', '{"type":"slack","target":"C1"}', 'earlier', 100, NULL)`,
  );
  await pool.end();
  const store = createPostgresDeliveryStore(URL!);
  const pending = await store.pending("slack");
  assert.deepEqual(
    pending.map((delivery) => delivery.id),
    ["earlier", "later"],
  );
  await store.ack("earlier", 300);
  await store.ack("later", 300);
});

test("pg delivery store: idempotent enqueue, pending-by-type, ack, get", { skip }, async () => {
  await exerciseDeliveryStore(createPostgresDeliveryStore(URL!));
});

test("pg delivery store: the queue survives across store instances (deploy/multi-instance)", { skip }, async () => {
  const writer = createPostgresDeliveryStore(URL!);
  const queued = await writer.enqueue({
    destination: { type: "slack", target: "C-durable" },
    text: "survives a deploy",
    idempotencyKey: "fire-durable",
  });

  const reader = createPostgresDeliveryStore(URL!);
  const pending = await reader.pending("slack");
  assert.ok(
    pending.some((p) => p.id === queued.id),
    "another instance reads the queued delivery",
  );
  assert.equal((await reader.get(queued.id))?.text, "survives a deploy");

  await reader.ack(queued.id, 999);
  assert.equal(
    (await writer.pending("slack")).some((p) => p.id === queued.id),
    false,
  );
  assert.equal((await writer.get(queued.id))?.deliveredAt, 999);

  const dup = await reader.enqueue({
    destination: { type: "slack", target: "C-durable" },
    text: "retry after deploy",
    idempotencyKey: "fire-durable",
  });
  assert.equal(dup.id, queued.id, "idempotency keys dedupe across instances");
});

test(
  "pg delivery store: concurrent claims from two instances never hand out the same row (rolling-deploy race)",
  { skip },
  async () => {
    const oldTask = createPostgresDeliveryStore(URL!);
    const newTask = createPostgresDeliveryStore(URL!);
    const queued = await oldTask.enqueue({
      destination: { type: "group", target: "C-overlap" },
      text: "enqueued mid-deploy",
      idempotencyKey: "fire-overlap",
    });
    const [a, b] = await Promise.all([oldTask.claimPending("group", 15_000), newTask.claimPending("group", 15_000)]);
    assert.equal(a.length + b.length, 1, "exactly one instance claims the row");
    assert.equal([...a, ...b][0]!.id, queued.id);
    await oldTask.ack(queued.id, 111);
  },
);
