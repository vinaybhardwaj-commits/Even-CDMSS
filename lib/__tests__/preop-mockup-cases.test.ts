/**
 *   node --test --import tsx lib/__tests__/preop-mockup-cases.test.ts
 *
 * THE B1 ACCEPTANCE GATE. The V-approved mockup (PREOP-RISK-AGENT-MOCKUP-v1, 26 Aug 2026)
 * hand-computed four synthetic patients from the published instruments and states in its
 * own footer that those numbers "are the arithmetic the pure cores must reproduce
 * exactly". This file reproduces all four end-to-end through composeSnapshot — scores,
 * ranges, Lee classes, risk percentages, chip strings, dashed-chip decisions, tiers,
 * escalations and the derived card lines — plus Shobha's v1 -> v2 -> v3 range progression,
 * which is the module's core demo (PRD §5).
 *
 * These are SYNTHETIC patients from a design document. No real patient data is in this
 * file and none may be added to it.
 *
 * The board is drawn as of Wed 26 Aug 2026, which is where every `daysToSurgery` here
 * comes from ("in 3 days", "in 6 days", "in 8 days", "in 9 days" on the cards).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyProcedureRisk, composeSnapshot,
  type Observation, type SnapshotInput,
} from '../preop-assemble-core.ts';
import { instrumentChip } from '../preop-tier-core.ts';

const ENGINE = 'preop-risk/0.1';

function snap(over: Partial<SnapshotInput> & Pick<SnapshotInput, 'episode' | 'observations'>): ReturnType<typeof composeSnapshot> {
  return composeSnapshot({
    engineVersion: ENGINE,
    pac: { onFile: false, status: null, verdict: null, reportUid: null, finalizedAt: null, workflowStatus: null, workflowLoggedAt: null },
    daysToSurgery: null,
    reviewed: false,
    includeExtracted: true,
    bookingEnumerated: true,
    bookingOnly: false,
    computedAt: '2026-08-26T08:30:00Z',
    ...over,
  } as SnapshotInput);
}

const chips = (s: ReturnType<typeof composeSnapshot>) =>
  [instrumentChip(s.rcri), instrumentChip(s.mfi5), instrumentChip(s.charlson)];

// ── Shobha K · 61 F · total knee replacement (left) · EHRC · Tue 1 Sep ───────────
// Mockup board card: RED · RCRI 2 Class III 6.6% · mFI-5 2/5 · Charlson 4 · PAC final.
// Mockup case page gives her factor tables verbatim, including each factor's source —
// which is where every observation below comes from.

const shobhaEpisode = {
  episodeKey: 'SC-2026-0871', individualUid: 'IND-0871', uhid: 'UHID-398871',
  patientName: 'Shobha K', age: 61, sex: 'F',
  procedure: 'Total knee replacement (left)', hospital: 'EHRC',
  surgeryDate: '2026-09-01', surgeon: 'Dr Prakash Rao', department: 'Orthopaedics',
};

/** What the booking form alone says (v1, 12 Aug). */
const shobhaBooking: Observation[] = [
  { inputId: 'high_risk_surgery', status: 'absent', source: 'BOOKING',
    detail: 'TKR — not intraperitoneal / intrathoracic / suprainguinal-vascular' },
  { inputId: 'ischaemic_heart_disease', status: 'present', source: 'EXTRACTED', confidence: 0.96, detail: 'MI 2019' },
  { inputId: 'myocardial_infarction', status: 'present', source: 'EXTRACTED', confidence: 0.96, detail: 'MI 2019' },
  { inputId: 'insulin_treated_diabetes', status: 'present', source: 'BOOKING' },
  { inputId: 'diabetes_mellitus', status: 'present', source: 'BOOKING' },
  { inputId: 'diabetes_uncomplicated', status: 'present', source: 'BOOKING' },
  { inputId: 'hypertension_on_medication', status: 'present', source: 'EXTRACTED', confidence: 0.91, detail: 'Telmisartan 40' },
];
/** v2, 19 Aug: the Eka lab lands. 1.4 mg/dL resolves the renal factor ABSENT. */
const shobhaLab: Observation[] = [
  { inputId: 'creatinine_over_2', status: 'absent', source: 'LAB', value: 1.4,
    detail: '1.4 mg/dL · 19 Aug', observedAt: '2026-08-19T00:00:00Z', provenanceRef: 'eka:PDV-4412' },
];
/** v3, 24 Aug: the PAC is finalized. Functional status: independent. */
const shobhaPac: Observation[] = [
  { inputId: 'functional_status_dependent', status: 'absent', source: 'PAC', detail: 'independent',
    observedAt: '2026-08-24T00:00:00Z', provenanceRef: 'kx:PAC-77' },
  { inputId: 'ischaemic_heart_disease', status: 'present', source: 'PAC', detail: 'MI 2019', observedAt: '2026-08-24T00:00:00Z' },
  { inputId: 'copd_or_pneumonia', status: 'absent', source: 'PAC', observedAt: '2026-08-24T00:00:00Z' },
];
const SHOBHA_PAC_FINAL = {
  onFile: true, status: 'final', verdict: 'PATIENT CAN BE TAKEN FOR SURGERY',
  reportUid: 'kx:PAC-77', finalizedAt: '2026-08-24T12:32:00Z',
  workflowStatus: 'COMPLETED', workflowLoggedAt: '2026-08-24T12:32:00Z',
};

