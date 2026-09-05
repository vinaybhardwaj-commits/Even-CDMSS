/**
 * lib/lab-v2/store.ts — every durable operation the platform performs
 * (LAB-MCP-V2-PRD-v1.0 §4.1, §5, §6.3).
 *
 * The SQL lives here and nowhere else. Tool handlers compose these functions; the worker
 * composes these functions; nothing above this file writes a statement of its own. That
 * is what lets the lease and budget invariants be stated once and tested once.
 *
 * TWO INVARIANTS CARRY THE WHOLE DESIGN.
 *
 *  1. THE LEASE TOKEN. Every claim increments `items.lease_token`. Every subsequent write
 *     for that attempt asserts the token it was given. A worker that was killed, came
 *     back, and tried to finish an item that has since been reaped and re-claimed will
 *     assert a stale token, match zero rows, and write nothing. Without this, the reaper
 *     and a zombie worker race to write the same row and the zombie sometimes wins.
 *
 *  2. THE BUDGET INEQUALITY. `spent + reserved + unknown + delta <= cap`, evaluated
 *     inside the same UPDATE that adds the reservation. Not read-then-write — the check
 *     and the increment are one statement, so two concurrent calls cannot both observe
 *     room for the last reservation. Zero rows updated IS the refusal.
 */
import { randomUUID } from 'crypto';
import type { Db } from './db';
import {
  LabError, hash, LEASE_MS, MAX_ATTEMPTS, REQUEUE_DELAY_MS, WORKER_ID,
  type Classification, type ObjectKind, type ItemState, type RunState,
} from './contracts';

const S = (ms: number) => ms / 1000;

// ── objects ──────────────────────────────────────────────────────────────────────────
export interface StoredObject {
  id: string; owner: string; kind: ObjectKind; body: Record<string, unknown>;
  hash: string; classification: Classification; created_at: string; idempotency_key: string | null;
}

/**
 * Store an immutable body. Two conflicts are possible and they mean different things:
 * the same (owner, kind, idempotency_key) is a RETRY and returns the prior row; the same
 * (kind, hash) is the SAME BODY reached by a different route and returns that row. Both
 * report `deduplicated`, because a caller that submitted twice deserves to know it got
 * one object rather than two.
 */
export async function putObject(
  db: Db, owner: string, kind: ObjectKind, body: unknown,
  classification: Classification, idempotencyKey: string | null,
): Promise<{ object: StoredObject; deduplicated: boolean }> {
  const h = hash(body);
  const existing = await db.query<StoredObject>(
    `SELECT * FROM lab_v2.objects WHERE kind = $1 AND (hash = $2 OR (owner = $3 AND idempotency_key IS NOT DISTINCT FROM $4 AND $4 IS NOT NULL)) LIMIT 1`,
    [kind, h, owner, idempotencyKey],
  );
  if (existing.length) return { object: existing[0], deduplicated: true };
  const rows = await db.query<StoredObject>(
    `INSERT INTO lab_v2.objects (owner, kind, body, hash, classification, idempotency_key)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6)
     ON CONFLICT (kind, hash) DO UPDATE SET hash = EXCLUDED.hash
     RETURNING *`,
    [owner, kind, JSON.stringify(body), h, classification, idempotencyKey],
  );
  return { object: rows[0], deduplicated: false };
}

