/**
 *   node --test --import tsx lib/__tests__/preop-d4-boundary.test.ts
 *
 * B5 + B6 — THE D4 PROOF, as a property rather than as a promise.
 *
 * PRD §7's invariant is: "a model may propose an INPUT (with provenance and confidence) or
 * write PROSE ABOUT a computed result. It may never contribute a point of score." Three
 * things have to be true for that to hold, and each gets a test here:
 *
 *   1 · with the flag off, a snapshot is byte-identical whether or not extracted
 *       observations were ever handed to it;
 *   2 · with the flag ON, an input a deterministic source ANSWERED does not move — not a
 *       lab, not a mapped PAC field, not an ICD code, not a booking form's positive
 *       assertion;
 *   3 · the only things the flag can change are an input the record left UNKNOWN and a
 *       WEAK FORM-NEGATIVE (Amendment A1-6: an absence inferred from an enumeration's
 *       silence, which the binding mockup's own Shobha card requires to be movable) — and
 *       every score change that follows traces to exactly one input status change.
 *
 * The narrative half is simpler and is tested the same way: the model is shown the
 * COMPUTED SNAPSHOT and nothing else, and a paragraph is rendered only when code has
 * checked every sentence against that snapshot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  composeSnapshot, resolveInputs, snapshotFingerprint,
  PAC_NONE, type Observation, type SnapshotInput,
} from '../preop-assemble-core.ts';
import { buildExtraction, extractionObservations, verifyExtraction } from '../preop-extract-core.ts';
import {
  buildNarrativeFacts, buildNarrativePrompt, buildPreopNarrative, narrativeRenderable,
} from '../preop-narrative-core.ts';

const src = (p: string) => readFileSync(p, 'utf8');

const EPISODE = {
  episodeKey: 'SC-D4', individualUid: 'IND-1', uhid: 'UH-1', patientName: 'Test Patient',
  age: 68, sex: 'MALE', procedure: 'Total knee replacement', hospital: 'Even Hospital',
  surgeryDate: '2026-09-10', surgeon: null, department: null,
};

/** The deterministic evidence: a booking form that enumerated diabetes, and an ICD-coded
 *  heart failure off an OPD consult. Exactly the shape production produces. */
const DETERMINISTIC: Observation[] = [
  { inputId: 'diabetes_mellitus', status: 'present', source: 'BOOKING', detail: 'booking: diabetes' },
  { inputId: 'diabetes_uncomplicated', status: 'present', source: 'BOOKING', detail: 'booking: diabetes' },
  { inputId: 'congestive_heart_failure', status: 'present', source: 'OPD', detail: 'heart failure (ICD I50.9)' },
  { inputId: 'high_risk_surgery', status: 'absent', source: 'BOOKING', detail: 'TKR — not intraperitoneal' },
];

const base = (over: Partial<SnapshotInput> = {}): SnapshotInput => ({
  engineVersion: 'preop-risk/0.1',
  episode: EPISODE,
  observations: DETERMINISTIC,
  pac: PAC_NONE,
  daysToSurgery: 14,
  reviewed: false,
  includeExtracted: false,
  bookingEnumerated: true,
  notClosedBy: ['insulin_treated_diabetes'],
  bookingOnly: false,
  computedAt: '2026-08-27T04:00:00Z',
  ...over,
});

/** One model reading of the PAC prose: it fills the insulin question the booking form
 *  cannot answer, AND contradicts two things the record already settled. */
const FIELDS = {
  pac_other_history: 'DM on insulin since 12 years. No cardiac history at all. Denies COPD.',
};
const EXTRACTION = buildExtraction({
  fields: FIELDS,
  verified: verifyExtraction([
    { input: 'insulin_treated_diabetes', status: 'present', field: 'pac_other_history', rawText: 'DM on insulin since 12 years', confidence: 0.95, note: null },
    { input: 'congestive_heart_failure', status: 'absent', field: 'pac_other_history', rawText: 'No cardiac history at all', confidence: 0.9, note: null },
    { input: 'copd_or_pneumonia', status: 'absent', field: 'pac_other_history', rawText: 'Denies COPD', confidence: 0.9, note: null },
  ], FIELDS),
  extractedAt: '2026-08-27T04:00:00Z', model: 'gemini-2.5-pro', provider: 'vertex', traceId: 't1',
});
const EXTRACTED = extractionObservations(EXTRACTION);

// ── 1 · flag off ────────────────────────────────────────────────────────────────

