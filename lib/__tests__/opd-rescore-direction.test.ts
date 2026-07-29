/**
 *   node --test --import tsx lib/__tests__/opd-rescore-direction.test.ts
 *
 * The `direction` dead-path fix (PRD 29 Jul 2026).
 *
 * MEASURED defect: `concept_id` is written by the concept tick AFTER the audit row lands, so on
 * the fresh-LLM path `finalize()` always sees an empty conceptId and `stampDirection` can never
 * fire — 52 prefixed findings across 0.81.16/0.81.17, zero directions. On the REUSE path the
 * stored findings DO carry `concept_id`, so the stamp works. The fix is a separate watermarked
 * re-score pass that drives the reuse path (D-1/D-2); the race with the concept tick is closed by
 * keying the watermark on the coded_at the re-score OBSERVED (D-3), not on when it ran.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stampDirection } from '../opd-note-audit-core.ts';
import { computeOpdScore } from '../opd-note-score-core.ts';
import {
  rescoreCandidateSql, clampRescoreLimit, RESCORE_WATERMARK_UPSERT_SQL, buildWatermarkParams,
  pdqi9ObjFromStoredRows, directionGained, underuseCount, reduceRescoreReport, emptyRescoreReport,
  resolveEngineFilter,
} from '../opd-rescore-direction-core.ts';
import { OPD_ENGINE_VERSIONS_CURRENT } from '../opd-note-audit-core.ts';
import type { OpdFinding } from '../opd-note-audit-core.ts';
import type { DeidOpdCase } from '../opd-ingest-core.ts';
import type { RescoreOutcome } from '../opd-rescore-direction-core.ts';

const AUDIT = readFileSync('lib/opd-note-audit.ts', 'utf8');
const ROUTE = readFileSync('app/api/admin/opd-rescore-direction/route.ts', 'utf8');
const MIGRATION = readFileSync('migrations/0030_opd_rescore_state.sql', 'utf8');

function mkFinding(p: Partial<OpdFinding> & { concept_id?: string }): OpdFinding {
  return {
    subject: 'Vitamin D supplementation not offered', verdict: 'low-value', confidence: 0.9,
    domain: 'appropriateness', rationale: 'guideline-indicated therapy absent from the plan',
    evidence: [], estimates: [], citation_ids: [], source: 'llm', ...p,
  } as OpdFinding;
}
// No medications on the case — irrelevant to the underuse tests (check 1 keys on OVERUSE + the
// antibiotic text regex), minimal by construction.
const CASE = { medications: [] } as unknown as DeidOpdCase;

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · Acceptance §4.1 — the reuse path stamps; the fresh path (no concept_id) does not
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§4.1: concept_id "underuse:…" + source llm ⇒ direction underuse', () => {
  const [f] = stampDirection([mkFinding({ concept_id: 'underuse:rx:vitamin d' })], CASE);
  assert.equal(f.direction, 'underuse');
});

test('§4.1: an underuse finding contributes ZERO penalty', () => {
  const base = { completenessCoverage: 1, pdqi9: null, patientCentred: { present: 2, total: 2 } };
  const [f] = stampDirection([mkFinding({ concept_id: 'underuse:rx:vitamin d' })], CASE);
  const withUnderuse = computeOpdScore({ ...base, findings: [{ verdict: f.verdict, confidence: f.confidence, domain: f.domain, direction: f.direction }] });
  const withNothing = computeOpdScore({ ...base, findings: [] });
  assert.equal(withUnderuse.headline, withNothing.headline, 'zero penalty ⇒ identical headline');
});

test('§4.1 pinned DELIBERATELY: the same finding with NO concept_id emerges with NO direction — the fresh-path behaviour, so a future change to it is visible', () => {
  const [f] = stampDirection([mkFinding({})], CASE);
  assert.equal(f.direction, undefined);
});

test('overuse: prefix stamps overuse (the four measured 0.81.17 exhibits — non-antibiotic subjects)', () => {
  const [f] = stampDirection([mkFinding({ concept_id: 'overuse:investigation:cbc', subject: 'CBC without indication', rationale: 'no indication documented' })], CASE);
  assert.equal(f.direction, 'overuse');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · Acceptance §4.2 — D-6: documentation/process prefixes set NOTHING
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§4.2 (D-6): documentation: and process: prefixes set no direction — absent stays the honest default', () => {
  const out = stampDirection([
    mkFinding({ concept_id: 'documentation:note:follow-up interval' }),
    mkFinding({ concept_id: 'process:referral:pathway' }),
  ], CASE);
  for (const f of out) assert.equal(f.direction, undefined);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · Acceptance §4.3 — D-3: the watermark stores the OBSERVED coded_at, by identity
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§4.3 (D-3): the value written as based_on_coded_at IS the value read — identity, not recency', () => {
  const observed = '2026-07-29T04:11:22.000Z';
  const params = buildWatermarkParams({
    uid: 'u1', engineVersion: 'opd-note-audit/0.81.17', observedCodedAt: observed,
    indexBefore: 61, indexAfter: 74, bandBefore: 'C', bandAfter: 'B',
  });
  assert.equal(params[2], observed, 'written ($3) === read, verbatim');
  assert.deepEqual(params, ['u1', 'opd-note-audit/0.81.17', observed, 61, 74, 'C', 'B']);
});

test('the watermark SQL binds based_on_coded_at as $3 and reserves now() for rescored_at only', () => {
  assert.ok(RESCORE_WATERMARK_UPSERT_SQL.includes('(uid, engine_version, based_on_coded_at, rescored_at, index_before, index_after, band_before, band_after)'));
  assert.ok(RESCORE_WATERMARK_UPSERT_SQL.includes('VALUES ($1, $2, $3, now(), $4, $5, $6, $7)'),
    'based_on_coded_at = $3 (the observed value); now() feeds rescored_at ONLY');
  assert.ok(RESCORE_WATERMARK_UPSERT_SQL.includes('ON CONFLICT (uid, engine_version) DO UPDATE'));
});

test('the route passes the coded_at from the CANDIDATE SELECT and never re-reads it after the update', () => {
  assert.ok(ROUTE.includes('observedCodedAt: stored.coded_at'), 'the selected value, verbatim');
  // The only SQL the route runs is the core's candidate query and the core's watermark upsert —
  // no inline SQL string exists that could re-read coded_at after the update.
  assert.ok(!/`\s*SELECT/i.test(ROUTE), 'no inline SELECT anywhere in the route');
  assert.ok(!ROUTE.includes('even_concept_state'), 'the route holds no SQL of its own against the concept watermark');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4 · The candidate query — bound params only, fail safe
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('candidate SQL: engine versions are a BOUND array param — unknown version ⇒ zero rows, never a throw', () => {
  const q = rescoreCandidateSql(true);
  assert.ok(q.includes('a.engine_version = ANY($2::text[])'));
  assert.ok(q.includes('a.app_source = $1'));
  assert.ok(q.includes('LIMIT $3'));
  assert.ok(!q.includes('0.81'), 'no version string is ever interpolated into the SQL text');
});

test('candidate SQL: candidacy = the coder touched the note more recently than the last re-score observed', () => {
  const q = rescoreCandidateSql(true);
  assert.ok(q.includes('(r.uid IS NULL OR s.coded_at > r.based_on_coded_at)'));
  assert.ok(q.includes('JOIN even_concept_state s'));
  assert.ok(q.includes('LEFT JOIN opd_rescore_state r'));
  assert.ok(q.includes('a.excluded_reason IS NULL'));
});

test('candidate SQL tolerates migration 0029 not having run (displayed_band variant)', () => {
  assert.ok(rescoreCandidateSql(true).includes('a.displayed_band'));
  assert.ok(!rescoreCandidateSql(false).includes('displayed_band'));
});

test('?limit= — default 800, clamped 1..3000, junk lands on the default', () => {
  assert.equal(clampRescoreLimit(null), 800);
  assert.equal(clampRescoreLimit('nonsense'), 800);
  assert.equal(clampRescoreLimit(-5), 800);
  assert.equal(clampRescoreLimit(0), 800);
  assert.equal(clampRescoreLimit(1), 1);
  assert.equal(clampRescoreLimit(99999), 3000);
  assert.equal(clampRescoreLimit('50'), 50);
});

// A-1 (D-8) — the ?engine= single-stratum filter. WHITELIST, not passthrough: only an exact member
// of the family narrows the list; anything else selects zero rows. The value is a bound parameter
// either way; these pin that it never reaches the query as a live term.
test('A-1 §1: resolveEngineFilter(null) returns the whole family', () => {
  assert.deepEqual(resolveEngineFilter(null, OPD_ENGINE_VERSIONS_CURRENT), [...OPD_ENGINE_VERSIONS_CURRENT]);
  assert.deepEqual(resolveEngineFilter('  ', OPD_ENGINE_VERSIONS_CURRENT), [...OPD_ENGINE_VERSIONS_CURRENT], 'blank is absent');
});

test('A-1 §2: an exact family member narrows to exactly that one version', () => {
  assert.deepEqual(resolveEngineFilter('opd-note-audit/0.81.17', OPD_ENGINE_VERSIONS_CURRENT), ['opd-note-audit/0.81.17']);
});

test('A-1 §3: an unknown version yields [] — the fail-safe, never a widened scope', () => {
  assert.deepEqual(resolveEngineFilter('opd-note-audit/9.9.9', OPD_ENGINE_VERSIONS_CURRENT), []);
  assert.deepEqual(resolveEngineFilter('0.81.17', OPD_ENGINE_VERSIONS_CURRENT), [],
    'a short form is NOT accepted and NOT helpfully prefixed — exact match is the safety property');
});

test("A-1 §4: an injection-shaped value yields [] and never reaches the query as a live term", () => {
  assert.deepEqual(resolveEngineFilter("'; DROP TABLE", OPD_ENGINE_VERSIONS_CURRENT), []);
});

test("A-1 §5: the report's engine_versions reflects the FILTERED list, not the family", () => {
  assert.ok(ROUTE.includes("const engines = resolveEngineFilter(p.get('engine'), OPD_ENGINE_VERSIONS_CURRENT);"));
  assert.ok(ROUTE.includes('engine_versions: engines.length,'), 'the report describes what actually ran');
  assert.ok(ROUTE.includes('[APP, engines, limit]'), 'and the same resolved list is the $2 bound parameter');
  assert.ok(!ROUTE.includes('[APP, [...OPD_ENGINE_VERSIONS_CURRENT], limit]'), 'the unfiltered family no longer feeds $2 directly');
});

test('a candidate-query error degrades to an EMPTY report — never a 500', () => {
  assert.deepEqual(emptyRescoreReport(), { considered: 0, not_fetched: 0, direction_stamped: 0, index_changed: 0, band_changed: 0, applied: 0, sample: [] });
  assert.ok(ROUTE.includes('...emptyRescoreReport(),'), 'the catch path returns the empty report');
  assert.ok(ROUTE.includes('candidate_query_error'), 'with the error surfaced for diagnosis, not swallowed');
  const catchIdx = ROUTE.indexOf('candidate_query_error');
  assert.ok(!ROUTE.slice(catchIdx - 400, catchIdx).includes('status: 500'), 'the degrade path is a 200');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5 · The route — reuse path, in-place update, apply gate, no scheduler
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('finalize() runs stampDirection on the reuse path — the moment that already works', () => {
  assert.ok(AUDIT.includes('out = stampDirection(out, oc);'), 'inside finalize');
  assert.ok(AUDIT.includes('const findings: OpdFinding[] = finalize([...det, ...opts.reuse.llmFindings]);'),
    'and the reuse path routes stored findings — which carry concept_id — through it');
});

test('the route threads each row\'s OWN engine_version into auditOpdNote, so the UPDATE is in place', () => {
  assert.ok(ROUTE.includes('auditOpdNote(note, { trace: false, reuse, engineVersion })'));
  assert.ok(ROUTE.includes("const engineVersion = String(stored.engine_version || '')"));
});

test('?apply=1 is the ONLY write switch — read-only without it', () => {
  assert.ok(ROUTE.includes("const apply = p.get('apply') === '1';"));
  const applyIdx = ROUTE.indexOf("const apply = p.get('apply') === '1';");
  const updIdx = ROUTE.indexOf('await updateOpdAudit', applyIdx);
  assert.ok(updIdx > applyIdx, 'the write happens after the switch is read');
  assert.ok(/if \(apply\)/.test(ROUTE), 'and is gated on it');
  const wmIdx = ROUTE.indexOf('RESCORE_WATERMARK_UPSERT_SQL', updIdx);
  assert.ok(wmIdx > updIdx, "the watermark write follows updateOpdAudit's 'updated' inside the same gate");
});

test('§2.7: no cron, no ?auto=1, no scheduler — cadence is V\'s decision, later', () => {
  assert.ok(!ROUTE.includes("get('auto')"), 'no drain switch is read');
  const vercelJson = readFileSync('vercel.json', 'utf8');
  assert.ok(!vercelJson.includes('opd-rescore-direction'), 'no cron entry was added');
});

test('hysteresis is NOT this build\'s code — the band rides updateOpdAudit (D-4), the report only mirrors it', () => {
  assert.ok(ROUTE.includes('hysteresisBand(indexAfter, storedDisplayed)'), 'the REPORT prediction uses the same pure rule');
  assert.ok(!ROUTE.includes('hysteresisCaseSql'), 'no SQL hysteresis of its own');
  assert.ok(!ROUTE.includes('UPDATE opd_note_audits'), 'the audit-row write is updateOpdAudit\'s alone');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 6 · The report — index/band movement counted DIRECTLY (rows_changed is not acceptable here)
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('reduceRescoreReport counts direction/index/band movement directly and samples ≤ 20 movers', () => {
  const moved: RescoreOutcome = { uid: 'a', fetched: true, directionGained: 2, indexBefore: 61, indexAfter: 74, bandBefore: 'C', bandAfter: 'B', nUnderuse: 2, applied: true };
  const still: RescoreOutcome = { uid: 'b', fetched: true, directionGained: 0, indexBefore: 80, indexAfter: 80, bandBefore: 'B', bandAfter: 'B', nUnderuse: 0, applied: true };
  const missing: RescoreOutcome = { uid: 'c', fetched: false, directionGained: 0, indexBefore: null, indexAfter: null, bandBefore: null, bandAfter: null, nUnderuse: 0, applied: false };
  const r = reduceRescoreReport([moved, still, missing]);
  assert.equal(r.considered, 2, 'not_fetched rows are NOT considered');
  assert.equal(r.not_fetched, 1);
  assert.equal(r.direction_stamped, 2);
  assert.equal(r.index_changed, 1);
  assert.equal(r.band_changed, 1);
  assert.equal(r.applied, 2, 'a zero-change note is still applied AND watermarked, so it is not rescanned');
  assert.deepEqual(r.sample.map((s) => s.uid), ['a'], 'only movers enter the sample');
});

test('directionGained counts findings that GAINED a direction; underuseCount feeds the sample', () => {
  const before = [mkFinding({ concept_id: 'underuse:rx:vitamin d' })];
  const after = stampDirection(before, CASE);
  assert.equal(directionGained(before, after), 1);
  assert.equal(directionGained(after, after), 0, 'idempotent re-stamp gains nothing');
  assert.equal(underuseCount(after), 1);
  assert.equal(directionGained(null, []), 0, 'junk stored findings degrade to zero, never a throw');
});

test('pdqi9 stored rows-array reconstructs to the computeOpdScore object form', () => {
  assert.deepEqual(pdqi9ObjFromStoredRows([{ attr: 'accurate', value: 4 }, { attr: 'thorough', value: '3' }]), { accurate: 4, thorough: 3 });
  assert.equal(pdqi9ObjFromStoredRows([]), null);
  assert.equal(pdqi9ObjFromStoredRows(null), null);
  assert.equal(pdqi9ObjFromStoredRows([{ attr: '', value: 4 }]), null, 'nameless rows do not fabricate an assessment');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 7 · Migration 0030 — additive, idempotent, the composite key the race guard needs
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('migration 0030: CREATE TABLE IF NOT EXISTS opd_rescore_state, keyed (uid, engine_version)', () => {
  assert.ok(MIGRATION.includes('CREATE TABLE IF NOT EXISTS opd_rescore_state'));
  assert.ok(MIGRATION.includes('PRIMARY KEY (uid, engine_version)'));
  assert.ok(MIGRATION.includes('based_on_coded_at  TIMESTAMPTZ NOT NULL'));
  assert.ok(!/DROP|ALTER TABLE opd_note_audits/i.test(MIGRATION), 'additive only — nothing existing is touched');
});
