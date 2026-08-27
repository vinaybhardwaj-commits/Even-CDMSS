/**
 *   node --test --import tsx lib/__tests__/preop-b5-b6-wiring.test.ts
 *
 * B5 + B6 — the wiring that cannot be exercised offline (the sweep reads db13 and Neon),
 * pinned where it is written. Every assertion here is about a property that would be
 * expensive to discover on production: a rail that writes when it was only asked to
 * measure, a budget checked after the overrun rather than before the call, a rail artefact
 * that reaches the fingerprint.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { opdNoteText } from '../preop/db13.ts';
import {
  PREOP_EXTRACT_MAX_PER_TICK, PREOP_LLM_BUDGET_MS, preopRailsFromEnv,
} from '../preop/run.ts';
import { PREOP_EXTRACT_BUDGET_MS } from '../preop/extract.ts';
import { PREOP_NARRATIVE_BUDGET_MS, PREOP_NARRATIVE_MAX_PER_TICK } from '../preop-narrative-core.ts';

const src = (p: string) => readFileSync(p, 'utf8');

// ── the flags ship OFF, and the module says so wherever it is asked ─────────────

test('both rails read OFF from an environment that has never set them', () => {
  delete process.env.PREOP_EXTRACT_ENABLED;
  delete process.env.PREOP_NARRATIVE_ENABLED;
  assert.deepEqual(preopRailsFromEnv(), { extract: false, narrative: false });
});

test('the flags are read from the environment on every call, never cached at import', () => {
  process.env.PREOP_EXTRACT_ENABLED = '1';
  assert.equal(preopRailsFromEnv().extract, true);
  delete process.env.PREOP_EXTRACT_ENABLED;
  assert.equal(preopRailsFromEnv().extract, false);
});

// ── a forced rail may never write ───────────────────────────────────────────────

test('the worker’s rails override IMPLIES dry run — enforced in code, not in the doc comment', () => {
  const w = src('app/api/preop/worker/route.ts');
  assert.match(w, /const dryRun = p\.get\('dry_run'\) === '1' \|\| !!railsOverride;/,
    'the OR must be on the dryRun line itself; a separate guard could be reordered away');
  // and there is exactly one call site, so the flag cannot be recomputed after the check
  assert.equal((w.match(/runPreopSweep\(/g) ?? []).length, 1);
  assert.match(w, /runPreopSweep\(\{ horizonDays, dryRun, rails: railsOverride,/);
  // and the heavy per-episode sample is offered on a probe only — never on a writing tick
  assert.match(w, /const collect = p\.get\('sample'\) === '1' && !!railsOverride;/);
});

test('the sweep guards every write behind dryRun — snapshot, extraction, narrative and heartbeat', () => {
  const r = src('lib/preop/run.ts');
  for (const call of ['saveExtraction(', 'saveNarrative(', 'saveSnapshot(', 'recordSweep(']) {
    const i = r.indexOf(call);
    assert.ok(i > 0, `${call} missing`);
    const before = r.slice(Math.max(0, i - 400), i);
    assert.ok(/!opts\.dryRun/.test(before), `${call} is not behind a dryRun guard`);
  }
});

// ── the budget is checked BEFORE the leg, not after it overruns ─────────────────

test('a leg is only begun if its own ceiling still fits inside what is left of the box', () => {
  const r = src('lib/preop/run.ts');
  assert.match(r, /const roomFor = \(legMs: number\) => spent\(\) \+ legMs <= llmBudgetMs;/);
  assert.match(r, /extractTally\.called >= PREOP_EXTRACT_MAX_PER_TICK \|\| !roomFor\(PREOP_EXTRACT_BUDGET_MS\)/);
  assert.match(r, /narrativeTally\.called >= PREOP_NARRATIVE_MAX_PER_TICK \|\| !roomFor\(PREOP_NARRATIVE_BUDGET_MS\)/);
});

test('the worst case the caps allow still fits the worker box only because the BUDGET binds', () => {
  const capsAlone = PREOP_EXTRACT_MAX_PER_TICK * PREOP_EXTRACT_BUDGET_MS
    + PREOP_NARRATIVE_MAX_PER_TICK * PREOP_NARRATIVE_BUDGET_MS;
  assert.ok(capsAlone > PREOP_LLM_BUDGET_MS, 'if the caps ever became the binding constraint, this arithmetic must be redone');
  const SLOWEST_MEASURED_DETERMINISTIC_TICK_MS = 55_383;   // 26 Aug, Metabase contention
  const MAX_DURATION_MS = 300_000;
  assert.ok(PREOP_LLM_BUDGET_MS + SLOWEST_MEASURED_DETERMINISTIC_TICK_MS < MAX_DURATION_MS);
});

test('a budget skip leaves the STORED reading in place — declining to call is not a retraction', () => {
  const r = src('lib/preop/run.ts');
  const i = r.indexOf('extractTally.skippedBudget++');
  const around = r.slice(i - 600, i + 200);
  assert.match(around, /record: extraction, changed: false/,
    'the skip path must carry the stored record forward, or an input the rail proposed would vanish for a tick');
});

// ── the rails cannot reach the fingerprint ──────────────────────────────────────

test('neither rail is written by saveSnapshot, and neither column is read by the fingerprint', () => {
  const store = src('lib/preop/store.ts');
  const save = store.slice(store.indexOf('export async function saveSnapshot'), store.indexOf('// ── reads'));
  for (const col of ['extraction', 'narrative']) {
    assert.ok(!save.includes(`${col} =`), `saveSnapshot must not write ${col}`);
    assert.ok(!save.includes(`${col}_fingerprint`), `saveSnapshot must not write ${col}_fingerprint`);
  }
  const assemble = src('lib/preop-assemble-core.ts');
  const fpStart = assemble.indexOf('export function snapshotFingerprint');
  const fp = assemble.slice(fpStart, assemble.indexOf('\n// ──', fpStart));
  assert.ok(!fp.includes('extraction'), 'the fingerprint material must not mention the extraction record');
  assert.ok(!fp.includes('narrative'), 'nor the narrative');
  assert.ok(!fp.includes('sourceSpan'), 'nor the verbatim span');
});

test('the extraction is read BEFORE the snapshot is composed — otherwise reuse holds only within a tick', () => {
  const r = src('lib/preop/run.ts');
  assert.ok(r.indexOf('readRails(') < r.indexOf('for (const ep of episodes)'), 'the stored rails are fetched up front');
  assert.ok(r.indexOf('const extractObs') < r.indexOf('const snap: PreopSnapshot = composeSnapshot'));
});

test('extracted observations reach the snapshot only when the rail is on — twice over', () => {
  const r = src('lib/preop/run.ts');
  assert.match(r, /const extractObs = rails\.extract \? extractionObservations\(extraction\) : \[\];/);
  assert.match(r, /includeExtracted: rails\.extract,/);
});

// ── the OPD free-text source ────────────────────────────────────────────────────

test('doctor_notes yields its note strings and nothing else', () => {
  assert.equal(opdNoteText('[{"note":"This is now recovered.","doctor":{"name":"Even Health"}}]'), 'This is now recovered.');
  assert.equal(opdNoteText('[{"note":"a"},{"note":"b"}]'), 'a\nb');
});

test('an unrecognised doctor_notes shape yields NOTHING — never a stringified blob for a model to read', () => {
  assert.equal(opdNoteText('{"note":"not an array"}'), null);
  assert.equal(opdNoteText('not json at all'), null);
  assert.equal(opdNoteText('[{"doctor":{"name":"Even Health"}}]'), null);
  assert.equal(opdNoteText(null), null);
});

test('the OPD free-text query only runs when the extraction rail is on', () => {
  const r = src('lib/preop/run.ts');
  assert.match(r, /const opdNarr = rails\.extract\s*\n?\s*\? await fetchOpdNarrative/);
});

test('the measured emptiness of that source is recorded beside the query, not left to be inferred', () => {
  const d = src('lib/preop/db13.ts');
  assert.match(d, /`relevant_medical_history` is filled on\s*\n \* 0, `doctor_notes` on 1/);
  assert.match(d, /SIXTH DETERMINISTIC source/, 'the structured comorbidities column is flagged for V, not silently mapped');
});
