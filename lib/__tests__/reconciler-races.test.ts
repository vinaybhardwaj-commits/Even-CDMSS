/**
 * lib/__tests__/reconciler-races.test.ts — kickoff tests 55, 58, 59 and 64.
 *
 * ⚠️ WHAT IS EXERCISED AND WHAT IS PINNED, CORRECTED. This header used to say the route was "pinned
 * by source and by its two exported statements". It has no exported statements — Next rejects extra
 * route exports, so `RECONCILER_SELECT_SQL`, `RECONCILER_UPDATE_SQL` and `REREAD_SQL` are three
 * module-private constants — and reading them out of the source was never sufficient. One line
 * defeats a source pin while leaving all three constants byte-identical:
 *
 *     await sql(RECONCILER_UPDATE_SQL.replace('AND row_revision = $2', 'AND $2::int IS NOT NULL'), …)
 *
 * So the exported `GET` is now DRIVEN, against a fake table stateful enough to decide from the
 * observed SQL, the bound parameters and the row's current revision and state whether an update
 * lands. The source pins are kept — they are cheap and they name the intent — but they are not what
 * proves the compare-and-set.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { installDbStub, type DbStub } from './telemetry-db-stub';
import { GET } from '../../app/api/admin/retrieval-telemetry-reconcile/route';
import {
  reconcilerStateFor, isAllowedTransition, RETRIEVAL_PERSISTENCE_STATES, TERMINAL_PERSISTENCE_STATES,
  NON_TERMINAL_PERSISTENCE_STATES,
} from '../retrieval-telemetry-core';
import {
  WORKER_MAX_DURATION_SECONDS, RECONCILER_GRACE_SECONDS, RECONCILER_STALE_AFTER_SECONDS,
} from '../opd-audit-runtime-config';

const RECONCILER = readFileSync('app/api/admin/retrieval-telemetry-reconcile/route.ts', 'utf8');
const WORKER_ROUTE = readFileSync('app/api/opd-audit/worker/route.ts', 'utf8');
const VERCEL = JSON.parse(readFileSync('vercel.json', 'utf8')) as { crons: Array<{ path: string; schedule: string }> };

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 55 — the mapping, the race, the reread, and the terminal-row rule
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('55 — every failure-phase to reconciler-state mapping, all four rows of D13\'s table', () => {
  const D13: Array<[('started' | 'retrieval_complete'), string[], string]> = [
    ['started', ['retrieval_terminal'], 'telemetry_persistence_failed'],
    ['started', [], 'aborted'],
    ['retrieval_complete', ['persistence_link'], 'telemetry_persistence_failed'],
    ['retrieval_complete', [], 'persistence_unknown'],
  ];
  for (const [from, phases, to] of D13) {
    assert.equal(reconcilerStateFor(from, phases), to, `${from} + [${phases}]`);
  }
  // "Where several failures exist, the latest phase RELEVANT TO THE CURRENT ROW STATE controls."
  // A `persistence_link` failure on a `started` row is not relevant: that row never got that far.
  assert.equal(reconcilerStateFor('started', ['persistence_link', 'work_declaration']), 'aborted');
  assert.equal(reconcilerStateFor('retrieval_complete', ['retrieval_terminal']), 'persistence_unknown');
  // A `work_declaration` failure produces no retrieval row at all, so it maps to nothing here.
  assert.equal(reconcilerStateFor('started', ['work_declaration']), 'aborted');
});

test('55 — the selection is bounded, non-terminal only, and oldest first', () => {
  assert.match(RECONCILER, /WHERE persistence_state IN \('started', 'retrieval_complete'\)/);
  assert.match(RECONCILER, /AND started_at < \$1/);
  assert.match(RECONCILER, /ORDER BY started_at\n\s+LIMIT \$2/);
  // A bounded pass that hides its truncation reads as "everything was covered".
  assert.ok(RECONCILER.includes('more_may_remain: stale.length === limit'));
});

test('55 — the update is a compare-and-set on the expected revision, and cannot move a terminal row', () => {
  assert.match(RECONCILER, /SET persistence_state = \$3, persistence_settled_at = \$4, row_revision = row_revision \+ 1/);
  assert.match(RECONCILER, /WHERE retrieval_run_id = \$1\n\s+AND row_revision = \$2/);
  // Belt to the revision's braces: the statement itself refuses a terminal row.
  assert.match(RECONCILER, /AND persistence_state IN \('started', 'retrieval_complete'\)\n\s+RETURNING row_revision/);
  // And the code refuses one before it even gets there — a successful terminal state always wins.
  assert.ok(RECONCILER.includes("if (isTerminalState(from)) return { runId: row.retrieval_run_id, result: 'won_by_a_later_write', from };"));
});

test('55 — a revision mismatch causes ONE reread and reclassification, never a blind retry', () => {
  // The reread re-derives the state from what the row BECAME…
  assert.ok(RECONCILER.includes('return reconcileRow(fresh[0], at, true);'));
  // …and the second attempt cannot recurse again.
  assert.ok(RECONCILER.includes("if (reread) {"));
  assert.match(RECONCILER, /if \(reread\) \{[\s\S]{0,260}return \{ runId: row\.retrieval_run_id, result: 'won_by_a_later_write', from \};/);
  // A blind retry would look like a loop on the same row object. There is exactly one recursive
  // call in the file, and it passes the FRESH row.
  assert.equal((RECONCILER.match(/reconcileRow\(/g) || []).length, 3, 'the definition, the entry call, and the one reread');
});

test('55 — every state the reconciler can assign is a legal transition from where it assigns it', () => {
  for (const from of ['started', 'retrieval_complete'] as const) {
    for (const phases of [[], ['retrieval_terminal'], ['persistence_link']]) {
      const to = reconcilerStateFor(from, phases);
      assert.ok(isAllowedTransition(from, to), `${from} -> ${to}`);
      assert.ok((RETRIEVAL_PERSISTENCE_STATES as readonly string[]).includes(to));
      assert.ok((TERMINAL_PERSISTENCE_STATES as readonly string[]).includes(to), 'and it is terminal — the pass ENDS the ambiguity');
    }
  }
  // The route checks this itself rather than trusting the mapping, and records a refusal instead of
  // forcing one: the transition table is the only authority.
  assert.ok(RECONCILER.includes("if (!isAllowedTransition(from, to)) {"));
});

test('55 — the reconciler owns an invocation of its own kind, and closes it', () => {
  assert.ok(RECONCILER.includes("const ctx = telemetryContextFor('reconciler', req.headers);"));
  assert.ok(RECONCILER.includes("await startInvocation(ctx, 'reconciler');"), 'kind = reconciler, never retrieval');
  // Both exits close it: a pass that threw still ran, and its invocation should not read as killed.
  assert.equal((RECONCILER.match(/await closeInvocation\(ctx,/g) || []).length, 2);
  // It must NOT join (uid, engine_version) to find an audit — two executions for one note are two
  // rows by design, and that join would link a run to another run's audit. Checked against the
  // CODE with comments stripped, because the prohibition is also written down in one of them.
  const code = RECONCILER.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/engine_version/.test(code), false, 'no statement mentions engine_version');
  assert.equal(/\bJOIN\b/i.test(code), false, 'and none joins anything at all');
  assert.equal(/\buid\b/.test(code), false, 'nor selects a patient identifier it has no use for');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 55, AT RUN TIME — the compare-and-set, the reread, and the stale decision that must not land
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// ⚠️ NON-GLOBAL REGULAR EXPRESSIONS, DELIBERATELY. The stub calls `RegExp.test()` repeatedly against
// the same objects, and `/g` or `/y` would carry `lastIndex` between calls — a route would match,
// then silently stop matching.

const STALE_SELECT = /SELECT retrieval_run_id[\s\S]*WHERE persistence_state IN/;
const REREAD_SELECT = /SELECT retrieval_run_id[\s\S]*WHERE retrieval_run_id = \$1/;
/** ⚠️ ANCHORED ON THE TELEMETRY TABLE. The request also closes its invocation, which issues an
 *  `UPDATE opd_retrieval_invocations`; counting every `UPDATE` gives the wrong answer. */
