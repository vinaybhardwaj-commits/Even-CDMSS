/**
 *   node --experimental-strip-types --test lib/__tests__/readmission-rates-core.test.ts
 * R7 (CDMSS Readmissions R7 PRD v1.0) — the pure rates core: Wilson CI against the report's worked
 * example (65 / 1,185 → 4.33 – 6.93) · three denominators incl. the understates tag · monthly cohorts
 * with censoring · the EHBR gate (first FULL month + 30 d) · held-out split via the detector's
 * EXCLUDED_DEPARTMENTS · immediate-return predicate · judgement stats with `condition-pass only` ·
 * the staged-return matcher on Mohsin's three fixtures (IPNO-31|IPNO-196 marked, IP-713|IP-740 marked,
 * IP-740|IP-827 NOT marked) · no identifiers in the payload shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONDITION_PASS_ONLY_LABEL, DEFAULT_DENOMINATOR, DENOMINATOR_WARNING, DENOMINATORS, FACILITY_EHBR, FACILITY_EHRC, IMMEDIATE_RETURN_COPY,
  PROPOSED_AVOIDABLE_SUBLINE, STAGED_RETURN_COPY, SURVEILLANCE_START, TRUE_IPD_EXCLUDED_DISPOSITIONS, addDays, computeRates, facilityOfEncounter,
  isHeldOutDepartment, isImmediateReturn, istDay, lastDayOfMonth, monthsBetween, nextMonth, returnContext, stagedReturnMatch, wilsonCi,
  type DischargeBucket, type RatePair,
} from '../readmission-rates-core.ts';
import { EXCLUDED_DEPARTMENTS } from '../readmission-detect-core.ts';

// ── Wilson CI: the report's worked example ───────────────────────────────────────────────

test('wilsonCi reproduces the report: 65 / 1,185 → 4.33 – 6.93 %; 0 / n → 0 – x; n = 0 → null', () => {
  assert.deepEqual(wilsonCi(65, 1185), { lo: 4.33, hi: 6.93 });
  assert.deepEqual(wilsonCi(45, 1088), { lo: 3.11, hi: 5.49 });
  const z = wilsonCi(0, 50)!;
  assert.equal(z.lo, 0); assert.ok(z.hi > 0 && z.hi < 10);
  assert.equal(wilsonCi(3, 0), null);
  assert.equal(wilsonCi(-1, 10), null);
  assert.equal(wilsonCi(11, 10), null);
});

// ── calendar helpers ─────────────────────────────────────────────────────────────────────

test('istDay / addDays / lastDayOfMonth / monthsBetween / nextMonth', () => {
  assert.equal(istDay('2026-08-18T19:30:00Z'), '2026-08-19');            // 01:00 IST next day
  assert.equal(istDay('2026-08-18T18:29:59Z'), '2026-08-18');
  assert.equal(istDay('2026-08-18 10:00:00+05:30'), '2026-08-18');
  assert.equal(istDay(null), null); assert.equal(istDay('junk'), null);
  assert.equal(addDays('2026-08-18', -30), '2026-07-19');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(lastDayOfMonth('2026-02'), '2026-02-28');
  assert.equal(lastDayOfMonth('2025-12'), '2025-12-31');
  assert.deepEqual(monthsBetween('2025-11', '2026-02'), ['2025-11', '2025-12', '2026-01', '2026-02']);
  assert.equal(nextMonth('2025-12'), '2026-01'); assert.equal(nextMonth('2026-06'), '2026-07');
});

test('facilityOfEncounter: R6 name wins; IP- → Even; IPNO-/ADM → Even-EHBR; unknown → null', () => {
  assert.equal(facilityOfEncounter('IP-713'), FACILITY_EHRC);
  assert.equal(facilityOfEncounter('IPNO-31'), FACILITY_EHBR);
  assert.equal(facilityOfEncounter('ADM-9'), FACILITY_EHBR);
  assert.equal(facilityOfEncounter('IP-713', 'Even-EHBR'), FACILITY_EHBR);
  assert.equal(facilityOfEncounter('IP-713', 'Somewhere'), FACILITY_EHRC);
  assert.equal(facilityOfEncounter('XYZ-1'), null);
  assert.equal(facilityOfEncounter(null), null);
});

test('isHeldOutDepartment reuses the detector set exactly (no redeclaration)', () => {
  for (const d of EXCLUDED_DEPARTMENTS) assert.equal(isHeldOutDepartment(d), true);
  assert.equal(isHeldOutDepartment(' Nephrology '), true);
  assert.equal(isHeldOutDepartment('Orthopedics'), false);
  assert.equal(isHeldOutDepartment('oncology'), false);   // exact strings, as the detector
  assert.equal(isHeldOutDepartment(null), false);
});

test('isImmediateReturn: gap ≤ 1 only', () => {
  assert.equal(isImmediateReturn(0), true); assert.equal(isImmediateReturn(1), true);
  assert.equal(isImmediateReturn(2), false); assert.equal(isImmediateReturn(null), false); assert.equal(isImmediateReturn(NaN), false);
  assert.equal(IMMEDIATE_RETURN_COPY, 'Immediate return — possible transfer or deferred surgery');
  assert.equal(STAGED_RETURN_COPY, 'possible planned staged return — the index follow-up mentions this procedure');
});

// ── computeRates: a small synthetic world ────────────────────────────────────────────────

const CEILING = '2026-08-18';
const b = (over: Partial<DischargeBucket>): DischargeBucket => ({ facility: FACILITY_EHRC, day: '2026-01-10', department: 'Orthopedics', disposition: 'Normal Discharge', n: 1, ...over });
const p = (over: Partial<RatePair>): RatePair => ({ index_encounter_id: 'IP-1', index_day: '2026-01-10', gap_days: 5, index_department: 'Orthopedics', lane: 'tight_bounce', audit_status: 'audited', avoidable: 'justified', planned: 'unplanned', ...over });

const discharges: DischargeBucket[] = [
  b({ day: '2025-09-10', n: 50 }),                                           // before surveillance start → ignored
  b({ day: '2025-10-05', n: 100 }),
  b({ day: '2025-10-05', department: 'Nephrology', n: 10 }),                 // held-out
  b({ day: '2025-10-20', disposition: 'DAMA', n: 4 }),                       // true-IPD exclusion
  b({ day: '2025-10-21', disposition: 'Expired', n: 1 }),                    // true-IPD exclusion
  b({ day: '2025-10-22', disposition: 'Discharge On Request', n: 2 }),       // NOT excluded
  b({ day: '2026-07-18', n: 30 }),                                           // last eligible-30 day (ceiling − 30 = 2026-07-19) → inside
  b({ day: '2026-07-20', n: 20 }),                                           // outside eligible-30, inside all_in_window
  b({ day: '2026-08-18', n: 5 }),                                            // ceiling day → all_in_window only
  b({ facility: FACILITY_EHBR, day: '2026-06-20', n: 7 }),                   // EHBR starts mid-June
  b({ facility: FACILITY_EHBR, day: '2026-07-15', n: 40 }),
];
const pairs: RatePair[] = [
  p({ index_encounter_id: 'IP-1', index_day: '2025-10-05', gap_days: 5 }),
  p({ index_encounter_id: 'IP-2', index_day: '2025-10-05', gap_days: 1, avoidable: 'avoidable' }),         // immediate + proposed avoidable
  p({ index_encounter_id: 'IP-3', index_day: '2025-10-05', gap_days: 45 }),                               // 90-day only
  p({ index_encounter_id: 'IP-4', index_day: '2025-10-05', gap_days: 3, index_department: 'Nephrology', audit_status: 'excluded', avoidable: null }), // held-out
  p({ index_encounter_id: 'IP-5', index_day: '2026-07-20', gap_days: 2, audit_status: 'audited', lane: 'other', avoidable: null }),   // outside eligible-30 window; condition-pass only
  p({ index_encounter_id: 'IP-6', index_day: '2025-09-01', gap_days: 2 }),                                // before surveillance start → not counted
  p({ index_encounter_id: 'IP-7', index_day: '2026-01-10', gap_days: 10, audit_status: 'audited', lane: 'tight_bounce', avoidable: null }), // true "no judgement"
  p({ index_encounter_id: 'IPNO-31', index_day: '2026-06-26', gap_days: 15, avoidable: 'needs_adjudication' }),
];

test('computeRates: three denominators per facility; eligible default; all_in_window tagged understates; true_ipd removes the five dispositions only', () => {
  const r = computeRates({ pairs, discharges, ceilingDay: CEILING });
  assert.equal(r.ceilingDay, CEILING); assert.equal(r.surveillanceStart, SURVEILLANCE_START);
  const ehrc = r.facilities.find((f) => f.facility === FACILITY_EHRC)!;
  const e = ehrc.denominators.eligible, t = ehrc.denominators.true_ipd, a = ehrc.denominators.all_in_window;
  // eligible-30: 100 + 10 + 4 + 1 + 2 + 30 = 147 (ceiling − 30 = 2026-07-19 inclusive; 07-20 excluded)
  assert.equal(e.d30, 147); assert.equal(e.d30_held_out, 10); assert.equal(e.d30_reviewable, 137);
  // true IPD: minus DAMA 4 + Expired 1 = 142 ('Discharge On Request' stays)
  assert.equal(t.d30, 142);
  // all in window: + 20 + 5 = 172
  assert.equal(a.d30, 172);
  assert.equal(DEFAULT_DENOMINATOR, 'eligible');
  assert.deepEqual(DENOMINATORS, ['eligible', 'true_ipd', 'all_in_window']);
  assert.equal(a.warning, 'understates — recent discharges lack 30d follow-up');
  assert.equal(e.warning, null); assert.equal(t.warning, null);
  assert.equal(DENOMINATOR_WARNING.all_in_window, a.warning);
  assert.deepEqual([...TRUE_IPD_EXCLUDED_DISPOSITIONS], ['DAMA', 'LAMA', 'Expired', 'Mortuary', 'Admitted Dead']);
});

test('computeRates: numerators — 30d / 90d / reviewable vs held-out / immediate / proposed-avoidable; pairs before the start or after the window edge are not counted', () => {
  const r = computeRates({ pairs, discharges, ceilingDay: CEILING });
  const e = r.facilities.find((f) => f.facility === FACILITY_EHRC)!.denominators.eligible;
  // 30-day pairs in eligible window: IP-1 (5), IP-2 (1), IP-4 (3, held-out) — IP-3 gap 45 out, IP-5 outside window, IP-6 before start, IP-7 gap 10 in ✓
  assert.equal(e.all30.numerator, 4); assert.equal(e.all30.denominator, 147);
  assert.equal(e.reviewable30.numerator, 3); assert.equal(e.reviewable30.denominator, 137);
  assert.equal(e.heldOut30.numerator, 1); assert.equal(e.heldOut30.denominator, 10);
  assert.equal(e.all30.rate, 2.72); assert.deepEqual(e.all30.ci, wilsonCi(4, 147));
  // 90-day: window end = ceiling − 90 = 2026-05-20 → IP-1, IP-2, IP-3 (45), IP-4, IP-7 = 5 of (100+10+4+1+2) = 117
  assert.equal(e.d90, 117); assert.equal(e.all90.numerator, 5); assert.equal(e.reviewable90.numerator, 4); assert.equal(e.d90_reviewable, 107);
  // immediate (gap ≤ 1) in the 30-day window: IP-2 only
  assert.equal(e.immediate.numerator, 1); assert.equal(e.immediate.denominator, 147);
  // proposed avoidable: IP-2
  assert.equal(e.proposedAvoidable.numerator, 1);
  assert.equal(PROPOSED_AVOIDABLE_SUBLINE, "agent's proposal · adjudication pending · advisory");
  // all_in_window numerator adds IP-5 (07-20, gap 2)
  const a = r.facilities.find((f) => f.facility === FACILITY_EHRC)!.denominators.all_in_window;
  assert.equal(a.all30.numerator, 5); assert.equal(a.all30.denominator, 172);
});

test('computeRates: monthly cohorts (IST index month) — complete = month end + 30 ≤ ceiling; incomplete months carry counts but null rates (censored); pre-start discharges excluded', () => {
  const r = computeRates({ pairs, discharges, ceilingDay: CEILING });
  const ehrc = r.facilities.find((f) => f.facility === FACILITY_EHRC)!;
  const months = ehrc.months;
  assert.equal(months[0].month, '2025-10');                                   // first discharge month at/after the surveillance start (09-10 is before the 22nd → excluded)
  const r9 = computeRates({ pairs: [], discharges: [b({ day: '2025-09-25', n: 2 })], ceilingDay: CEILING });
  assert.equal(r9.facilities[0].months[0].month, '2025-09');                  // a discharge on/after the 22nd anchors the surveillance month
  assert.equal(months[months.length - 1].month, '2026-08');
  const oct = months.find((m) => m.month === '2025-10')!;
  assert.equal(oct.complete, true); assert.equal(oct.discharges, 117); assert.equal(oct.discharges_held_out, 10); assert.equal(oct.returns30, 3); assert.equal(oct.returns30_held_out, 1);
  assert.equal(oct.rate30, 2.56); assert.equal(oct.rate30_reviewable, Math.round((2 / 107) * 10_000) / 100); assert.equal(oct.rate30_held_out, 10);
  const jul = months.find((m) => m.month === '2026-07')!;
  assert.equal(jul.complete, false);                                           // 2026-07-31 + 30 = 08-30 > ceiling
  assert.equal(jul.discharges, 50); assert.equal(jul.returns30, 1); assert.equal(jul.rate30, null); assert.equal(jul.rate30_reviewable, null);
  const jun = months.find((m) => m.month === '2026-06')!;
  assert.equal(jun.complete, true);                                            // 06-30 + 30 = 07-30 ≤ ceiling
});

test('computeRates: EHBR gate — first FULL month (Jul 2026) completes 30-day follow-up on 30 Aug → counts only at ceiling 2026-08-18; opens at 2026-08-30; EHRC open (first full month Oct 2025)', () => {
  const r = computeRates({ pairs, discharges, ceilingDay: CEILING });
  const ehbr = r.facilities.find((f) => f.facility === FACILITY_EHBR)!;
  assert.equal(ehbr.gate.firstDischargeDay, '2026-06-20');
  assert.equal(ehbr.gate.firstFullMonth, '2026-07');
  assert.equal(ehbr.gate.opensOn, '2026-08-30');
  assert.equal(ehbr.ratesAllowed, false);
  assert.match(ehbr.gate.reason!, /counts only/);
  assert.equal(ehbr.pairs, 1);                                                 // IPNO-31 counted by prefix
  assert.equal(ehbr.denominators.eligible.all30.numerator, 1); assert.equal(ehbr.denominators.eligible.d30, 47);   // 06-20 (7) + 07-15 (40), both ≤ ceiling − 30
  const later = computeRates({ pairs, discharges, ceilingDay: '2026-08-30' });
  assert.equal(later.facilities.find((f) => f.facility === FACILITY_EHBR)!.ratesAllowed, true);
  const ehrc = r.facilities.find((f) => f.facility === FACILITY_EHRC)!;
  assert.equal(ehrc.gate.firstDischargeDay, '2025-10-05');                     // pre-start days ignored
  assert.equal(ehrc.gate.firstFullMonth, '2025-11'); assert.equal(ehrc.ratesAllowed, true); assert.equal(ehrc.gate.reason, null);
  // a facility whose first discharge is the 1st: that month IS the first full month
  const r2 = computeRates({ pairs: [], discharges: [b({ facility: FACILITY_EHBR, day: '2026-06-01', n: 3 })], ceilingDay: '2026-07-30' });
  const g = r2.facilities.find((f) => f.facility === FACILITY_EHBR)!.gate;
  assert.equal(g.firstFullMonth, '2026-06'); assert.equal(g.opensOn, '2026-07-30');
  assert.equal(r2.facilities.find((f) => f.facility === FACILITY_EHBR)!.ratesAllowed, true);
  // no discharges at all → no gate, rates not allowed, nothing throws
  const r3 = computeRates({ pairs: [], discharges: [], ceilingDay: CEILING });
  for (const f of r3.facilities) { assert.equal(f.ratesAllowed, false); assert.equal(f.gate.opensOn, null); assert.equal(f.denominators.eligible.all30.rate, null); }
});

test('computeRates: judgement stats — condition-pass only (lane other, null avoidable) is labelled and kept apart from a true no-judgement; statuses tallied; gap distribution', () => {
  const r = computeRates({ pairs, discharges, ceilingDay: CEILING });
  const j = r.facilities.find((f) => f.facility === FACILITY_EHRC)!.judgements;
  assert.equal(j.audited, 6);                                                  // IP-1,2,3,5,6,7 (IP-4 excluded)
  assert.equal(j.justified, 3); assert.equal(j.avoidable, 1); assert.equal(j.needs_adjudication, 0);
  assert.equal(j.condition_pass_only, 1);                                      // IP-5
  assert.equal(j.no_judgement, 1);                                             // IP-7
  assert.equal(j.held_out_detected, 1); assert.equal(j.not_auditable, 0); assert.equal(j.pending, 0);
  assert.equal(CONDITION_PASS_ONLY_LABEL, 'condition-pass only');
  const g = r.facilities.find((f) => f.facility === FACILITY_EHRC)!.gapDistribution;
  assert.deepEqual(g, { d0_1: 1, d2_7: 4, d8_30: 1, d31_90: 1 });
});

test('computeRates payload carries aggregates only — no encounter ids, names, UHIDs or doc ids', () => {
  const r = computeRates({ pairs, discharges, ceilingDay: CEILING });
  const s = JSON.stringify(r);
  assert.doesNotMatch(s, /IP-\d|IPNO-|dedup|uhid|patient|encounter/i);
});

// ── R7-6 staged-return matcher: Mohsin's three fixtures (texts captured live 19 Aug 2026) ──────

const IPNO31_INDEX = [
  'LEFT URS+ BILATERAL RIRS + LASER LITHOTRIPSY + BILATERAL DJ STENTING UNDER SA on 25/06/2026.',
  'Review after 5 days with Dr Sarat Chandra Das in OPD with prior appointment.',
  'REVIEW AFTER 5 DAYS WITH DR SARAT CHANDRA DAS IN OPD WITH PRIOR APPOINTMENT',
];
const IPNO196_RETURN = ['Cystoscopy + Bilateral DJ stent removal under LA on 11/07/2026.'];

const IP713_INDEX = [
  'Bilateral Total Knee Replacement (TKR) was planned but not performed due to unforeseen technical constraints in the operation theatre.',
  'Review in Orthopaedic OPD in 5 days or earlier if symptoms worsen. Surgery to be rescheduled.',
  'Review in Orthopaedic OPD in 5days or earlier if symptoms worsen. Surgery will be rescheduled after appropriate planning.',
];
const IP740_RETURN = ['Left Total Knee Replacement with Medial Tibial Plateau Screw Fixation. Implants: FEMORAL COMPONENT - SIZE 3 LEFT, TIBIAL INSERT - SIZE 3-4 9MM, TIBIAL BASEPLATE - SIZE 3 LEFT, 1 TITANIUM SCREWS - 25MM.'];

const IP740_INDEX = [
  'Left Total Knee Replacement with Medial Tibial Plateau Screw Fixation. Implants: FEMORAL COMPONENT - SIZE 3 LEFT, TIBIAL INSERT - SIZE 3-4 9MM, TIBIAL BASEPLATE - SIZE 3 LEFT, 1 TITANIUM SCREWS - 25MM.',
  'Review in Orthopaedic OPD after 10 days. Monitor renal function (Serum Creatinine). Plan for right knee surgery after 6 weeks.',
  'Review in Orthopaedic OPD after 10 days. Monitor renal function (Serum Creatinine). Plan for right knee surgery after 6 weeks.',
];
const IP827_RETURN = ['OGD (Oesophago-gastro-duodenoscopy)'];

test('fixture IPNO-31|IPNO-196: DJ stenting → DJ stent removal — device-stage match → staged marker', () => {
  const m = stagedReturnMatch(IPNO31_INDEX, IPNO196_RETURN);
  assert.equal(m.matched, true); assert.equal(m.kind, 'device'); assert.equal(m.anchor, 'stent');
  const ctx = returnContext({ gapDays: 15, indexTexts: IPNO31_INDEX, returnTexts: IPNO196_RETURN });
  assert.equal(ctx.immediate, false); assert.equal(ctx.staged.matched, true);
});

test('fixture IP-713|IP-740: TKR planned-not-performed, "surgery to be rescheduled" → TKR — deferred match → staged marker; gap 5 is not immediate', () => {
  const m = stagedReturnMatch(IP713_INDEX, IP740_RETURN);
  assert.equal(m.matched, true); assert.equal(m.kind, 'deferred');
  assert.match(m.anchor!, /knee|replacement/);
  const ctx = returnContext({ gapDays: 5, indexTexts: IP713_INDEX, returnTexts: IP740_RETURN });
  assert.equal(ctx.immediate, false); assert.equal(ctx.staged.matched, true);
});

test('fixture IP-740|IP-827: TKR → OGD for an LRTI — NOT a staged return (no device act, no shared procedure term) even though the index plans a right-knee surgery', () => {
  const m = stagedReturnMatch(IP740_INDEX, IP827_RETURN);
  assert.deepEqual(m, { matched: false, kind: null, anchor: null });
  assert.equal(returnContext({ gapDays: 11, indexTexts: IP740_INDEX, returnTexts: IP827_RETURN }).staged.matched, false);
});

test('stagedReturnMatch: empty sides never match; a return procedure that merely repeats a device word without a removal act does not match; deferral cue without a shared term does not match', () => {
  assert.equal(stagedReturnMatch([], IPNO196_RETURN).matched, false);
  assert.equal(stagedReturnMatch(IPNO31_INDEX, [null, '']).matched, false);
  assert.equal(stagedReturnMatch(['DJ stenting done'], ['Cystoscopy with stent in situ, biopsy taken']).matched, false);
  assert.equal(stagedReturnMatch(['Hernia repair deferred; to be rescheduled'], ['Cystoscopy']).matched, false);
  assert.equal(stagedReturnMatch(['Hernia repair deferred; to be rescheduled'], ['Open inguinal hernia repair']).matched, true);
  assert.equal(stagedReturnMatch(['ORIF with K-wire fixation; K-wire removal after 4 weeks'], ['K-wire removal under LA']).kind, 'device');
});

// ── view model ───────────────────────────────────────────────────────────────────────────

import { computedAtLabel, fmtCi, fmtPct, judgementStatsLine, moduleFacility, rateCards, returnContextLines, trendBars } from '../readmission-rates-core.ts';

test('rateCards: five cards; rates as % with CI when allowed; counts-only "n / d" when the gate is closed; fifth card carries the advisory sub-line', () => {
  const r = computeRates({ pairs, discharges, ceilingDay: CEILING });
  const ehrc = r.facilities.find((f) => f.facility === FACILITY_EHRC)!;
  const cards = rateCards(ehrc, 'eligible');
  assert.equal(cards.length, 5);
  assert.deepEqual(cards.map((c) => c.key), ['all30', 'reviewable30', 'all90', 'immediate', 'proposedAvoidable']);
  assert.equal(cards[0].big, '2.72%'); assert.match(cards[0].sub, /^4 of 147 discharges$/); assert.match(cards[0].ci, /^\d+\.\d{2}–\d+\.\d{2}%$/);
  assert.match(cards[1].sub, /held-out 1\/10 \(10\.00%\)/);
  assert.equal(cards[4].advisory, PROPOSED_AVOIDABLE_SUBLINE); assert.equal(cards[4].tone, 'advisory'); assert.equal(cards[4].big, '1');
  const ehbr = r.facilities.find((f) => f.facility === FACILITY_EHBR)!;
  const closed = rateCards(ehbr, 'eligible');
  assert.equal(closed[0].big, '1 / 47'); assert.match(closed[0].sub, /^counts only/); assert.equal(closed[0].ci, '');
  assert.equal(fmtPct(null), '—'); assert.equal(fmtPct(5.6), '5.60%'); assert.equal(fmtCi(null), ''); assert.equal(fmtCi({ lo: 4.33, hi: 6.93 }), '4.33–6.93%');
});

test('trendBars: complete months split reviewable / held-out (stacking to the all-cause rate); incomplete months are ghosts with counts in the hover; gate closed → all ghosts', () => {
  const r = computeRates({ pairs, discharges, ceilingDay: CEILING });
  const bars = trendBars(r.facilities.find((f) => f.facility === FACILITY_EHRC)!);
  const oct = bars.find((b) => b.month === '2025-10')!;
  assert.equal(oct.label, 'Oct 25'); assert.equal(oct.complete, true);
  assert.equal(Math.round(((oct.reviewablePct ?? 0) + (oct.heldOutPct ?? 0)) * 100) / 100, 2.56);
  assert.match(oct.title, /3 of 117 \(2\.56%\) — reviewable 2 .* held-out 1/);
  const jul = bars.find((b) => b.month === '2026-07')!;
  assert.equal(jul.reviewablePct, null); assert.match(jul.title, /1 of 50 so far — 30-day follow-up not complete, no rate/);
  const ehbrBars = trendBars(r.facilities.find((f) => f.facility === FACILITY_EHBR)!);
  assert.ok(ehbrBars.length > 0); assert.ok(ehbrBars.every((b) => b.reviewablePct == null));
});

test('moduleFacility: the R6 hospital wins, then the tab, then the first facility with discharges; judgementStatsLine labels condition-pass only; computedAtLabel prints IST', () => {
  const r = computeRates({ pairs, discharges, ceilingDay: CEILING });
  assert.equal(moduleFacility(r, 'Even-EHBR', 'Even')!.facility, 'Even-EHBR');
  assert.equal(moduleFacility(r, null, 'Even-EHBR')!.facility, 'Even-EHBR');
  assert.equal(moduleFacility(r, 'Nowhere', null)!.facility, 'Even');
  assert.equal(judgementStatsLine(r.facilities[0].judgements), '6 audited: justified 3 · needs adjudication 0 · proposed avoidable 1 · condition-pass only 1 · no judgement 1');
  assert.doesNotMatch(judgementStatsLine({ ...r.facilities[0].judgements, no_judgement: 0 }), /no judgement/);
  assert.equal(computedAtLabel('2026-08-19T14:09:19.856Z'), 'computed 2026-08-19 19:39 IST');
  assert.equal(computedAtLabel(null), '');
});

test('returnContextLines: exact copy, immediate first, nothing for a null context', () => {
  assert.deepEqual(returnContextLines(null), []);
  assert.deepEqual(returnContextLines({ immediate: true, staged: { matched: true, kind: 'device', anchor: 'stent' } }).map((l) => l.text), [IMMEDIATE_RETURN_COPY, STAGED_RETURN_COPY]);
  assert.deepEqual(returnContextLines({ immediate: false, staged: { matched: false, kind: null, anchor: null } }), []);
});
