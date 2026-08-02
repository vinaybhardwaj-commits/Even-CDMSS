/**
 *   node --test --import tsx lib/__tests__/clinical-bands.test.ts
 *
 * Phase 3b — ratified vitamin-D bands and the dose concordance matrix (rulings R-6, D-3, and
 * Dr Zaki's 29 Jul ratification).
 *
 * BUG 8 (P0): two notes from ONE prescriber on ONE day — 17 and 18 ng/mL, identical 60,000 IU
 * weekly × 8 week regimens — scored 100 and 60. One nanogram, forty points. MEASURED by exhaustive
 * search: the engine held NO vitamin D threshold at all; the cutoff was model recall, attributed in
 * the stored rationale to "cited guidelines" that exist nowhere in the system. Row 3 of the exhibit
 * completes the picture: the MOST aggressive regimen (24 ng/mL, 12 weeks) was not flagged at all —
 * the check varied AGAINST severity.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  vitaminDBand, parseVitaminDLevel, vitaminDConcordance, VITAMIN_D_DOSE_MATRIX,
  VITAMIN_D_STANDARD, VITAMIN_D_DEFICIENT_BELOW, VITAMIN_D_SUFFICIENT_AT_OR_ABOVE,
} from '../clinical-bands.ts';
import { vitaminDRepletionFindings } from '../opd-note-audit.ts';
import type { OpdMed } from '../opd-ingest-core.ts';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · The bands — contiguous, no gap
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('BUG 8: 17 and 18 ng/mL land in the SAME band — the acceptance test for this batch', () => {
  assert.equal(vitaminDBand(17), 'deficient');
  assert.equal(vitaminDBand(18), 'deficient');
  assert.equal(vitaminDBand(17), vitaminDBand(18), 'one nanogram may never separate two notes');
});

test('§6.1: the full band table, boundaries exact and CONTIGUOUS', () => {
  for (const v of [0, 5, 17, 18, 19, 19.9, 19.99]) assert.equal(vitaminDBand(v), 'deficient', `${v}`);
  for (const v of [20.0, 20.5, 25, 29, 29.9, 29.99]) assert.equal(vitaminDBand(v), 'insufficient', `${v}`);
  for (const v of [30.0, 35, 100]) assert.equal(vitaminDBand(v), 'sufficient', `${v}`);
  // THE GAP THAT PRODUCED BUG 8: the published text says "below 20" and "21 to 29", leaving
  // 20.0–20.9 undefined. Here it is defined.
  for (const v of [20.0, 20.5, 20.9]) assert.equal(vitaminDBand(v), 'insufficient', `${v} must not be undefined`);
});

test('the boundary constants and the standard are named, verbatim', () => {
  assert.equal(VITAMIN_D_DEFICIENT_BELOW, 20.0);
  assert.equal(VITAMIN_D_SUFFICIENT_AT_OR_ABOVE, 30.0);
  assert.equal(VITAMIN_D_STANDARD, 'Endocrine Society');
});

test('an unusable level yields NO band — never a guess', () => {
  for (const v of [NaN, Infinity, -Infinity, -1]) assert.equal(vitaminDBand(v), null, String(v));
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · Level parsing — fail-safe, mirroring vitaminDRepletionFindings' doctrine
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the level is read only when BOTH a vitamin-D token and ng/mL are present', () => {
  assert.equal(parseVitaminDLevel('Vitamin D 17 ng/mL'), 17);
  assert.equal(parseVitaminDLevel('vitamin d3: 18.5 ng/ml, B12 172 pg/mL'), 18.5);
  assert.equal(parseVitaminDLevel('25(OH)D 24 ng/mL'), 24);
  assert.equal(parseVitaminDLevel('Cholecalciferol level 8 ng/mL'), 8);
});

test('FAIL-SAFE: a bare number, a different unit, or no vitamin-D token reads as NOTHING', () => {
  for (const t of [
    'Vitamin D deficiency', 'level 17', 'B12 172 pg/mL', '',
    'Vitamin D 45 nmol/L',                      // a DIFFERENT scale — must not be banded
    'Vitamin D 900 ng/mL',                      // implausible ⇒ refused rather than banded
    null, undefined,
  ]) {
    assert.equal(parseVitaminDLevel(t as never), null, JSON.stringify(t));
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · The matrix — EXACTLY two ratified rows, silence everywhere else
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§6.2/§6.3: the matrix holds EXACTLY the two ratified rows', () => {
  assert.equal(VITAMIN_D_DOSE_MATRIX.length, 2, 'no row may be invented — a row is a clinical ratification');
  assert.deepEqual(VITAMIN_D_DOSE_MATRIX.map((r) => [r.band, r.iu, r.weekly, r.weeks, r.verdict]), [
    ['deficient', 60000, true, 8, 'concordant'],
    ['insufficient', 60000, true, 8, 'concordant'],
  ]);
});

test('row 1: deficient + 60,000 IU weekly × 8 weeks is concordant', () => {
  assert.equal(vitaminDConcordance('deficient', { iu: 60000, weekly: true, weeks: 8 }), 'concordant');
});

test('row 2: insufficient + the same regimen is concordant (Dr Zaki, Indian context)', () => {
  assert.equal(vitaminDConcordance('insufficient', { iu: 60000, weekly: true, weeks: 8 }), 'concordant');
});

test('§6.4: EVERY unratified pair yields null — and null means EMIT NOTHING, never discordance', () => {
  for (const [band, regimen, why] of [
    ['sufficient', { iu: 60000, weekly: true, weeks: 8 }, 'a course at a sufficient level'],
    ['deficient', { iu: 60000, weekly: true, weeks: 12 }, 'beyond 8 weeks'],
    ['deficient', { iu: 60000, weekly: false, weeks: 8 }, 'monthly maintenance / not weekly'],
    ['deficient', { iu: 1000, weekly: true, weeks: 8 }, 'a different strength'],
    ['insufficient', { iu: 60000, weekly: true, weeks: 4 }, 'a shorter course'],
    [null, { iu: 60000, weekly: true, weeks: 8 }, 'no band could be read'],
  ] as const) {
    assert.equal(vitaminDConcordance(band as never, regimen as never), null, why as string);
  }
  assert.equal(vitaminDConcordance('deficient', null), null, 'no regimen');
  assert.equal(vitaminDConcordance('deficient', { iu: 60000, weekly: true, weeks: null }), null, 'unparseable duration');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4 · The Ruling 13 retest prompt, extended to `insufficient`
// ═════════════════════════════════════════════════════════════════════════════════════════════

const vitD = (duration: string): OpdMed => ({
  brand: 'Uprise-D3 60K', generic: 'Cholecalciferol', strength: '60000 IU',
  frequency: 'weekly', duration,
} as OpdMed);

test('§6.5: the retest prompt fires for INSUFFICIENT as well as deficient, still informational', () => {
  for (const band of ['deficient', 'insufficient'] as const) {
    const out = vitaminDRepletionFindings([vitD('8 weeks')], band);
    assert.equal(out.length, 1, `${band} must prompt for a retest`);
    assert.equal(out[0].informational, true, 'informational — a documentation prompt, not a verdict');
    assert.equal(out[0].verdict, 'uncertain');
    assert.equal(out[0].confidence, 0);
    assert.equal(out[0].source, 'deterministic');
    assert.match(out[0].rationale, /Endocrine Society/, 'the standard is DISCLOSED — bug 8 had none');
  }
});

test('the prompt keeps signal_type vitamin_d_repletion_duration through stampFindingIdentity', async () => {
  const { stampFindingIdentity } = await import('../opd-note-audit-core.ts');
  const out = stampFindingIdentity(vitaminDRepletionFindings([vitD('8 weeks')], 'insufficient'));
  assert.equal(out[0].signal_type, 'vitamin_d_repletion_duration');
});

test('a SUFFICIENT level with the same regimen emits nothing — silence is the default', () => {
  assert.deepEqual(vitaminDRepletionFindings([vitD('8 weeks')], 'sufficient'), []);
});

test('NO BAND (unreadable level) emits nothing for an 8-week course — never band on a guess', () => {
  assert.deepEqual(vitaminDRepletionFindings([vitD('8 weeks')], null), []);
});

test('the >8-week Ruling 13 prompt is UNCHANGED and still band-independent', () => {
  const out = vitaminDRepletionFindings([vitD('12 weeks')], null);
  assert.equal(out.length, 1, 'the original trigger does not need a band');
  assert.equal(out[0].informational, true);
  assert.match(out[0].rationale, /standard repletion once low levels are established/);
  assert.match(out[0].subject, /prescribed for 12 weeks/);
});

test('FAIL-SAFE doctrine intact: an unparseable duration emits NOTHING in either mode', () => {
  for (const band of [null, 'deficient', 'insufficient'] as const) {
    assert.deepEqual(vitaminDRepletionFindings([vitD('as advised')], band), [], String(band));
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5 · Deterministic precedence (arm 7) and the untouched list
// ═════════════════════════════════════════════════════════════════════════════════════════════

// §6.6 (arm 7 precedence) tests DELETED with the contradicted-by-structure neutraliser (0.81.19,
// V 1 Aug 2026): contradicted_ratified_rule measured 50 findings suppressed, zero correctly. An LLM
// vitamin-D dose finding now scores beside the deterministic rule's informational prompt.

test('the system prompt names vitamin D dose adequacy beside muscle relaxants', () => {
  const core = readFileSync('lib/opd-note-audit-core.ts', 'utf8');
  assert.ok(core.includes('VITAMIN D DOSE ADEQUACY'));
  assert.ok(core.includes('never overrule the clinician'), 'bug 8: the model overruled the documented diagnosis');
});

test('the engine version is 0.81.19 and the read family keeps the older versions', async () => {
  const { OPD_ENGINE_VERSION, OPD_ENGINE_VERSIONS_CURRENT } = await import('../opd-note-audit-core.ts');
  assert.equal(OPD_ENGINE_VERSION, 'opd-note-audit/0.81.20');
  assert.ok((OPD_ENGINE_VERSIONS_CURRENT as readonly string[]).includes('opd-note-audit/0.81.19'));
  assert.ok((OPD_ENGINE_VERSIONS_CURRENT as readonly string[]).includes('opd-note-audit/0.81.17'));
  assert.ok((OPD_ENGINE_VERSIONS_CURRENT as readonly string[]).includes('opd-note-audit/0.81.16'));
});
