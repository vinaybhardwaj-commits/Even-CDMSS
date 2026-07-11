import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deterministicExtract, normalizeWithLlm, mergeLlmFindings, type ExtractInput,
} from '../clinical-state/extract';
import { buildDdxClinicalState, applyParsedInvestigations, floorRulesFor, priorFor } from '../clinical-state/from-primitives';
import { validateClinicalState, emptyClinicalState } from '../clinical-state/schema';
import type { ParsedInvestigations } from '../investigations';

const INPUT: ExtractInput = {
  surface: 'ddx',
  age: 62,
  sex: 'M',
  fields: {
    complaint: 'epigastric discomfort for 2 hours',
    history: 'diabetic, smoker. No fever. Denies vomiting. Pain is worsening.',
    exam: 'soft non-tender abdomen',
    vitals: 'BP 82/50, HR 134, SpO2 90%',
  },
};

// ── Stage 1 — deterministic ──

test('demographics: structured input wins; band derived', () => {
  const s = deterministicExtract(INPUT);
  assert.equal(s.demographics.age, 62);
  assert.equal(s.demographics.sex, 'M');
  assert.equal(s.demographics.ageBand, '60-69');
  assert.deepEqual(validateClinicalState(s), s);
});

test('"No fever" → absent; "fever not mentioned" → unknown (the two are DIFFERENT)', () => {
  const s = deterministicExtract(INPUT);
  const fever = s.negatives.find((f) => f.concept === 'fever');
  assert.ok(fever, 'explicit negation lands in negatives');
  assert.equal(fever!.status, 'absent');
  assert.equal(fever!.provenance.rawText, 'No fever');
  assert.ok(!s.unknowns.some((f) => f.concept === 'fever'), 'a negated concept is NOT unknown');

  // Same input minus the negation: fever silent → unknown + missingCriticalData.
  const silent = deterministicExtract({ ...INPUT, fields: { ...INPUT.fields, history: 'diabetic, smoker.' } });
  const unknownFever = silent.unknowns.find((f) => f.concept === 'fever');
  assert.ok(unknownFever, 'unmentioned checklist concept lands in unknowns');
  assert.equal(unknownFever!.status, 'unknown');
  assert.ok(silent.missingCriticalData.includes('fever'));
});

test('"Denies vomiting" is a negation too; complaint carries its duration', () => {
  const s = deterministicExtract(INPUT);
  assert.ok(s.negatives.some((f) => f.concept === 'vomiting'));
  const complaint = s.positives.find((f) => f.provenance.sourceField === 'complaint');
  assert.ok(complaint);
  assert.equal(complaint!.temporality?.duration, 'for 2 hours');
});

test('vitals: parsed reads + instability from adult thresholds', () => {
  const s = deterministicExtract(INPUT);
  const sbp = s.positives.find((f) => f.concept === 'systolic bp');
  assert.equal(sbp?.value, '82');
  assert.equal(s.instability.unstable, true);
  assert.ok(s.instability.reasons.some((r) => r.includes('SBP 82')));
  assert.ok(s.instability.reasons.some((r) => r.includes('HR 134')));
  assert.ok(s.instability.reasons.some((r) => r.includes('SpO2 90')));

  const calm = deterministicExtract({ ...INPUT, fields: { ...INPUT.fields, vitals: 'BP 118/76, HR 72, SpO2 99%' } });
  assert.equal(calm.instability.unstable, false);
});

// ── Three-state instability (UI-integrity fix): assessment + assessed/missing channels ──

test('instability three-state: no vitals → not_assessable, all 5 channels missing', () => {
  const s = deterministicExtract({ ...INPUT, fields: { ...INPUT.fields, vitals: '' } });
  assert.equal(s.instability.assessment, 'not_assessable');
  assert.equal(s.instability.unstable, false);
  assert.deepEqual(s.instability.assessedInputs, []);
  assert.deepEqual(s.instability.missingInputs, ['BP', 'HR', 'SpO₂', 'RR', 'T']);
});

test('instability three-state: full normal vitals → no_instability_detected, all 5 assessed', () => {
  const s = deterministicExtract({ ...INPUT, fields: { ...INPUT.fields, vitals: 'BP 120/80 HR 80 SpO2 98 RR 16 Temp 37' } });
  assert.equal(s.instability.assessment, 'no_instability_detected');
  assert.equal(s.instability.unstable, false);
  assert.deepEqual(s.instability.reasons, []);
  assert.deepEqual(s.instability.assessedInputs, ['BP', 'HR', 'SpO₂', 'RR', 'T']);
  assert.deepEqual(s.instability.missingInputs, []);
});

test('instability three-state: partial vitals (temperature only) → assessed [T], rest missing', () => {
  // "Temp 37" (not bare "T 37") is the token parseVitals actually reads — parser LOGIC unchanged;
  // the display label for the temperature channel is 'T' per spec.
  const s = deterministicExtract({ ...INPUT, fields: { ...INPUT.fields, vitals: 'Temp 37' } });
  assert.equal(s.instability.assessment, 'no_instability_detected');
  assert.deepEqual(s.instability.assessedInputs, ['T']);
  assert.deepEqual(s.instability.missingInputs, ['BP', 'HR', 'SpO₂', 'RR']);
});