test('FLAG OFF: extracted observations cannot reach the snapshot, byte for byte', () => {
  const without = composeSnapshot(base());
  const with_ = composeSnapshot(base({ observations: [...DETERMINISTIC, ...EXTRACTED] }));
  assert.equal(with_.fingerprint, without.fingerprint);
  assert.deepEqual(JSON.parse(JSON.stringify(with_)), JSON.parse(JSON.stringify(without)),
    'the whole snapshot, not merely the score');
});

test('FLAG OFF: an unresolvable input stays unknown and the instrument stays a range', () => {
  const s = composeSnapshot(base({ observations: [...DETERMINISTIC, ...EXTRACTED] }));
  assert.equal(s.rcri.kind, 'range');
  assert.ok(s.rcri.missing.includes('insulin_treated_diabetes'));
});

// ── 2 · flag on, and the record still wins ──────────────────────────────────────

test('FLAG ON: a model cannot overturn an ICD-coded fact', () => {
  const s = composeSnapshot(base({ includeExtracted: true, observations: [...DETERMINISTIC, ...EXTRACTED] }));
  const chf = s.inputs.find((i) => i.inputId === 'congestive_heart_failure')!;
  assert.equal(chf.status, 'present');
  assert.equal(chf.source, 'OPD');
  assert.equal(chf.conflict, true, 'and the disagreement is SHOWN, not swallowed');
  assert.equal(chf.extractionOverruled.length, 1);
});

test('FLAG ON: a model cannot overturn a POSITIVE booking assertion', () => {
  // The form was asked and it answered: diabetes is present by observation, not by
  // silence. No extraction may touch it.
  const rogue: Observation = { inputId: 'diabetes_mellitus', status: 'absent', source: 'EXTRACTED', confidence: 0.99, sourceSpan: 'not diabetic' };
  const s = composeSnapshot(base({ includeExtracted: true, observations: [...DETERMINISTIC, ...EXTRACTED, rogue] }));
  const dm = s.inputs.find((i) => i.inputId === 'diabetes_mellitus')!;
  assert.equal(dm.status, 'present');
  assert.equal(dm.source, 'BOOKING');
  assert.equal(dm.overturnedFormNegative, false);
  assert.equal(dm.extractionOverruled.length, 1, 'the proposal is recorded, and it moved nothing');
});

test('FLAG ON: the WEAK form-negative is the one absence a cited extraction may overturn (A1-6)', () => {
  // copd_or_pneumonia is absent only because a booking form that enumerates comorbidities
  // did not list it — an absence inferred from silence, which A1-6 calls weak and which
  // the binding mockup's own Shobha card depends on being movable.
  const asserts: Observation = {
    inputId: 'copd_or_pneumonia', status: 'present', source: 'EXTRACTED', confidence: 0.9,
    detail: 'COPD or current pneumonia — read from PAC · other medical history',
    sourceSpan: 'known COPD on inhalers',
  };
  const off = composeSnapshot(base({ observations: [...DETERMINISTIC, asserts] }));
  assert.equal(off.inputs.find((i) => i.inputId === 'copd_or_pneumonia')!.status, 'absent');

  const on = composeSnapshot(base({ includeExtracted: true, observations: [...DETERMINISTIC, asserts] }));
  const copd = on.inputs.find((i) => i.inputId === 'copd_or_pneumonia')!;
  assert.equal(copd.status, 'present');
  assert.equal(copd.source, 'EXTRACTED');
  assert.equal(copd.overturnedFormNegative, true);
  assert.equal(copd.conflict, true, 'the form disagrees, and the card must say so rather than printing the model reading alone');
});

test('an extraction that AGREES with the form’s silence corroborates — it does not take the input over', () => {
  // Measured on the golden set: one anaesthetist's "NO KNOWN COMORBIDITIES" produced
  // twelve absent readings on a single case. Every one of them agreed with the booking
  // form, moved no score — and, before this rule, replaced BOOKING with EXTRACTED as the
  // input's source. Source is inside the snapshot fingerprint, so flipping the flag would
  // have minted a version row saying nothing happened.
  const agrees: Observation = {
    inputId: 'copd_or_pneumonia', status: 'absent', source: 'EXTRACTED', confidence: 0.9,
    sourceSpan: 'NO KNOWN COMORBIDITIES',
  };
  const off = composeSnapshot(base({ observations: [...DETERMINISTIC, agrees] }));
  const on = composeSnapshot(base({ includeExtracted: true, observations: [...DETERMINISTIC, agrees] }));

  const copd = on.inputs.find((i) => i.inputId === 'copd_or_pneumonia')!;
  assert.equal(copd.status, 'absent');
  assert.equal(copd.source, 'BOOKING', 'the deterministic provenance is kept');
  assert.equal(copd.closedWorld, true);
  assert.equal(copd.corroborating.length, 1, 'the model reading is shown as corroboration');
  assert.equal(copd.conflict, false);
  assert.equal(on.fingerprint, off.fingerprint, 'and no version is minted by agreement');
});