test('mockup · Shobha K — RED, RCRI 2 Class III 6.6%, mFI-5 2/5, Charlson 4', () => {
  const s = snap({
    episode: shobhaEpisode,
    observations: [...shobhaBooking, ...shobhaLab, ...shobhaPac],
    pac: SHOBHA_PAC_FINAL, daysToSurgery: 6,
  });

  assert.equal(s.rcri.kind, 'point');
  assert.equal(s.rcri.lo, 2);
  assert.equal(s.mfi5.lo, 2);
  assert.equal(s.mfi5.kind, 'point');
  assert.equal(s.charlson.lo, 4);
  assert.equal(s.charlson.kind, 'point');

  const [rcri, mfi, cci] = chips(s);
  assert.deepEqual(
    { score: rcri.score, cls: rcri.cls, dashed: rcri.dashed },
    { score: '2', cls: 'Class III · 6.6%', dashed: false },
  );
  assert.deepEqual({ score: mfi.score, cls: mfi.cls, dashed: mfi.dashed }, { score: '2/5', cls: '', dashed: false });
  assert.deepEqual({ score: cci.score, cls: cci.cls, dashed: cci.dashed }, { score: '4', cls: '', dashed: false });

  assert.equal(s.tier.tier, 'RED');
  assert.deepEqual(s.tier.escalations, []);        // the PAC is final: no 72 h escalation
  assert.equal(s.tier.redCount, 1);
  assert.equal(s.tier.dominant, 'rcri');
  assert.equal(s.tier.needsReview, true);          // unreviewed RED, surgery in 6 days
  assert.equal(s.lines.missing, '');               // "Nothing outstanding for RCRI — all six factors resolved at v3"
  assert.equal(s.lines.situation, '');
  assert.match(s.lines.why, /^ischaemic heart disease \(MI 2019\) \+ insulin-treated diabetes /);
});

