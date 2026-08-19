/**
 *   node --experimental-strip-types --test lib/__tests__/readmission-filter-core.test.ts
 * R5 (CDMSS Readmissions R5 PRD v1.0) — the pure search + filter core: multi-word AND search ·
 * verdict incl. "Not yet judged" · serious flags (only 'suspected' passes) · either-stay department ·
 * lane · null gap / date handling · R5-6 unknown-bill pass-through · URL round-trip incl. malformed
 * params · department options · chips · counter copy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyFilters, activeFilterChips, decodeFilters, departmentOptions, encodeFilters, hasActiveFilters, istDay, laneOptions,
  matchesDates, matchesDepartment, matchesFlags, matchesGap, matchesLane, matchesMinBill, matchesQuery, matchesVerdict, searchText, showingLine,
  EMPTY_FILTERS, GAP_PRESETS, VERDICTS, VERDICT_LABEL, type FilterState,
} from '../readmission-filter-core.ts';
import { LANE_META, type SurfaceFinding } from '../readmission-surface-core.ts';

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
  indexCase: { diagnosis: 'Fracture neck of femur (L)', indication: 'Displaced intracapsular fracture', procedure: 'Cemented hemiarthroplasty', age: 58, sex: 'F' },
  returnBill: { state: 'billed', netRs: 96450, lines: 38 },
  caseLine: 'She returned with a discharging wound.',
  ...over,
});
const st = (over: Partial<FilterState> = {}): FilterState => ({ ...EMPTY_FILTERS, ...over });

// ── search ─────────────────────────────────────────────────────────────────────────────

test('searchText joins the normative haystack (nulls contribute nothing) lower-cased; matchesQuery is case-insensitive substring, multi-word AND', () => {
  const hay = searchText(f());
  assert.match(hay, /asha khan · uh-77812 · dr r menon · dr s iyer · orthopaedics · general surgery · fracture neck of femur \(l\) · displaced intracapsular fracture · cemented hemiarthroplasty · she returned with a discharging wound\./);
  assert.equal(searchText(f({ patientName: null, uhid: null, indexDoctor: null, readmitDoctor: null, indexDepartment: null, readmitDepartment: null, indexCase: null, caseLine: null })), '');
  assert.equal(matchesQuery(f(), 'khan'), true);
  assert.equal(matchesQuery(f(), 'KHAN hemiarthro'), true);      // every token matches somewhere
  assert.equal(matchesQuery(f(), 'khan cardiology'), false);     // one token fails → no match
  assert.equal(matchesQuery(f(), '  '), true);
  assert.equal(matchesQuery(f({ patientName: null }), 'khan'), false);   // name join failed → the rest still searched
  assert.equal(matchesQuery(f({ patientName: null }), 'uh-77812'), true);
});

// ── judgement ──────────────────────────────────────────────────────────────────────────

test('verdict select: each stored verdict; "Not yet judged" keeps no-verdict cards; a specific verdict drops them', () => {
  for (const v of ['avoidable', 'needs_adjudication', 'justified'] as const) {
    assert.equal(matchesVerdict(f({ avoidable: v }), v), true);
    assert.equal(matchesVerdict(f({ avoidable: v }), 'none'), false);
    assert.equal(matchesVerdict(f({ avoidable: null }), v), false);
  }
  assert.equal(matchesVerdict(f({ avoidable: null, auditStatus: 'not_auditable' }), 'none'), true);
  assert.equal(matchesVerdict(f({ avoidable: null, auditStatus: 'excluded' }), 'none'), true);
  assert.equal(matchesVerdict(f({ avoidable: 'avoidable' }), 'justified'), false);
  assert.equal(matchesVerdict(f(), null), true);
  assert.deepEqual([...VERDICTS], ['avoidable', 'needs_adjudication', 'justified', 'none']);
  assert.equal(VERDICT_LABEL.none, 'Not yet judged');
});

test('serious flags (R5-8): only the exact string "suspected" on either judgement passes; unknown / not_suggested / null / junk fail', () => {
  assert.equal(matchesFlags(f({ preventableInjury: 'suspected', negligence: 'unknown' }), true), true);
  assert.equal(matchesFlags(f({ preventableInjury: 'unknown', negligence: 'suspected' }), true), true);
  assert.equal(matchesFlags(f({ preventableInjury: 'not_suggested', negligence: 'not_suggested' }), true), false);
  assert.equal(matchesFlags(f({ preventableInjury: 'unknown', negligence: 'unknown' }), true), false);
  assert.equal(matchesFlags(f({ preventableInjury: null, negligence: null }), true), false);
  assert.equal(matchesFlags(f({ preventableInjury: 'Suspected' as never, negligence: 'SUSPECTED' as never }), true), false);   // exact string only
  assert.equal(matchesFlags(f({ preventableInjury: null, negligence: null }), false), true);
});

// ── case type + department ─────────────────────────────────────────────────────────────

test('lane matches exactly; laneOptions reuse the board\'s own lane titles in LANE_ORDER; department matches EITHER stay case-insensitively (R5-5)', () => {
  assert.equal(matchesLane(f({ lane: 'tight_bounce' }), 'tight_bounce'), true);
  assert.equal(matchesLane(f({ lane: 'structural_30d' }), 'tight_bounce'), false);
  assert.equal(matchesLane(f(), null), true);
  assert.deepEqual(laneOptions().map((o) => o.label), ['er_routed', 'tight_bounce', 'structural_30d', 'out_of_network', 'other', 'excluded'].map((l) => LANE_META[l].title));
  assert.equal(matchesDepartment(f(), 'orthopaedics'), true);          // first stay
  assert.equal(matchesDepartment(f(), 'General Surgery'), true);       // return stay
  assert.equal(matchesDepartment(f(), ' general surgery '), true);
  assert.equal(matchesDepartment(f(), 'Cardiology'), false);
  assert.equal(matchesDepartment(f({ indexDepartment: null, readmitDepartment: null }), 'Orthopaedics'), false);
  assert.equal(matchesDepartment(f(), null), true);
  assert.deepEqual(departmentOptions([f(), f({ indexDepartment: 'general surgery', readmitDepartment: 'Cardiology' }), f({ indexDepartment: null, readmitDepartment: '  ' })]), ['Cardiology', 'General Surgery', 'Orthopaedics']);
});

// ── dates, gap, bill ───────────────────────────────────────────────────────────────────

test('gap presets (R5-7): gapDays <= n; null gap passes only Any', () => {
  assert.deepEqual([...GAP_PRESETS], [3, 7, 15, 30]);
  assert.equal(matchesGap(f({ gapDays: 4 }), 3), false);
  assert.equal(matchesGap(f({ gapDays: 4 }), 7), true);
  assert.equal(matchesGap(f({ gapDays: 7 }), 7), true);
  assert.equal(matchesGap(f({ gapDays: 30.4 }), 30), false);
  assert.equal(matchesGap(f({ gapDays: null }), 30), false);
  assert.equal(matchesGap(f({ gapDays: null }), null), true);
});

test('return-date range: IST calendar day of readmitAdmitAt, inclusive; null return date passes only with no date filter', () => {
  assert.equal(istDay('2026-06-05T09:30:00+05:30'), '2026-06-05');
  assert.equal(istDay('2026-06-04T20:00:00Z'), '2026-06-05');          // 01:30 IST next day
  assert.equal(istDay('2026-06-05 09:30:00'), '2026-06-05');
  assert.equal(istDay('junk'), null); assert.equal(istDay(null), null);
  assert.equal(matchesDates(f(), '2026-06-05', null), true);
  assert.equal(matchesDates(f(), '2026-06-06', null), false);
  assert.equal(matchesDates(f(), null, '2026-06-05'), true);
  assert.equal(matchesDates(f(), null, '2026-06-04'), false);
  assert.equal(matchesDates(f(), '2026-06-01', '2026-06-30'), true);
  assert.equal(matchesDates(f({ readmitAdmitAt: null }), null, null), true);
  assert.equal(matchesDates(f({ readmitAdmitAt: null }), '2026-06-01', null), false);
});

test('minimum bill (R5-6): billed passes when netRs >= min; not_finalised / unknown / na / no object ALWAYS pass', () => {
  assert.equal(matchesMinBill(f({ returnBill: { state: 'billed', netRs: 96450, lines: 38 } }), 50000), true);
  assert.equal(matchesMinBill(f({ returnBill: { state: 'billed', netRs: 96450, lines: 38 } }), 100000), false);
  assert.equal(matchesMinBill(f({ returnBill: { state: 'billed', netRs: 50000, lines: 1 } }), 50000), true);
  for (const state of ['not_finalised', 'unknown', 'na'] as const) assert.equal(matchesMinBill(f({ returnBill: { state, netRs: null, lines: null } }), 50000), true, state);
  assert.equal(matchesMinBill(f({ returnBill: null }), 50000), true);
  assert.equal(matchesMinBill(f({ returnBill: undefined }), 50000), true);
  assert.equal(matchesMinBill(f({ returnBill: { state: 'billed', netRs: 1, lines: 1 } }), null), true);
  assert.equal(matchesMinBill(f({ returnBill: { state: 'billed', netRs: 1, lines: 1 } }), 0), true);
});

// ── the one entry point — AND across groups ─────────────────────────────────────────────

test('applyFilters is AND across groups, preserves order, composes on whatever set it is given', () => {
  const rows = [
    f({ dedupKey: 'a', avoidable: 'avoidable', indexDepartment: 'Cardiology', gapDays: 2, returnBill: { state: 'billed', netRs: 120000, lines: 9 } }),
    f({ dedupKey: 'b', avoidable: 'avoidable', indexDepartment: 'Cardiology', gapDays: 12 }),                    // fails gap
    f({ dedupKey: 'c', avoidable: 'justified', indexDepartment: 'Cardiology', gapDays: 2 }),                     // fails verdict
    f({ dedupKey: 'd', avoidable: 'avoidable', indexDepartment: 'Orthopaedics', readmitDepartment: 'Cardiology', gapDays: 5, returnBill: { state: 'not_finalised', netRs: null, lines: null } }),   // either-stay dept, unfinalised bill passes
    f({ dedupKey: 'e', avoidable: 'avoidable', indexDepartment: 'Cardiology', gapDays: 3, returnBill: { state: 'billed', netRs: 10000, lines: 2 } }),   // fails min bill
  ];
  const out = applyFilters(rows, st({ verdict: 'avoidable', dept: 'cardiology', gap: 7, minBill: 50000 }));
  assert.deepEqual(out.map((r) => r.dedupKey), ['a', 'd']);
  assert.deepEqual(applyFilters(rows, EMPTY_FILTERS).map((r) => r.dedupKey), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(applyFilters(rows, st({ q: 'khan cardiology', flags: true })).map((r) => r.dedupKey), ['a', 'b', 'c', 'd', 'e']);   // all have Khan + Cardiology + pi suspected
  assert.deepEqual(applyFilters(rows, st({ q: 'nobody' })), []);
});

// ── URL round-trip (R5-4) ──────────────────────────────────────────────────────────────

test('encode/decode round-trip every param; absent = off; malformed values are ignored silently (bad shared link → unfiltered)', () => {
  const full = st({ q: 'khan  hemi', verdict: 'avoidable', flags: true, lane: 'tight_bounce', dept: 'General Surgery', gap: 7, from: '2026-06-01', to: '2026-06-30', minBill: 50000, held: true });
  const qs = encodeFilters(full);
  assert.equal(qs, 'q=khan++hemi&verdict=avoidable&flags=1&lane=tight_bounce&dept=General+Surgery&gap=7&from=2026-06-01&to=2026-06-30&minbill=50000&held=1');
  assert.deepEqual(decodeFilters(new URLSearchParams(qs)), { ...full, q: 'khan hemi' });
  assert.deepEqual(decodeFilters(new URLSearchParams('')), EMPTY_FILTERS);
  assert.deepEqual(decodeFilters(null), EMPTY_FILTERS);
  assert.equal(encodeFilters(EMPTY_FILTERS), '');
  // malformed / unknown values → that filter off, nothing throws
  const bad = decodeFilters(new URLSearchParams('verdict=bogus&flags=yes&lane=nope&gap=5&from=2026-13-40&to=yesterday&minbill=-3&held=true&q=ok'));
  assert.deepEqual(bad, { ...EMPTY_FILTERS, q: 'ok' });
  assert.deepEqual(decodeFilters(new URLSearchParams('minbill=abc&gap=7x')), EMPTY_FILTERS);
  assert.deepEqual(decodeFilters({ q: ['first', 'second'], verdict: 'justified' }), { ...EMPTY_FILTERS, q: 'first', verdict: 'justified' });
  // an over-long q is clipped, not rejected
  assert.equal(decodeFilters(new URLSearchParams(`q=${'a'.repeat(300)}`)).q.length, 200);
});

// ── toolbar helpers ─────────────────────────────────────────────────────────────────────

test('hasActiveFilters ignores the held-out checkbox; chips in toolbar order with plain labels; counter copy', () => {
  assert.equal(hasActiveFilters(EMPTY_FILTERS), false);
  assert.equal(hasActiveFilters(st({ held: true })), false);
  assert.equal(hasActiveFilters(st({ q: ' ' })), false);
  assert.equal(hasActiveFilters(st({ minBill: 1 })), true);
  const chips = activeFilterChips(st({ q: 'khan', verdict: 'needs_adjudication', flags: true, lane: 'structural_30d', dept: 'Cardiology', gap: 15, from: '2026-06-01', minBill: 50000 }));
  assert.deepEqual(chips.map((c) => [c.key, c.label]), [
    ['q', 'search “khan”'], ['verdict', 'Needs adjudication'], ['flags', 'Serious flags only'], ['lane', LANE_META.structural_30d.title],
    ['dept', 'Cardiology'], ['gap', 'gap ≤ 15 days'], ['from', 'returned from 2026-06-01'], ['minBill', 'bill ≥ ₹50,000'],
  ]);
  assert.equal(activeFilterChips(st({ to: '2026-06-30' }))[0].label, 'returned to 2026-06-30');
  assert.equal(showingLine(3, 54), 'showing 3 of 54 cases');
  assert.equal(showingLine(1, 1), 'showing 1 of 1 case');
});
