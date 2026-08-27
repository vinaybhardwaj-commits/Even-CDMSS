/**
 *   node --test --import tsx lib/__tests__/preop-harvest-core.test.ts
 *
 * B8a — the deterministic harvest, and above all the rule B7 was written in blood for:
 * a medication may establish an input whose definition IS the medication, and may never
 * establish a diagnosis it merely suggests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  diseaseHits, diseaseObservations, negated, opdComorbidityObservations, rxHits, rxObservations,
  BANNED_DRUG_INFERENCE, DISEASE_RULES, PREOP_HARVEST_RULE_VERSION,
  RX_DEFINITIONAL_INPUTS, RX_RULES,
} from '../preop-harvest-core.ts';
import { composeSnapshot, PAC_NONE, type Observation, type SnapshotInput } from '../preop-assemble-core.ts';

// ── the category ban ────────────────────────────────────────────────────────────

test('THE ACCEPTANCE TEST: telmisartan maps, rabeprazole maps to NOTHING', () => {
  const telma = rxObservations('TAB TELMA 40 MG', 'PAC · cardiovascular note');
  assert.equal(telma.length, 1);
  assert.equal(telma[0].inputId, 'hypertension_on_medication');
  assert.equal(telma[0].status, 'present');
  assert.equal(telma[0].source, 'RX');

  // The exact string that moved a 75-year-old from AMBER to RED on 27 Aug.
  assert.deepEqual(rxObservations('TAB RABEPRAZOLE 20 MG', 'PAC · other medical history'), []);
  assert.deepEqual(rxHits('TAB RABEPRAZOLE 20 MG'), []);
});

test('the ban is a CATEGORY, not a blocklist — no rule may name a non-definitional input', () => {
  for (const rule of RX_RULES) {
    for (const id of [...rule.present, ...(rule.absent ?? [])]) {
      assert.ok(RX_DEFINITIONAL_INPUTS.has(id),
        `${rule.label} maps ${id}, which is not an input whose definition IS a medication`);
    }
  }
  // …and the definitional set itself contains no diagnosis. These four are the whole list.
  assert.deepEqual([...RX_DEFINITIONAL_INPUTS].sort(), [
    'diabetes_mellitus', 'diabetes_uncomplicated', 'hypertension_on_medication', 'insulin_treated_diabetes',
  ]);
  assert.ok(BANNED_DRUG_INFERENCE.includes('RABEPRAZOLE'), 'the reasoning names the case that caused it');
});

test('no drug class may name a Charlson diagnosis, however tempting', () => {
  // aspirin/antiplatelet → NOT ischaemic heart disease. inhaler → NOT COPD. Both were
  // plausible readings the B7 rail could have made; neither has a rule here.
  for (const text of ['TAB ECOSPRIN 75', 'TAB CLOPIDOGREL 75', 'SEROFLO INHALER', 'TAB PANTOPRAZOLE 40',
                      'TAB ATORVASTATIN 20', 'TAB THYRONORM 50 MCG', 'TAB FUROSEMIDE 40']) {
    for (const o of rxObservations(text, 'x')) {
      assert.ok(RX_DEFINITIONAL_INPUTS.has(o.inputId), `${text} produced ${o.inputId}`);
    }
  }
});

test('insulin establishes the RCRI factor; an ORAL agent establishes diabetes and says nothing about insulin', () => {
  const ins = rxObservations('INJ HUMAN MIXTARD 30/70', 'x').map((o) => `${o.inputId}:${o.status}`);
  assert.ok(ins.includes('insulin_treated_diabetes:present'));
  assert.ok(ins.includes('diabetes_mellitus:present'));

  // ⚠️ THE B7 CORRECTION. That rail read "TAB VOGLIBOSE 0.3 MG" as insulin-treated diabetes
  // ABSENT. A type-2 diabetic on metformin PLUS basal insulin is an ordinary patient, and
  // absence of a drug from a list is not evidence: the list may be incomplete.
  const oral = rxObservations('TAB VOGLIBOSE 0.3 MG', 'x');
  assert.ok(oral.some((o) => o.inputId === 'diabetes_mellitus' && o.status === 'present'));
  assert.ok(!oral.some((o) => o.inputId === 'insulin_treated_diabetes'),
    'an oral agent must resolve NOTHING about insulin — in either direction');
});

test('word boundaries hold — "insulinoma" is not insulin', () => {
  assert.deepEqual(rxHits('h/o insulinoma resected 2019'), []);
});

// ── the disease-name matcher ────────────────────────────────────────────────────

test('a named disease is observed; the name is all it takes', () => {
  const r = diseaseObservations('K/C/O IHD, CABG 2019. COPD on inhalers.', 'PAC · other medical history');
  const ids = r.observations.map((o) => o.inputId);
  assert.ok(ids.includes('ischaemic_heart_disease'));
  assert.ok(ids.includes('copd_or_pneumonia'));
  assert.ok(ids.includes('chronic_pulmonary_disease'));
  assert.ok(r.observations.every((o) => o.source === 'PAC' && o.status === 'present'));
});

test('THE NEGATION GUARD: "no h/o IHD" must not match, and neither must a blanket denial', () => {
  assert.deepEqual(diseaseObservations('no h/o IHD', 'x').observations, []);
  assert.deepEqual(diseaseObservations('No history of stroke', 'x').observations, []);
  assert.deepEqual(diseaseObservations('denies CVA', 'x').observations, []);
  assert.deepEqual(diseaseObservations('negative for COPD', 'x').observations, []);
  // …and the other side of the name, which clinicians write at least as often:
  assert.deepEqual(diseaseObservations('CKD not present', 'x').observations, []);
  assert.deepEqual(diseaseObservations('IHD - nil', 'x').observations, []);
  assert.deepEqual(diseaseObservations('COPD: no', 'x').observations, []);
  // the blanket denial this cohort actually writes, in four spellings
  for (const t of ['NO KNOWN COMORBIDITIES, no IHD', 'no comorbids - CAD ruled out', 'NIL COMORBIDITIES; CKD not present']) {
    assert.deepEqual(diseaseObservations(t, 'x').observations, [], `matched inside: ${t}`);
  }
});

test('a negated mention observes NOTHING — it does not assert absence either', () => {
  const r = diseaseObservations('no h/o IHD', 'x');
  assert.deepEqual(r.observations, []);
  assert.deepEqual(r.suppressedByNegation, ['Ischaemic heart disease']);
  // ...because a free-text box is a note, not an enumeration. Absence-from-silence is
  // reserved for forms that actually enumerate (the closed-world rule).
});

test('when in doubt the guard MISSES — a miss degrades to a suggestion, a false hit corrupts a score', () => {
  // "pain not relieved by antacids, h/o peptic ulcer" — the negation governs the pain, not
  // the ulcer, so a perfect guard would match. This one does not, and that is the safe
  // direction: B8b will offer it as a suggestion for a human to confirm.
  const r = diseaseObservations('h/o peptic ulcer, pain not relieved by antacids', 'x');
  assert.ok(r.observations.some((o) => o.inputId === 'peptic_ulcer_disease'), 'the unnegated form still matches');
  assert.equal(negated('no known comorbidities', 3, 5), true);
});

test('ARF is deliberately absent from the disease list — the B3 ruling, kept', () => {
  const names = DISEASE_RULES.flatMap((r) => r.names);
  assert.ok(!names.includes('arf'), 'acute renal failure is not chronic renal disease');
  assert.deepEqual(diseaseObservations('ARF resolved', 'x').observations, []);
  // ...while the chronic forms do match.
  assert.ok(diseaseObservations('CKD stage 4, on dialysis', 'x').observations.some((o) => o.inputId === 'moderate_severe_renal_disease'));
});

test('a curated name with no instrument is counted, not lost', () => {
  const r = diseaseObservations('hypothyroidism on thyronorm', 'x');
  assert.deepEqual(r.observations, []);
  assert.deepEqual(r.unmapped, ['Hypothyroidism']);
});

test('the matcher is a table, not a classifier — the same text always gives the same answer', () => {
  const t = 'K/C/O DM, HTN, IHD s/p PTCA 2018; CVA 2020 with residual hemiparesis';
  const a = diseaseHits(t).map((h) => `${h.rule.label}:${h.negated}`);
  const b = diseaseHits(t).map((h) => `${h.rule.label}:${h.negated}`);
  assert.deepEqual(a, b);
  assert.ok(a.length > 2);
});

// ── the sixth deterministic source ──────────────────────────────────────────────

test('the OPD comorbidity list maps what it can and counts what it cannot', () => {
  const r = opdComorbidityObservations(['Diabetes', 'Thyroid Disorder', 'High BP']);
  assert.ok(r.observations.some((o) => o.inputId === 'diabetes_mellitus' && o.source === 'OPD'));
  assert.deepEqual(r.unmapped.sort(), ['High BP', 'Thyroid Disorder']);
});

test('"High BP" does NOT assert the mFI item — the form never said it was medicated', () => {
  const r = opdComorbidityObservations(['High BP']);
  assert.ok(!r.observations.some((o) => o.inputId === 'hypertension_on_medication'),
    'mFI-5 scores hypertension REQUIRING MEDICATION; this field does not say that');
});

// ── end to end: the harvest scores, and it scores deterministically ─────────────

const base = (obs: Observation[]): SnapshotInput => ({
  engineVersion: 'preop-risk/0.1',
  episode: {
    episodeKey: 'SC-H', individualUid: 'I', uhid: 'U', patientName: 'X', age: 70, sex: 'MALE',
    procedure: 'Total knee replacement', hospital: 'H', surgeryDate: '2026-09-30', surgeon: null, department: null,
  },
  observations: obs, pac: PAC_NONE, daysToSurgery: 30, reviewed: false,
  includeExtracted: false, bookingEnumerated: true, bookingOnly: false,
  computedAt: '2026-08-27T04:00:00Z',
});

test('an RX observation scores with the extraction rail OFF — it is not an extraction', () => {
  const rx = rxObservations('TAB TELMA 40 MG', 'PAC · cardiovascular note');
  const without = composeSnapshot(base([]));
  const with_ = composeSnapshot(base(rx));
  assert.equal(without.inputs.find((i) => i.inputId === 'hypertension_on_medication')!.status, 'absent');
  const htn = with_.inputs.find((i) => i.inputId === 'hypertension_on_medication')!;
  assert.equal(htn.status, 'present');
  assert.equal(htn.source, 'RX');
  assert.equal(with_.mfi5.lo, (without.mfi5.lo ?? 0) + 1, 'and it moved the frailty score, deterministically');
});

test('the same text twice gives a byte-identical snapshot — the property B7 could not promise', () => {
  const t = 'K/C/O IHD, DM on TAB GLYCOMET 500. No h/o stroke.';
  const run = () => composeSnapshot(base([
    ...rxObservations(t, 'PAC · other medical history'),
    ...diseaseObservations(t, 'PAC · other medical history').observations,
  ]));
  assert.equal(run().fingerprint, run().fingerprint);
  const s = run();
  assert.equal(s.inputs.find((i) => i.inputId === 'ischaemic_heart_disease')!.status, 'present');
  assert.equal(s.inputs.find((i) => i.inputId === 'cerebrovascular_disease')!.status, 'absent', 'closed world, not the negated mention');
  // The oral agent contributed NOTHING about insulin — the 'absent' here is the booking
  // form's closed world, not the drug. That distinction is the whole B7 correction.
  const ins = s.inputs.find((i) => i.inputId === 'insulin_treated_diabetes')!;
  assert.equal(ins.status, 'absent');
  assert.equal(ins.closedWorld, true, 'the FORM closed it, not the pharmacy line');
  assert.equal(ins.source, 'BOOKING');
});

test('the rule version is pinned', () => {
  assert.equal(PREOP_HARVEST_RULE_VERSION, 'preop-harvest/1');
});