const TELEMETRY_UPDATE = /^\s*UPDATE opd_audit_retrieval_telemetry\b/;
const INVOCATION_WRITE = /opd_retrieval_invocations/;
const FAILURE_PHASES = /SELECT failed_phase/;

interface FakeRow { id: string; role: string; state: string; revision: number }
const wire = (r: FakeRow) => ({
  retrieval_run_id: r.id, retrieval_role: r.role, persistence_state: r.state, row_revision: r.revision,
});

/**
 * A fake table that DECIDES. Returning `[]` from every update would prove nothing about a
 * compare-and-set: the point is that the predicates in the statement the route actually sent are
 * what determine whether the write lands.
 *
 * `race` is the concurrent writer, applied immediately before the Nth update is evaluated.
 */
function installFakeTable(
  db: DbStub,
  selected: FakeRow[],
  race?: { beforeUpdate: number; becomes: FakeRow },
) {
  const live = new Map(selected.map((r) => [r.id, { ...r }]));
  const log: Array<{ params: unknown[]; landed: boolean }> = [];

  db.on(INVOCATION_WRITE, []);
  db.on(FAILURE_PHASES, []);                       // no failure evidence in any case here
  db.on(STALE_SELECT, selected.map(wire));         // a snapshot, as a real SELECT would be
  db.on(REREAD_SELECT, (c) => {
    const r = live.get(String(c.params[0]));
    return r ? [wire(r)] : [];
  });
  db.on(TELEMETRY_UPDATE, (c) => {
    if (race && log.length + 1 === race.beforeUpdate) live.set(race.becomes.id, { ...race.becomes });
    const [runId, boundRevision, state] = c.params as [string, string, string];
    const row = live.get(runId);
    const revisionGuarded = /AND row_revision = \$2/.test(c.query);
    const stateGuarded = /AND persistence_state IN \('started', 'retrieval_complete'\)/.test(c.query);
    let landed = !!row;
    if (row && revisionGuarded && Number(boundRevision) !== row.revision) landed = false;
    if (row && stateGuarded && !(NON_TERMINAL_PERSISTENCE_STATES as readonly string[]).includes(row.state)) landed = false;
    log.push({ params: c.params, landed });
    if (!landed || !row) return [];
    row.state = state;
    row.revision += 1;
    return [{ row_revision: row.revision }];
  });
  return { live, log };
}

