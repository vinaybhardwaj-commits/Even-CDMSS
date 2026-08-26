/**
 *   node --test --import tsx lib/__tests__/preop-surface-core.test.ts
 *
 * B4 — every judgement the board and the case page make, and the gate wiring that keeps
 * the surface dark. The components carry no judgement of their own; if a decision is not
 * tested here, it is not made anywhere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildBands, computeTiles, daysToSurgery, degradedStrip, denseLine, identityLine,
  isReviewed, longDate, pacBanner, pacChip, provenanceChip, reviewState, shortDate,
  whenText, PAC_BANNER_ABSENT, PAC_REPORT_LAG_HOURS, PROVENANCE_CHIPS,
  type PreopCardRow,
} from '../preop-surface-core.ts';
import { computeCharlson, computeMfi5, computeRcri, charlsonCategories } from '../preop-instruments-core.ts';

const src = (p: string) => readFileSync(p, 'utf8');

const row = (over: Partial<PreopCardRow> = {}): PreopCardRow => ({
  episodeKey: 'SC-1', patientName: 'Test Patient', uhid: 'UHID-1', age: 61, sex: 'FEMALE',
  procedure: 'Total knee replacement', hospital: 'EHRC', surgeryDate: '2026-09-01',
  tier: 'AMBER',
  rcri: computeRcri({ highRiskSurgery: 'absent', ischaemicHeartDisease: 'absent', congestiveHeartFailure: 'absent', cerebrovascularDisease: 'absent', insulinTreatedDiabetes: 'absent', creatinineOver2: 'absent' }),
  mfi5: computeMfi5({ functionalStatusDependent: 'absent', diabetesMellitus: 'absent', copdOrPneumonia: 'absent', congestiveHeartFailure: 'absent', hypertensionOnMedication: 'absent' }),
  charlson: computeCharlson({ age: 61, categories: charlsonCategories({}) }),
  needsReview: false, bookingOnly: false, whyLine: null, missingLine: null, situationLine: null,
  versionNo: 1, reviewedAt: null, reviewedBy: null, reviewedVersion: null, computedAt: '2026-08-26T08:30:00Z',
  pacOnFile: false, pacStatus: null, pacFinalizedAt: null, pacVerdict: null,
  pacWorkflowStatus: null, pacWorkflowLoggedAt: null,
  ...over,
});

// ── delta 3 · identity (A1-4) ──────────────────────────────────────────────────

test('a card is NEVER anonymous — the fallback chain always yields a name', () => {
  assert.equal(identityLine(row()).name, 'Test Patient');
  assert.equal(identityLine(row()).sub, 'UHID-1 · 61 F');
  // display_name is empty across this entire cohort, so the UHID has to carry it.
  assert.equal(identityLine(row({ patientName: null })).name, 'UHID-1');
  assert.equal(identityLine(row({ patientName: '   ' })).name, 'UHID-1');
  // ...and if even that is gone, the episode itself identifies the card.
  assert.equal(identityLine(row({ patientName: null, uhid: null })).name, 'Episode SC-1');
  assert.equal(identityLine(row({ patientName: null, uhid: null, age: null, sex: null })).sub, '');
});

// ── delta 2 · the PAC dual-fact chip (A1-3) ────────────────────────────────────

const NOW = '2026-08-26T12:00:00Z';

test('a bridged final report is the ONLY state that renders a tick', () => {
  const c = pacChip(row({ pacOnFile: true, pacStatus: 'final', pacFinalizedAt: '2026-08-24T00:00:00Z' }), NOW);
  assert.equal(c.state, 'final');
  assert.equal(c.text, 'PAC ✓ final · 24 Aug');
  assert.equal(c.tone, 'ok');
});

test('a completed workflow inside the lag window says the report is EXPECTED, not present', () => {
  const c = pacChip(row({ pacWorkflowStatus: 'COMPLETED', pacWorkflowLoggedAt: '2026-08-26T00:00:00Z' }), NOW);
  assert.equal(c.state, 'expected');
  assert.equal(c.text, 'PAC marked complete — report expected');
  assert.equal(c.tone, 'muted');
  assert.ok(!c.text.includes('✓'), 'a workflow status must never render as a tick');
});

test('past the lag window it becomes an amber data-quality signal', () => {
  const c = pacChip(row({ pacWorkflowStatus: 'COMPLETED', pacWorkflowLoggedAt: '2026-08-23T00:00:00Z' }), NOW);
  assert.equal(c.state, 'missing');
  assert.equal(c.text, 'PAC marked complete 3d ago — no report on file');
  assert.equal(c.tone, 'warn');
  // The boundary itself is the ratified 48 hours.
  assert.equal(PAC_REPORT_LAG_HOURS, 48);
  const atBoundary = pacChip(row({ pacWorkflowStatus: 'COMPLETED', pacWorkflowLoggedAt: '2026-08-24T12:00:00Z' }), NOW);
  assert.equal(atBoundary.state, 'expected');
});

test('every other case is "PAC — none", including PENDING and an unknown logged-at', () => {
  assert.equal(pacChip(row({ pacWorkflowStatus: 'PENDING' }), NOW).state, 'none');
  assert.equal(pacChip(row(), NOW).state, 'none');
  // COMPLETED with no timestamp cannot be aged, so it stays in the muted state rather
  // than being accused of being a gap.
  assert.equal(pacChip(row({ pacWorkflowStatus: 'COMPLETED', pacWorkflowLoggedAt: null }), NOW).state, 'expected');
});

// ── delta 1 · five provenance chips (A1-2) ─────────────────────────────────────

test('there are five provenance chips, and only EXTRACTED is the model boundary', () => {
  assert.deepEqual(Object.keys(PROVENANCE_CHIPS).sort(), ['BOOKING', 'EXTRACTED', 'LAB', 'OPD', 'PAC']);
  assert.equal(PROVENANCE_CHIPS.OPD.label, 'OPD · ICD-10');
  assert.equal(PROVENANCE_CHIPS.OPD.model, false, 'an ICD code has no model near it');
  assert.equal(PROVENANCE_CHIPS.EXTRACTED.model, true);
  assert.ok(Object.values(PROVENANCE_CHIPS).every((c) => c.label.trim().length > 0), 'colour never carries meaning alone');
  assert.equal(provenanceChip('nope'), null);
  assert.equal(provenanceChip(null), null);
});

// ── delta 5 · the degraded strip ───────────────────────────────────────────────

test('the degraded strip appears only when a source actually fell over', () => {
  assert.equal(degradedStrip([]), null);
  assert.equal(degradedStrip(null), null);
  assert.equal(degradedStrip(undefined), null);
  const s = degradedStrip(['individuals-prescriptions']);
  assert.ok(s?.startsWith('sources degraded at last sweep — coverage shown is a floor'));
  assert.ok(s?.includes('individuals-prescriptions'));
});

// ── the bands ──────────────────────────────────────────────────────────────────

test('the needs-review band is pinned on top and CLAIMS its cases', () => {
  const rows = [
    row({ episodeKey: 'a', tier: 'RED', needsReview: true, surgeryDate: '2026-09-02' }),
    row({ episodeKey: 'b', tier: 'RED', needsReview: false, surgeryDate: '2026-09-03' }),
    row({ episodeKey: 'c', tier: 'GREEN', surgeryDate: '2026-09-01' }),
  ];
  const bands = buildBands(rows);
  assert.equal(bands[0].key, 'needs_review');
  assert.equal(bands[0].rows.length, 1);
  assert.equal(bands[0].dense, false);
  // ...and 'a' is NOT also listed under RED — every case appears exactly once.
  const red = bands.find((b) => b.key === 'RED');
  assert.deepEqual(red?.rows.map((r) => r.episodeKey), ['b']);
  const all = bands.flatMap((b) => b.rows.map((r) => r.episodeKey));
  assert.equal(new Set(all).size, all.length);
  // GREEN collapses to dense rows; nothing else does.
  assert.equal(bands.find((b) => b.key === 'GREEN')?.dense, true);
  assert.equal(red?.dense, false);
});

test('bands order CRITICAL → RED → AMBER → GREEN, and cases sort by surgery date', () => {
  const rows = [
    row({ episodeKey: 'g', tier: 'GREEN' }), row({ episodeKey: 'c', tier: 'CRITICAL' }),
    row({ episodeKey: 'a', tier: 'AMBER' }), row({ episodeKey: 'r', tier: 'RED' }),
  ];
  assert.deepEqual(buildBands(rows).map((b) => b.key), ['CRITICAL', 'RED', 'AMBER', 'GREEN']);
  const dated = buildBands([
    row({ episodeKey: 'late', tier: 'AMBER', surgeryDate: '2026-09-10' }),
    row({ episodeKey: 'soon', tier: 'AMBER', surgeryDate: '2026-08-28' }),
  ]);
  assert.deepEqual(dated[0].rows.map((r) => r.episodeKey), ['soon', 'late']);
});

test('a row the engine has not tiered yet is shown, never dropped', () => {
  const bands = buildBands([row({ episodeKey: 'x', tier: null })]);
  assert.equal(bands.length, 1);
  assert.equal(bands[0].rows.length, 1);
  assert.match(bands[0].title, /not yet computed/i);
});

test('an empty board produces no bands at all — the page renders its empty state', () => {
  assert.deepEqual(buildBands([]), []);
});

// ── the tiles ──────────────────────────────────────────────────────────────────

test('the tiles are computed from the SAME rows the bands render', () => {
  const rows = [
    row({ episodeKey: 'a', needsReview: true, pacOnFile: false, bookingOnly: true }),
    row({ episodeKey: 'b', needsReview: false, pacOnFile: true, bookingOnly: false }),
    row({ episodeKey: 'c', needsReview: true, pacOnFile: false, bookingOnly: false }),
  ];
  const t = computeTiles(rows);
  assert.deepEqual(t.map((x) => x.v), ['3', '2', '2', '1']);
  assert.equal(t[2].s, 'of 3 upcoming');
  // Zeroes render as zeroes; the board is never blank (mockup §4).
  assert.deepEqual(computeTiles([]).map((x) => x.v), ['0', '0', '0', '0']);
});

// ── review, per snapshot version (mockup note 7) ───────────────────────────────

test('a review stands only for the version it was given for', () => {
  assert.equal(isReviewed(row({ versionNo: 3, reviewedVersion: 3 })), true);
  assert.equal(isReviewed(row({ versionNo: 4, reviewedVersion: 3 })), false);
  assert.equal(isReviewed(row({ versionNo: 1, reviewedVersion: null })), false);
  const reopened = reviewState(row({ versionNo: 4, reviewedVersion: 3 }));
  assert.equal(reopened.reviewed, false);
  assert.equal(reopened.reopened, true);
  assert.match(reopened.label, /re-opened by a new snapshot/i);
  assert.match(reviewState(row({ versionNo: 2, reviewedVersion: 2, reviewedBy: 'asha' })).label, /Reviewed · asha/);
});

// ── the PAC banner ─────────────────────────────────────────────────────────────

test('the anaesthetist is quoted verbatim, and orders are not dressed up as a verdict', () => {
  const fit = pacBanner(row({ pacOnFile: true, pacStatus: 'final', pacVerdict: 'PATIENT CAN BE TAKEN FOR SURGERY', pacFinalizedAt: '2026-08-24T00:00:00Z' }));
  assert.equal(fit.tone, 'quoted');
  assert.equal(fit.text, 'PATIENT CAN BE TAKEN FOR SURGERY');
  assert.equal(fit.caveat, null);
  assert.match(fit.label, /KareXpert, 24 Aug, final/);

  // The common production case: the conclusion box holds orders.
  const orders = pacBanner(row({ pacOnFile: true, pacStatus: 'final', pacVerdict: '1. Post dialysis CBC\n2. HBA1C' }));
  assert.equal(orders.text, '1. Post dialysis CBC\n2. HBA1C', 'still verbatim');
  assert.ok(orders.caveat?.includes('records orders rather than a fitness statement'));

  const none = pacBanner(row());
  assert.equal(none.tone, 'absent');
  assert.equal(none.text, PAC_BANNER_ABSENT);
});

// ── dates and dense rows ───────────────────────────────────────────────────────

test('dates and the countdown read the way the mockup prints them', () => {
  assert.equal(longDate('2026-08-29'), 'Sat 29 Aug');
  assert.equal(shortDate('2026-08-24T12:32:00Z'), '24 Aug');
  assert.equal(shortDate(null), '');
  assert.equal(longDate('nonsense'), '');
  assert.equal(whenText(3), 'in 3 days');
  assert.equal(whenText(0), 'today');
  assert.equal(whenText(1), 'tomorrow');
  assert.equal(whenText(-1), 'was yesterday');
  assert.equal(whenText(null), 'no surgery date');
  assert.equal(daysToSurgery('2026-08-26', '2026-08-29'), 3);
  assert.equal(daysToSurgery('2026-08-26', null), null);
});

test('the dense GREEN row prints the mockup line', () => {
  assert.equal(denseLine(row()), 'RCRI 0 (0.4%) · mFI 0 · CCI 2');
  assert.equal(denseLine(row({ rcri: null })), 'not yet computed');
});

// ── the gate wiring (the flag must be enforced in every place, independently) ───

test('PREOP_SURFACE_ENABLED gates the tile, the page and every read route separately', () => {
  const page = src('app/care/preop/page.tsx');
  const casePage = src('app/care/preop/case/[key]/page.tsx');
  const list = src('app/api/care/preop/list/route.ts');
  const caseRoute = src('app/api/care/preop/case/route.ts');
  const review = src('app/api/care/preop/review/route.ts');
  const chooser = src('app/care/page.tsx');

  for (const [name, s] of [['board page', page], ['case page', casePage]] as const) {
    assert.match(s, /process\.env\.CCB_ENABLED !== '1'\) notFound\(\)/, name);
    assert.match(s, /process\.env\.PREOP_SURFACE_ENABLED !== '1'\) notFound\(\)/, name);
    assert.ok(s.includes('isCareUnlocked'), `${name} checks the care cookie`);
  }
  // ONE definition of the gate, in lib/ — a Next.js route module may export only route
  // handlers and route config, so a helper exported from a route file passes tsc and then
  // fails `next build`. That is why this lives in lib/preop/gate.ts.
  const gate = src('lib/preop/gate.ts');
  assert.ok(gate.includes("process.env.CCB_ENABLED === '1' && process.env.PREOP_SURFACE_ENABLED === '1'"));
  // ...and every route re-checks independently rather than trusting the page.
  for (const [name, s] of [['list route', list], ['case route', caseRoute], ['review route', review]] as const) {
    assert.ok(s.includes('preopSurfaceEnabled()'), name);
    assert.ok(s.includes('preopAuthed()'), name);
  }
  // The chooser tile is behind the same flag, and its badge uses the board's own predicate.
  assert.ok(chooser.includes("const preopEnabled = process.env.PREOP_SURFACE_ENABLED === '1';"));
  assert.ok(chooser.includes('preopBoardCounts().then((c) => c.needsReview)'));
  assert.ok(chooser.includes("href: '/care/preop'"));
});

test('the case page awaits its params — Next.js 15 makes them a Promise', () => {
  const s = src('app/care/preop/case/[key]/page.tsx');
  assert.match(s, /params: Promise<\{ key: string \}>/);
  assert.match(s, /const \{ key \} = await params;/);
  assert.ok(s.includes('isEpisodeKeyShape'), 'and validates the key before it reaches a query');
});

test('the surface makes NO model call — the components fetch and render, nothing else', () => {
  for (const p of ['components/care/PreopBoard.tsx', 'components/care/PreopCasePage.tsx',
    'app/api/care/preop/list/route.ts', 'app/api/care/preop/case/route.ts', 'app/api/care/preop/review/route.ts']) {
    const s = src(p);
    for (const forbidden of ['tracedChat', 'governedChat', 'chatWithFallback', 'geminiConfigured', 'bedrock']) {
      assert.ok(!s.includes(forbidden), `${p} must not reach a model (${forbidden})`);
    }
  }
});

test('review is the ONLY write on the surface', () => {
  assert.ok(src('app/api/care/preop/list/route.ts').includes('export async function GET'));
  assert.ok(!src('app/api/care/preop/list/route.ts').includes('export async function POST'));
  assert.ok(!src('app/api/care/preop/case/route.ts').includes('export async function POST'));
  const review = src('app/api/care/preop/review/route.ts');
  assert.ok(review.includes('export async function POST'));
  assert.ok(review.includes('markReviewed'), 'and it writes through the store, not raw SQL');
});
