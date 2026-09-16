/**
 *   node --experimental-strip-types --test lib/__tests__/readmission-ehrc-relabel.test.ts
 * READMIT-EHRC-RELABEL-BUILDER-BRIEF-16-SEP-2026 — since 19 Aug 2026 the KareXpert ADT feed labels
 * EHRC encounters `Even-EHRC` instead of `Even` (db13 kx_discharged_completed_patients.facility_name).
 * canonicalFacility maps both to the canonical key `Even`; every boundary that reads a raw facility_name
 * off db13 (the rates denominator buckets, the incidence denominator SQL, the ADT name-join facility on
 * findings, the hospital filter) canonicalises through it so the two labels behave as one hospital.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FACILITY_EHBR, FACILITY_EHRC, FACILITY_EHRC_ALIASES, canonicalFacility, computeRates,
  type DischargeBucket, type RatePair,
} from '../readmission-rates-core.ts';
import { incidenceDenominatorSql } from '../readmission/rates.ts';
import { facilityOptions, matchesFacility } from '../readmission-filter-core.ts';
import type { SurfaceFinding } from '../readmission-surface-core.ts';

// ── canonicalFacility ────────────────────────────────────────────────────────────────────

test('canonicalFacility: Even and Even-EHRC (trimmed) canonicalise to Even; Even-EHBR is verbatim; null/empty → null', () => {
  assert.equal(canonicalFacility('Even'), 'Even');
  assert.equal(canonicalFacility('Even-EHRC'), 'Even');
  assert.equal(canonicalFacility(' Even-EHRC '), 'Even');
  assert.equal(canonicalFacility('Even-EHBR'), 'Even-EHBR');
  assert.equal(canonicalFacility(null), null);
  assert.equal(canonicalFacility(''), null);
  assert.equal(canonicalFacility(undefined), null);
  assert.equal(canonicalFacility('   '), null);
  assert.deepEqual(FACILITY_EHRC_ALIASES, ['Even', 'Even-EHRC']);
});

// ── rates ────────────────────────────────────────────────────────────────────────────────

test('computeRates: discharge buckets split across Even and Even-EHRC both count toward the Even denominator; a pair whose facility is Even-EHRC counts in the Even numerator; EHBR totals unchanged', () => {
  const discharges: DischargeBucket[] = [
    { facility: 'Even', day: '2026-01-10', department: 'Orthopedics', disposition: 'Normal Discharge', n: 60 },
    { facility: 'Even-EHRC', day: '2026-01-11', department: 'Orthopedics', disposition: 'Normal Discharge', n: 40 },
    { facility: 'Even-EHBR', day: '2026-01-10', department: 'Orthopedics', disposition: 'Normal Discharge', n: 25 },
  ];
  const pairs: RatePair[] = [
    { index_encounter_id: 'IP-1', index_day: '2026-01-10', gap_days: 3, index_department: 'Orthopedics', lane: 'tight_bounce', audit_status: 'audited', avoidable: 'justified', planned: 'unplanned', facility: 'Even-EHRC' },
    { index_encounter_id: 'IPNO-1', index_day: '2026-01-10', gap_days: 3, index_department: 'Orthopedics', lane: 'tight_bounce', audit_status: 'audited', avoidable: 'justified', planned: 'unplanned', facility: 'Even-EHBR' },
  ];
  const r = computeRates({ pairs, discharges, ceilingDay: '2026-08-19' });
  const ehrc = r.facilities.find((f) => f.facility === FACILITY_EHRC)!;
  const ehbr = r.facilities.find((f) => f.facility === FACILITY_EHBR)!;
  assert.equal(ehrc.denominators.eligible.d30, 100);        // 60 (Even) + 40 (Even-EHRC)
  assert.equal(ehrc.denominators.eligible.all30.numerator, 1);   // the Even-EHRC pair counts in the Even numerator
  assert.equal(ehbr.denominators.eligible.d30, 25);          // unchanged
  assert.equal(ehbr.denominators.eligible.all30.numerator, 1);
});

// ── incidence denominator SQL ───────────────────────────────────────────────────────────

test('incidenceDenominatorSql contains both Even and Even-EHRC', () => {
  const sql = incidenceDenominatorSql('2026-07-20');
  assert.match(sql, /facility_name IN \(/);
  assert.match(sql, /'Even'/);
  assert.match(sql, /'Even-EHRC'/);
});

// ── filter ───────────────────────────────────────────────────────────────────────────────

const f = (over: Partial<SurfaceFinding> = {}): SurfaceFinding => ({
  dedupKey: 'IP-1|IP-2', findingClass: 'even_even', lane: 'tight_bounce', auditStatus: 'audited',
  patientName: 'Asha Khan', uhid: 'UH-77812', ageGender: '58F', gapDays: 4,
  indexDepartment: 'Orthopaedics', readmitDepartment: 'General Surgery', indexDoctor: 'Dr R Menon', readmitDoctor: 'Dr S Iyer',
  indexDischargeAt: '2026-06-01T10:00:00+05:30', readmitAdmitAt: '2026-06-05T09:30:00+05:30',
  payerIndex: 'Even', payerReadmit: 'Even', cmNote: null,
  planned: 'unplanned', sameCondition: 'same', avoidable: 'needs_adjudication',
  labTier: 'tier1', labTimingProfile: null, nOmissions: 1,
  needsHumanReview: true, promotedToFull: false, notAuditableReason: null,
  finding: null, omissionEvidence: null, preventableInjury: 'suspected', negligence: 'unknown',
  indexCase: null, returnBill: null, caseLine: null,
  facility: null,
  ...over,
});

test('a row with raw facility Even-EHRC passes an Even hospital filter', () => {
  assert.equal(matchesFacility(f({ facility: 'Even-EHRC' }), 'Even'), true);
  assert.equal(matchesFacility(f({ facility: 'Even-EHRC' }), 'Even-EHBR'), false);
});

test('facilityOptions contains Even once and no Even-EHRC', () => {
  const opts = facilityOptions([f({ facility: 'Even' }), f({ facility: 'Even-EHRC' }), f({ facility: 'Even-EHBR' })]);
  assert.deepEqual(opts, ['Even', 'Even-EHBR']);
  assert.ok(!opts.includes('Even-EHRC'));
});