test('mockup · Shobha K — the v1 -> v2 -> v3 timeline, exactly as the case page prints it', () => {
  // v1 · 12 Aug · booking form only — RCRI 2–3 (6.6–11%) · mFI 2–3 · CCI 4
  const v1 = snap({ episode: shobhaEpisode, observations: shobhaBooking, daysToSurgery: 20, computedAt: '2026-08-12T05:30:00Z' });
  assert.deepEqual([v1.rcri.lo, v1.rcri.hi], [2, 3]);
  assert.equal(instrumentChip(v1.rcri).score, '2–3');
  assert.equal(instrumentChip(v1.rcri).cls, 'Class III–IV · 6.6–11%');
  // NOT dashed: Class III and Class IV are both RED, so the uncertainty spans two Lee
  // classes but no SEVERITY boundary — nothing about the tier is unconfirmed, and the
  // AMBER floor has nothing to do. The score text and the dashed flag answer two
  // different questions and are deliberately independent.
  assert.equal(instrumentChip(v1.rcri).dashed, false);
  assert.deepEqual([v1.mfi5.lo, v1.mfi5.hi], [2, 3]);
  assert.equal(v1.charlson.lo, 4);
  assert.deepEqual(v1.rcri.missing, ['creatinine_over_2']);
  assert.deepEqual(v1.mfi5.missing, ['functional_status_dependent']);

  // v2 · 19 Aug · lab result landed — RCRI 2 (6.6%) · mFI 2–3 · CCI 4
  const v2 = snap({ episode: shobhaEpisode, observations: [...shobhaBooking, ...shobhaLab], daysToSurgery: 13, computedAt: '2026-08-19T05:30:00Z' });
  assert.equal(v2.rcri.kind, 'point');
  assert.equal(v2.rcri.lo, 2);
  assert.equal(instrumentChip(v2.rcri).cls, 'Class III · 6.6%');
  assert.deepEqual([v2.mfi5.lo, v2.mfi5.hi], [2, 3]);
  assert.equal(v2.charlson.lo, 4);

  // v3 · 24 Aug · PAC finalized — RCRI 2 (6.6%) · mFI 2/5 · CCI 4
  const v3 = snap({
    episode: shobhaEpisode, observations: [...shobhaBooking, ...shobhaLab, ...shobhaPac],
    pac: SHOBHA_PAC_FINAL, daysToSurgery: 8, computedAt: '2026-08-24T12:32:00Z',
  });
  assert.equal(v3.mfi5.kind, 'point');
  assert.equal(v3.mfi5.lo, 2);
  assert.equal(v3.charlson.lo, 4);

  // Every step is a DIFFERENT reading, so every step mints a version; the arithmetic
  // only ever tightened, never moved.
  assert.notEqual(v1.fingerprint, v2.fingerprint);
  assert.notEqual(v2.fingerprint, v3.fingerprint);
});

// ── Manjunath R · 68 M · open right hemicolectomy · EHRC · Sat 29 Aug ────────────
// Mockup: CRITICAL by BOTH escalation clauses. RCRI 3 Class IV 11% (creatinine still
// missing, but both bounds are Class IV so the chip does not print a range and is not
// dashed) · mFI-5 3–4/5 "frail" (a range, but both bounds are RED, so also not dashed)
// · Charlson 6 · no PAC on file, surgery in 3 days.

test('mockup · Manjunath R — CRITICAL by both escalation clauses', () => {
  const s = snap({
    episode: {
      episodeKey: 'SC-2026-0904', individualUid: 'IND-0904', uhid: 'UHID-401223',
      patientName: 'Manjunath R', age: 68, sex: 'M',
      procedure: 'Open right hemicolectomy', hospital: 'EHRC',
      surgeryDate: '2026-08-29', surgeon: 'Dr A Kulkarni', department: 'Surgical Gastroenterology',
    },
    observations: [
      { inputId: 'high_risk_surgery', status: 'present', source: 'BOOKING' },
      { inputId: 'ischaemic_heart_disease', status: 'present', source: 'BOOKING' },
      { inputId: 'insulin_treated_diabetes', status: 'present', source: 'BOOKING' },
      { inputId: 'diabetes_mellitus', status: 'present', source: 'BOOKING' },
      { inputId: 'copd_or_pneumonia', status: 'present', source: 'BOOKING' },
      { inputId: 'hypertension_on_medication', status: 'present', source: 'BOOKING' },
      { inputId: 'myocardial_infarction', status: 'present', source: 'BOOKING' },
      { inputId: 'chronic_pulmonary_disease', status: 'present', source: 'BOOKING' },
      { inputId: 'diabetes_end_organ_damage', status: 'present', source: 'BOOKING' },
    ],
    daysToSurgery: 3,
  });

  // RCRI 3–4 — but Class IV at BOTH bounds, so the answer is not in doubt.
  assert.deepEqual([s.rcri.lo, s.rcri.hi], [3, 4]);
  const [rcri, mfi, cci] = chips(s);
  assert.deepEqual({ score: rcri.score, cls: rcri.cls, dashed: rcri.dashed },
    { score: '3', cls: 'Class IV · 11%', dashed: false });
  assert.deepEqual([s.mfi5.lo, s.mfi5.hi], [3, 4]);
  assert.deepEqual({ score: mfi.score, cls: mfi.cls, dashed: mfi.dashed },
    { score: '3–4/5', cls: 'frail', dashed: false });
  assert.equal(s.charlson.kind, 'point');
  assert.equal(s.charlson.lo, 6);
  assert.deepEqual({ score: cci.score, cls: cci.cls, dashed: cci.dashed }, { score: '6', cls: '', dashed: false });

  assert.equal(s.tier.tier, 'CRITICAL');
  assert.equal(s.tier.redCount, 3);
  assert.deepEqual(s.tier.escalations, ['red_on_two_instruments', 'red_without_finalized_pac_72h']);
  assert.equal(s.tier.needsReview, true);

  // The three derived card lines, verbatim from the mockup.
  assert.equal(s.lines.why,
    'high-risk surgery + ischaemic heart disease + insulin-treated diabetes (RCRI, 3 of 6 factors)');
  assert.equal(s.lines.missing, 'Missing: creatinine · functional status — both confirmable at PAC');
  assert.equal(s.lines.situation, 'No PAC on file and surgery is in 3 days');
});