test('a BELOW-FLOOR extraction cannot overturn even a weak form-negative', () => {
  const weak: Observation = { inputId: 'copd_or_pneumonia', status: 'present', source: 'EXTRACTED', confidence: 0.5, sourceSpan: 'maybe some wheeze' };
  const s = composeSnapshot(base({ includeExtracted: true, observations: [...DETERMINISTIC, weak] }));
  const copd = s.inputs.find((i) => i.inputId === 'copd_or_pneumonia')!;
  assert.equal(copd.status, 'absent');
  assert.equal(copd.closedWorld, true);
  assert.equal(copd.droppedBelowFloor.length, 1);
});

test('FLAG ON: a model cannot overturn a measured lab', () => {
  const lab: Observation = { inputId: 'creatinine_over_2', status: 'absent', source: 'LAB', value: 0.9, detail: '0.9 mg/dL' };
  const rogue: Observation = { inputId: 'creatinine_over_2', status: 'present', source: 'EXTRACTED', confidence: 0.99, sourceSpan: 'renal failure' };
  const r = resolveInputs([lab, rogue], { includeExtracted: true, bookingEnumerated: false });
  assert.equal(r.creatinine_over_2.status, 'absent');
  assert.equal(r.creatinine_over_2.source, 'LAB');
});

// ── 3 · what the flag CAN change ────────────────────────────────────────────────

test('FLAG ON: the one thing that moves is the input the record left UNKNOWN', () => {
  const off = composeSnapshot(base({ observations: [...DETERMINISTIC, ...EXTRACTED] }));
  const on = composeSnapshot(base({ includeExtracted: true, observations: [...DETERMINISTIC, ...EXTRACTED] }));

  const moved = on.inputs.filter((a, n) => a.status !== off.inputs[n].status).map((a) => a.inputId);
  assert.deepEqual(moved, ['insulin_treated_diabetes'], 'exactly one input status change');

  const ins = on.inputs.find((i) => i.inputId === 'insulin_treated_diabetes')!;
  assert.equal(ins.source, 'EXTRACTED');
  assert.equal(ins.confidence, 0.95);
  assert.equal(ins.sourceSpan, 'DM on insulin since 12 years', 'the span the card shows');

  // And the score change that follows traces to exactly that one input: the CONFIRMED
  // bound rises by the one point that input is worth, and the upper bound does not move —
  // an extraction confirms something the range already allowed for. RCRI stays a range
  // because creatinine is never closed by an enumeration and nobody measured it.
  assert.equal(off.rcri.kind, 'range');
  assert.equal(on.rcri.kind, 'range');
  assert.equal(on.rcri.lo, (off.rcri.lo ?? 0) + 1);
  assert.equal(on.rcri.hi, off.rcri.hi);
  assert.deepEqual(off.rcri.missing, ['insulin_treated_diabetes', 'creatinine_over_2']);
  assert.deepEqual(on.rcri.missing, ['creatinine_over_2']);
});

test('the arithmetic itself never sees a source: same statuses, same score, whatever fed them', () => {
  const viaModel = composeSnapshot(base({ includeExtracted: true, observations: [...DETERMINISTIC, ...EXTRACTED] }));
  const viaRecord = composeSnapshot(base({
    observations: [...DETERMINISTIC,
      { inputId: 'insulin_treated_diabetes', status: 'present', source: 'PAC', detail: 'PAC: IDDM' }],
  }));
  assert.equal(viaModel.rcri.lo, viaRecord.rcri.lo);
  assert.equal(viaModel.rcri.hi, viaRecord.rcri.hi);
  assert.equal(viaModel.tier.tier, viaRecord.tier.tier);
  assert.notEqual(viaModel.fingerprint, viaRecord.fingerprint, 'but the PROVENANCE differs, and the rail records that');
});

test('the snapshot fingerprint ignores the verbatim span, so a re-worded quotation mints nothing', () => {
  const a = composeSnapshot(base({ includeExtracted: true, observations: [...DETERMINISTIC, ...EXTRACTED] }));
  const reworded = EXTRACTED.map((o) => (o.inputId === 'insulin_treated_diabetes' ? { ...o, sourceSpan: 'on insulin since 12 years' } : o));
  const b = composeSnapshot(base({ includeExtracted: true, observations: [...DETERMINISTIC, ...reworded] }));
  assert.equal(a.fingerprint, b.fingerprint);
});

