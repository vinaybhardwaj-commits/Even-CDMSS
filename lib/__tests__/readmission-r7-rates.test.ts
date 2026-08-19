/**
 *   node --experimental-strip-types --test lib/__tests__/readmission-r7-rates.test.ts
 * R7 — the server seam: readRates with injected reads (fail-safe on either fault, ≤ 15-min cache keyed by
 * the IST ceiling day, computed-at stamp), the verbatim SQL shape, and returnContextOf over the surface
 * row (index extract + readmit extract + readmit-side OT ledger items) — Mohsin's three fixtures through
 * the route-side function. The R7 hard rules: the six prompt builders, the engine version, the badge
 * query text are unchanged (fingerprints pinned by the R4.1 / R4.3 suites; re-asserted here by import).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DENOMINATOR_SQL, NUMERATOR_SQL, RATES_CACHE_MS, _resetRatesCache, readRates } from '../readmission/rates.ts';
import { returnContextOf } from '../readmission/surface-row.ts';
import { READMIT_ENGINE_VERSION } from '../readmission/store.ts';
import type { SurfaceRow } from '../readmission/store.ts';
import type { DischargeBucket, RatePair } from '../readmission-rates-core.ts';

const pairs: RatePair[] = [{ index_encounter_id: 'IP-1', index_day: '2026-01-10', gap_days: 3, index_department: 'Orthopedics', lane: 'tight_bounce', audit_status: 'audited', avoidable: 'justified', planned: 'unplanned' }];
const discharges: DischargeBucket[] = [{ facility: 'Even', day: '2025-10-01', department: 'Orthopedics', disposition: 'Normal Discharge', n: 10 }, { facility: 'Even', day: '2026-01-10', department: 'Orthopedics', disposition: 'Normal Discharge', n: 90 }];

test('readRates: both reads ok → ok with computedAt + engine; numerators fault → ok:false numerators; denominators fault → ok:false denominators; never throws', async () => {
  _resetRatesCache();
  const now = new Date('2026-08-19T10:00:00Z');
  const r = await readRates({ now, numerators: async () => pairs, denominators: async () => discharges });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.computedAt, now.toISOString()); assert.equal(r.cached, false); assert.equal(r.engineVersion, READMIT_ENGINE_VERSION);
    assert.equal(r.rates.ceilingDay, '2026-08-19');
    assert.equal(r.rates.facilities[0].denominators.eligible.all30.numerator, 1);
    assert.equal(r.rates.facilities[0].denominators.eligible.d30, 100);
  }
  _resetRatesCache();
  const n = await readRates({ now, numerators: async () => null, denominators: async () => discharges });
  assert.deepEqual(n, { ok: false, reason: 'numerators', computedAt: now.toISOString() });
  const d = await readRates({ now, numerators: async () => pairs, denominators: async () => null });
  assert.deepEqual(d, { ok: false, reason: 'denominators', computedAt: now.toISOString() });
  const t = await readRates({ now, numerators: async () => { throw new Error('boom'); }, denominators: async () => discharges }).catch(() => 'threw');
  assert.notEqual(t, 'threw');
});

test('readRates cache: a second read inside 15 min is served cached with the FIRST computed-at; force bypasses; a new IST day or 15 min+ recomputes; a failed read is never cached', async () => {
  _resetRatesCache();
  let calls = 0;
  const num = async () => { calls++; return pairs; };
  const t0 = new Date('2026-08-19T10:00:00Z');
  const a = await readRates({ now: t0, numerators: num, denominators: async () => discharges });
  const b = await readRates({ now: new Date(t0.getTime() + 5 * 60_000), numerators: num, denominators: async () => discharges });
  assert.equal(calls, 1); assert.equal(b.ok && b.cached, true); assert.equal(b.ok && a.ok && b.computedAt === a.computedAt, true);
  const c = await readRates({ now: new Date(t0.getTime() + 5 * 60_000), force: true, numerators: num, denominators: async () => discharges });
  assert.equal(calls, 2); assert.equal(c.ok && c.cached, false);
  await readRates({ now: new Date(t0.getTime() + 5 * 60_000 + RATES_CACHE_MS + 1), numerators: num, denominators: async () => discharges });
  assert.equal(calls, 3);
  // IST day rollover (18:30 UTC) → the ceiling moves → recompute even inside 15 min
  await readRates({ now: new Date('2026-08-19T18:29:00Z'), numerators: num, denominators: async () => discharges });
  const before = calls;
  await readRates({ now: new Date('2026-08-19T18:31:00Z'), numerators: num, denominators: async () => discharges });
  assert.equal(calls, before + 1);
  _resetRatesCache();
  await readRates({ now: t0, numerators: async () => null, denominators: async () => discharges });
  const after = await readRates({ now: t0, numerators: num, denominators: async () => discharges });
  assert.equal(after.ok && after.cached, false);
});

test('the SQL, verbatim: numerators parameterised on the engine version and pinned to even_even; denominators grouped facility × IST day × department × disposition, PHI-free, from the surveillance start', () => {
  assert.match(NUMERATOR_SQL, /FROM readmission_findings/);
  assert.match(NUMERATOR_SQL, /engine_version = \$1 AND finding_class = 'even_even'/);
  assert.match(NUMERATOR_SQL, /AT TIME ZONE 'Asia\/Kolkata'/);
  assert.doesNotMatch(NUMERATOR_SQL, /uhid|patient|dedup_key|readmit_encounter_id/);
  assert.match(DENOMINATOR_SQL, /FROM kx_discharged_completed_patients/);
  assert.match(DENOMINATOR_SQL, /encounter_type = 'ip_admission'/);
  assert.match(DENOMINATOR_SQL, /discharge_date >= '2025-09-22'/);
  assert.match(DENOMINATOR_SQL, /treating_sub_department_name AS department/);
  assert.match(DENOMINATOR_SQL, /discharge_type_value AS disposition/);
  assert.match(DENOMINATOR_SQL, /GROUP BY 1, 2, 3, 4/);
  assert.doesNotMatch(DENOMINATOR_SQL, /patient_name|uhid|encounter_id|dob|mobile/);
});

// ── returnContextOf over the surface row ─────────────────────────────────────────────────

const row = (gap: number): SurfaceRow => ({ gap_days: gap } as unknown as SurfaceRow);
const ex = (o: Record<string, unknown>) => o as unknown as Parameters<typeof returnContextOf>[2];

test('returnContextOf: the three fixtures via the route-side function (index procedure / followUp / aftercare vs return procedure + readmit OT ledger)', () => {
  const stent = returnContextOf(row(15), null,
    ex({ procedure: 'LEFT URS+ BILATERAL RIRS + LASER LITHOTRIPSY + BILATERAL DJ STENTING UNDER SA on 25/06/2026.', followUp: 'Review after 5 days with Dr Sarat Chandra Das in OPD with prior appointment.', aftercare: { follow_up_detail: 'REVIEW AFTER 5 DAYS WITH DR SARAT CHANDRA DAS IN OPD WITH PRIOR APPOINTMENT' } }),
    ex({ procedure: 'Cystoscopy + Bilateral DJ stent removal under LA on 11/07/2026.' }));
  assert.deepEqual(stent, { immediate: false, staged: { matched: true, kind: 'device', anchor: 'stent' } });

  const tkr = returnContextOf(row(5), null,
    ex({ procedure: 'Bilateral Total Knee Replacement (TKR) was planned but not performed due to unforeseen technical constraints in the operation theatre.', followUp: 'Review in Orthopaedic OPD in 5 days or earlier if symptoms worsen. Surgery to be rescheduled.', aftercare: { follow_up_detail: 'Review in Orthopaedic OPD in 5days or earlier if symptoms worsen. Surgery will be rescheduled after appropriate planning.' } }),
    ex({ procedure: 'Left Total Knee Replacement with Medial Tibial Plateau Screw Fixation. Implants: FEMORAL COMPONENT - SIZE 3 LEFT, TIBIAL INSERT - SIZE 3-4 9MM, TIBIAL BASEPLATE - SIZE 3 LEFT, 1 TITANIUM SCREWS - 25MM.' }));
  assert.equal(tkr.immediate, false); assert.equal(tkr.staged.matched, true); assert.equal(tkr.staged.kind, 'deferred');

  const lrti = returnContextOf(row(11), null,
    ex({ procedure: 'Left Total Knee Replacement with Medial Tibial Plateau Screw Fixation. Implants: FEMORAL COMPONENT - SIZE 3 LEFT, TIBIAL INSERT - SIZE 3-4 9MM, TIBIAL BASEPLATE - SIZE 3 LEFT, 1 TITANIUM SCREWS - 25MM.', followUp: 'Review in Orthopaedic OPD after 10 days. Monitor renal function (Serum Creatinine). Plan for right knee surgery after 6 weeks.', aftercare: { follow_up_detail: 'Review in Orthopaedic OPD after 10 days. Monitor renal function (Serum Creatinine). Plan for right knee surgery after 6 weeks.' } }),
    ex({ procedure: 'OGD (Oesophago-gastro-duodenoscopy)' }));
  assert.deepEqual(lrti, { immediate: false, staged: { matched: false, kind: null, anchor: null } });
});

test('returnContextOf: readmit-side OT ledger items count as return procedure evidence; index-side OT items do not; no extracts → unmatched, immediate from the gap alone', () => {
  const blob = { evidenceLedger: { version: 'ledger/1', generatedAt: 'x', source: 'audit', items: [
    { id: 'R9', source: 'ot_note', side: 'readmit', at: null, weight: 'interested', text: 'OT note (return stay): surgery: Cystoscopy + DJ stent removal' },
    { id: 'IX9', source: 'ot_note', side: 'index', at: null, weight: 'interested', text: 'OT note (first stay): surgery: DJ stent removal' },
  ] } } as unknown as Parameters<typeof returnContextOf>[1];
  const a = returnContextOf(row(1), blob, ex({ procedure: 'Right URS + DJ stenting' }), null);
  assert.deepEqual(a, { immediate: true, staged: { matched: true, kind: 'device', anchor: 'stent' } });
  const b = returnContextOf(row(1), blob, null, null);
  assert.deepEqual(b, { immediate: true, staged: { matched: false, kind: null, anchor: null } });
  const c = returnContextOf(row(0), null, null, null);
  assert.equal(c.immediate, true); assert.equal(c.staged.matched, false);
});