// ── Farhan S · 54 M · laparoscopic cholecystectomy · EHRC · Thu 3 Sep ────────────
// Mockup: AMBER via the lower bound + the boundary-crossing floor. RCRI 1–2, Class
// II–III, 0.9–6.6%, DASHED. The card's own fix is data: "a single lab collapses the range".

test('mockup · Farhan S — AMBER on the confirmed lower bound, dashed on the crossing', () => {
  const s = snap({
    episode: {
      episodeKey: 'SC-2026-0912', individualUid: 'IND-0912', uhid: 'UHID-402911',
      patientName: 'Farhan S', age: 54, sex: 'M',
      procedure: 'Laparoscopic cholecystectomy', hospital: 'EHRC',
      surgeryDate: '2026-09-03', surgeon: 'Dr M Shetty', department: 'General Surgery',
    },
    observations: [
      { inputId: 'high_risk_surgery', status: 'absent', source: 'BOOKING' },
      { inputId: 'ischaemic_heart_disease', status: 'present', source: 'BOOKING', detail: 'coronary angioplasty 2021' },
      { inputId: 'myocardial_infarction', status: 'present', source: 'BOOKING', detail: 'coronary angioplasty 2021' },
      { inputId: 'hypertension_on_medication', status: 'present', source: 'BOOKING' },
      { inputId: 'functional_status_dependent', status: 'absent', source: 'PAC', detail: 'independent', observedAt: '2026-08-22T00:00:00Z' },
    ],
    pac: { onFile: true, status: 'final', verdict: 'PATIENT CAN BE TAKEN FOR SURGERY', reportUid: 'kx:PAC-81', finalizedAt: '2026-08-22T10:10:00Z', workflowStatus: 'COMPLETED', workflowLoggedAt: '2026-08-22T10:10:00Z' },
    daysToSurgery: 8,
  });

  const [rcri, mfi, cci] = chips(s);
  assert.deepEqual([s.rcri.lo, s.rcri.hi], [1, 2]);
  assert.deepEqual({ score: rcri.score, cls: rcri.cls, dashed: rcri.dashed },
    { score: '1–2', cls: 'Class II–III · 0.9–6.6%', dashed: true });
  assert.deepEqual({ score: mfi.score, cls: mfi.cls, dashed: mfi.dashed }, { score: '1/5', cls: '', dashed: false });
  assert.deepEqual({ score: cci.score, cls: cci.cls, dashed: cci.dashed }, { score: '2', cls: '', dashed: false });

  // The lower bound scores AMBER; the unconfirmed upper bound would be RED, and the rule
  // refuses to mint RED off missing data — but it can no longer render GREEN either.
  assert.equal(s.tier.tier, 'AMBER');
  assert.equal(s.tier.redCount, 0);
  assert.equal(s.tier.unconfirmed, true);
  assert.equal(s.tier.dominant, 'rcri');
  assert.equal(s.tier.needsReview, false);         // AMBER never enters the review band
  assert.equal(s.lines.missing, 'Missing: creatinine — a single lab collapses the range');
  assert.equal(s.lines.situation, '');
  assert.match(s.lines.why, /coronary angioplasty 2021.*upper bound unconfirmed$/);
});

// ── Lakshmamma H · 71 F · cataract surgery (right) · EHBR · Fri 4 Sep ────────────
// Mockup: the booking-only patient. Every instrument renders, none is hidden, and the
// thin data IS the finding. Charlson 3 comes entirely from the age band.

