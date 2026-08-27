/**
 *   node --test --import tsx lib/__tests__/preop-suggest-core.test.ts
 *
 * B8b — the suggestion rail. The property under test throughout is a NEGATIVE one: nothing
 * the model produces reaches an instrument. The only thing that can is a named human, and
 * that path is tested too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  autoAcceptable, decisionObservations, definitionalFor, openSuggestions, parseExtractMode, reconcileReads,
  redundantSuggestions, scoreModeReachable, spanIsMedicationOnly, spanNamesADrug, stabilityByClass,
  PREOP_DECISIONS, PREOP_EXTRACT_MODES, PROMOTED_CLASSES, SUGGEST_EXCLUDED, SUGGEST_TARGET_IDS,
  type PreopDecision, type PreopSuggestionRecord,
} from '../preop-suggest-core.ts';
import { verifyExtraction, type ExtractProposal } from '../preop-extract-core.ts';
import { composeSnapshot, PAC_NONE, type Observation, type SnapshotInput } from '../preop-assemble-core.ts';

const src = (p: string) => readFileSync(p, 'utf8');

const FIELDS: Record<string, string> = {
  pac_other_history: 'K/C/O DM. TAB RABEPRAZOLE 20 MG. Not ambulating since 15 days.',
  pac_examination: 'Conscious and alert. Good effort tolerance.',
};
const p = (o: Partial<ExtractProposal>): ExtractProposal => ({
  input: 'functional_status_dependent', status: 'present', field: 'pac_other_history',
  rawText: 'Not ambulating since 15 days', confidence: 0.9, note: null, ...o,
});
const read = (props: ExtractProposal[]) => verifyExtraction(props, FIELDS);

// ── the mode ────────────────────────────────────────────────────────────────────

test('the mode has exactly three values and defaults to off', () => {
  assert.deepEqual([...PREOP_EXTRACT_MODES], ['off', 'suggest', 'score']);
  assert.equal(parseExtractMode(undefined), 'off');
});

test('score mode auto-accepts nothing, because B8d has ratified nothing', () => {
  assert.deepEqual([...PROMOTED_CLASSES], []);
  assert.equal(scoreModeReachable(), false);
  assert.equal(autoAcceptable('score', 'functional_status_dependent'), false);
  assert.equal(autoAcceptable('suggest', 'functional_status_dependent'), false);
  assert.equal(autoAcceptable('off', 'functional_status_dependent'), false);
});

// ── the banned inference, filtered BEFORE suggestion ────────────────────────────

test('a span naming a drug may not SUGGEST a diagnosis — the B7 defect refused in public', () => {
  const reads = [1, 2, 3].map(() => read([
    p({ input: 'peptic_ulcer_disease', rawText: 'TAB RABEPRAZOLE 20 MG' }),
  ]));
  const { suggestions, dropped } = reconcileReads(reads);
  assert.deepEqual(suggestions, [], 'unanimous three times and STILL not offered');
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].reason, 'medication_inference');
  // The detail names WHY the span read as a pharmacy line — here the dosage form, because
  // rabeprazole is not in the RX dictionary and must never need to be.
  assert.equal(dropped[0].detail, 'dosage form');
});

test('the filter recognises a pharmacy line by SHAPE — the dictionary alone let rabeprazole through', () => {
  // ⚠️ The first version of this gate asked the RX dictionary, and rabeprazole is
  // deliberately NOT in it (it maps to nothing), so the exact B7 defect walked past.
  assert.equal(spanNamesADrug('TAB RABEPRAZOLE 20 MG'), null, 'the dictionary does not know it, and should not');
  assert.ok(spanIsMedicationOnly('TAB RABEPRAZOLE 20 MG'), 'but the shape gives it away');
  for (const t of ['CAP OMEPRAZOLE 20', 'ECOSPRIN 75 OD', 'INJ CEFTRIAXONE 1 G', 'atorvastatin 20 mg HS',
                   'T. PANTOP 40 1-0-0']) {
    assert.ok(spanIsMedicationOnly(t), `${t} should read as a medication line`);
  }
  // …and it does not fire on clinical prose
  for (const t of ['not ambulating since 15 days', 'good effort tolerance', 'Conscious and alert']) {
    assert.equal(spanIsMedicationOnly(t), null, `${t} is not a medication line`);
  }
});

test('a span carrying a DISEASE name survives, even beside a drug — the disease is the evidence', () => {
  assert.equal(spanIsMedicationOnly('IHD, on TAB ECOSPRIN 75'), null);
  assert.equal(spanIsMedicationOnly('K/C/O COPD on seroflo inhaler'), null);
});

test('the three inputs B8a owns are not even asked about any more', () => {
  assert.deepEqual([...SUGGEST_EXCLUDED].sort(), ['diabetes_mellitus', 'diabetes_uncomplicated', 'hypertension_on_medication']);
  for (const id of SUGGEST_EXCLUDED) assert.ok(!SUGGEST_TARGET_IDS.has(id));
  // asking a model for a fact a table already has is how the rabeprazole reading happened
  const { dropped } = reconcileReads([read([p({ input: 'hypertension_on_medication', rawText: 'Conscious and alert', field: 'pac_examination' })])]);
  assert.equal(dropped[0].reason, 'not_a_target');
});

// ── three reads ─────────────────────────────────────────────────────────────────

test('unanimous across three reads is a HIGH-confidence suggestion — and still not a score', () => {
  const { suggestions } = reconcileReads([read([p({})]), read([p({})]), read([p({})])]);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].agreement, 'unanimous');
  assert.equal(suggestions[0].confidence, 'high');
  assert.deepEqual(suggestions[0].reads, ['present', 'present', 'present']);
});

test('two of three is a MAJORITY at low confidence — silence is a null vote, not an absence', () => {
  const { suggestions } = reconcileReads([read([p({})]), read([p({})]), read([])]);
  assert.equal(suggestions[0].agreement, 'majority');
  assert.equal(suggestions[0].confidence, 'low');
  assert.deepEqual(suggestions[0].reads, ['present', 'present', null]);
});

test('a genuine present/absent split is recorded as a split, at low confidence', () => {
  const { suggestions } = reconcileReads([
    read([p({})]),
    read([p({ status: 'absent', rawText: 'Good effort tolerance', field: 'pac_examination' })]),
  ]);
  assert.equal(suggestions[0].agreement, 'split');
  assert.equal(suggestions[0].confidence, 'low');
});

test('the model’s own confidence is carried for display and decides nothing', () => {
  const { suggestions } = reconcileReads([read([p({ confidence: 1 })]), read([p({ confidence: 0.6 })]), read([p({ confidence: 0.8 })])]);
  assert.equal(suggestions[0].modelConfidence, 0.8);
  assert.equal(suggestions[0].confidence, 'high', 'three-read agreement decides, not the self-report');
});

test('per-class stability is measurable, which is what B8d promotes on', () => {
  const rec = (agreement: 'unanimous' | 'majority'): PreopSuggestionRecord => ({
    version: 'preop-suggest/1', sourceFingerprint: 'f', generatedAt: 'n', model: 'm', provider: 'p',
    traceIds: [], readCount: 3, dropped: [], fieldsSeen: [],
    suggestions: [{
      inputId: 'functional_status_dependent', status: 'present', reads: [], agreement,
      confidence: agreement === 'unanimous' ? 'high' : 'low', span: 's', field: 'f',
      fieldLabel: 'F', label: 'L', modelConfidence: 0.9, polaritySuspect: false,
    }],
  });
  const t = stabilityByClass([rec('unanimous'), rec('unanimous'), rec('majority')]);
  assert.equal(t.functional_status_dependent.total, 3);
  assert.equal(t.functional_status_dependent.stability, 0.667);
});

// ── the only path to a score ────────────────────────────────────────────────────

const decision = (o: Partial<PreopDecision> = {}): PreopDecision => ({
  episodeKey: 'SC-1', inputId: 'functional_status_dependent', status: 'present',
  span: 'Not ambulating since 15 days', field: 'pac_other_history',
  decision: 'confirm', decidedBy: 'care-manager', decidedAt: '2026-08-27T05:00:00Z',
  sourceFingerprint: 'fp1', ...o,
});

test('a CONFIRM becomes an observation with HUMAN provenance, carrying who and when', () => {
  const obs = decisionObservations([decision()], 'fp1');
  assert.equal(obs.length, 1);
  assert.equal(obs[0].source, 'HUMAN');
  assert.equal(obs[0].status, 'present');
  assert.match(obs[0].detail!, /confirmed by care-manager/);
  assert.equal(obs[0].sourceSpan, 'Not ambulating since 15 days');
});

test('a DISMISS produces no observation, and hides the suggestion for that text', () => {
  assert.deepEqual(decisionObservations([decision({ decision: 'dismiss' })], 'fp1'), []);
  const rec = { sourceFingerprint: 'fp1', suggestions: [{ inputId: 'functional_status_dependent', status: 'present' }] } as unknown as PreopSuggestionRecord;
  assert.deepEqual(openSuggestions(rec, [decision({ decision: 'dismiss' })]), []);
  assert.equal(openSuggestions(rec, []).length, 1);
});

test('a confirmation RETIRES when the note is edited — it was a reading of text that is gone', () => {
  assert.deepEqual(decisionObservations([decision()], 'fp2'), []);
  assert.deepEqual(decisionObservations([decision()], null), []);
});

test('a B5-era record with no suggestions degrades to "nothing to offer", never a throw', () => {
  const stale = { sourceFingerprint: 'fp1', version: 'preop-extract/1' } as unknown as PreopSuggestionRecord;
  assert.deepEqual(openSuggestions(stale, []), []);
});

test('a HUMAN confirmation outranks the record — and the audit trail is what makes that safe', () => {
  const base = (obs: Observation[]): SnapshotInput => ({
    engineVersion: 'preop-risk/0.1',
    episode: { episodeKey: 'SC-1', individualUid: 'I', uhid: 'U', patientName: 'X', age: 70, sex: 'MALE', procedure: 'TKR', hospital: 'H', surgeryDate: '2026-09-30', surgeon: null, department: null },
    observations: obs, pac: PAC_NONE, daysToSurgery: 30, reviewed: false,
    includeExtracted: false, bookingEnumerated: true, bookingOnly: false, computedAt: 'now',
  });
  // The booking form closed functional status? No — it is NEVER_ENUMERATED, so it is
  // unknown until something observes it. A confirmation observes it.
  const off = composeSnapshot(base([]));
  assert.equal(off.inputs.find((i) => i.inputId === 'functional_status_dependent')!.status, 'unknown');
  const on = composeSnapshot(base(decisionObservations([decision()], 'fp1')));
  const f = on.inputs.find((i) => i.inputId === 'functional_status_dependent')!;
  assert.equal(f.status, 'present');
  assert.equal(f.source, 'HUMAN');
  assert.equal(on.mfi5.lo, (off.mfi5.lo ?? 0) + 1);
  // …and it is NOT gated by the extraction mode: `includeExtracted` was false on BOTH
  // snapshots above, and the confirmation scored anyway. A person's decision is not an
  // extraction, and the sweep passes HUMAN observations through whatever the mode says.
  const r = src('lib/preop/run.ts');
  assert.match(r, /const extractObs = \[\.\.\.humanObs, \.\.\.suggestObs\];/);
  assert.ok(r.indexOf('const humanObs = decisionObservations(') < r.indexOf('const extractObs ='));
});

test('the decision verbs are closed at two', () => {
  assert.deepEqual([...PREOP_DECISIONS], ['confirm', 'dismiss']);
});

// ── structural pins ─────────────────────────────────────────────────────────────

test('the panel is pink OUTLINE, never a filled pink chip', () => {
  const c = src('components/care/PreopCasePage.tsx');
  const panel = c.slice(c.indexOf('function SuggestionPanel'), c.indexOf('function sourceClass'));
  assert.match(panel, /border-pink-300 bg-transparent/, 'unconfirmed is an outline');
  assert.ok(!/bg-pink-\d+/.test(panel), 'a filled pink chip on this page means an input that is actually scoring');
  assert.match(panel, /Nothing in this panel has scored anything/);
});

test('the panel never recomputes — it posts a decision and reloads what the server says', () => {
  const c = src('components/care/PreopCasePage.tsx');
  const panel = c.slice(c.indexOf('function SuggestionPanel'), c.indexOf('function sourceClass'));
  assert.match(panel, /\/api\/care\/preop\/suggestion/);
  for (const forbidden of ['computeRcri', 'computeMfi5', 'computeCharlson', 'composeSnapshot']) {
    assert.ok(!panel.includes(forbidden), `the panel must never ${forbidden}`);
  }
});

// ── the flood, found on the live board ──────────────────────────────────────────

test('a suggestion that AGREES with the record is counted, never put in front of a clinician', () => {
  // ⚠️ Measured on a Preview probe, 27 Aug: one misspelt span — "no comorbities" — produced
  // NINETEEN unanimous ABSENT suggestions on a single episode, every one already settled the
  // same way by the booking form's closed world. Confirming them moves nothing; dismissing
  // them is nineteen clicks. A panel that asks a clinician to adjudicate what the record has
  // already answered will not be used.
  const s = (inputId: string, status: 'present' | 'absent') => ({
    inputId, status, reads: [status, status, status], agreement: 'unanimous' as const,
    confidence: 'high' as const, span: 'no comorbities', field: 'pac_other_history',
    fieldLabel: 'PAC · other medical history', label: inputId, modelConfidence: 1, polaritySuspect: false,
  });
  const rec = {
    version: 'preop-suggest/1', sourceFingerprint: 'fp1', generatedAt: 'n', model: 'm',
    provider: 'p', traceIds: [], readCount: 3, dropped: [], fieldsSeen: [],
    suggestions: [s('dementia', 'absent'), s('aids', 'absent'), s('functional_status_dependent', 'present')],
  } as unknown as PreopSuggestionRecord;

  const resolved = { dementia: 'absent', aids: 'absent', functional_status_dependent: 'unknown' };
  const offered = openSuggestions(rec, [], resolved);
  assert.deepEqual(offered.map((o) => o.inputId), ['functional_status_dependent'],
    'only the reading that would CHANGE something is offered');
  assert.equal(redundantSuggestions(rec, resolved), 2);

  // with no resolved map at all, nothing is filtered — the caller decides, not the core
  assert.equal(openSuggestions(rec, []).length, 3);
});

test('a suggestion that CONTRADICTS the record is always offered — that is the interesting case', () => {
  const contradicts = {
    version: 'preop-suggest/1', sourceFingerprint: 'fp1', generatedAt: 'n', model: 'm', provider: 'p',
    traceIds: [], readCount: 3, dropped: [], fieldsSeen: [],
    suggestions: [{
      inputId: 'copd_or_pneumonia', status: 'present', reads: ['present', 'present', 'present'],
      agreement: 'unanimous', confidence: 'high', span: 'known COPD on inhalers',
      field: 'pac_other_history', fieldLabel: 'F', label: 'COPD', modelConfidence: 0.9, polaritySuspect: false,
    }],
  } as unknown as PreopSuggestionRecord;
  assert.equal(openSuggestions(contradicts, [], { copd_or_pneumonia: 'absent' }).length, 1);
  assert.equal(redundantSuggestions(contradicts, { copd_or_pneumonia: 'absent' }), 0);
});

test('an ORAL agent may not suggest insulin status — in either direction', () => {
  // ⚠️ Measured on the 48-episode golden set: three suggestions of insulin_treated_diabetes
  // ABSENT survived the first cut of this gate, on spans naming metformin and glimepiride.
  // The definitional carve-out has to be per-CLASS, not per-input: an oral agent is
  // definitional for diabetes and definitional for nothing about insulin.
  for (const span of ['TAB GLYCOMET GP1', 'DIABETES SINCE 15 YEARS ,TAB METFORMIN 500MG 1-0-1', 'TAB GLIMIPRIDE + METFORMIN']) {
    const { suggestions, dropped } = reconcileReads([1, 2, 3].map(() => verifyExtraction([{
      input: 'insulin_treated_diabetes', status: 'absent', field: 'pac_other_history',
      rawText: span, confidence: 1, note: null,
    }], { pac_other_history: span })));
    assert.deepEqual(suggestions, [], `${span} must suggest nothing about insulin`);
    assert.equal(dropped[0]?.reason, 'medication_inference');
  }
  // …while an INSULIN span still may, because there the drug IS the factor.
  const ins = 'INJ MIXTARD 30/70 12-0-8';
  const { suggestions } = reconcileReads([1, 2, 3].map(() => verifyExtraction([{
    input: 'insulin_treated_diabetes', status: 'present', field: 'pac_other_history',
    rawText: ins, confidence: 1, note: null,
  }], { pac_other_history: ins })));
  assert.equal(suggestions.length, 1);
  assert.equal(definitionalFor(ins, 'insulin_treated_diabetes'), true);
  assert.equal(definitionalFor('TAB METFORMIN 500', 'insulin_treated_diabetes'), false);
  assert.equal(definitionalFor('TAB METFORMIN 500', 'diabetes_mellitus'), true);
});