export async function getObject(db: Db, id: string): Promise<StoredObject | null> {
  const rows = await db.query<StoredObject>(`SELECT * FROM lab_v2.objects WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

// ── budgets ──────────────────────────────────────────────────────────────────────────
export interface Budget {
  id: string; owner: string; name: string;
  cap_microusd: string; reserved_microusd: string; spent_microusd: string; unknown_microusd: string;
}

export async function ensureBudget(db: Db, owner: string, name: string, capMicrousd: number): Promise<Budget> {
  const rows = await db.query<Budget>(
    `INSERT INTO lab_v2.budgets (owner, name, cap_microusd) VALUES ($1, $2, $3)
     ON CONFLICT (owner, name) DO UPDATE SET cap_microusd = GREATEST(lab_v2.budgets.cap_microusd, EXCLUDED.cap_microusd)
     RETURNING *`,
    [owner, name, capMicrousd],
  );
  return rows[0];
}

export async function getBudget(db: Db, id: string): Promise<Budget | null> {
  const rows = await db.query<Budget>(`SELECT * FROM lab_v2.budgets WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

/**
 * Atomic reservation (§6.3). The inequality is IN the WHERE clause: either the row moves
 * and there was room, or no row moves and there was not. Zero rows is BUDGET_EXHAUSTED —
 * the caller records the call as `refused` and fails the item with error.category
 * 'budget'. There is no read-check-write window for a second call to slip through.
 */
export async function reserve(db: Db, budgetId: string, maxMicrousd: number): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `UPDATE lab_v2.budgets SET reserved_microusd = reserved_microusd + $2
     WHERE id = $1 AND spent_microusd + reserved_microusd + unknown_microusd + $2 <= cap_microusd
     RETURNING id`,
    [budgetId, maxMicrousd],
  );
  return rows.length > 0;
}

/** Settle: the reservation comes off `reserved` and the measured cost goes onto `spent`. */
export async function settleReservation(db: Db, budgetId: string, reservedMicrousd: number, actualMicrousd: number): Promise<void> {
  await db.query(
    `UPDATE lab_v2.budgets SET reserved_microusd = GREATEST(0, reserved_microusd - $2), spent_microusd = spent_microusd + $3 WHERE id = $1`,
    [budgetId, reservedMicrousd, actualMicrousd],
  );
}

/**
 * A transport error with no usage. The money may or may not have been spent and we cannot
 * tell, so it moves reserved → unknown and STAYS against the cap until reconciled. This
 * is the one place a budget could silently forget, and it deliberately does not.
 */
export async function moveReservationToUnknown(db: Db, budgetId: string, reservedMicrousd: number): Promise<void> {
  await db.query(
    `UPDATE lab_v2.budgets SET reserved_microusd = GREATEST(0, reserved_microusd - $2), unknown_microusd = unknown_microusd + $2 WHERE id = $1`,
    [budgetId, reservedMicrousd],
  );
}

// ── calls ────────────────────────────────────────────────────────────────────────────
export async function openCall(
  db: Db, itemId: string, leaseToken: number, stage: string, budgetId: string,
  requested: unknown, reservedMicrousd: number, pricingVersion: string, state: 'reserved' | 'refused',
): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `INSERT INTO lab_v2.calls (item_id, lease_token, stage, budget_id, requested, request_hash, reserved_microusd, state, pricing_version)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9) RETURNING id`,
    [itemId, leaseToken, stage, budgetId, JSON.stringify(requested), hash(requested), reservedMicrousd, state, pricingVersion],
  );
  return rows[0].id;
}

export async function settleCall(db: Db, callId: string, served: unknown, actualMicrousd: number | null): Promise<void> {
  await db.query(
    `UPDATE lab_v2.calls SET state = 'settled', served = $2::jsonb, actual_microusd = $3, settled_at = now() WHERE id = $1`,
    [callId, JSON.stringify(served ?? null), actualMicrousd],
  );
}

export async function markCallUnknown(db: Db, callId: string): Promise<void> {
  await db.query(`UPDATE lab_v2.calls SET state = 'unknown', settled_at = now() WHERE id = $1`, [callId]);
}

// ── events ───────────────────────────────────────────────────────────────────────────
export async function recordEvent(db: Db, actor: string, aggregate: string, kind: string, body: Record<string, unknown>): Promise<void> {
  await db.query(
    `INSERT INTO lab_v2.events (actor, aggregate, kind, body) VALUES ($1, $2, $3, $4::jsonb)`,
    [actor, aggregate, kind, JSON.stringify(body)],
  );
}

// ── workers ──────────────────────────────────────────────────────────────────────────
export interface Worker { id: string; paused: boolean; revision: number; heartbeat_at: string | null; active_item: string | null }