test('mockup · Lakshmamma H — booking-only, ranges everywhere, AMBER off Charlson alone', () => {
  const s = snap({
    episode: {
      episodeKey: 'SC-2026-0918', individualUid: 'IND-0918', uhid: 'UHID-403544',
      patientName: 'Lakshmamma H', age: 71, sex: 'F',
      procedure: 'Cataract surgery (right)', hospital: 'EHBR',
      surgeryDate: '2026-09-04', surgeon: 'Dr S Nair', department: 'Ophthalmology',
    },
    observations: [
      { inputId: 'high_risk_surgery', status: 'absent', source: 'BOOKING' },
      { inputId: 'hypertension_on_medication', status: 'present', source: 'BOOKING' },
    ],
    daysToSurgery: 9,
    bookingOnly: true,
  });

  const [rcri, mfi, cci] = chips(s);
  assert.deepEqual([s.rcri.lo, s.rcri.hi], [0, 1]);
  assert.deepEqual({ score: rcri.score, cls: rcri.cls, dashed: rcri.dashed },
    { score: '0–1', cls: 'Class I–II · 0.4–0.9%', dashed: true });
  assert.deepEqual([s.mfi5.lo, s.mfi5.hi], [1, 2]);
  assert.deepEqual({ score: mfi.score, cls: mfi.cls, dashed: mfi.dashed }, { score: '1–2/5', cls: '', dashed: true });
  assert.equal(s.charlson.kind, 'point');
  assert.equal(s.charlson.lo, 3);                  // the age band alone
  assert.deepEqual({ score: cci.score, cls: cci.cls, dashed: cci.dashed }, { score: '3', cls: '', dashed: false });

  assert.equal(s.tier.tier, 'AMBER');
  assert.equal(s.tier.dominant, 'charlson');
  assert.equal(s.tier.needsReview, false);
  assert.equal(s.lines.missing, 'Missing: creatinine · functional status · PAC');
  assert.equal(s.lines.situation, '');             // AMBER: the red line is for RED/CRITICAL only
  assert.match(s.lines.why, /^age 71 /);
  assert.match(s.lines.why, /booking form is the only source on file — no OPD, labs or PAC yet$/);
});

// ── the dense GREEN rows the board collapses ────────────────────────────────────

test('mockup · a clean young patient renders GREEN with a point score on all three', () => {
  const s = snap({
    episode: {
      episodeKey: 'SC-2026-0930', individualUid: 'IND-0930', uhid: 'UHID-404001',
      patientName: 'Arjun P', age: 29, sex: 'M',
      procedure: 'Inguinal hernia repair', hospital: 'EHRC',
      surgeryDate: '2026-09-07', surgeon: 'Dr M Shetty', department: 'General Surgery',
    },
    observations: [
      { inputId: 'high_risk_surgery', status: 'absent', source: 'BOOKING' },
      { inputId: 'creatinine_over_2', status: 'absent', source: 'LAB', value: 0.9 },
      { inputId: 'functional_status_dependent', status: 'absent', source: 'PAC' },
    ],
    pac: { onFile: true, status: 'final', verdict: 'PATIENT CAN BE TAKEN FOR SURGERY', reportUid: 'kx:PAC-90', finalizedAt: '2026-08-25T09:00:00Z', workflowStatus: 'COMPLETED', workflowLoggedAt: '2026-08-25T09:00:00Z' },
    daysToSurgery: 12,
  });
  assert.equal(s.rcri.lo, 0);
  assert.equal(s.mfi5.lo, 0);
  assert.equal(s.charlson.lo, 0);
  assert.equal(s.tier.tier, 'GREEN');
  assert.equal(s.tier.needsReview, false);
  assert.equal(instrumentChip(s.rcri).cls, 'Class I · 0.4%');
});

// ── the procedure risk classifier the four cases depend on ──────────────────────