test('the fingerprint material is a CLOSED list — a new snapshot field cannot leak into it', () => {
  const s = composeSnapshot(base());
  const { fingerprint, ...rest } = s;
  const tampered = { ...rest, narrative: { text: 'anything at all' }, extraction: { inputs: [] } } as unknown as Parameters<typeof snapshotFingerprint>[0];
  assert.equal(snapshotFingerprint(tampered), fingerprint);
});

// ── the narrative half ──────────────────────────────────────────────────────────

test('the narrative model is shown the COMPUTED SNAPSHOT and nothing else', () => {
  const snap = composeSnapshot(base({
    pac: { ...PAC_NONE, onFile: true, status: 'final', verdict: 'Mr Test Patient is fit for surgery under GA. — Dr A' },
  }));
  const { user, system } = buildNarrativePrompt(buildNarrativeFacts(snap));
  const seen = `${system}\n${user}`;
  assert.ok(!seen.includes('Test Patient'), 'no patient name reaches the model');
  assert.ok(!seen.includes('UH-1'), 'no UHID reaches the model');
  assert.ok(!seen.includes('fit for surgery'), 'the anaesthetist’s verdict is quoted by the page, never shown to a model');
  assert.ok(!seen.includes('DM on insulin'), 'no source prose reaches the model');
  assert.ok(seen.includes('RCRI'), 'what it does see is the computed result');
  assert.ok(seen.includes('conclusion'), 'and the FACT that a conclusion exists');
});

test('CODE decides: a sentence with no citation invalidates the whole narrative', () => {
  const facts = buildNarrativeFacts(composeSnapshot(base()));
  const n = buildPreopNarrative({
    text: 'RCRI is a range because insulin status is unknown [F4]. This patient should be optimised before surgery.',
    facts, snapshotFingerprint: 'fp1', generatedAt: 'now', model: 'm', provider: 'p', traceId: 't',
  });
  assert.equal(n.valid, false);
  assert.equal(n.invalidReason, 'uncited_sentence');
  assert.equal(n.uncitedSentences.length, 1);
  assert.ok(n.text.length > 0, 'stored for review even though it is never rendered');
});

test('CODE decides: a citation naming a fact that does not exist invalidates it', () => {
  const facts = buildNarrativeFacts(composeSnapshot(base()));
  const n = buildPreopNarrative({
    text: 'The tier is AMBER [F999].', facts,
    snapshotFingerprint: 'fp1', generatedAt: 'now', model: 'm', provider: 'p', traceId: 't',
  });
  assert.equal(n.invalidReason, 'unresolved_ids');
  assert.deepEqual(n.invalidIds, ['F999']);
});

test('a valid narrative is still not rendered against a reading it was not written for', () => {
  const facts = buildNarrativeFacts(composeSnapshot(base()));
  const n = buildPreopNarrative({
    text: 'The composite tier is AMBER [F1]. Insulin status is unknown [F1].', facts,
    snapshotFingerprint: 'fp1', generatedAt: 'now', model: 'm', provider: 'p', traceId: 't',
  });
  assert.equal(n.valid, true);
  assert.equal(narrativeRenderable(n, 'fp1'), true);
  assert.equal(narrativeRenderable(n, 'fp2'), false, 'the score moved; the prose did not');
  assert.equal(narrativeRenderable(n, null), false);
});

test('a narrative can never carry a score: the rail stores prose and the store never writes one', () => {
  const store = src('lib/preop/store.ts');
  const save = store.slice(store.indexOf('export async function saveNarrative'), store.indexOf('export async function saveNarrative') + 900);
  for (const col of ['tier =', 'rcri_', 'mfi_', 'cci_', 'snapshot =', 'snapshot_fingerprint =']) {
    assert.ok(!save.includes(col), `saveNarrative must not write ${col}`);
  }
  const saveEx = store.slice(store.indexOf('export async function saveExtraction'), store.indexOf('export async function saveExtraction') + 900);
  for (const col of ['tier =', 'rcri_', 'mfi_', 'cci_', 'snapshot =']) {
    assert.ok(!saveEx.includes(col), `saveExtraction must not write ${col}`);
  }
});

test('the case page renders a narrative only through the renderable predicate', () => {
  const row = src('lib/preop/surface-row.ts');
  assert.ok(row.includes('narrativeRenderable'), 'the read path must go through the predicate');
  assert.ok(/narrativeState === 'shown' \? stored : null/.test(row), 'anything else returns null, not a caveat');
});