export async function getWorker(db: Db, id: string = WORKER_ID): Promise<Worker> {
  const rows = await db.query<Worker>(`SELECT * FROM lab_v2.workers WHERE id = $1`, [id]);
  if (rows.length) return rows[0];
  const created = await db.query<Worker>(`INSERT INTO lab_v2.workers (id) VALUES ($1) ON CONFLICT (id) DO NOTHING RETURNING *`, [id]);
  return created[0] ?? { id, paused: false, revision: 0, heartbeat_at: null, active_item: null };
}

export async function setWorkerPaused(db: Db, paused: boolean, id: string = WORKER_ID): Promise<Worker> {
  await getWorker(db, id);
  const rows = await db.query<Worker>(
    `UPDATE lab_v2.workers SET paused = $2, revision = revision + 1 WHERE id = $1 RETURNING *`, [id, paused],
  );
  return rows[0];
}

// ── runs and items ───────────────────────────────────────────────────────────────────
export interface Item {
  id: string; run_id: string; case_key: string; arm_hash: string; repetition: number;
  payload: Record<string, unknown>; state: ItemState; next_at: string;
  lease_owner: string | null; lease_token: number; lease_expires_at: string | null;
  attempts: number; error: Record<string, unknown> | null; result: Record<string, unknown> | null;
  execution_status: string | null; assessment_status: string | null; attribution_status: string | null;
}
export interface Run {
  id: string; owner: string; experiment_id: string | null; operation: string; request_hash: string;
  idempotency_key: string; budget_id: string; state: RunState;
  cancel_requested_at: string | null; created_at: string; deadline_at: string;
}

export interface NewItem { case_key: string; arm_hash: string; repetition: number; payload: unknown }

/**
 * §5.2 — the run and all its items in ONE transaction, then return before any model
 * work. The unique index on (owner, operation, idempotency_key) is the deduplication
 * mechanism; we probe first for the common case and rely on the constraint for the race.
 */
export async function submitRun(
  db: Db, owner: string, operation: string, experimentId: string | null, budgetId: string,
  idempotencyKey: string, requestHash: string, deadlineMs: number, items: NewItem[],
): Promise<{ run: Run; itemCount: number; deduplicated: boolean }> {
  const prior = await db.query<Run>(
    `SELECT * FROM lab_v2.runs WHERE owner = $1 AND operation = $2 AND idempotency_key = $3`,
    [owner, operation, idempotencyKey],
  );
  if (prior.length) {
    const n = await db.query<{ c: string }>(`SELECT count(*)::text AS c FROM lab_v2.items WHERE run_id = $1`, [prior[0].id]);
    return { run: prior[0], itemCount: Number(n[0].c), deduplicated: true };
  }
  return db.transaction(async (tx) => {
    const runRows = await tx.query<Run>(
      `INSERT INTO lab_v2.runs (owner, experiment_id, operation, request_hash, idempotency_key, budget_id, state, deadline_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'queued', now() + make_interval(secs => $7))
       ON CONFLICT (owner, operation, idempotency_key) DO NOTHING
       RETURNING *`,
      [owner, experimentId, operation, requestHash, idempotencyKey, budgetId, S(deadlineMs)],
    );
    if (!runRows.length) {
      const raced = await tx.query<Run>(
        `SELECT * FROM lab_v2.runs WHERE owner = $1 AND operation = $2 AND idempotency_key = $3`,
        [owner, operation, idempotencyKey],
      );
      const n = await tx.query<{ c: string }>(`SELECT count(*)::text AS c FROM lab_v2.items WHERE run_id = $1`, [raced[0].id]);
      return { run: raced[0], itemCount: Number(n[0].c), deduplicated: true };
    }
    const run = runRows[0];
    for (const it of items) {
      await tx.query(
        `INSERT INTO lab_v2.items (run_id, case_key, arm_hash, repetition, payload, state)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'queued')
         ON CONFLICT (run_id, case_key, arm_hash, repetition) DO NOTHING`,
        [run.id, it.case_key, it.arm_hash, it.repetition, JSON.stringify(it.payload)],
      );
    }
    return { run, itemCount: items.length, deduplicated: false };
  });
}

