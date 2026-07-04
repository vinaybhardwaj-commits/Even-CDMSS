import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  branchForVerdict, floorFor, buildConcordancePrompt, parseConcordance,
  scoreCase, summarize, type CaseExpectation,
} from '../concordance-core.ts';

test('branchForVerdict maps verdicts to branches', () => {
  assert.equal(branchForVerdict('discordant-likely-error'), 'A');
  assert.equal(branchForVerdict('discordant-likely-real'), 'B');
  assert.equal(branchForVerdict('concordant'), 'none');
  assert.equal(branchForVerdict('indeterminate'), 'none');
});

test('floorFor detects in-scope analytes and dedups', () => {
  const k = floorFor('Potassium 6.8 mmol/L (ref 3.5-5.1)');
  assert.ok(k.some((r) => r.analyte === 'potassium'));
  const ca = floorFor('Calcium 11.8 mg/dL');
  assert.ok(ca.some((r) => r.analyte === 'calcium'));
  const none = floorFor('Vitamin B12 300 pg/mL');
  assert.equal(none.length, 0);
});

test('prompt injects the cannot-miss floor for the analyte', () => {
  const { system, user } = buildConcordancePrompt('Potassium 6.8 mmol/L', '58F asymptomatic');
  assert.match(system, /BRANCH A/);
  assert.match(user, /CANNOT-MISS FLOOR/);
  assert.match(user, /hyperkalemia/i);
});

test('parser extracts a single committed verdict', () => {
  const raw = [
    'VERDICT: discordant-likely-error',
    'CONFIDENCE: moderate — capped by unknown hemolysis index',
    'BRANCH A (error): pseudohyperkalemia from tourniquet',
    'BRANCH B (real): true hyperkalemia — cannot-miss cardiac risk',
    'DECISIVE GAP: hemolysis index on the drawn sample',
    'VoI LEDGER: hemolysis index · lab · run on existing sample · high · yes',
    'NEXT STEP: hemolysis index, then plasma repeat',
    'GROUNDING: clinical-reasoning',
  ].join('\n');
  const p = parseConcordance(raw);
  assert.equal(p.verdict, 'discordant-likely-error');
  assert.equal(p.multipleVerdicts, false);
  assert.equal(p.branch, 'A');
  assert.equal(p.confidence, 'moderate');
  assert.equal(p.confidenceCapped, true);
  assert.match(p.decisiveGap, /hemolysis index/);
});

test('parser flags multiple verdicts (the A1 mini failure mode)', () => {
  const raw = 'VERDICT: discordant-likely-real | indeterminate\nCONFIDENCE: moderate';
  const p = parseConcordance(raw);
  assert.equal(p.multipleVerdicts, true);
});

test('scoreCase: correct branch-A verdict + gap hit + cannot-miss covered', () => {
  const exp: CaseExpectation = {
    id: 'A1', category: 'branchA', expectedVerdict: 'discordant-likely-error', expectedBranch: 'A',
    decisiveGapKeywords: ['hemolysis'], cannotMissKeywords: ['hyperkalemia'],
  };
  const p = parseConcordance([
    'VERDICT: discordant-likely-error',
    'BRANCH B (real): true hyperkalemia risk',
    'DECISIVE GAP: hemolysis index',
  ].join('\n'));
  const s = scoreCase(exp, p);
  assert.equal(s.verdictMatch, true);
  assert.equal(s.branchMatch, true);
  assert.equal(s.decisiveGapHit, true);
  assert.equal(s.cannotMissCovered, true);
  assert.equal(s.overFlagged, false);
});

test('scoreCase: control marked discordant is over-flagged', () => {
  const exp: CaseExpectation = {
    id: 'C1', category: 'control', expectedVerdict: 'concordant', expectedBranch: 'none',
    decisiveGapKeywords: ['fasting'],
  };
  const p = parseConcordance('VERDICT: discordant-likely-real\nDECISIVE GAP: none');
  const s = scoreCase(exp, p);
  assert.equal(s.overFlagged, true);
  assert.equal(s.verdictMatch, false);
});

test('summarize aggregates the bank', () => {
  const scores = [
    scoreCase({ id: 'A1', category: 'branchA', expectedVerdict: 'discordant-likely-error', expectedBranch: 'A', decisiveGapKeywords: ['x'] },
      parseConcordance('VERDICT: discordant-likely-error')),
    scoreCase({ id: 'C1', category: 'control', expectedVerdict: 'concordant', expectedBranch: 'none', decisiveGapKeywords: ['x'] },
      parseConcordance('VERDICT: concordant')),
  ];
  const sum = summarize(scores);
  assert.equal(sum.n, 2);
  assert.equal(sum.verdictAccuracy, 1);
  assert.equal(sum.controlOverFlagRate, 0);
});
