/**
 * Pure-core tests for lib/opd-note-score-core.ts.
 *   node --experimental-strip-types --test lib/__tests__/opd-note-score-core.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeOpdScore, OPD_DEFAULT_WEIGHTS, type OpdScoreInput } from '../opd-note-score-core.ts';

const PDQI_ALL = (v: number) => ({
  up_to_date: v, accurate: v, thorough: v, useful: v, organized: v,
  comprehensible: v, succinct: v, synthesized: v, internally_consistent: v,
});

test('a complete, high-quality note scores in band A', () => {
  const sc = computeOpdScore({
    findings: [],
    completenessCoverage: 1,
    pdqi9: PDQI_ALL(5),
    patientCentred: { present: 3, total: 3 },
  });
  assert.equal(sc.headline, 100);
  assert.equal(sc.band, 'A');
  // 0 findings + a PDQI read → signal 2 → 'moderate' (confidence scales with signal found)
  assert.equal(sc.confidence, 'moderate');
});

test('a poor note (gaps + low-value order + prescribing issue + weak PDQI) scores low', () => {
  const input: OpdScoreInput = {
    findings: [
      { verdict: 'low-value', confidence: 0.9, domain: 'appropriateness' },
      { verdict: 'low-value', confidence: 0.8, domain: 'prescribing_safety' },
    ],
    completenessCoverage: 0.4,
    pdqi9: PDQI_ALL(2),
    patientCentred: { present: 0, total: 3 },
  };
  const sc = computeOpdScore(input);
  assert.ok(sc.headline < 55, `expected low headline, got ${sc.headline}`);
  assert.ok(['D', 'E'].includes(sc.band));
  // documentation reflects coverage exactly
  assert.equal(sc.domains.find((d) => d.domain === 'documentation')!.score, 40);
  // PDQI all-2 → (2-1)/4*100 = 25
  assert.equal(sc.domains.find((d) => d.domain === 'note_quality')!.score, 25);
});

test('PDQI-9 not assessed → note_quality weight collapses to 0 (does not drag the index)', () => {
  const sc = computeOpdScore({
    findings: [],
    completenessCoverage: 1,
    pdqi9: null,
    patientCentred: { present: 2, total: 2 },
  });
  const nq = sc.domains.find((d) => d.domain === 'note_quality')!;
  assert.equal(nq.weight, 0);
  assert.equal(nq.basis, 'PDQI-9 not assessed');
  // headline = weighted mean over the other four, all 100 → 100
  assert.equal(sc.headline, 100);
});

test('PDQI-9 partial ratings average only the provided attributes', () => {
  const sc = computeOpdScore({
    findings: [],
    completenessCoverage: 1,
    pdqi9: { accurate: 5, thorough: 1 }, // mean 3 → (3-1)/4*100 = 50
    patientCentred: { present: 1, total: 1 },
  });
  assert.equal(sc.domains.find((d) => d.domain === 'note_quality')!.score, 50);
  assert.equal(sc.pdqi9.length, 2);
});

test('weights are sane', () => {
  const sum = Object.values(OPD_DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `weights should sum to 1, got ${sum}`);
});
