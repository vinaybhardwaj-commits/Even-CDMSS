/**
 * Pure-core tests for the /care/readmissions surface logic
 * (CDMSS-READMISSION-PHASE-2-CARE-SURFACE-PRD v1.0 §5).
 *
 * Strip-types-safe: no extensionless imports, no DB, no React. Run with
 *   node --experimental-strip-types --test lib/__tests__/readmission-surface-core.test.ts
 *
 * The render itself is verified live on prod, not here. What IS pinned here is every
 * decision the surface makes that a screenshot would not catch: which lane a finding
 * lands in and in what order, which findings count as work, and what each label claims.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LANE_ORDER, badgesFor, careLine, computeTiles, confidenceBand, countReview,
  groupByLane, identityLine, isReviewFinding, laneRank, shortDate, sortWithinLane,
  tierBadge, verdictConfidence, verdictLabel,
  type SurfaceFinding,
} from '../readmission-surface-core.ts';

// A minimal audited finding; each test overrides only the fields it is about.
const f = (over: Partial<SurfaceFinding> = {}): SurfaceFinding => ({
  dedupKey: 'IP-1|IP-2', findingClass: 'even_even', lane: 'structural_30d', auditStatus: 'audited',
  patientName: null, uhid: 'UH-1', ageGender: null, gapDays: 5,
  indexDepartment: null, readmitDepartment: null, indexDoctor: null, readmitDoctor: null,
  indexDischargeAt: '2026-06-01T10:00:00+05:30', readmitAdmitAt: '2026-06-06T10:00:00+05:30',
  payerIndex: null, payerReadmit: null, cmNote: null,
  planned: 'unplanned', sameCondition: 'same', avoidable: 'justified',
  labTier: 'tier1', labTimingProfile: 'has_late_labs', nOmissions: 0,
  needsHumanReview: false, promotedToFull: false, notAuditableReason: null,
  finding: null, omissionEvidence: null,
  ...over,
});

// ── lane order ─────────────────────────────────────────────────────────────────

test('lanes render clearest-first, and an UNKNOWN lane never hides in the collapsed block', () => {
  assert.deepEqual([...LANE_ORDER], ['er_routed', 'tight_bounce', 'structural_30d', 'out_of_network', 'other', 'excluded']);
  const groups = groupByLane([
    f({ dedupKey: 'a', lane: 'excluded' }),
    f({ dedupKey: 'b', lane: 'structural_30d' }),
    f({ dedupKey: 'c', lane: 'er_routed' }),
    f({ dedupKey: 'd', lane: 'out_of_network', findingClass: 'out_of_network' }),
    f({ dedupKey: 'e', lane: 'tight_bounce' }),
    f({ dedupKey: 'g', lane: 'brand_new_lane' }),
  ]);
  assert.deepEqual(groups.map((g) => g.lane),
    ['er_routed', 'tight_bounce', 'structural_30d', 'out_of_network', 'brand_new_lane', 'excluded']);
  // A lane the detector grows tomorrow sorts BEFORE 'excluded', so it is visible work,
  // not something folded into the held-out sample nobody opens.
  assert.ok(laneRank('brand_new_lane') < laneRank('excluded'));
  assert.equal(groups.find((g) => g.lane === 'excluded')?.collapsed, true);
  // Empty lanes are omitted entirely — a header with nothing under it reads as a bug.
  assert.equal(groups.some((g) => g.rows.length === 0), false);
});

test('within a lane, needs_human_review comes first and then the most recent readmission', () => {
  const rows = [
    f({ dedupKey: 'old-flagged', needsHumanReview: true, readmitAdmitAt: '2026-01-02T00:00:00+05:30' }),
    f({ dedupKey: 'new-clear', needsHumanReview: false, readmitAdmitAt: '2026-07-30T00:00:00+05:30' }),
    f({ dedupKey: 'mid-clear', needsHumanReview: false, readmitAdmitAt: '2026-05-01T00:00:00+05:30' }),
    f({ dedupKey: 'new-flagged', needsHumanReview: true, readmitAdmitAt: '2026-07-31T00:00:00+05:30' }),
    f({ dedupKey: 'undated', needsHumanReview: false, readmitAdmitAt: null }),
  ];
  assert.deepEqual(sortWithinLane(rows).map((r) => r.dedupKey),
    ['new-flagged', 'old-flagged', 'new-clear', 'mid-clear', 'undated']);
  // The flag beats recency on purpose: an OLD finding the engine refused to decide
  // alone is still the one that needs a person, and it must not sink out of view.
  assert.equal(sortWithinLane(rows)[1].dedupKey, 'old-flagged');
});

// ── the review predicate ───────────────────────────────────────────────────────

test('the review count is audited AND (avoidable | needs_adjudication) — nothing else', () => {
  assert.equal(isReviewFinding({ auditStatus: 'audited', avoidable: 'avoidable' }), true);
  assert.equal(isReviewFinding({ auditStatus: 'audited', avoidable: 'needs_adjudication' }), true);
  assert.equal(isReviewFinding({ auditStatus: 'audited', avoidable: 'justified' }), false);
  assert.equal(isReviewFinding({ auditStatus: 'audited', avoidable: null }), false);
  // Still detected → not work yet, however alarming the verdict column looks. This is
  // the exact case where a badge could count a row the page cannot render.
  assert.equal(isReviewFinding({ auditStatus: 'detected', avoidable: 'avoidable' }), false);
  assert.equal(isReviewFinding({ auditStatus: 'not_auditable', avoidable: null }), false);
  assert.equal(countReview([
    f({ avoidable: 'avoidable' }), f({ avoidable: 'justified' }),
    f({ avoidable: 'needs_adjudication' }), f({ auditStatus: 'detected', avoidable: 'avoidable' }),
  ]), 2);
});

// ── verdicts + badges ──────────────────────────────────────────────────────────

test('out-of-network never shows an avoidable verdict, and not_auditable says why', () => {
  // Decision 13: we hold no record of the other hospital, so there is no verdict to
  // give — the label says what we DID judge (our own discharge) rather than blanking.
  const oon = verdictLabel({ findingClass: 'out_of_network', avoidable: null, auditStatus: 'audited' });
  assert.equal(oon.label, 'Our discharge: review');
  assert.equal(oon.sub, 'other hospital not audited');
  // Even if a future engine wrote one, the class wins — the scope is index-side only.
  assert.equal(verdictLabel({ findingClass: 'out_of_network', avoidable: 'avoidable', auditStatus: 'audited' }).label, 'Our discharge: review');
  assert.equal(verdictLabel({ findingClass: 'even_even', avoidable: 'avoidable', auditStatus: 'audited' }).label, 'Likely avoidable');
  assert.equal(verdictLabel({ findingClass: 'even_even', avoidable: 'justified', auditStatus: 'audited' }).sub, 'no review needed');
  assert.equal(verdictLabel({ findingClass: 'even_even', avoidable: null, auditStatus: 'not_auditable' }).label, 'Not auditable');
});

test('an excluded row says "Held out", never lane-D’s "No verdict"', () => {
  // Phase 2.1 decision 3. Excluded rows are never audited, so `avoidable` is null on all
  // of them — the branch has to fire on auditStatus, not on the empty verdict, or every
  // one of the 38 held-out cards reads as "we audited this and found nothing", which is
  // the opposite of what happened.
  const held = verdictLabel({ auditStatus: 'excluded', avoidable: null, findingClass: 'even_even' });
  assert.deepEqual(held, { label: 'Held out', sub: 'expected by design', tone: 'slate' });
  // The status wins over BOTH fall-throughs it sits in front of: the out-of-network
  // class label and any verdict a future engine might leave on an excluded row.
  assert.equal(verdictLabel({ auditStatus: 'excluded', avoidable: 'avoidable', findingClass: 'out_of_network' }).label, 'Held out');
  // And it does not steal the other unaudited label.
  assert.equal(verdictLabel({ auditStatus: 'not_auditable', avoidable: null, findingClass: 'even_even' }).label, 'Not auditable');
  assert.equal(verdictLabel({ auditStatus: 'audited', avoidable: null, findingClass: 'even_even' }).label, 'No verdict');
  // Excluded rows are not work: the review predicate must still refuse them.
  assert.equal(isReviewFinding({ auditStatus: 'excluded', avoidable: 'avoidable' }), false);
});

test('the held-out sample groups last and collapsed, with the audited lanes untouched', () => {
  const groups = groupByLane([
    f({ dedupKey: 'x1', lane: 'excluded', auditStatus: 'excluded', avoidable: null }),
    f({ dedupKey: 'a1', lane: 'er_routed' }),
    f({ dedupKey: 'n1', lane: 'structural_30d', auditStatus: 'not_auditable', avoidable: null }),
    f({ dedupKey: 'x2', lane: 'excluded', auditStatus: 'excluded', avoidable: null }),
    f({ dedupKey: 's1', lane: 'structural_30d' }),
  ]);
  assert.deepEqual(groups.map((g) => g.lane), ['er_routed', 'structural_30d', 'excluded']);
  const excluded = groups[groups.length - 1];
  assert.equal(excluded.collapsed, true);
  assert.equal(excluded.rows.length, 2);
  // not_auditable rows are NOT held out — they sit in their real lane, visible, where a
  // reviewer can see that a discharge could not be read at all.
  assert.equal(groups.find((g) => g.lane === 'structural_30d')?.rows.length, 2);
  assert.notEqual(groups.find((g) => g.lane === 'er_routed')?.collapsed, true);
});

test('tiles are blind to excluded rows — the route filters, and the filter is the contract', () => {
  // Guards the route-level `rows.filter(auditStatus === 'audited')`: computeTiles over the
  // audited subset must equal computeTiles over that subset with the excluded rows never
  // added. If these ever diverge, the rate people quote has silently changed basis.
  const audited = [
    f({ dedupKey: 'a', lane: 'er_routed', gapDays: 3 }),
    f({ dedupKey: 'b', lane: 'structural_30d', gapDays: 12 }),
    f({ dedupKey: 'c', lane: 'other', gapDays: 44 }),
    f({ dedupKey: 'd', lane: 'out_of_network', findingClass: 'out_of_network', gapDays: null }),
  ];
  const heldOut = [
    f({ dedupKey: 'x1', lane: 'excluded', auditStatus: 'excluded', avoidable: null, gapDays: 4 }),
    f({ dedupKey: 'x2', lane: 'excluded', auditStatus: 'excluded', avoidable: null, gapDays: 9 }),
  ];
  const all = [...audited, ...heldOut];
  assert.deepEqual(computeTiles(all.filter((r) => r.auditStatus === 'audited'), 200), computeTiles(audited, 200));
  // And the basis genuinely matters — feeding everything WOULD move two tiles, which is
  // exactly the mistake this filter exists to prevent.
  assert.notDeepEqual(computeTiles(all, 200), computeTiles(audited, 200));
  assert.equal(computeTiles(audited, 200).readmissionCount, 3);
  assert.equal(computeTiles(audited, 200).thirtyDayRate, 2 / 200);
});

test('a badge is omitted rather than guessed — unknown planned, ambiguous department, absent tier', () => {
  // 'unknown' planned is the reconcile rule refusing to call it planned; that is NOT
  // the same as unplanned, and the chip must not blur the two.
  assert.equal(badgesFor(f({ planned: 'unknown', sameCondition: 'unknown', labTier: null, gapDays: null })).length, 0);
  assert.equal(careLine('General Surgery')?.text, 'Surgical');
  assert.equal(careLine('Internal Medicine')?.text, 'Medical');
  assert.equal(careLine('Urology')?.text, 'Surgical');
  assert.equal(careLine('Nephrology')?.text, 'Medical');
  // Matches BOTH patterns → ambiguous → no chip. medical/surgical is not a stored flag
  // (PairTags has no such field), so a wrong chip here would be pure invention.
  assert.equal(careLine('Surgical Gastroenterology'), null);
  assert.equal(careLine('Day Care'), null);
  assert.equal(careLine(null), null);
  assert.equal(tierBadge('tier1')?.text, 'Lab-backed');
  assert.equal(tierBadge('tier2')?.text, 'Summary-only');
  assert.equal(tierBadge('tier9'), null);
});

test('the verdict chip never borrows another verdict’s confidence', () => {
  // No confidence is stored against the money verdict today, so the chip falls back to
  // the strength-of-evidence the schema DOES carry rather than showing a number that
  // describes `planned` or `sameCondition`.
  assert.deepEqual(verdictConfidence({ corroborationTrack: 'lab_corroborated' }), { text: 'lab-corroborated', tone: 'emerald' });
  assert.deepEqual(verdictConfidence({ corroborationTrack: 'prose_only' }), { text: 'prose only', tone: 'amber' });
  assert.equal(verdictConfidence({ planned: { confidence: 0.9 }, sameCondition: { confidence: 0.95 } }), null);
  assert.equal(verdictConfidence(null), null);
  // Forward-compatible: a real avoidable confidence renders as one.
  assert.equal(verdictConfidence({ avoidable: { confidence: 0.8 }, corroborationTrack: 'prose_only' })?.text, 'confidence high');
  assert.equal(confidenceBand(0.75), 'high');
  assert.equal(confidenceBand(0.5), 'medium');
  assert.equal(confidenceBand(0.2), 'low');
  for (const bad of [null, undefined, NaN, -0.1, 1.4, Infinity]) assert.equal(confidenceBand(bad as number), null);
});

// ── tiles + identity ───────────────────────────────────────────────────────────

test('the 30-day rate is null without a real denominator — never a rate over a guess', () => {
  const rows = [
    f({ lane: 'er_routed', gapDays: 3 }),
    f({ lane: 'structural_30d', gapDays: 20 }),
    f({ lane: 'other', gapDays: 61 }),                                     // outside 30d
    f({ lane: 'out_of_network', findingClass: 'out_of_network', gapDays: null }),
  ];
  const t = computeTiles(rows, 200);
  assert.equal(t.readmissionCount, 3);          // out-of-network is not an Even→Even pair
  assert.equal(t.inReviewLanes, 2);             // er_routed + structural_30d (Lanes A + B)
  assert.equal(t.outOfNetwork, 1);
  assert.equal(t.thirtyDayRate, 2 / 200);
  // A rate is a number people quote out loud. No denominator → no rate, and the tile
  // renders "—" instead of something that looks measured.
  for (const bad of [null, 0, -5]) assert.equal(computeTiles(rows, bad).thirtyDayRate, null);
});

test('a failed name join degrades to the UHID, never a blank card', () => {
  assert.equal(identityLine({ patientName: 'Pranjal M.', uhid: 'UH-9', ageGender: '34/M' }), 'Pranjal M. · UH-9 · 34/M');
  assert.equal(identityLine({ patientName: null, uhid: 'UH-9', ageGender: null }), 'UH-9');
  assert.equal(identityLine({ patientName: null, uhid: '  ', ageGender: null }), 'Unidentified patient');
  assert.equal(shortDate('2026-04-07T09:00:00+05:30'), '7 Apr');
  assert.equal(shortDate('2026-04-07 09:00:00'), '7 Apr');   // Postgres space-separated form
  assert.equal(shortDate('not a date'), null);
  assert.equal(shortDate(null), null);
});