const cronRequest = () => new NextRequest(
  'https://cdmss.invalid/api/admin/retrieval-telemetry-reconcile',
  { headers: { 'x-vercel-cron': '1' } },
);

/** The route's JSON body, typed only as far as these tests read it. */
interface ReconcileBody {
  ok: boolean;
  selected: number;
  verdicts: Array<{ runId: string; result: string; from?: string; to?: string; reread?: boolean }>;
}

test('55 runtime — the pass runs, selects, and reports', async () => {
  const db = installDbStub();
  installFakeTable(db, [{ id: 'r1', role: 'primary', state: 'started', revision: 3 }]);
  const res = await GET(cronRequest());
  assert.equal(res.status, 200);
  const body = await res.json() as ReconcileBody;
  assert.equal(body.ok, true);
  assert.equal(body.selected, 1);
  assert.equal(db.matching(STALE_SELECT).length, 1, 'the stale-row SELECT ran');
});

test('55 runtime — the UPDATE the route ACTUALLY SENT carries both predicates', async () => {
  const db = installDbStub();
  installFakeTable(db, [{ id: 'r1', role: 'primary', state: 'started', revision: 3 }]);
  await GET(cronRequest());
  const [update] = db.matching(TELEMETRY_UPDATE);
  assert.ok(update, 'a telemetry update was issued');
  // ⚠️ THE RUNTIME TEXT, NOT THE MODULE CONSTANT. `RECONCILER_UPDATE_SQL.replace(…)` at the call
  // site leaves the constant byte-identical and every source regex still matching.
  assert.match(update.query, /AND row_revision = \$2/, 'the revision predicate survived to the wire');
  assert.match(update.query, /AND persistence_state IN \('started', 'retrieval_complete'\)/);
});

test('55 runtime — each row\'s update binds ITS OWN revision', async () => {
  const db = installDbStub();
  const { log } = installFakeTable(db, [
    { id: 'r-a', role: 'primary', state: 'started', revision: 41 },
    { id: 'r-b', role: 'normative_channel', state: 'retrieval_complete', revision: 97 },
  ]);
  await GET(cronRequest());
  assert.equal(log.length, 2);
  // Wire form: the driver renders every bound parameter to text before it leaves the process.
  assert.deepEqual(log.map((u) => [u.params[0], u.params[1]]), [['r-a', '41'], ['r-b', '97']]);
  assert.deepEqual(log.map((u) => u.landed), [true, true]);
});

test('55 runtime — THE STALE DECISION DOES NOT LAND: reread, reclassify, write the FRESH state', async () => {
  const db = installDbStub();
  // Selected as `started` at 7. A concurrent writer completes the retrieval before the update runs.
  const { log } = installFakeTable(
    db,
    [{ id: 'r1', role: 'primary', state: 'started', revision: 7 }],
    { beforeUpdate: 1, becomes: { id: 'r1', role: 'primary', state: 'retrieval_complete', revision: 8 } },
  );
  const body = await (await GET(cronRequest())).json() as ReconcileBody;

  assert.equal(log.length, 2, 'exactly two telemetry updates');
  // The first carries the decision made from the row as SELECTED — and must not land.
  assert.deepEqual(log[0].params.slice(0, 3), ['r1', '7', 'aborted']);
  assert.equal(log[0].landed, false, 'the stale decision was written anyway');
  assert.equal(db.matching(REREAD_SELECT).length, 1, 'exactly one reread');
  // The second is RECLASSIFIED from the fresh row: `retrieval_complete` with no failure evidence is
  // `persistence_unknown`, not the `aborted` this pass first decided on.
  assert.deepEqual(log[1].params.slice(0, 3), ['r1', '8', 'persistence_unknown']);
  assert.equal(log[1].landed, true);
  assert.deepEqual(body.verdicts, [{
    runId: 'r1', result: 'reconciled', from: 'retrieval_complete', to: 'persistence_unknown', reread: true,
  }]);
});

