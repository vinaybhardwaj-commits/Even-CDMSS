/**
 *   node --experimental-strip-types --test lib/__tests__/readmission-detect-core.test.ts
 * Pure core: Stage-1 readmission detection (PRD §4/§4a/§11, decisions 5/8/12/13).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pairEncounters, computeTags, laneFor, detectReadmissions, reconcilePersons,
  pairDedupKey, oonDedupKey, EXCLUDED_DEPARTMENTS, ADT_COLUMN_CANDIDATES, resolveMappedCols,
  type KxEncounter, type FormReadmission,
} from '../readmission-detect-core.ts';

const enc = (o: Partial<KxEncounter> & { encounterId: string; admitAt: string }): KxEncounter => ({
  uhid: 'U1', encounterType: 'ip_admission', dischargeAt: null, admissionType: 'Elective',
  department: 'Urology', doctor: 'Dr A', payer: null, ...o,
});

// ── pairing (LEAD semantics) ────────────────────────────────────────────────────

test('pairs A→B→C into (A,B) and (B,C)', () => {
  const A = enc({ encounterId: 'IP-1', admitAt: '2026-01-01T10:00:00+05:30', dischargeAt: '2026-01-05T10:00:00+05:30' });
  const B = enc({ encounterId: 'IP-2', admitAt: '2026-01-20T10:00:00+05:30', dischargeAt: '2026-01-25T10:00:00+05:30' });
  const C = enc({ encounterId: 'IP-3', admitAt: '2026-02-10T10:00:00+05:30', dischargeAt: '2026-02-12T10:00:00+05:30' });
  const pairs = pairEncounters([C, A, B]);   // order-independent
  assert.equal(pairs.length, 2);
  assert.deepEqual(pairs.map((p) => [p.index.encounterId, p.readmit.encounterId]), [['IP-1', 'IP-2'], ['IP-2', 'IP-3']]);
});

test('no pair beyond 90 days; exactly 90 days is IN the window', () => {
  const A = enc({ encounterId: 'IP-1', admitAt: '2026-01-01T00:00:00Z', dischargeAt: '2026-01-02T00:00:00Z' });
  const late = enc({ encounterId: 'IP-2', admitAt: '2026-04-03T00:00:01Z' });   // 91d+1s after discharge
  assert.equal(pairEncounters([A, late]).length, 0);
  const at90 = enc({ encounterId: 'IP-3', admitAt: '2026-04-02T00:00:00Z' });   // exactly +90d
  assert.equal(pairEncounters([A, at90]).length, 1);
});

test('same-day / overlapping admissions never pair; ER encounters never pair', () => {
  const A = enc({ encounterId: 'IP-1', admitAt: '2026-01-01T00:00:00Z', dischargeAt: '2026-01-05T12:00:00Z' });
  const overlap = enc({ encounterId: 'IP-2', admitAt: '2026-01-05T12:00:00Z' });   // adm == disch
  assert.equal(pairEncounters([A, overlap]).length, 0);
  const er = enc({ encounterId: 'ER-9', admitAt: '2026-01-10T00:00:00Z', encounterType: 'er_admission' });
  assert.equal(pairEncounters([A, er]).length, 0);
});

// ── tags ────────────────────────────────────────────────────────────────────────

const mkPair = (gapDays: number, over: { idx?: Partial<KxEncounter>; rd?: Partial<KxEncounter> } = {}) => {
  const index = enc({ encounterId: 'IP-1', admitAt: '2026-01-01T00:00:00Z', dischargeAt: '2026-01-10T00:00:00Z', ...over.idx });
  const readmit = enc({
    encounterId: 'IP-2',
    admitAt: new Date(Date.parse('2026-01-10T00:00:00Z') + gapDays * 86_400_000).toISOString(),
    ...over.rd,
  });
  return { index, readmit };
};

test('tight_7d / within_30d boundaries', () => {
  assert.equal(computeTags(mkPair(7)).tight_7d, true);
  assert.equal(computeTags(mkPair(8)).tight_7d, false);
  assert.equal(computeTags(mkPair(30)).within_30d, true);
  assert.equal(computeTags(mkPair(31)).within_30d, false);
});

test('structural_bounce = same department OR same doctor', () => {
  const sameDept = computeTags(mkPair(20, { idx: { doctor: 'Dr A' }, rd: { doctor: 'Dr B' } }));
  assert.equal(sameDept.structural_bounce, true);
  const sameDoc = computeTags(mkPair(20, { idx: { department: 'Urology' }, rd: { department: 'General Surgery' } }));
  assert.equal(sameDoc.structural_bounce, true);
  const neither = computeTags(mkPair(20, { rd: { department: 'General Surgery', doctor: 'Dr B' } }));
  assert.equal(neither.structural_bounce, false);
});

test('er_route via admission_type Emergency and via an ER encounter within 48h', () => {
  assert.equal(computeTags(mkPair(10, { rd: { admissionType: 'Emergency' } })).er_route, true);
  const pair = mkPair(10);
  const erNear = enc({ encounterId: 'ER-1', encounterType: 'er_admission', admitAt: new Date(Date.parse(pair.readmit.admitAt) - 24 * 3_600_000).toISOString() });
  assert.equal(computeTags(pair, [erNear]).er_route, true);
  const erFar = enc({ encounterId: 'ER-2', encounterType: 'er_admission', admitAt: new Date(Date.parse(pair.readmit.admitAt) - 72 * 3_600_000).toISOString() });
  assert.equal(computeTags(pair, [erFar]).er_route, false);
});

test('excluded_category fires on EITHER side, exact live strings', () => {
  for (const dept of EXCLUDED_DEPARTMENTS) {
    assert.equal(computeTags(mkPair(10, { idx: { department: dept } })).excluded_category, true, dept);
    assert.equal(computeTags(mkPair(10, { rd: { department: dept } })).excluded_category, true, dept);
  }
  assert.equal(computeTags(mkPair(10)).excluded_category, false);
});

// ── lane precedence (first match wins) ──────────────────────────────────────────

test('lane precedence: excluded → er_routed → tight_bounce → structural_30d → other', () => {
  const all = { tight_7d: true, within_30d: true, structural_bounce: true, er_route: true, excluded_category: true };
  assert.equal(laneFor(all), 'excluded');
  assert.equal(laneFor({ ...all, excluded_category: false }), 'er_routed');
  assert.equal(laneFor({ ...all, excluded_category: false, er_route: false }), 'tight_bounce');
  assert.equal(laneFor({ tight_7d: false, within_30d: true, structural_bounce: true, er_route: false, excluded_category: false }), 'structural_30d');
  assert.equal(laneFor({ tight_7d: false, within_30d: true, structural_bounce: false, er_route: false, excluded_category: false }), 'other');
  // tight without structural is NOT a tight_bounce (both conditions required)
  assert.equal(laneFor({ tight_7d: true, within_30d: true, structural_bounce: false, er_route: false, excluded_category: false }), 'other');
});

// ── dedup keys ──────────────────────────────────────────────────────────────────

test('dedup keys: stable for the same pair, distinct for different pairs and classes', () => {
  assert.equal(pairDedupKey('IP-1', 'IP-2'), pairDedupKey('IP-1', 'IP-2'));
  assert.notEqual(pairDedupKey('IP-1', 'IP-2'), pairDedupKey('IP-2', 'IP-1'));
  assert.notEqual(pairDedupKey('IP-1', 'IP-2'), pairDedupKey('IP-1', 'IP-3'));
  assert.notEqual(oonDedupKey('IP-1', 'F-9'), pairDedupKey('IP-1', 'F-9'));
});

// ── duplicate-MRN reconcile ─────────────────────────────────────────────────────

test('duplicate-MRN reconcile fires only on name AND dob — never on a shared identifier alone', () => {
  const a = enc({ encounterId: 'IP-1', uhid: 'U1', admitAt: '2026-01-01T00:00:00Z', dischargeAt: '2026-01-03T00:00:00Z', patientName: 'Asha Rao', dob: '1980-01-01' });
  const b = enc({ encounterId: 'IP-2', uhid: 'U2', admitAt: '2026-01-10T00:00:00Z', patientName: 'Asha  Rao', dob: '1980-01-01' });
  const merged = reconcilePersons([a, b]);
  assert.equal(merged.get('U1'), merged.get('U2'));           // same person → cross-UHID pairing
  assert.equal(pairEncounters([a, b]).length, 1);

  // name matches, dob differs (the family-member trap): NEVER merged
  const c = enc({ encounterId: 'IP-3', uhid: 'U3', admitAt: '2026-01-10T00:00:00Z', patientName: 'Asha Rao', dob: '2005-06-06' });
  const noMerge = reconcilePersons([a, c]);
  assert.equal(noMerge.has('U3'), false);
  assert.equal(pairEncounters([a, c]).length, 0);

  // missing dob: no merge (both facts required)
  const d = enc({ encounterId: 'IP-4', uhid: 'U4', admitAt: '2026-01-10T00:00:00Z', patientName: 'Asha Rao', dob: null });
  assert.equal(reconcilePersons([a, d]).has('U4'), false);
});

// ── form detector union + dedup (decisions 12/13) ───────────────────────────────

const form = (o: Partial<FormReadmission> & { formUid: string }): FormReadmission => ({
  memberUid: 'M1', readmissionDate: null, eventType: null, isPlanned: null,
  sameCondition: null, notes: 'CM note text', uhids: ['U1'], ...o,
});

test('form within ±5d of a KX readmit dedupes into the pair and attaches the CM note', () => {
  const A = enc({ encounterId: 'IP-1', admitAt: '2026-01-01T00:00:00Z', dischargeAt: '2026-01-05T00:00:00Z' });
  const B = enc({ encounterId: 'IP-2', admitAt: '2026-01-20T00:00:00Z', dischargeAt: '2026-01-22T00:00:00Z' });
  const det = detectReadmissions([A, B], [form({ formUid: 'F-1', readmissionDate: '2026-01-23' })]);   // 3d off the KX admit
  assert.equal(det.pairs.length, 1);
  assert.equal(det.pairs[0].cmNote, 'CM note text');
  assert.equal(det.pairs[0].formUid, 'F-1');
  assert.equal(det.oon.length, 0);
  assert.equal(det.formStats.dedupedIntoPairs, 1);
});

test('form with an Even index stay but NO matching KX readmit is out-of-network, index-side', () => {
  const A = enc({ encounterId: 'IP-1', admitAt: '2026-01-01T00:00:00Z', dischargeAt: '2026-01-05T00:00:00Z' });
  const det = detectReadmissions([A], [form({ formUid: 'F-2', readmissionDate: '2026-02-01' })]);
  assert.equal(det.oon.length, 1);
  assert.equal(det.oon[0].index.encounterId, 'IP-1');
  assert.equal(det.oon[0].cmNote, 'CM note text');
  assert.equal(det.formStats.outOfNetwork, 1);
});

test('form patients with no Even IP stay are OUT of scope; blank readmission_date is counted, not audited', () => {
  const A = enc({ encounterId: 'IP-1', admitAt: '2026-01-01T00:00:00Z', dischargeAt: '2026-01-05T00:00:00Z' });
  const det = detectReadmissions([A], [
    form({ formUid: 'F-3', uhids: [] }),                                     // no Even stay
    form({ formUid: 'F-4', uhids: ['U-OTHER'] }),                            // uhid with no encounters
    form({ formUid: 'F-5', readmissionDate: null }),                         // no date
  ]);
  assert.equal(det.oon.length, 0);
  assert.equal(det.formStats.noEvenIpStay, 2);
  assert.equal(det.formStats.noReadmitDate, 1);
});

// ── ADT column mapping (the 5 Aug prod defect: zero lanes from a null discharge) ─
// Pins the fact the live bug taught us: the ADT discharge column is `discharge_date`,
// and it must win over the kx_discharge_summary_records-shaped names.

test('ADT mapping: discharge_date resolves FIRST; admission_date_time stays first', () => {
  assert.equal(ADT_COLUMN_CANDIDATES.dischargeAt[0], 'discharge_date');
  assert.equal(ADT_COLUMN_CANDIDATES.admitAt[0], 'admission_date_time');
  // Priority: a row carrying BOTH names maps to discharge_date, not the summary-table name.
  const both = [{ admission_date_time: '2026-01-01T00:00:00Z', discharge_date: '2026-01-05T00:00:00Z', discharge_date_time: '2026-01-06T00:00:00Z' }];
  assert.deepEqual(resolveMappedCols(both), { admission: 'admission_date_time', discharge: 'discharge_date' });
  // An unmapped field reports null — visible, never guessed.
  assert.deepEqual(resolveMappedCols([{ admission_date_time: 'x' }]), { admission: 'admission_date_time', discharge: null });
});

test('detectReadmissions lane counts + within-30 subset', () => {
  const A = enc({ encounterId: 'IP-1', admitAt: '2026-01-01T00:00:00Z', dischargeAt: '2026-01-05T00:00:00Z' });
  const B = enc({ encounterId: 'IP-2', admitAt: '2026-01-08T00:00:00Z', dischargeAt: '2026-01-09T00:00:00Z' });          // 3d gap, same dept+doctor → tight_bounce
  const C = enc({ encounterId: 'IP-3', uhid: 'U2', department: 'Oncology', admitAt: '2026-01-01T00:00:00Z', dischargeAt: '2026-01-04T00:00:00Z' });
  const D = enc({ encounterId: 'IP-4', uhid: 'U2', department: 'Oncology', admitAt: '2026-01-20T00:00:00Z' });           // excluded
  const det = detectReadmissions([A, B, C, D]);
  assert.equal(det.laneCounts.tight_bounce, 1);
  assert.equal(det.laneCounts.excluded, 1);
  assert.equal(det.within30, 2);
});
