/**
 *   node --test --import tsx lib/__tests__/preop-assemble-core.test.ts
 *
 * Input assembly (PRD v1.1-LOCKED §7, §8; mockup note 3): source precedence, conflict
 * tagging, the extraction confidence floor, the closed-world rule that lets a
 * booking-only patient score a POINT rather than an absurd range, and the fingerprint
 * that decides what "changed" means for the whole versions rail.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_INPUT_IDS, composeSnapshot, EXTRACT_CONFIDENCE_FLOOR, resolveInputs, SOURCE_RANK,
  canonicalJson, snapshotFingerprint,
  type Observation, type SnapshotInput,
} from '../preop-assemble-core.ts';

const opts = { includeExtracted: true, bookingEnumerated: true };

test('precedence — LAB/PAC outrank BOOKING, which outranks EXTRACTED', () => {
  assert.ok(SOURCE_RANK.LAB === SOURCE_RANK.PAC);
  assert.ok(SOURCE_RANK.PAC < SOURCE_RANK.BOOKING);
  assert.ok(SOURCE_RANK.BOOKING < SOURCE_RANK.EXTRACTED);

  const obs: Observation[] = [
    { inputId: 'creatinine_over_2', status: 'present', source: 'EXTRACTED', confidence: 0.95, detail: 'renal impairment noted' },
    { inputId: 'creatinine_over_2', status: 'absent', source: 'LAB', value: 1.4 },
    { inputId: 'creatinine_over_2', status: 'present', source: 'BOOKING' },
  ];
  const r = resolveInputs(obs, opts).creatinine_over_2;
  assert.equal(r.source, 'LAB');
  assert.equal(r.status, 'absent');           // the lab scores it
  assert.equal(r.value, 1.4);
});

test('a losing source that DISAGREES is a conflict; one that agrees corroborates', () => {
  const conflicted = resolveInputs([
    { inputId: 'ischaemic_heart_disease', status: 'present', source: 'PAC' },
    { inputId: 'ischaemic_heart_disease', status: 'absent', source: 'BOOKING' },
  ], opts).ischaemic_heart_disease;
  assert.equal(conflicted.status, 'present');
  assert.equal(conflicted.conflict, true);
  assert.equal(conflicted.corroborating.length, 0);

  const agreed = resolveInputs([
    { inputId: 'ischaemic_heart_disease', status: 'present', source: 'PAC' },
    { inputId: 'ischaemic_heart_disease', status: 'present', source: 'BOOKING' },
  ], opts).ischaemic_heart_disease;
  assert.equal(agreed.conflict, false);
  assert.equal(agreed.corroborating.length, 1);
  assert.equal(agreed.corroborating[0].source, 'BOOKING');
});

test('a tie inside one precedence rank is broken by the newer observation', () => {
  const r = resolveInputs([
    { inputId: 'functional_status_dependent', status: 'present', source: 'PAC', observedAt: '2026-08-01T00:00:00Z' },
    { inputId: 'functional_status_dependent', status: 'absent', source: 'PAC', observedAt: '2026-08-20T00:00:00Z' },
  ], opts).functional_status_dependent;
  assert.equal(r.status, 'absent');
  assert.equal(r.observedAt, '2026-08-20T00:00:00Z');
});

test('below the floor an EXTRACTED input is DROPPED, not down-weighted — it becomes UNKNOWN', () => {
  const obs: Observation[] = [
    { inputId: 'creatinine_over_2', status: 'present', source: 'EXTRACTED', confidence: EXTRACT_CONFIDENCE_FLOOR - 0.01 },
  ];
  const r = resolveInputs(obs, { ...opts, bookingEnumerated: false }).creatinine_over_2;
  assert.equal(r.status, 'unknown');
  assert.equal(r.source, null);
  assert.equal(r.droppedBelowFloor.length, 1);      // the drop is shown, never silent
  // ...and at the floor exactly, it counts.
  const at = resolveInputs([{ inputId: 'creatinine_over_2', status: 'present', source: 'EXTRACTED', confidence: EXTRACT_CONFIDENCE_FLOOR }], opts).creatinine_over_2;
  assert.equal(at.status, 'present');
});

test('with the extraction flag OFF, an EXTRACTED observation never enters the resolution', () => {
  const obs: Observation[] = [
    { inputId: 'hypertension_on_medication', status: 'present', source: 'EXTRACTED', confidence: 0.99 },
  ];
  const on = resolveInputs(obs, opts).hypertension_on_medication;
  const off = resolveInputs(obs, { ...opts, includeExtracted: false }).hypertension_on_medication;
  assert.equal(on.status, 'present');
  // Flag off ⇒ the SAME §8 degradation machinery a missing input uses. No new concept.
  assert.equal(off.status, 'absent');               // closed by the booking enumeration
  const offNoBooking = resolveInputs(obs, { includeExtracted: false, bookingEnumerated: false }).hypertension_on_medication;
  assert.equal(offNoBooking.status, 'unknown');
  assert.equal(offNoBooking.droppedBelowFloor.length, 0);
});

test('the closed-world rule — a booking form that exists ENUMERATES comorbidities', () => {
  const r = resolveInputs([{ inputId: 'ischaemic_heart_disease', status: 'present', source: 'BOOKING' }], opts);
  // Not listed on a form that exists = absent, and the reason is recorded on the input.
  assert.equal(r.congestive_heart_failure.status, 'absent');
  assert.equal(r.congestive_heart_failure.closedWorld, true);
  assert.equal(r.congestive_heart_failure.source, 'BOOKING');
  // ...but nothing closes creatinine, functional status, the procedure class or age.
  assert.equal(r.creatinine_over_2.status, 'unknown');
  assert.equal(r.functional_status_dependent.status, 'unknown');
  assert.equal(r.high_risk_surgery.status, 'unknown');
  assert.equal(r.age.status, 'unknown');
});

test('with NO booking form, nothing is closed and everything is unknown', () => {
  const r = resolveInputs([], { includeExtracted: true, bookingEnumerated: false });
  for (const id of ALL_INPUT_IDS) assert.equal(r[id].status, 'unknown', `${id} should be unknown`);
});

test('every input in the canonical space is present in the resolution, always', () => {
  const r = resolveInputs([], opts);
  assert.equal(Object.keys(r).length, ALL_INPUT_IDS.length);
  for (const id of ALL_INPUT_IDS) assert.equal(r[id].inputId, id);
});

// ── the fingerprint ─────────────────────────────────────────────────────────────

const episode = {
  episodeKey: 'SC-TEST-1', individualUid: 'IND-1', uhid: 'UH-1', patientName: 'Test Patient',
  age: 60, sex: 'F', procedure: 'Cataract surgery (right)', hospital: 'EHBR',
  surgeryDate: '2026-09-30', surgeon: 'Dr T', department: 'Ophthalmology',
};
const base: SnapshotInput = {
  engineVersion: 'preop-risk/0.1', episode, observations: [
    { inputId: 'high_risk_surgery', status: 'absent', source: 'BOOKING' },
  ],
  pac: { onFile: false, status: null, verdict: null, reportUid: null, finalizedAt: null },
  daysToSurgery: 20, reviewed: false, includeExtracted: false, bookingEnumerated: true,
  bookingOnly: true, computedAt: '2026-09-10T00:00:00Z',
};

test('the same evidence produces a byte-identical snapshot, every time', () => {
  const a = composeSnapshot(base);
  const b = composeSnapshot(base);
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('a sweep is not a change — computedAt and daysToSurgery are outside the fingerprint', () => {
  const a = composeSnapshot(base);
  const later = composeSnapshot({ ...base, computedAt: '2026-09-11T00:00:00Z', daysToSurgery: 19 });
  assert.equal(a.fingerprint, later.fingerprint);   // this is the double-tick gate, in one line
});

test('one new input mints exactly one new fingerprint', () => {
  const a = composeSnapshot(base);
  const withLab = composeSnapshot({
    ...base,
    observations: [...base.observations, { inputId: 'creatinine_over_2', status: 'absent', source: 'LAB', value: 1.1 }],
  });
  assert.notEqual(a.fingerprint, withLab.fingerprint);
  assert.equal(a.rcri.kind, 'range');
  assert.equal(withLab.rcri.kind, 'point');
});

test('a tier that escalates as the calendar closes in DOES mint a version', () => {
  // RED with no PAC. At 4 days out it is RED; at 3 days out the 72 h clause fires.
  const red: SnapshotInput = {
    ...base, bookingOnly: false,
    observations: [
      { inputId: 'high_risk_surgery', status: 'present', source: 'BOOKING' },
      { inputId: 'ischaemic_heart_disease', status: 'present', source: 'BOOKING' },
      { inputId: 'creatinine_over_2', status: 'absent', source: 'LAB', value: 1.0 },
    ],
  };
  const far = composeSnapshot({ ...red, daysToSurgery: 4 });
  const near = composeSnapshot({ ...red, daysToSurgery: 3 });
  assert.equal(far.tier.tier, 'RED');
  assert.equal(near.tier.tier, 'CRITICAL');
  assert.notEqual(far.fingerprint, near.fingerprint);
});

test('needs_review is a board predicate, not a snapshot fact — it never mints a version', () => {
  const red: SnapshotInput = {
    ...base, bookingOnly: false,
    pac: { onFile: true, status: 'final', verdict: 'FIT', reportUid: 'p1', finalizedAt: '2026-09-01T00:00:00Z' },
    observations: [
      { inputId: 'high_risk_surgery', status: 'present', source: 'BOOKING' },
      { inputId: 'ischaemic_heart_disease', status: 'present', source: 'BOOKING' },
      { inputId: 'creatinine_over_2', status: 'absent', source: 'LAB', value: 1.0 },
      { inputId: 'functional_status_dependent', status: 'absent', source: 'PAC' },
    ],
  };
  const outside = composeSnapshot({ ...red, daysToSurgery: 8 });
  const inside = composeSnapshot({ ...red, daysToSurgery: 7 });
  assert.equal(outside.tier.needsReview, false);
  assert.equal(inside.tier.needsReview, true);
  assert.equal(outside.tier.tier, inside.tier.tier);
  assert.equal(outside.fingerprint, inside.fingerprint);
});

test('canonicalJson is key-order independent — a fingerprint tracks values, not spelling', () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] }), canonicalJson({ a: [2, { c: 3, d: 4 }], b: 1 }));
});

test('the fingerprint reads the evidence, not the prose', () => {
  const a = composeSnapshot(base);
  const material = snapshotFingerprint(a);
  assert.equal(material, a.fingerprint);
  // Renaming a patient changes the card header and nothing about the reading.
  const renamed = composeSnapshot({ ...base, episode: { ...episode, patientName: 'Someone Else' } });
  assert.equal(renamed.fingerprint, a.fingerprint);
});
