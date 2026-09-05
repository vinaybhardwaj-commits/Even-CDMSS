/**
 * lib/lab-v2/worker.ts — one tick of the queue (LAB-MCP-V2-PRD-v1.0 §5.3, decision 3).
 *
 * Decision 3 puts Slice A's worker on a Vercel cron rather than a long-lived process:
 * the cron hits an idempotent tick route that claims BOUNDED work inside `maxDuration`.
 * Everything below is written to be safe when the function is killed at any instruction,
 * because on Vercel it eventually will be.
 *
 * THE SAFETY ARGUMENT, IN ORDER.
 *   · Work is claimed with a LEASE, not a flag. A killed worker's lease simply expires;
 *     the next tick reaps it. Nothing needs to run on the way down.
 *   · Every write asserts the lease token, so a zombie that wakes up after its item was
 *     reaped and re-claimed writes nothing at all.
 *   · The loop stops at 4 items or 500 s elapsed, well inside `maxDuration = 800`, so the
 *     tick returns a report rather than being killed mid-item as a matter of routine.
 *   · Reservations are written before the network, so money in flight is visible to the
 *     reaper even when the process that spent it is gone.
 */
import type { Db } from './db';
import {
  HEARTBEAT_MS, TICK_MAX_ITEMS, TICK_MAX_ELAPSED_MS, WORKER_ID, LabError, hash,
  type AssessmentStatus, type ExecutionStatus, type ItemState,
} from './contracts';
import { Gateway, type StageSpec } from './gateway';
import {
  claim, deriveRunState, finish, getObject, getWorker, heartbeat, isCancelRequested,
  putObject, reap, recordEvent,
} from './store';
import type { Transport } from './transport';
import { ADAPTERS } from './adapters/opd';
import type { Adapter } from './adapters/types';

export interface TickOptions {
  db: Db;
  transport: Transport;
  worker?: string;
  maxItems?: number;
  maxElapsedMs?: number;
  /** Injected in tests so a tick is deterministic rather than wall-clock dependent. */
  now?: () => number;
  /** Injection seam for unit tests (repo idiom). Production uses the real ADAPTERS map. */
  adapters?: Record<string, Adapter>;
}

export interface TickReport {
  claimed: number;
  finished: number;
  reaped: number;
  paused?: boolean;
}

export async function tick(opts: TickOptions): Promise<TickReport> {
  const { db, transport } = opts;
  const workerId = opts.worker ?? WORKER_ID;
  const maxItems = opts.maxItems ?? TICK_MAX_ITEMS;
  const maxElapsed = opts.maxElapsedMs ?? TICK_MAX_ELAPSED_MS;
  const now = opts.now ?? Date.now;
  const startedAt = now();

  // 1. Reap first: a lease that expired while we were away frees its item for THIS tick.
  const reaped = await reap(db);

  // 2. A paused worker claims nothing. Running items elsewhere finish on their own.
  const worker = await getWorker(db, workerId);
  if (worker.paused) return { claimed: 0, finished: 0, reaped, paused: true };

  let claimed = 0;
  let finished = 0;

  while (claimed < maxItems && now() - startedAt < maxElapsed) {
    const item = await claim(db, workerId);
    if (!item) break;
    claimed += 1;
    const ok = await runItem({ db, transport, item, workerId, adapters: opts.adapters ?? ADAPTERS });
    if (ok) finished += 1;
    await deriveRunState(db, item.run_id);
  }

  return { claimed, finished, reaped };
}

interface RunItemArgs {
  db: Db;
  transport: Transport;
  item: Awaited<ReturnType<typeof claim>> & object;
  workerId: string;
  adapters: Record<string, Adapter>;
}

/**
 * One leased item, start to finish. Always ends by calling `finish` with all three
 * statuses (§9) unless the lease was lost — in which case it deliberately writes nothing.
 */
