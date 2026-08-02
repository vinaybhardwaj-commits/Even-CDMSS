/**
 *   node --test --import tsx lib/__tests__/engine-health-honesty.test.ts
 *
 * ENGINE-HEALTH-HONESTY PRD v1.0 (2 Aug 2026) — the panel must not report green on a silent engine.
 *
 * Defect 1: L-3's verdict is a disjunction (`!praiseStillPresent || safetyFired`), so on 1 Aug it
 * reported HOLDS while amoxicillin against a documented penicillin allergy went unflagged — base
 * praise never appeared, `!praiseStillPresent` was true, and the safety matcher was never consulted.
 * Defect 2: the panel's "Ratified @ 0.81.17" header was a hard-coded string that drifts silently.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PART_C_RELATIONS, partCVerdict, RATIFIED_AT_ENGINE, ratificationDriftWarning,
  RATIFIED_RELATION_STATUS,
} from '../metamorphic-core.ts';
import { OPD_ENGINE_VERSION } from '../opd-note-audit-core.ts';

const rel = (id: string) => PART_C_RELATIONS.find((r) => r.id === id)!;
const silent = { baseFired: false, basePraise: false, transformedFired: false, transformedPraise: false };

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Gate test 1 — a failing precondition returns VACUOUS, never HOLDS, never FAILS
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the 1-Aug regression shape: L-3 with no base praise is VACUOUS, not HOLDS', () => {
  // Exactly the measured state that hid the missed contraindication: base praise absent, engine
  // silent on the transformed arm. The old disjunction returned true (HOLDS).
  const out = partCVerdict(rel('L-3'), silent);
  assert.equal(out.verdict, 'VACUOUS');
  assert.notEqual(out.verdict, 'HOLDS');
  assert.equal(out.reason, 'could not be tested — the base arm produced no praise');
});

test('every Part C relation is VACUOUS when its base arm lacks the tested state', () => {
  for (const r of PART_C_RELATIONS) {
    const out = partCVerdict(r, silent);
    assert.equal(out.verdict, 'VACUOUS', `${r.id} must be VACUOUS on a silent base arm`);
    assert.equal(out.reason, `could not be tested — the base arm produced no ${r.precondition}`);
    // …even when the transformed arm looks like a pass — the precondition is checked FIRST.
    const transformedLooksGood = partCVerdict(r, { ...silent, transformedFired: r.id === 'L-3' });
    assert.equal(transformedLooksGood.verdict, 'VACUOUS', `${r.id}: precondition precedes the verdict fn`);
  }
});

test('L-1/L-2 precondition is base fires; L-3 precondition is base praise, not base fires', () => {
  assert.equal(rel('L-1').precondition, 'fires');
  assert.equal(rel('L-2').precondition, 'fires');
  assert.equal(rel('L-3').precondition, 'praise');
  // L-3's base arm never trips its own safety matcher (the fixture plants the allergy only in the
  // transformed arm), so gating L-3 on baseFired would make it permanently vacuous. Base PRAISE
  // present + baseFired false must therefore still be testable:
  const testable = partCVerdict(rel('L-3'), { ...silent, basePraise: true });
  assert.notEqual(testable.verdict, 'VACUOUS');
});

test('with the precondition met, the verdicts are the relation\'s own — HOLDS and FAILS both reachable', () => {
  // L-1: fired on base, gone on transformed → HOLDS; still firing → FAILS.
  assert.equal(partCVerdict(rel('L-1'), { ...silent, baseFired: true }).verdict, 'HOLDS');
  assert.equal(partCVerdict(rel('L-1'), { ...silent, baseFired: true, transformedFired: true }).verdict, 'FAILS');
  // L-3: praise present on base; transformed praise persists with NO safety finding → FAILS (the
  // blind-praise defect); praise persists but safety fired → HOLDS; praise withdrawn → HOLDS.
  assert.equal(partCVerdict(rel('L-3'), { ...silent, basePraise: true, transformedPraise: true }).verdict, 'FAILS');
  assert.equal(partCVerdict(rel('L-3'), { ...silent, basePraise: true, transformedPraise: true, transformedFired: true }).verdict, 'HOLDS');
  assert.equal(partCVerdict(rel('L-3'), { ...silent, basePraise: true, transformedPraise: false }).verdict, 'HOLDS');
  // A tested relation never reports VACUOUS's reason.
  assert.equal(partCVerdict(rel('L-1'), { ...silent, baseFired: true }).reason, undefined);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Gate test 2 — the ratified-at label and the drift warning
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('RATIFIED_AT_ENGINE is pinned to the version the map was measured at — NOT the current engine', () => {
  assert.equal(RATIFIED_AT_ENGINE, 'opd-note-audit/0.81.17');
  assert.notEqual(RATIFIED_AT_ENGINE, OPD_ENGINE_VERSION,
    'if these are now equal, the relations were re-measured and this test must be re-ratified with the map');
});

test('a deployed engine differing from RATIFIED_AT_ENGINE produces the drift warning, verbatim', () => {
  const w = ratificationDriftWarning(OPD_ENGINE_VERSION);
  assert.equal(w,
    `Ratified at ${RATIFIED_AT_ENGINE}. The deployed engine is ${OPD_ENGINE_VERSION}. These statuses have not been re-measured against the deployed engine.`);
  assert.equal(ratificationDriftWarning(RATIFIED_AT_ENGINE), null, 'no warning when the map is current');
});

test('the panel renders the constant, not a hard-coded version string', () => {
  const page = readFileSync('app/admin/observability/engine-health/page.tsx', 'utf8');
  assert.ok(page.includes('Ratified @ {RATIFIED_AT_ENGINE}'), 'the header reads the exported constant');
  assert.ok(!page.includes('Ratified @ 0.81.17'), 'the hard-coded header is gone');
  assert.ok(page.includes('ratificationDriftWarning(OPD_ENGINE_VERSION)'), 'the drift warning is wired to the deployed engine');
  assert.ok(page.includes('partCVerdict(rel, {'), 'the panel verdict goes through the shared partCVerdict — including L-3\'s (praise, safety) wiring');
});

test('RATIFIED_RELATION_STATUS itself is untouched — D-5 and D-7 stay pinned failures', () => {
  assert.equal(RATIFIED_RELATION_STATUS['D-5'], 'fail');
  assert.equal(RATIFIED_RELATION_STATUS['D-7'], 'fail');
  assert.equal(Object.keys(RATIFIED_RELATION_STATUS).length, 14);
});