export async function getRun(db: Db, id: string): Promise<Run | null> {
  const rows = await db.query<Run>(`SELECT * FROM lab_v2.runs WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function itemsOf(db: Db, runId: string, limit = 1000, offset = 0): Promise<Item[]> {
  return db.query<Item>(
    `SELECT * FROM lab_v2.items WHERE run_id = $1 ORDER BY case_key, arm_hash, repetition LIMIT $2 OFFSET $3`,
    [runId, limit, offset],
  );
}

export async function countItemsByState(db: Db, runId: string): Promise<Record<string, number>> {
  const rows = await db.query<{ state: string; c: string }>(
    `SELECT state, count(*)::text AS c FROM lab_v2.items WHERE run_id = $1 GROUP BY state`, [runId],
  );
  return Object.fromEntries(rows.map((r) => [r.state, Number(r.c)]));
}

/**
 * §5.1 — run state derived from its items, in the PRD's precedence order. Expiry is
 * checked FIRST and it is a real transition, not a label: items still queued past the
 * deadline move to `expired` so the reaper stops considering them.
 */
export async function deriveRunState(db: Db, runId: string): Promise<RunState> {
  const run = await getRun(db, runId);
  if (!run) throw new LabError('NOT_FOUND', `run ${runId} not found`);
  const expiredNow = await db.query<{ id: string }>(
    `UPDATE lab_v2.items SET state = 'expired'
     WHERE run_id = $1 AND state = 'queued' AND now() > (SELECT deadline_at FROM lab_v2.runs WHERE id = $1)
     RETURNING id`, [runId],
  );
  const counts = await countItemsByState(db, runId);
  const n = (k: string) => counts[k] ?? 0;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  let state: RunState;
  if (expiredNow.length && n('running') === 0 && n('succeeded') === 0) state = 'expired';
  else if (run.cancel_requested_at && n('running') === 0) state = 'cancelled';
  else if (total > 0 && n('succeeded') === total) state = 'succeeded';
  else if (total > 0 && n('failed') + n('expired') === total) state = 'failed';
  else if (n('succeeded') > 0 && (n('failed') > 0 || n('expired') > 0) && n('running') === 0 && n('queued') === 0) state = 'partial';
  else if (n('running') > 0) state = 'running';
  else if (n('queued') > 0) state = 'queued';
  else if (n('cancelled') > 0) state = 'cancelled';
  else state = 'queued';
  await db.query(`UPDATE lab_v2.runs SET state = $2 WHERE id = $1`, [runId, state]);
  return state;
}

// ── the queue: claim, heartbeat, finish, reap (§5.3) ─────────────────────────────────

/**
 * §5.3.3 — claim exactly one queued item. `FOR UPDATE SKIP LOCKED` inside the subquery is
 * what makes two concurrent ticks pick DIFFERENT rows instead of blocking on each other
 * or both winning. `lease_token + 1` stamps this attempt's identity.
 */
export async function claim(db: Db, worker: string = WORKER_ID): Promise<Item | null> {
  return db.transaction(async (tx) => {
    const rows = await tx.query<Item>(
      `UPDATE lab_v2.items SET state = 'running', lease_owner = $1, lease_token = lease_token + 1,
              lease_expires_at = now() + make_interval(secs => $2), attempts = attempts + 1
       WHERE id = (
         SELECT id FROM lab_v2.items
         WHERE state = 'queued' AND next_at <= now()
         ORDER BY next_at LIMIT 1 FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [worker, S(LEASE_MS)],
    );
    if (!rows.length) return null;
    const item = rows[0];
    await tx.query(
      `INSERT INTO lab_v2.attempts (item_id, lease_token, worker) VALUES ($1, $2, $3)`,
      [item.id, item.lease_token, worker],
    );
    await tx.query(`UPDATE lab_v2.workers SET active_item = $2, heartbeat_at = now() WHERE id = $1`, [worker, item.id]);
    return item;
  });
}

