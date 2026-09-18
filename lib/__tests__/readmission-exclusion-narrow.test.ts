/**
 *   node --experimental-strip-types --test lib/__tests__/readmission-exclusion-narrow.test.ts
 * READMIT-EXCLUSION-NARROW (18 Sep 2026, V's ruling): gynaecological surgery is audited like any
 * other surgery — only OBSTETRIC care stays excluded (isObstetricStay: Maternity admission type OR
 * an obstetric ward hint) — and any muted return within TIGHT_BOUNCE_OVERRIDE_DAYS (7) is audited
 * whatever its department (tight_bounce beats excluded). Rates must not move: EXCLUDED_DEPARTMENTS
 * (and therefore lib/readmission-rates-core.ts's isHeldOutDepartment / the held-out bar split) keeps
 * its six strings, ObGyn included — the narrowing lives in isExcludedDept's ObGyn special case, not
 * in the array rates-core reuses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  computeTags, laneFor, pairEncounters, pairDedupKey, isObstetricStay,
  OBSTETRIC_ADMISSION_TYPES, OBSTETRIC_WARD_HINTS, TIGHT_BOUNCE_OVERRIDE_DAYS, EXCLUDED_DEPARTMENTS,
  type KxEncounter,
} from '../readmission-detect-core.ts';
import {
  computeRates, rateCards, trendBars, recentStripLine, DENOMINATORS, DEFAULT_DENOMINATOR, FACILITY_EHRC,
  type DischargeBucket, type RatePair,
} from '../readmission-rates-core.ts';

const enc = (o: Partial<KxEncounter> & { encounterId: string; admitAt: string }): KxEncounter => ({
  uhid: 'U1', encounterType: 'ip_admission', dischargeAt: null, admissionType: 'Elective',
  department: 'Obstetrics and Gynecology', doctor: 'Dr A', payer: null, ward: null, ...o,
});

// ── isObstetricStay ──────────────────────────────────────────────────────────────

test('isObstetricStay: Maternity admission type, an obstetric ward, plain gynae, wrong department, case/whitespace', () => {
  assert.equal(OBSTETRIC_ADMISSION_TYPES.length, 1);
  assert.equal(OBSTETRIC_ADMISSION_TYPES[0], 'Maternity');
  assert.deepEqual([...OBSTETRIC_WARD_HINTS], ['birthday suite', 'labour', 'labor', 'ldr']);
  assert.equal(TIGHT_BOUNCE_OVERRIDE_DAYS, 7);

  // Maternity admission type → true
  assert.equal(isObstetricStay({ department: 'Obstetrics and Gynecology', admissionType: 'Maternity', ward: null }), true);
  // BirthDay Suite ward → true, even with a non-Maternity admission type
  assert.equal(isObstetricStay({ department: 'Obstetrics and Gynecology', admissionType: 'Elective', ward: 'BirthDay Suite' }), true);
  // Elective gynae in a private ward → false
  assert.equal(isObstetricStay({ department: 'Obstetrics and Gynecology', admissionType: 'Elective', ward: 'Private Ward 3' }), false);
  assert.equal(isObstetricStay({ department: 'Obstetrics and Gynecology', admissionType: 'Day Care', ward: null }), false);
  // a non-ObGyn department with a Maternity type → false (department gates everything)
  assert.equal(isObstetricStay({ department: 'General Surgery', admissionType: 'Maternity', ward: null }), false);
  // case and whitespace variants
  assert.equal(isObstetricStay({ department: '  obstetrics AND gynecology  ', admissionType: ' MATERNITY ', ward: null }), true);
  assert.equal(isObstetricStay({ department: 'Obstetrics and Gynecology', admissionType: null, ward: '  LABOUR Ward  ' }), true);
  assert.equal(isObstetricStay({ department: 'Obstetrics and Gynecology', admissionType: null, ward: 'LDR-2' }), true);
  assert.equal(isObstetricStay({ department: 'Obstetrics and Gynecology', admissionType: null, ward: null }), false);
});

// ── gynae vs obstetric lane outcomes ────────────────────────────────────────────

test('a gynae index pair with a 20-day gap is auditable, not excluded', () => {
  const index = enc({ encounterId: 'IP-1', admitAt: '2026-01-01T00:00:00Z', dischargeAt: '2026-01-10T00:00:00Z', admissionType: 'Elective' });
  const readmit = enc({ encounterId: 'IP-2', admitAt: '2026-01-30T00:00:00Z', admissionType: 'Elective' });
  const tags = computeTags({ index, readmit });
  assert.equal(tags.excluded_category, false);
  assert.notEqual(laneFor(tags), 'excluded');
});

test('an obstetric index pair with a 20-day gap is excluded', () => {
  const index = enc({ encounterId: 'IP-1', admitAt: '2026-01-01T00:00:00Z', dischargeAt: '2026-01-10T00:00:00Z', admissionType: 'Maternity' });
  const readmit = enc({ encounterId: 'IP-2', admitAt: '2026-01-30T00:00:00Z', admissionType: 'Elective' });
  const tags = computeTags({ index, readmit });
  assert.equal(tags.excluded_category, true);
  assert.equal(laneFor(tags), 'excluded');
});

test('an oncology pair at 3 days is auditable (excluded_category still true, tight_bounce override); at 30 days it is excluded', () => {
  const index = enc({ encounterId: 'IP-1', admitAt: '2026-01-01T00:00:00Z', dischargeAt: '2026-01-10T00:00:00Z', department: 'Oncology', doctor: 'Dr B' });
  const near = enc({ encounterId: 'IP-2', admitAt: '2026-01-13T00:00:00Z', department: 'Oncology', doctor: 'Dr B' });
  const far = enc({ encounterId: 'IP-3', admitAt: '2026-02-09T00:00:00Z', department: 'Oncology', doctor: 'Dr B' });

  const tagsNear = computeTags({ index, readmit: near });
  assert.equal(tagsNear.excluded_category, true);
  assert.equal(laneFor(tagsNear), 'tight_bounce');

  const tagsFar = computeTags({ index, readmit: far });
  assert.equal(tagsFar.excluded_category, true);
  assert.equal(laneFor(tagsFar), 'excluded');
});

// ── the real case: UHID-10441, IP-1535 → IP-1555 ────────────────────────────────

test('the real case: IP-1535 → IP-1555, gap 1, ObGyn, Elective → auditable, tags unchanged, dedup key IP-1535|IP-1555', () => {
  const index = enc({
    encounterId: 'IP-1535', uhid: 'UHID-10441', admissionType: 'Elective',
    doctor: 'Dr Nivedita Jha', admitAt: '2026-09-01T10:00:00+05:30', dischargeAt: '2026-09-03T10:00:00+05:30',
  });
  const readmit = enc({
    encounterId: 'IP-1555', uhid: 'UHID-10441', admissionType: 'Elective',
    doctor: 'Dr Nivedita Jha', admitAt: '2026-09-04T22:22:00+05:30', dischargeAt: '2026-09-08T12:00:00+05:30',
  });
  const [pair] = pairEncounters([index, readmit]);
  assert.ok(pair, 'IP-1535 and IP-1555 must pair');
  assert.equal(pair.gapDays, 1);

  const tags = computeTags(pair);
  assert.equal(tags.excluded_category, false);   // no longer muted — Elective, no obstetric signal
  assert.equal(tags.tight_7d, true);
  assert.equal(tags.within_30d, true);
  assert.equal(tags.structural_bounce, true);    // same department AND same doctor
  assert.equal(laneFor(tags), 'tight_bounce');

  assert.equal(pairDedupKey(pair.index.encounterId, pair.readmit.encounterId), 'IP-1535|IP-1555');
});

// ── saveDetection: the re-queue CASE expression (source pin, no live DB in this sandbox) ────

const store = readFileSync(join(process.cwd(), 'lib/readmission/store.ts'), 'utf8');

test('saveDetection SQL re-queues excluded → detected on an auditable lane, keeps a re-excluded row excluded, and never touches audited / not_auditable', () => {
  assert.match(
    store,
    /audit_status = CASE\s*\n\s*WHEN readmission_findings\.audit_status IN \('audited', 'not_auditable'\) THEN readmission_findings\.audit_status\s*\n\s*WHEN EXCLUDED\.lane = 'excluded' THEN 'excluded'\s*\n\s*WHEN readmission_findings\.audit_status = 'excluded' THEN 'detected'\s*\n\s*ELSE readmission_findings\.audit_status\s*\n\s*END/,
  );
});

// ── rates guard: the five headline cards, the recent strip and the trend bars must not move ────

const CEILING = '2026-08-18';
const b = (over: Partial<DischargeBucket>): DischargeBucket => ({ facility: FACILITY_EHRC, day: '2026-01-10', department: 'Orthopedics', disposition: 'Normal Discharge', n: 1, ...over });
const p = (over: Partial<RatePair>): RatePair => ({ index_encounter_id: 'IP-1', index_day: '2026-01-10', gap_days: 5, index_department: 'Orthopedics', lane: 'tight_bounce', audit_status: 'audited', avoidable: 'justified', planned: 'unplanned', ...over });

const baseDischarges: DischargeBucket[] = [
  b({ day: '2025-10-05', n: 100 }),
  b({ day: '2026-07-18', n: 30 }),
];
const basePairs: RatePair[] = [
  p({ index_encounter_id: 'IP-10', index_day: '2026-01-10', gap_days: 5 }),
];
const obgynDischarge: DischargeBucket = b({ day: '2026-01-05', department: 'Obstetrics and Gynecology', n: 1 });

function runRates(obgynPair: RatePair) {
  return computeRates({
    pairs: [...basePairs, obgynPair],
    discharges: [...baseDischarges, obgynDischarge],
    ceilingDay: CEILING,
  });
}

test('rates guard: an ObGyn pair moving from excluded/excluded to tight_bounce/detected does not move the five headline cards, the recent strip, or the trend bars', () => {
  assert.ok(EXCLUDED_DEPARTMENTS.includes('Obstetrics and Gynecology'));   // the array rates-core reuses is untouched

  const before = runRates(p({
    index_encounter_id: 'IP-OB', index_day: '2026-01-05', gap_days: 1, index_department: 'Obstetrics and Gynecology',
    lane: 'excluded', audit_status: 'excluded', avoidable: null,
  }));
  const after = runRates(p({
    index_encounter_id: 'IP-OB', index_day: '2026-01-05', gap_days: 1, index_department: 'Obstetrics and Gynecology',
    lane: 'tight_bounce', audit_status: 'detected', avoidable: null,
  }));

  const facB = before.facilities.find((f) => f.facility === FACILITY_EHRC)!;
  const facA = after.facilities.find((f) => f.facility === FACILITY_EHRC)!;
  assert.ok(facB && facA);

  for (const key of DENOMINATORS) {
    const dB = facB.denominators[key], dA = facA.denominators[key];
    const five = (d: typeof dB) => ({ all30: d.all30, reviewable30: d.reviewable30, heldOut30: d.heldOut30, all90: d.all90, reviewable90: d.reviewable90 });
    assert.deepEqual(five(dA), five(dB), `denominator ${key} moved`);
  }
  assert.deepEqual(rateCards(facA, DEFAULT_DENOMINATOR), rateCards(facB, DEFAULT_DENOMINATOR));
  assert.deepEqual(trendBars(facA), trendBars(facB));
  assert.deepEqual(facA.recent, facB.recent);
  assert.equal(recentStripLine(facA.recent, facA.ratesAllowed), recentStripLine(facB.recent, facB.ratesAllowed));
});
