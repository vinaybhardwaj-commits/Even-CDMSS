/**
 * lib/__tests__/reconciler-races.test.ts — kickoff tests 55, 58, 59 and 64.
 *
 * ⚠️ WHAT IS EXERCISED AND WHAT IS PINNED. D13's MAPPING is a pure function and is exercised
 * exhaustively. The reconciler's RACE BEHAVIOUR lives inside a Next route handler that this
 * repository has no harness to invoke, so it is pinned by source and by its two exported statements
 * — which is weaker, and is said so here rather than left to be assumed. What the pins can prove is
 * that the compare-and-set carries an expected revision, that the statement itself cannot move a
 * terminal row, and that the reread happens exactly once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  reconcilerStateFor, isAllowedTransition, RETRIEVAL_PERSISTENCE_STATES, TERMINAL_PERSISTENCE_STATES,
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

test('64 — exactly ONE line changed in each file, and it is the cron-count line', () => {
  // The check is a line-by-line diff against the assertion that was there before: every OTHER line
  // must be untouched. Asserting "nothing else changed" by eye is what lets a second edit ride
  // along inside an authorised one.
  const before: Record<string, { line: number; text: string }> = {
    'lib/__tests__/provider-switch-unit-d.test.ts': {
      line: 270, text: '  assert.equal(cfg.crons.length, 16);',
    },
    'lib/__tests__/ipd-worker-batch-and-model.test.ts': {
      line: 57, text: "  assert.equal(VERCEL.crons.length, 16, '14 + the restored IPD worker + the readmission worker');",
    },
  };
  for (const f of CRON_COUNT_FILES) {
    const lines = readFileSync(f, 'utf8').split('\n');
    const { line, text } = before[f];
    // The authorised line, and only it, differs from what it was.
    assert.notEqual(lines[line - 1], text, `${f}:${line} is the line that changed`);
    assert.match(lines[line - 1], /crons\.length, 17/, `${f}:${line} now reads 17`);
    // And the count assertion appears exactly once, so the edit did not duplicate itself elsewhere.
    assert.equal(
      lines.filter((l) => /crons\.length, 1[67]/.test(l)).length, 1,
      `${f} asserts the cron count in exactly one place`,
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
