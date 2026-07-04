import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  branchForVerdict, floorFor, buildConcordancePrompt, parseConcordance,
  scoreCase, summarize, type CaseExpectation,
  initInterview, normalizeBelief, topBelief, isUnknownAnswer, shouldStop,
  recordTurn, toVerdictContext, parseSeed, parseNextQuestion, DEFAULT_INTERVIEW_OPTS,
  type NextQuestion, type InterviewState,
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

// ── P1 interview core ──

test('normalizeBelief sums to 1 and topBelief picks the leader', () => {
  const b = normalizeBelief([
    { cause: 'hemolysis', branch: 'A', weight: 1 },
    { cause: 'true hyperkalemia', branch: 'B', weight: 3 },
  ]);
  const sum = b.reduce((s, i) => s + i.weight, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  assert.equal(topBelief(b)!.cause, 'true hyperkalemia');
});

test('isUnknownAnswer recognises "I don\'t have this" variants', () => {
  for (const a of ['I don\'t have this', 'Unknown', 'not measured', 'N/A', 'no data']) assert.equal(isUnknownAnswer(a), true);
  for (const a of ['Albumin normal', '6.8']) assert.equal(isUnknownAnswer(a), false);
});

test('shouldStop fires on cap and on belief threshold', () => {
  const base = initInterview('K 6.8', 'asx');
  assert.equal(shouldStop({ ...base, askedCount: 6 }, DEFAULT_INTERVIEW_OPTS), true);
  assert.equal(shouldStop({ ...base, belief: [{ cause: 'x', branch: 'B', weight: 0.8 }] }, DEFAULT_INTERVIEW_OPTS), true);
  assert.equal(shouldStop({ ...base, askedCount: 2, belief: [{ cause: 'x', branch: 'B', weight: 0.4 }] }, DEFAULT_INTERVIEW_OPTS), false);
});

test('recordTurn logs an open gap on "I don\'t have this" and increments count', () => {
  const nq: NextQuestion = { stop: false, question: 'Albumin?', whoKnows: 'you', why: 'w', options: ['high', 'normal'] };
  const s0 = { ...initInterview('Ca 11.8', 'asx'), status: 'asking' as const };
  const s1 = recordTurn(s0, nq, 'Albumin normal');
  assert.equal(s1.askedCount, 1);
  assert.equal(s1.openGaps.length, 0);
  const s2 = recordTurn(s1, { ...nq, question: 'PTH?' }, 'I don\'t have this');
  assert.equal(s2.askedCount, 2);
  assert.equal(s2.openGaps.length, 1);
  assert.equal(s2.openGaps[0].gap, 'PTH?');
});

test('toVerdictContext folds transcript + open gaps into the context', () => {
  let s: InterviewState = { ...initInterview('Ca 11.8', '56F asymptomatic'), status: 'asking' };
  s = recordTurn(s, { stop: false, question: 'Albumin raised?', whoKnows: 'you', why: 'w', options: [] }, 'normal');
  s = recordTurn(s, { stop: false, question: 'PTH?', whoKnows: 'you', why: 'w', options: [] }, 'Unknown');
  const ctx = toVerdictContext(s);
  assert.match(ctx, /56F asymptomatic/);
  assert.match(ctx, /Albumin raised\? -> normal/);
  assert.match(ctx, /Still unknown/);
  assert.match(ctx, /PTH\?/);
});

test('parseSeed reads branch|weight|cause lines and normalises', () => {
  const b = parseSeed('A|0.5|hemolysis from difficult draw\nB|1.5|true hyperkalemia\ngarbage line');
  assert.equal(b.length, 2);
  assert.ok(Math.abs(b.reduce((s, i) => s + i.weight, 0) - 1) < 1e-9);
  assert.equal(topBelief(b)!.branch, 'B');
});

test('parseSeed tolerates a stray leading label (BRANCH|B|0.4|cause)', () => {
  const b = parseSeed('BRANCH|B|0.4|primary hyperparathyroidism\nBRANCH|A|0.15|EDTA contamination');
  assert.equal(b.length, 2);
  assert.equal(topBelief(b)!.cause, 'primary hyperparathyroidism');
});

test('parseNextQuestion parses a question and detects STOP', () => {
  const q = parseNextQuestion('QUESTION: Is the albumin raised?\nWHOKNOWS: you\nWHY: separates hemoconcentration\nOPTIONS: high | normal | unknown');
  assert.equal(q.stop, false);
  assert.equal(q.whoKnows, 'you');
  assert.match(q.question, /albumin/);
  assert.equal(q.options.length, 3);
  assert.equal(parseNextQuestion('QUESTION: STOP').stop, true);
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