test('procedure risk class — the mockup\'s own arithmetic is what settles each case', () => {
  assert.equal(classifyProcedureRisk('Open right hemicolectomy').status, 'present');
  assert.equal(classifyProcedureRisk('TKR').status, 'absent');
  assert.equal(classifyProcedureRisk('TKR').reason,
    'TKR — not intraperitoneal / intrathoracic / suprainguinal-vascular');
  assert.equal(classifyProcedureRisk('Total knee replacement (left)').status, 'absent');
  assert.equal(classifyProcedureRisk('Cataract surgery (right)').status, 'absent');
  // Both laparoscopic cases score high-risk-surgery ABSENT in the approved mockup, even
  // though the peritoneum is entered — minimal access is the discriminator it used.
  assert.equal(classifyProcedureRisk('Laparoscopic cholecystectomy').status, 'absent');
  assert.equal(classifyProcedureRisk('Lap appendectomy (interval)').status, 'absent');
  assert.equal(classifyProcedureRisk('Inguinal hernia repair').status, 'absent');
  assert.equal(classifyProcedureRisk('ACL reconstruction').status, 'absent');
  // Unrecognised text is a DATA GAP, never a quiet zero.
  assert.equal(classifyProcedureRisk('Procedure as per plan').status, 'unknown');
  assert.equal(classifyProcedureRisk('').status, 'unknown');
  assert.equal(classifyProcedureRisk(null).status, 'unknown');
});

// ── B7 · the synthetic half of the golden set ───────────────────────────────────
//
// The kickoff's golden set is the PAC-covered cohort plus these four hand-computed
// patients plus booking-only synthetics. The four above ARE that second half, and they
// run with `includeExtracted: true` — which is why they are also where the D4 equality
// claim gets its synthetic arm: the rail is on, and it still cannot move an instrument
// unless there is an extracted observation to move it with.

const shobhaDeterministicOnly = shobhaBooking.filter((o) => o.source !== 'EXTRACTED');

test('B7 golden set · a booking-only synthetic scores identically with the rail on and off', () => {
  const args = {
    episode: {
      episodeKey: 'SC-2026-0918', individualUid: 'IND-0918', uhid: 'UHID-403544',
      patientName: 'Lakshmamma H', age: 71, sex: 'F',
      procedure: 'Cataract surgery (right)', hospital: 'EHBR',
      surgeryDate: '2026-09-04', surgeon: 'Dr S Nair', department: 'Ophthalmology',
    },
    observations: [
      { inputId: 'high_risk_surgery' as const, status: 'absent' as const, source: 'BOOKING' as const },
      { inputId: 'hypertension_on_medication' as const, status: 'present' as const, source: 'BOOKING' as const },
    ],
    daysToSurgery: 9,
    bookingOnly: true,
  };
  const on = snap(args);
  const off = snap({ ...args, includeExtracted: false });
  assert.equal(on.fingerprint, off.fingerprint);
  assert.deepEqual(JSON.parse(JSON.stringify(on)), JSON.parse(JSON.stringify(off)));
});

test('B7 golden set · Shobha K is the case the extraction rail is FOR, and the mockup drew it that way', () => {
  // Her ischaemic heart disease ("MI 2019") and her hypertension ("Telmisartan 40") are
  // both pink EXTRACTED chips on the approved card. Turn the rail off and the module
  // reports LESS — which is the honest degraded behaviour Slice 1 ships with, not a bug.
  const withRail = snap({
    episode: shobhaEpisode,
    observations: [...shobhaBooking, ...shobhaLab, ...shobhaPac],
    pac: SHOBHA_PAC_FINAL, daysToSurgery: 6,
  });
  const withoutRail = snap({
    episode: shobhaEpisode,
    observations: [...shobhaDeterministicOnly, ...shobhaLab, ...shobhaPac],
    pac: SHOBHA_PAC_FINAL, daysToSurgery: 6,
    includeExtracted: false,
  });

  assert.equal(withRail.rcri.lo, 2, 'the approved card says RCRI 2');
  assert.equal(withoutRail.rcri.lo, 2, 'RCRI survives the rail being off — her PAC states the MI deterministically, so only mFI-5 depended on a model');
  assert.equal(withRail.mfi5.lo, 2);
  assert.equal(withoutRail.mfi5.lo, 1, 'the hypertension item was extraction-only ("Telmisartan 40"); without the rail the module knows less and says so');
  // Both are honest readings of different evidence. Neither is the model scoring: every
  // point in both comes from the same arithmetic over a different set of input STATUSES.
  assert.equal(withRail.tier.tier, 'RED');
  assert.equal(withoutRail.tier.tier, 'RED', 'the tier holds — one frailty point was the whole difference');
});