/** Extend the lease, asserting the token. False means the lease was lost — abort. */
export async function heartbeat(db: Db, itemId: string, leaseToken: number, worker: string = WORKER_ID): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `UPDATE lab_v2.items SET lease_expires_at = now() + make_interval(secs => $3)
     WHERE id = $1 AND lease_token = $2 AND state = 'running' RETURNING id`,
    [itemId, leaseToken, S(LEASE_MS)],
  );
  if (rows.length) await db.query(`UPDATE lab_v2.workers SET heartbeat_at = now() WHERE id = $1`, [worker]);
  return rows.length > 0;
}

export async function assertLease(db: Db, itemId: string, leaseToken: number): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `SELECT id FROM lab_v2.items WHERE id = $1 AND lease_token = $2 AND state = 'running'`, [itemId, leaseToken],
  );
  return rows.length > 0;
}

export interface FinishInput {
  state: ItemState;
  result: unknown | null;
  error: Record<string, unknown> | null;
  execution_status: string;
  assessment_status: string;
  attribution_status: string;
  outcome: string;
}

/**
 * §5.3.5 — the single transaction that ends an attempt. The lease token is asserted in
 * the UPDATE's WHERE clause, so a worker whose lease was reaped writes NOTHING and says
 * so by returning false. All three statuses are set here and only here, which is why
 * §9's "all three on every finished item" is structurally true rather than a convention.
 */
export async function finish(db: Db, itemId: string, leaseToken: number, input: FinishInput): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx.query<{ id: string }>(
      `UPDATE lab_v2.items
       SET state = $3, result = $4::jsonb, error = $5::jsonb,
           execution_status = $6, assessment_status = $7, attribution_status = $8,
           lease_owner = NULL, lease_expires_at = NULL
       WHERE id = $1 AND lease_token = $2 AND state = 'running'
       RETURNING id`,
      [itemId, leaseToken, input.state, JSON.stringify(input.result ?? null), JSON.stringify(input.error ?? null),
        input.execution_status, input.assessment_status, input.attribution_status],
    );
    if (!rows.length) return false;
    await tx.query(
      `UPDATE lab_v2.attempts SET ended_at = now(), outcome = $3 WHERE item_id = $1 AND lease_token = $2`,
      [itemId, leaseToken, input.outcome],
    );
    await tx.query(`UPDATE lab_v2.workers SET active_item = NULL WHERE active_item = $1`, [itemId]);
    return true;
  });
}

/**
 * §5.3.1 — reap expired leases.
 *
 * ⚠️ ATTEMPT COUNTING. `attempts` is incremented once, at claim. The PRD's §5.3.1 phrase
 * "attempts + 1" describes the count that claim already consumed, not a second increment:
 * §15.6 requires that a THIRD abandonment expires the item, and with MAX_ATTEMPTS = 3
 * that is only true if each claim-and-abandon cycle costs exactly one. Incrementing in
 * both places would expire on the second abandonment.
 */
export async function reap(db: Db): Promise<number> {
  return db.transaction(async (tx) => {
    const dead = await tx.query<Item>(
      `SELECT * FROM lab_v2.items WHERE state = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < now() FOR UPDATE SKIP LOCKED`,
    );
    for (const item of dead) {
      await tx.query(
        `UPDATE lab_v2.attempts SET ended_at = now(), outcome = 'abandoned' WHERE item_id = $1 AND lease_token = $2 AND ended_at IS NULL`,
        [item.id, item.lease_token],
      );
      // Money reserved by that attempt is now unattributable: move it to `unknown`.
      const orphaned = await tx.query<{ id: string; budget_id: string; reserved_microusd: string }>(
        `SELECT id, budget_id, reserved_microusd FROM lab_v2.calls WHERE item_id = $1 AND lease_token = $2 AND state = 'reserved'`,
        [item.id, item.lease_token],
      );
      for (const c of orphaned) {
        await moveReservationToUnknown(tx, c.budget_id, Number(c.reserved_microusd));
        await markCallUnknown(tx, c.id);
      }
      const exhausted = item.attempts >= MAX_ATTEMPTS;
      await tx.query(
        exhausted
          ? `UPDATE lab_v2.items SET state = 'expired', lease_owner = NULL, lease_expires_at = NULL,
               execution_status = COALESCE(execution_status, 'expired'),
               assessment_status = COALESCE(assessment_status, 'not_reached'),
               attribution_status = COALESCE(attribution_status, 'unknown')
             WHERE id = $1`
          : `UPDATE lab_v2.items SET state = 'queued', lease_owner = NULL, lease_expires_at = NULL,
               next_at = now() + make_interval(secs => ${S(REQUEUE_DELAY_MS)}) WHERE id = $1`,
        [item.id],
      );
      await tx.query(`UPDATE lab_v2.workers SET active_item = NULL WHERE active_item = $1`, [item.id]);
      await recordEvent(tx, 'system', item.id, 'item_reaped', { attempts: item.attempts, expired: exhausted });
    }
    return dead.length;
  });
}