async function runItem({ db, transport, item, workerId, adapters }: RunItemArgs): Promise<boolean> {
  const leaseToken = item.lease_token;
  const controller = new AbortController();
  const payload = item.payload as { engine?: string; frozen?: Record<string, unknown>; arm?: Record<string, unknown>; budget_id?: string };
  const events: { kind: string; body: Record<string, unknown> }[] = [];

  // The heartbeat does two jobs: it extends the lease, and it is the ONLY place the
  // adapter learns about cancellation (§5.4) or about having lost its lease. Both abort
  // the same way, because from the adapter's point of view they are the same event: this
  // attempt is no longer the one that owns the item.
  let lost = false;
  const beat = setInterval(() => {
    void (async () => {
      try {
        const held = await heartbeat(db, item.id, leaseToken, workerId);
        if (!held) { lost = true; controller.abort(); return; }
        if (await isCancelRequested(db, item.run_id)) controller.abort();
      } catch { /* a failed heartbeat is not itself fatal; the lease will simply lapse */ }
    })();
  }, HEARTBEAT_MS);

  const stages = (payload.arm?.stages ?? {}) as Record<string, StageSpec>;
  const budgetId = String(payload.budget_id ?? '');
  // Resolved BEFORE the gateway, because decision 22 makes the gateway's default ceiling the
  // adapter's. A missing adapter is still handled below, as an ENGINE_UNSUPPORTED failure.
  const adapter = adapters[String(payload.engine ?? '')];
  const gateway = new Gateway({
    db, itemId: item.id, leaseToken, budgetId, transport, stages,
    signal: controller.signal,
    defaultTimeoutMs: adapter?.perAttemptTimeoutMs,
  });

  let state: ItemState = 'failed';
  let execution: ExecutionStatus = 'failed';
  let assessment: AssessmentStatus = 'not_reached';
  let result: unknown = null;
  let error: Record<string, unknown> | null = null;
  let outcome = 'failed';

  try {
    if (!adapter) throw new LabError('ENGINE_UNSUPPORTED', `no round-1 adapter for engine '${payload.engine}'`);

    const outcomeOfRun = await adapter.run({
      runId: item.run_id,
      itemId: item.id,
      caseKey: item.case_key,
      frozen: payload.frozen ?? {},
      arm: payload.arm ?? {},
      repetition: item.repetition,
      gateway,
      signal: controller.signal,
      event: (kind, body) => { events.push({ kind, body }); },
      checkpoint: async <T,>(name: string, dependencyHash: string, produce: () => Promise<T>): Promise<T> => {
        const value = await produce();
        // Slice A writes steps; Slice B's exact code replay reads them (§4.1).
        const { object } = await putObject(db, item.lease_owner ?? workerId, 'artifact', value as unknown, 'deidentified', null);
        await db.query(
          `INSERT INTO lab_v2.steps (item_id, name, dependency_hash, artifact_id) VALUES ($1, $2, $3, $4)
           ON CONFLICT (item_id, name) DO UPDATE SET dependency_hash = EXCLUDED.dependency_hash, artifact_id = EXCLUDED.artifact_id`,
          [item.id, name, dependencyHash, object.id],
        );
        return value;
      },
    });

    result = outcomeOfRun.result;
    execution = outcomeOfRun.execution_status;
    assessment = outcomeOfRun.assessment_status;
    state = execution === 'succeeded' ? 'succeeded' : execution === 'partial' ? 'partial' : 'failed';
    outcome = state === 'succeeded' ? 'succeeded' : 'failed';
    // The summary is what run_result returns inline; the full body becomes an artifact.
    const { object: artifact } = await putObject(db, item.lease_owner ?? workerId, 'artifact', result, 'deidentified', null);
    result = { summary: outcomeOfRun.summary, artifact_id: artifact.id, result_hash: hash(outcomeOfRun.result) };
  } catch (e) {
    const err = e as LabError & { name?: string };
    // A cancelled run whose provider call had already gone out still stores its outcome,
    // and says so (§5.4): the money was spent and the evidence should not be discarded.
    if (controller.signal.aborted && !lost) {
      state = 'cancelled'; execution = 'cancelled'; assessment = 'not_reached'; outcome = 'cancelled';
      result = { late_response: true };
      error = { category: 'cancelled', message: err.message };
    } else {
      error = {
        category: err.code === 'BUDGET_EXHAUSTED' ? 'budget'
          : err.code === 'MODEL_UNSUPPORTED' ? 'model'
          : err.code === 'LAB_IO_FORBIDDEN' ? 'isolation'
          : 'provider',
        code: err.code ?? null,
        message: String(err.message).slice(0, 500),
      };
    }
  } finally {
    clearInterval(beat);
  }

  // A lost lease writes NOTHING further — the item now belongs to another attempt.
  if (lost) {
    await recordEvent(db, 'system', item.id, 'lease_lost', { lease_token: leaseToken });
    return false;
  }

  const wrote = await finish(db, item.id, leaseToken, {
    state,
    result,
    error,
    execution_status: execution,
    assessment_status: assessment,
    attribution_status: gateway.attributionStatus(),
    outcome,
  });
  if (wrote) {
    for (const ev of events) await recordEvent(db, 'system', item.id, ev.kind, ev.body);
  }
  return wrote && state === 'succeeded';
}

/** Read one stored artifact body back, for the `lab://artifacts/{id}` MCP resource. */
export async function readArtifact(db: Db, id: string): Promise<unknown | null> {
  const obj = await getObject(db, id);
  return obj ? obj.body : null;
}
