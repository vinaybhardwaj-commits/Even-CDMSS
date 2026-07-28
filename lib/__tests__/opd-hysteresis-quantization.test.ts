/**
 *   node --test --import tsx lib/__tests__/opd-hysteresis-quantization.test.ts
 *
 * S1 — hysteresis banding + confidence quantization (PRD 28 Jul 2026; engine 0.81.15).
 *
 * MEASURED, 50-pair A/A at 0.81.14: 31/50 notes differ between two identical runs, 10 band flips
 * (20%), 18/50 within one σ of a band edge — flips are threshold-proximity events, so averaging
 * cannot fix them and hysteresis can (simulated 0.223 → 0.079 at zero inference cost). Separately,
 * findingPenalty multiplied a RAW SAMPLED LLM FLOAT into the penalty: ±0.15 confidence wobble
 * moved the index ±1.35, and 9/50 pairs had identical findings but different scores.
 *
 * Two changes of different classes: quantization is a SCORING change (engine bump, golden A/B
 * gated); hysteresis is a DISPLAY rule (changes no stored score). They ship together because the
 * version bump resets every anchor anyway — the anchors start clean by construction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  quantizeConfidence, hysteresisBand, HYSTERESIS_G, bandFor, computeOpdScore,
  PENALTY_BASE, SEVERITY,
} from '../opd-note-score-core.ts';
import { OPD_ENGINE_VERSION, OPD_ENGINE_VERSIONS_CURRENT } from '../opd-note-audit-core.ts';

const CORE = readFileSync('lib/opd-note-score-core.ts', 'utf8');
const STORE = readFileSync('lib/opd-audit-store.ts', 'utf8');
const MIGRATION = readFileSync('migrations/0029_opd_displayed_band.sql', 'utf8');

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · quantizeConfidence (D3) — three levels, boundaries at the level midpoints
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('quantizeConfidence: the three levels, EXACT at the boundaries', () => {
  // < 0.45 → 0.3
  assert.equal(quantizeConfidence(0), 0.3);
  assert.equal(quantizeConfidence(0.3), 0.3);
  assert.equal(quantizeConfidence(0.4499), 0.3);
  // 0.45 ≤ c < 0.80 → 0.6  (both boundaries: 0.45 IN, 0.80 OUT)
  assert.equal(quantizeConfidence(0.45), 0.6);
  assert.equal(quantizeConfidence(0.6), 0.6);
  assert.equal(quantizeConfidence(0.7999), 0.6);
  // ≥ 0.80 → 1.0
  assert.equal(quantizeConfidence(0.80), 1.0);
  assert.equal(quantizeConfidence(0.9), 1.0);
  assert.equal(quantizeConfidence(1), 1.0);
});

test('quantizeConfidence is TOTAL — junk clamps into a level, never escapes the scale', () => {
  assert.equal(quantizeConfidence(-3), 0.3);
  assert.equal(quantizeConfidence(7), 1.0);
  assert.equal(quantizeConfidence(NaN), 0.3, 'NaN clamps to 0 → lowest level');
  assert.equal(quantizeConfidence(undefined as unknown as number), 0.3);
});

test('the quantized value reaches the penalty: a ±0.15 wobble inside a level moves the score ZERO', () => {
  // The defect: 0.65 vs 0.79 used to differ by 45×1.0×0.14 = 6.3 points of domain penalty.
  const at = (c: number) => computeOpdScore({
    findings: [{ verdict: 'low-value', confidence: c, domain: 'appropriateness' }],
    completenessCoverage: 1, pdqi9: null, patientCentred: { present: 1, total: 1 },
  }).headline;
  assert.equal(at(0.65), at(0.79), 'same level ⇒ identical score');
  assert.equal(at(0.46), at(0.60), 'same level ⇒ identical score');
  assert.equal(at(0.81), at(0.99), 'same level ⇒ identical score');
  // …but levels still discriminate: a high-confidence finding penalises more than a low one.
  assert.ok(at(0.9) < at(0.3), 'quantization must not flatten confidence entirely');
});

test('findingPenalty applies quantization IMMEDIATELY before the confidence multiply', () => {
  assert.ok(CORE.includes('return PENALTY_BASE * (SEVERITY[f.verdict] ?? 0.2) * quantizeConfidence(f.confidence);'));
  assert.equal(PENALTY_BASE, 45, 'the base is untouched');
  assert.deepEqual(SEVERITY, { 'low-value': 1.0, 'context-dependent': 0.5, uncertain: 0.2, 'high-value': 0 }, 'severity untouched');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · hysteresisBand (D1/D2) — the §3 table, exact
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('bandFor and its thresholds are BYTE-IDENTICAL — hysteresis wraps, never replaces', () => {
  assert.ok(CORE.includes(`export function bandFor(headline: number): Band {
  if (headline >= 85) return 'A';
  if (headline >= 70) return 'B';
  if (headline >= 55) return 'C';
  if (headline >= 40) return 'D';
  return 'E';
}`));
  assert.equal(HYSTERESIS_G, 3.87);
});

test('NULL prior (first score at this version) ⇒ bandFor(index) — the anchor is set normally', () => {
  for (const [idx, b] of [[90, 'A'], [72, 'B'], [60, 'C'], [45, 'D'], [10, 'E']] as const) {
    assert.equal(hysteresisBand(idx, null), b);
    assert.equal(hysteresisBand(idx, undefined), b);
  }
  // Unknown junk behaves as no prior — total, never throws.
  assert.equal(hysteresisBand(90, 'X'), 'A');
  assert.equal(hysteresisBand(90, ''), 'A');
});

test('THE TABLE (g = 3.87): each held band leaves exactly at its ± g edges', () => {
  // held at A: leave only if index < 81.13
  assert.equal(hysteresisBand(81.13, 'A'), 'A', 'at the edge: holds');
  assert.equal(hysteresisBand(81.12, 'A'), 'B', 'decisively below: moves');
  assert.equal(hysteresisBand(60, 'A'), 'C', 'NOT one step — the band the raw index implies');
  // held at B: up at ≥ 88.87, down below 66.13
  assert.equal(hysteresisBand(88.87, 'B'), 'A');
  assert.equal(hysteresisBand(88.86, 'B'), 'B');
  assert.equal(hysteresisBand(66.13, 'B'), 'B');
  assert.equal(hysteresisBand(66.12, 'B'), 'C');
  // held at C: up at ≥ 73.87, down below 51.13
  assert.equal(hysteresisBand(73.87, 'C'), 'B');
  assert.equal(hysteresisBand(73.86, 'C'), 'C');
  assert.equal(hysteresisBand(51.13, 'C'), 'C');
  assert.equal(hysteresisBand(51.12, 'C'), 'D');
  // held at D: up at ≥ 58.87, down below 36.13
  assert.equal(hysteresisBand(58.87, 'D'), 'C');
  assert.equal(hysteresisBand(58.86, 'D'), 'D');
  assert.equal(hysteresisBand(36.13, 'D'), 'D');
  assert.equal(hysteresisBand(36.12, 'D'), 'E');
  // held at E: leave only at ≥ 43.87
  assert.equal(hysteresisBand(43.87, 'E'), 'D');
  assert.equal(hysteresisBand(43.86, 'E'), 'E');
});

test('a decisive crossing lands on bandFor(index), even across MULTIPLE bands', () => {
  assert.equal(hysteresisBand(95, 'E'), 'A', 'E → A directly on a decisive rise');
  assert.equal(hysteresisBand(20, 'A'), 'E', 'A → E directly on a decisive fall');
});

test('THE POINT: a threshold-proximity wobble no longer flips the displayed band', () => {
  // A note at B whose re-scores wobble 68..72 (the measured σ) around the 70 threshold:
  for (const idx of [66.2, 68, 69.9, 70.1, 72, 73.8]) {
    assert.equal(hysteresisBand(idx, 'B'), 'B', `index ${idx} must HOLD at B`);
  }
  // …while band/bandFor (the raw stored value) keeps moving freely underneath.
  assert.equal(bandFor(69.9), 'C');
  assert.equal(bandFor(70.1), 'B');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · The write paths — the anchor lives in SQL, all three paths correct
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the SQL CASE mirrors the pure function EXACTLY, built from the same HYSTERESIS_G', () => {
  // One builder, used by both mutating paths, thresholds derived from g in code (85-g etc).
  assert.ok(STORE.includes('function hysteresisCaseSql('));
  assert.ok(STORE.includes('const g = HYSTERESIS_G;'));
  for (const frag of [
    "= 'A' AND ${newIndex} < ${85 - g}",
    "= 'B' AND (${newIndex} >= ${85 + g} OR ${newIndex} < ${70 - g})",
    "= 'C' AND (${newIndex} >= ${70 + g} OR ${newIndex} < ${55 - g})",
    "= 'D' AND (${newIndex} >= ${55 + g} OR ${newIndex} < ${40 - g})",
    "= 'E' AND ${newIndex} >= ${40 + g}",
  ]) assert.ok(STORE.includes(frag), `SQL table row missing: ${frag}`);
  // No inlined threshold literals in comparisons — g has ONE home. ("0.81.13" the engine version
  // legitimately appears in comments, so match only comparison contexts.)
  assert.ok(!/[<>]=?\s?(81\.13|88\.87|66\.13|73\.87|51\.13|58\.87|36\.13|43\.87)/.test(STORE),
    'thresholds must be computed from HYSTERESIS_G, never inlined');
});

test('all three write paths set displayed_band: insert anchor, conflict CASE, update CASE', () => {
  // 1. INSERT — the fresh raw band is the value (first score sets the anchor).
  assert.ok(STORE.includes('...(withBand ? [sc.band] : []),'));
  // 2. ON CONFLICT — the CASE reads the EXISTING row; no read-modify-write in app code.
  assert.ok(STORE.includes("displayed_band = ${hysteresisCaseSql('opd_note_audits.displayed_band', 'EXCLUDED.displayed_band', 'EXCLUDED.note_quality_index')}"));
  // 3. updateOpdAudit — REUSES $3 (band) and $2 (headline): zero new params, no re-indexing.
  assert.ok(STORE.includes("displayed_band = ${hysteresisCaseSql('displayed_band', '$3', '$2')}"));
});

test('deploy-before-migrate tolerance on BOTH writers and readers — 0029 not yet run ⇒ raw band, never a blank page', () => {
  assert.ok(STORE.includes("async function displayedBandColumnExists(): Promise<boolean> { return opdColumnExists('displayed_band'); }"));
  for (const f of [
    'app/admin/opd-audit/page.tsx',
    'lib/opd-audit-doctor.ts',
    'app/admin/opd-audit/[id]/page.tsx',
    'app/api/opd-audit/export-pdf/route.ts',
  ]) {
    assert.ok(/displayedBandColumnExists/.test(readFileSync(f, 'utf8')),
      `${f} must gate the column on its existence — a SELECT naming a missing column fails whole`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4 · The display readers — displayed band, raw-band fallback, raw index beside
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('every per-note band display renders displayed_band with the raw-band fallback', () => {
  const page = readFileSync('app/admin/opd-audit/page.tsx', 'utf8');
  assert.ok(page.includes('band: r.displayed_band ?? r.band'), 'the list mapping');
  assert.ok(page.includes('bandColor(r.displayed_band ?? r.band)'), 'the review-queue chip');
  const doctor = readFileSync('app/admin/opd-audit/doctor/[uid]/page.tsx', 'utf8');
  assert.ok(doctor.includes('band: r.displayed_band ?? r.band'));
  const detail = readFileSync('app/admin/opd-audit/[id]/page.tsx', 'utf8');
  assert.ok(detail.includes("const band = String(r.displayed_band || '') || String(r.band || '');"));
  const pdf = readFileSync('app/api/opd-audit/export-pdf/route.ts', 'utf8');
  assert.ok(pdf.includes("band: String(row.displayed_band || row.band || '')"));
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5 · Migration, engine version, and the untouched list
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('migration 0029 is exactly one additive, idempotent statement', () => {
  const stmts = MIGRATION.replace(/--.*$/gm, '').split(';').map((s) => s.trim()).filter(Boolean);
  assert.equal(stmts.length, 1);
  assert.equal(stmts[0], 'ALTER TABLE opd_note_audits ADD COLUMN IF NOT EXISTS displayed_band text');
  assert.doesNotMatch(MIGRATION.replace(/--.*$/gm, ''), /\b(DROP|DELETE|TRUNCATE|NOT NULL|DEFAULT)\b/i);
});

test('engine version is 0.81.15 AND the read family includes it (the classic error, not repeated)', () => {
  assert.equal(OPD_ENGINE_VERSION, 'opd-note-audit/0.81.15');
  assert.ok((OPD_ENGINE_VERSIONS_CURRENT as readonly string[]).includes('opd-note-audit/0.81.15'),
    'bump without the family append orphans the corpus (decision 21)');
  assert.ok((OPD_ENGINE_VERSIONS_CURRENT as readonly string[]).includes('opd-note-audit/0.81.14'),
    'history stays in the read family');
});

test('S0 behaviour and worker dedup are UNTOUCHED by S1', () => {
  // excluded_reason semantics exactly as S0 left them, on both mutating paths.
  assert.ok(STORE.includes(`excluded_reason = COALESCE(EXCLUDED.excluded_reason,
           CASE WHEN opd_note_audits.excluded_reason = 'llm_leg_failed' THEN NULL ELSE opd_note_audits.excluded_reason END)`));
  assert.ok(STORE.includes(`excluded_reason = COALESCE($21,
         CASE WHEN excluded_reason = 'llm_leg_failed' THEN NULL ELSE excluded_reason END)`));
  // dedup readers still unfiltered, verbatim.
  assert.ok(STORE.includes(`    \`SELECT uid FROM opd_note_audits
     WHERE engine_version = $1 AND (note_date AT TIME ZONE 'Asia/Kolkata')::date = $2::date\``));
  assert.ok(STORE.includes(`    \`SELECT DISTINCT uid FROM opd_note_audits
     WHERE (note_date AT TIME ZONE 'Asia/Kolkata')::date = $1::date\``));
  // the S0 leg-failure predicate and the S0 gate text are untouched in the audit path.
  const audit = readFileSync('lib/opd-note-audit.ts', 'utf8');
  assert.ok(audit.includes('const llmLegFailed = !opts.evalModel && llmLegFailedAfterParse(parsed);'));
});

test('the lab eval path knows nothing of hysteresis or displayed_band', () => {
  for (const f of ['lib/lab-batch.ts', 'lib/lab-batch-core.ts']) {
    assert.ok(!/displayed_band|hysteresis|quantizeConfidence/i.test(readFileSync(f, 'utf8')), `${f} untouched`);
  }
});
