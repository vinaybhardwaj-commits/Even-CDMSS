/**
 *   node --test --import tsx lib/__tests__/quantization-revert.test.ts
 *
 * Audit-integrity batch, PHASE 0 — confidence quantization REVERTED (28 Jul S0/S1 ruling).
 *
 * MEASURED on production: 17.0% of 36,502 scoring findings carry confidence exactly 0.80 — the
 * quantization boundary — and quantization raised the mean penalty by 3.10 points per finding.
 * A cliff on the modal confidence value is a worse instrument than the raw float it replaced.
 *
 * The ruling withdrew quantization ONLY and endorsed hysteresis: displayed_band, HYSTERESIS_G and
 * hysteresisBand must not move by a byte.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  computeOpdScore, bandFor, hysteresisBand, HYSTERESIS_G, PENALTY_BASE, SEVERITY,
} from '../opd-note-score-core.ts';
import { OPD_ENGINE_VERSION, OPD_ENGINE_VERSIONS_CURRENT } from '../opd-note-audit-core.ts';

const CORE = readFileSync('lib/opd-note-score-core.ts', 'utf8');

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · The revert itself
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('quantizeConfidence is DELETED — the function, its export, and every call', () => {
  assert.ok(!CORE.includes('quantizeConfidence'), 'no definition, no export, no call may survive');
});

test('findingPenalty is the target text VERBATIM — raw clamped float, no level cliff', () => {
  assert.ok(CORE.includes(`function findingPenalty(f: { verdict: NetValue; confidence: number }): number {
  return PENALTY_BASE * (SEVERITY[f.verdict] ?? 0.2) * clamp(Number(f.confidence) || 0, 0, 1);
}`));
});

test('the penalty is CONTINUOUS in confidence again — the 0.80 cliff is gone', () => {
  const at = (c: number) => computeOpdScore({
    findings: [{ verdict: 'low-value', confidence: c, domain: 'appropriateness' }],
    completenessCoverage: 1, pdqi9: null, patientCentred: { present: 1, total: 1 },
  }).headline;
  // Under quantization, 0.79 → 0.6 and 0.80 → 1.0: an 18-point penalty step on the modal value.
  // Reverted: one hundredth of confidence moves the domain by 0.45 points, the index by ≤ 1.
  assert.ok(Math.abs(at(0.79) - at(0.80)) <= 1, 'no cliff at the 17.0% modal boundary');
  assert.ok(Math.abs(at(0.44) - at(0.45)) <= 1, 'no cliff at the lower boundary either');
  // …and confidence still discriminates monotonically.
  assert.ok(at(0.9) < at(0.5) && at(0.5) < at(0.1), 'raw confidence scales the penalty');
});

test('THE KEPT BEHAVIOUR: junk confidence lands on the scale, not outside it', () => {
  const at = (c: number) => computeOpdScore({
    findings: [{ verdict: 'low-value', confidence: c, domain: 'appropriateness' }],
    completenessCoverage: 1, pdqi9: null, patientCentred: { present: 1, total: 1 },
  }).headline;
  assert.equal(at(-3), at(0), 'below 0 clamps to 0');
  assert.equal(at(7), at(1), 'above 1 clamps to 1');
  assert.equal(at(NaN), at(0), 'NaN clamps to 0 — junk must never escape the scale');
});

test('the pre-S1 arithmetic is restored exactly: the triple-QT canary computes 26 again', () => {
  // 45 × 1.0 × 0.8 = 36 per finding ⇒ 100 × 0.64³ = 26 (was 17 under quantization).
  const interaction = { verdict: 'low-value' as const, confidence: 0.8, domain: 'prescribing_safety' as const };
  const sc = computeOpdScore({
    findings: [interaction, interaction, interaction],
    completenessCoverage: 1,
    pdqi9: { up_to_date: 5, accurate: 5, thorough: 5, useful: 5, organized: 5, comprehensible: 5, succinct: 5, synthesized: 5, internally_consistent: 5 } as never,
    patientCentred: { present: 3, total: 3 },
  });
  assert.equal(sc.domains.find((d) => d.domain === 'prescribing_safety')!.score, 26);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · What must NOT move — the ruling withdrew quantization ONLY
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('PENALTY_BASE, SEVERITY and bandFor are byte-identical', () => {
  assert.equal(PENALTY_BASE, 45);
  assert.deepEqual(SEVERITY, { 'low-value': 1.0, 'context-dependent': 0.5, uncertain: 0.2, 'high-value': 0 });
  assert.ok(CORE.includes(`export function bandFor(headline: number): Band {
  if (headline >= 85) return 'A';
  if (headline >= 70) return 'B';
  if (headline >= 55) return 'C';
  if (headline >= 40) return 'D';
  return 'E';
}`));
});

test('hysteresis is ENDORSED and untouched: g, the rule, and the store CASE all stand', () => {
  assert.equal(HYSTERESIS_G, 3.87);
  assert.equal(hysteresisBand(69.9, 'B'), 'B', 'holds inside g');
  assert.equal(hysteresisBand(66.12, 'B'), 'C', 'moves on a decisive crossing');
  assert.equal(hysteresisBand(72, null), 'B', 'NULL prior bands normally');
  const store = readFileSync('lib/opd-audit-store.ts', 'utf8');
  assert.ok(store.includes('function hysteresisCaseSql('), 'the displayed_band write paths stand');
  assert.ok(store.includes("displayed_band = ${hysteresisCaseSql('opd_note_audits.displayed_band', 'EXCLUDED.displayed_band', 'EXCLUDED.note_quality_index')}"));
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · The bump — a scoring change must be nameable
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('engine is 0.81.16 and the family includes it (decision 21 — no orphaned corpus)', () => {
  assert.equal(OPD_ENGINE_VERSION, 'opd-note-audit/0.81.16');
  const fam = OPD_ENGINE_VERSIONS_CURRENT as readonly string[];
  assert.ok(fam.includes('opd-note-audit/0.81.16'), 'bump without the append empties the lists');
  assert.ok(fam.includes('opd-note-audit/0.81.15'), 'history stays readable');
});