test('instability three-state: breach → unstable, reasons byte-identical to unchanged logic', () => {
  const s = deterministicExtract({ ...INPUT, fields: { ...INPUT.fields, vitals: 'BP 82/50' } });
  assert.equal(s.instability.assessment, 'unstable');
  assert.equal(s.instability.unstable, true);
  assert.deepEqual(s.instability.reasons, ['SBP 82 < 90']);          // instabilityReasons unchanged
  assert.deepEqual(s.instability.assessedInputs, ['BP']);
  // the original full-INPUT breach still yields exactly today's reason set
  const full = deterministicExtract(INPUT);                          // vitals 'BP 82/50, HR 134, SpO2 90%'
  assert.deepEqual(full.instability.reasons, ['SBP 82 < 90', 'HR 134 outside 40-130', 'SpO2 90% < 92%']);
});

test('instability invariant: unstable === (assessment === "unstable"); emptyClinicalState passes updated zod', () => {
  for (const vitals of ['', 'Temp 37', 'BP 120/80 HR 80 SpO2 98 RR 16 Temp 37', 'BP 82/50', 'BP 82/50, HR 134, SpO2 90%']) {
    const s = deterministicExtract({ ...INPUT, fields: { ...INPUT.fields, vitals } });
    assert.equal(s.instability.unstable, s.instability.assessment === 'unstable', `vitals="${vitals}"`);
  }
  // emptyClinicalState default satisfies the updated .strict() validator (new required fields present)
  assert.doesNotThrow(() => validateClinicalState(emptyClinicalState('ddx')));
  const def = emptyClinicalState('ddx').instability;
  assert.equal(def.assessment, 'not_assessable');
  assert.deepEqual(def.missingInputs, ['BP', 'HR', 'SpO₂', 'RR', 'T']);
});

// ── Stage 2 — LLM normalisation with span verification (fake chat, no network) ──

test('normalizeWithLlm: verified spans accepted with offsets; unverifiable spans REJECTED', async () => {
  const fake = async () => JSON.stringify({
    findings: [
      { concept: 'diabetes', status: 'historical', field: 'history', rawText: 'diabetic' },
      { concept: 'jaundice', status: 'present', field: 'exam', rawText: 'icteric sclera' }, // NOT in the exam text
    ],
  });
  const { accepted, rejected } = await normalizeWithLlm(INPUT, fake);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].concept, 'diabetes');
  assert.equal(accepted[0].status, 'historical');
  assert.equal(accepted[0].provenance.extractionMethod, 'llm');
  assert.equal(accepted[0].provenance.startOffset, INPUT.fields.history!.indexOf('diabetic'));
  assert.deepEqual(rejected, [{ concept: 'jaundice', rawText: 'icteric sclera', field: 'exam' }]);
});

test('mergeLlmFindings: resolves checklist unknowns, dedupes, sorts absent into negatives', async () => {
  const silent = deterministicExtract({ ...INPUT, fields: { ...INPUT.fields, history: 'diabetic. no chills' } });
  assert.ok(silent.unknowns.some((f) => f.concept === 'fever'));
  const fake = async () => JSON.stringify({
    findings: [
      { concept: 'fever', status: 'absent', field: 'history', rawText: 'diabetic' }, // span exists; concept resolves the unknown
    ],
  });
  const llm = await normalizeWithLlm({ ...INPUT, fields: { ...INPUT.fields, history: 'diabetic. no chills' } }, fake);
  const merged = mergeLlmFindings(silent, llm);
  assert.ok(!merged.unknowns.some((f) => f.concept === 'fever'), 'LLM-resolved concept leaves unknowns');
  assert.ok(!merged.missingCriticalData.includes('fever'));
  assert.ok(merged.negatives.some((f) => f.concept === 'fever' && f.provenance.extractionMethod === 'llm'));
  assert.deepEqual(validateClinicalState(merged), merged);
});

// ── from-primitives wiring ──

const PARSED: ParsedInvestigations = {
  raw: 'K 6.8, Hb 13.9',
  findings: [
    { test: 'Potassium', value: '6.8', unit: 'mmol/L', flag: 'critical', category: 'lab', note: 'hyperkalemia' },
    { test: 'Hb', value: '13.9', unit: 'g/dL', flag: 'normal', category: 'lab', note: null },
  ],
  summary: 'hyperkalemia',
  abnormalTerms: ['hyperkalemia'],
  promptBlock: '(unused here)',
  structured: true,
};

test('applyParsedInvestigations: rows land verbatim; only abnormals become positive findings', () => {
  const s = applyParsedInvestigations(deterministicExtract(INPUT), PARSED);
  assert.equal(s.investigations.length, 2);
  const k = s.positives.find((f) => f.concept === 'hyperkalemia');
  assert.ok(k, 'abnormal investigation is a stated positive finding');
  assert.equal(k!.provenance.sourceField, 'investigations');
  assert.ok(!s.positives.some((f) => f.concept === 'Hb'), 'normal rows never become findings');
  assert.deepEqual(validateClinicalState(s), s);
});

test('buildDdxClinicalState composes stage 1 + investigations; floor + priors wire through', () => {
  const s = buildDdxClinicalState(
    { age: 62, sex: 'M', cc: INPUT.fields.complaint, history: INPUT.fields.history, exam: INPUT.fields.exam, vitals: INPUT.fields.vitals },
    PARSED,
  );
  assert.equal(s.surface, 'ddx');
  assert.equal(s.investigations.length, 2);
  const rules = floorRulesFor(s);
  assert.ok(rules.some((r) => r.analyte === 'potassium'), 'cannot-miss floor sees the potassium row');
  const prior = priorFor(s, 'potassium');
  assert.ok(prior && prior.stratum === 'M 60+', 'stratified prior resolves from demographics');
  assert.deepEqual(validateClinicalState(s), s);
});