/** §5.4 — queued items cancel at once; running ones are signalled at their next heartbeat. */
export async function requestCancel(db: Db, runId: string): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.query(`UPDATE lab_v2.runs SET cancel_requested_at = COALESCE(cancel_requested_at, now()) WHERE id = $1`, [runId]);
    const rows = await tx.query<{ id: string }>(
      `UPDATE lab_v2.items SET state = 'cancelled',
         execution_status = 'cancelled', assessment_status = 'not_reached',
         attribution_status = COALESCE(attribution_status, 'unknown')
       WHERE run_id = $1 AND state = 'queued' RETURNING id`,
      [runId],
    );
    return rows.length;
  });
}

export async function isCancelRequested(db: Db, runId: string): Promise<boolean> {
  const rows = await db.query<{ c: string | null }>(`SELECT cancel_requested_at AS c FROM lab_v2.runs WHERE id = $1`, [runId]);
  return !!rows[0]?.c;
}

/** §5.5 — re-queue failed/expired items as NEW attempts on the SAME item id. Never a succeeded one. */
export async function retryRun(db: Db, runId: string): Promise<number> {
  const rows = await db.query<{ id: string }>(
    `UPDATE lab_v2.items SET state = 'queued', next_at = now(), attempts = 0, error = NULL,
       execution_status = NULL, assessment_status = NULL, attribution_status = NULL
     WHERE run_id = $1 AND state IN ('failed', 'expired') RETURNING id`,
    [runId],
  );
  if (rows.length) await db.query(`UPDATE lab_v2.runs SET cancel_requested_at = NULL, state = 'queued' WHERE id = $1`, [runId]);
  return rows.length;
}

// ── migrations (§4, §14.4) ───────────────────────────────────────────────────────────
export interface MigrationFile { name: string; sql: string; checksum: string }

/**
 * Apply by name order, record by name and checksum. A checksum that differs from the one
 * recorded for an already-applied name is an ERROR, never a re-apply: the file changed
 * after it ran, so the database and the repository disagree and only a human can say
 * which is right.
 */
export async function applyMigrations(db: Db, files: MigrationFile[]): Promise<{ applied: string[]; skipped: string[] }> {
  await db.exec(`CREATE SCHEMA IF NOT EXISTS lab_v2`);
  await db.exec(`CREATE TABLE IF NOT EXISTS lab_v2.migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  const applied: string[] = []; const skipped: string[] = [];
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    const prior = await db.query<{ checksum: string }>(`SELECT checksum FROM lab_v2.migrations WHERE name = $1`, [f.name]);
    if (prior.length) {
      if (prior[0].checksum !== f.checksum) {
        throw new LabError('STORE_UNAVAILABLE', `migration ${f.name} was applied with checksum ${prior[0].checksum} but the file now hashes to ${f.checksum}`);
      }
      skipped.push(f.name);
      continue;
    }
    await db.exec(f.sql);
    await db.query(`INSERT INTO lab_v2.migrations (name, checksum) VALUES ($1, $2)`, [f.name, f.checksum]);
    applied.push(f.name);
  }
  return { applied, skipped };
}

export async function appliedMigrations(db: Db): Promise<string[]> {
  const rows = await db.query<{ name: string }>(`SELECT name FROM lab_v2.migrations ORDER BY name`);
  return rows.map((r) => r.name);
}

export const newId = randomUUID;