test('55 runtime — a TERMINAL row wins, and no second update is issued', async () => {
  const db = installDbStub();
  const { log } = installFakeTable(
    db,
    [{ id: 'r1', role: 'primary', state: 'started', revision: 7 }],
    { beforeUpdate: 1, becomes: { id: 'r1', role: 'primary', state: 'persisted_complete', revision: 8 } },
  );
  const body = await (await GET(cronRequest())).json() as ReconcileBody;

  assert.equal(log.length, 1, 'exactly one telemetry update — the reread found a terminal row');
  assert.equal(log[0].landed, false);
  assert.equal(db.matching(REREAD_SELECT).length, 1, 'exactly one reread');
  assert.deepEqual(body.verdicts, [{ runId: 'r1', result: 'won_by_a_later_write', from: 'persisted_complete' }]);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 58 — the shared duration constant and the worker route literal agree
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('58 — WORKER_MAX_DURATION_SECONDS equals the worker route\'s own maxDuration literal', () => {
  // The constant is new; the route literal is what production has always run on. A grace derived
  // from a number that silently moved is worse than no reconciler.
  const m = /^export const maxDuration = (\d+);$/m.exec(WORKER_ROUTE);
  assert.ok(m, 'the worker route still declares maxDuration as a top-level literal');
  assert.equal(Number(m[1]), WORKER_MAX_DURATION_SECONDS);
  // The grace itself, recorded here so a change to it changes a test as well as a report.
  assert.equal(RECONCILER_GRACE_SECONDS, 1800);
  assert.equal(RECONCILER_STALE_AFTER_SECONDS, WORKER_MAX_DURATION_SECONDS + RECONCILER_GRACE_SECONDS);
  assert.equal(RECONCILER_STALE_AFTER_SECONDS, 2600);
  // ⚠️ NOT READ FROM THE ENVIRONMENT. A preregistered value that can be changed by setting a
  // variable is not preregistered.
  const cfg = readFileSync('lib/opd-audit-runtime-config.ts', 'utf8');
  assert.equal(/process\.env/.test(cfg), false, 'the runtime config reads no environment variable');
  assert.ok(RECONCILER.includes('RECONCILER_STALE_AFTER_SECONDS'), 'and the route uses the constant, not a number');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 59 — the reconciler cron does not overlap the worker window
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** The hours a `m h * * *`-style cron fires on. Only the shapes this file's crons actually use. */
function hoursOf(schedule: string): number[] {
  const hourField = schedule.split(/\s+/)[1];
  if (hourField === '*') return Array.from({ length: 24 }, (_, i) => i);
  const out = new Set<number>();
  for (const part of hourField.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    assert.ok(m, `unhandled hour field: ${hourField}`);
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    for (let h = from; h <= to; h += 1) out.add(h);
  }
  return [...out];
}

test('59 — the reconciler fires at 10:01 UTC, outside every hour the OPD worker runs', () => {
  const reconciler = VERCEL.crons.find((c) => c.path === '/api/admin/retrieval-telemetry-reconcile');
  assert.ok(reconciler, 'the reconciler cron exists');
  assert.equal(reconciler.schedule, '1 10 * * *');

  const worker = VERCEL.crons.find((c) => c.path === '/api/opd-audit/worker');
  assert.ok(worker, 'the OPD worker cron exists');
  const workerHours = hoursOf(worker.schedule);
  const reconcilerHours = hoursOf(reconciler.schedule);
  for (const h of reconcilerHours) {
    assert.equal(workerHours.includes(h), false, `hour ${h} is inside the worker window ${worker.schedule}`);
  }
  // ⚠️ THE WINDOW WRAPS MIDNIGHT (18-23,0-2), so the distance is CIRCULAR. Subtracting the last
  // hour from the first would report -13 and read as an overlap that is not there.
  const circular = (a: number, b: number) => Math.min(Math.abs(a - b), 24 - Math.abs(a - b));
  const gapHours = Math.min(...workerHours.map((h) => circular(h, reconcilerHours[0])));
  assert.ok(gapHours >= 1, `only ${gapHours}h from the nearest worker hour to the reconciler`);
  assert.equal(gapHours, 8, 'eight hours clear on either side of the window');

  // Off the even minute, deliberately: minute 0 and every even minute already carry crons.
  const minute = Number(reconciler.schedule.split(/\s+/)[0]);
  assert.equal(minute % 2, 1, 'an odd minute keeps it clear of the */2 backfill ticks');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 64 — the two cron-count tests read 17, and NOTHING ELSE in either file changed
// ════════════════════════════════════════════════════════════════════════════════════════════════

const CRON_COUNT_FILES = [
  'lib/__tests__/provider-switch-unit-d.test.ts',
  'lib/__tests__/ipd-worker-batch-and-model.test.ts',
] as const;

test('64 — both files assert 17, and neither still asserts 16', () => {
  assert.equal(VERCEL.crons.length, 17);
  for (const f of CRON_COUNT_FILES) {
    const src = readFileSync(f, 'utf8');
    assert.match(src, /crons\.length, 17/, `${f} reads 17`);
    assert.equal(/crons\.length, 16/.test(src), false, `${f} has no stale 16`);
  }
});

/**
 * The BYTE COMPARISON of the untouched regions kickoff v11 line 1178 asks for, and which the
 * previous version of this test did not do — replacing line 273 of `provider-switch-unit-d.test.ts`
 * with `assert.ok(true);` left every case here green.
 *
 * The method: undo the ONE authorised edit in memory, then hash the whole file and compare against
 * what it hashed to at `177adc9`. Nothing about the file except that line may differ, and the hash
 * covers every byte of it. The baselines are stored HERE, outside the two files being hashed, and
 * are not derived from the current source at run time — a hash computed from the thing it is meant
 * to check is a tautology, and git is not consulted from a test.
 *
 * ⚠️ WHAT A CONTENT HASH CANNOT SEE: a mode change, a type change or a rename. Those are the
 * commit-shape checks' job, not this one's.
 */
const CRON_BASELINE = [
  {
    file: 'lib/__tests__/provider-switch-unit-d.test.ts',
    line: 270,
    current: '  assert.equal(cfg.crons.length, 17);',
    historical: '  assert.equal(cfg.crons.length, 16);',
    sha256At177adc9: '07119f83d03b98614e55b886b812bb8b0d30515bdfa6086b98d7e14e90b3ce66',
  },
  {
    file: 'lib/__tests__/ipd-worker-batch-and-model.test.ts',
    line: 57,
    current: "  assert.equal(VERCEL.crons.length, 17, '14 + the restored IPD worker + the readmission worker + the retrieval-telemetry reconciler');",
    historical: "  assert.equal(VERCEL.crons.length, 16, '14 + the restored IPD worker + the readmission worker');",
    sha256At177adc9: '05c935ca7ed81be95b26bb5703317769670d5ec4c0ca49660098b8a6d34ec78a',
  },
] as const;

test('64 — undo the one authorised line and each file hashes to exactly what it did at 177adc9', () => {
  for (const b of CRON_BASELINE) {
    const lines = readFileSync(b.file, 'utf8').split('\n');
    assert.equal(
      lines.filter((l) => l === b.current).length, 1,
      `${b.file}: the authorised line must occur exactly once, verbatim`,
    );
    assert.equal(
      lines.filter((l) => l === b.historical).length, 0,
      `${b.file}: the historical line must not still be present`,
    );
    const at = lines.indexOf(b.current);
    assert.equal(at + 1, b.line, `${b.file}: the authorised line is at line ${b.line}`);
    lines[at] = b.historical;
    assert.equal(
      createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex'), b.sha256At177adc9,
      `${b.file}: something OTHER than the cron count changed`,
    );
  }
});

test('64 — provider-switch-unit-d\'s sql-guard assertion is untouched, and is nowhere near line 270', () => {
  const lines = readFileSync('lib/__tests__/provider-switch-unit-d.test.ts', 'utf8').split('\n');
  // The kickoff says line 255 holds this and line 1073 says 257. The TREE says 255 is the test
  // title and 257 is the assertion; both are re-read here rather than restated.
  assert.match(lines[254], /^test\('lib\/sql-guard-core\.ts was NOT edited by this build'/);
  assert.match(lines[256], /assert\.ok\(guard\.includes\('const BLOCKED_RELATIONS = /);
  assert.ok(
    lines[256].includes('traces|trace_events|appropriateness_runs|ccb_briefs|care_track_assignments|opd_audit_feedback'),
    'the blocked-relation literal is byte-identical',
  );
});
