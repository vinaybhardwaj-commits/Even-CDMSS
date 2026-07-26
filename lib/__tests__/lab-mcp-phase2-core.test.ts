// LAB-MCP Phase 2 pure cores — F6/F17 (rollup), F11 (routing), F12b (lab_source), F13 (provenance),
// F14 (propose/ratify/gaps), F16 (source weight). No DB, no Next, no model calls.
//
// VOCABULARY IS MODULE-QUALIFIED THROUGHOUT (gotcha G2 / D22 / A10.3): opd-feedback-core exports
// SCOPES with FOUR entries while opd-feedback-rollup-core's has THREE. Aliased on import so a bare
// name can never be read as the wrong one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFeedbackBody,
  SCOPES as FEEDBACK_SCOPES,
  MISSED_CATEGORIES,
  IMPACT_TAGS,
} from '../opd-feedback-core';
import { SCOPES as ROLLUP_SCOPES, DETAIL_SCOPES, buildDetailSql, reduceRollup, CATEGORY_SIGNAL_MAP, type FindingCountRow, type FiredRow, type ImpactRow } from '../opd-feedback-rollup-core';
import { decideLabSource, normalizeRepoPath, LAB_SOURCE_ALLOW_PREFIXES } from '../lab-source-core';
import { resolveProvider, checkPaidCeiling, DEFAULT_PAID_CEILING } from '../lab-provider-core';
import {
  checkCitationFields, INTERNAL_PROTOCOL, parseProposeArgs, parseRatifyArgs, checkPromotable,
  classifyGaps, statementSimilarity, findNearDuplicates, clampSourceWeight, LAB_SOURCE_WEIGHT_CAP,
  DEFAULT_AUTHOR, type ExistingStatement, type GapRow,
} from '../lvc-proposal-core';

const AUDIT_ID = '11111111-2222-3333-4444-555555555555';

// ── A10.3 — the vocabulary collision is real; assert it rather than unify blind ──
test('G2/A10.3: the two SCOPES constants differ and are NOT unified', () => {
  assert.deepEqual([...FEEDBACK_SCOPES], ['audit', 'finding', 'missed', 'impact']);
  assert.deepEqual([...ROLLUP_SCOPES], ['finding', 'missed', 'audit']);
  assert.equal(FEEDBACK_SCOPES.length, 4);
  assert.equal(ROLLUP_SCOPES.length, 3);
  // the write path knows about 'impact'; the rollup's scope filter never did — that IS D23
  assert.ok((FEEDBACK_SCOPES as readonly string[]).includes('impact'));
  assert.ok(!(ROLLUP_SCOPES as readonly string[]).includes('impact'));
});

// ── F6 — category required for scope='missed' ──────────────────────────────────
test('F6: parseFeedbackBody REFUSES scope=missed without a category', () => {
  const r = parseFeedbackBody({ auditId: AUDIT_ID, scope: 'missed', comment: 'should have flagged the interaction' });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /category required/);
});

test('F6: accepts every whitelisted category, rejects an unknown one', () => {
  for (const c of MISSED_CATEGORIES) {
    const r = parseFeedbackBody({ auditId: AUDIT_ID, scope: 'missed', comment: 'x', category: c });
    assert.equal(r.ok, true, c);
    assert.equal(r.ok && r.value.category, c);
  }
  const bad = parseFeedbackBody({ auditId: AUDIT_ID, scope: 'missed', comment: 'x', category: 'made_up' });
  assert.equal(bad.ok, false);
  assert.match((bad as { error: string }).error, /must be one of/);
});

test('F6: the required-category change touches ONLY scope=missed', () => {
  assert.equal(parseFeedbackBody({ auditId: AUDIT_ID, scope: 'audit', comment: 'fine' }).ok, true);
  assert.equal(parseFeedbackBody({ auditId: AUDIT_ID, scope: 'finding', verdict: 'true_positive', finding_ref: 'abc' }).ok, true);
  assert.equal(parseFeedbackBody({ auditId: AUDIT_ID, scope: 'impact', verdict: 'changes_management', finding_ref: 'abc' }).ok, true);
});

const fRow = (st: string, verdict: string, n: number, ev = '0.81.14'): FindingCountRow => ({ engine_version: ev, signal_type: st, verdict, n });
const firedRow = (st: string, fired: number, ev = '0.81.14'): FiredRow => ({ engine_version: ev, signal_type: st, fired });

test('F6: rollup groups missed by CATEGORY and reports recall_proxy as a lower bound', () => {
  const r = reduceRollup({
    findingRows: [fRow('low_value_care', 'true_positive', 8)],
    firedRows: [firedRow('low_value_care', 20)],
    missedRows: [
      { engine_version: '0.81.14', category: 'appropriateness_low_value', n: 2 },
      { engine_version: '0.81.14', category: null, n: 3 },
    ],
    auditRows: [], reviewerRows: [], ledgerRows: [],
  }, {});
  assert.ok(r.missed.some((m) => m.category === 'appropriateness_low_value'));
  assert.ok(r.missed.some((m) => m.category === '(unclassified)'), 'pre-F6 rows must group as (unclassified), never a guess');

  const mapped = r.recall_proxy.find((x) => x.category === 'appropriateness_low_value');
  assert.ok(mapped);
  assert.equal(mapped.tp, 8);
  assert.equal(mapped.missed, 2);
  assert.equal(mapped.recall_proxy, 0.8);        // 8 / (8+2)
  assert.match(mapped.basis, /LOWER BOUND/);

  const unmapped = r.recall_proxy.find((x) => x.category === '(unclassified)');
  assert.ok(unmapped);
  assert.equal(unmapped.recall_proxy, null, 'an unmapped category must be null, not invented');
});

test('F6: recall_proxy is null on a zero denominator, never NaN', () => {
  const r = reduceRollup({
    findingRows: [], firedRows: [],
    missedRows: [{ engine_version: '0.81.14', category: 'coding', n: 0 }],
    auditRows: [], reviewerRows: [], ledgerRows: [],
  }, {});
  const c = r.recall_proxy.find((x) => x.category === 'coding');
  assert.ok(c);
  assert.equal(c.recall_proxy, null);
  assert.ok(!Number.isNaN(c.recall_proxy as unknown as number));
});

test('F6: the category→signal map is deliberately partial', () => {
  assert.ok(CATEGORY_SIGNAL_MAP.appropriateness_low_value);
  assert.ok(CATEGORY_SIGNAL_MAP.prescribing_safety);
  assert.ok(CATEGORY_SIGNAL_MAP.coding);
  assert.equal(CATEGORY_SIGNAL_MAP.note_quality, undefined);
  assert.equal(CATEGORY_SIGNAL_MAP.continuity, undefined);
});

// ── F17 — impact fold ──────────────────────────────────────────────────────────
test('F17: impact fold reports both tags and coverage_of_tp', () => {
  const impactRows: ImpactRow[] = [
    { verdict: 'changes_management', n: 3, n_refs: 3 },
    { verdict: 'chart_hygiene', n: 5, n_refs: 5 },
  ];
  const r = reduceRollup({
    findingRows: [fRow('drug_interaction', 'true_positive', 16)],
    firedRows: [firedRow('drug_interaction', 20)],
    missedRows: [], auditRows: [], reviewerRows: [], ledgerRows: [], impactRows,
  }, {});
  assert.equal(r.impact.changes_management, 3);
  assert.equal(r.impact.chart_hygiene, 5);
  assert.equal(r.impact.n_refs_tagged, 8);
  assert.equal(r.impact.coverage_of_tp, 0.5);   // 8 tagged refs / 16 tp
  for (const t of IMPACT_TAGS) assert.ok(['changes_management', 'chart_hygiene'].includes(t));
});

test('F17: absent impact rows degrade to zeroes and a null coverage, never a throw', () => {
  const r = reduceRollup({ findingRows: [], firedRows: [], missedRows: [], auditRows: [], reviewerRows: [], ledgerRows: [] }, {});
  assert.equal(r.impact.changes_management, 0);
  assert.equal(r.impact.chart_hygiene, 0);
  assert.equal(r.impact.coverage_of_tp, null);
});

// ── F11 — provider routing ─────────────────────────────────────────────────────
test('F11: resolver maps all three prefixes and marks paid correctly', () => {
  const mini = 'qwen2.5:14b';
  const o = resolveProvider('ollama:qwen2.5:14b', mini);
  assert.equal(o.ok && o.provider, 'ollama');
  assert.equal(o.ok && o.model, 'qwen2.5:14b');
  assert.equal(o.ok && o.paid, false);

  const r = resolveProvider('openrouter:google/gemini-2.5-flash', mini);
  assert.equal(r.ok && r.provider, 'openrouter');
  assert.equal(r.ok && r.model, 'google/gemini-2.5-flash');
  assert.equal(r.ok && r.paid, true);

  const v = resolveProvider('vertex:gemini-2.5-pro', mini);
  assert.equal(v.ok && v.provider, 'vertex');
  assert.equal(v.ok && v.paid, true);
});

test('F11: omitted model = the local mini, behaviour unchanged', () => {
  const d = resolveProvider(undefined, 'qwen2.5:14b');
  assert.equal(d.ok && d.provider, 'ollama');
  assert.equal(d.ok && d.model, 'qwen2.5:14b');
  assert.equal(d.ok && d.paid, false);
});

test('F11: an unknown provider ERRORS LOUD and never falls back to the mini', () => {
  const bad = resolveProvider('gpt5:turbo', 'qwen2.5:14b');
  assert.equal(bad.ok, false);
  assert.match((bad as { error: string }).error, /unknown provider prefix/);
  assert.match((bad as { error: string }).error, /Never falls back/);
  // a bare vendor-looking id is a forgotten prefix, not a mini run
  const bare = resolveProvider('google/gemini-2.5-flash', 'qwen2.5:14b');
  assert.equal(bare.ok, false);
  assert.equal(resolveProvider('openrouter:', 'q').ok, false);
});

test('F11: paid ceiling defaults to 250, stops at N and reports', () => {
  assert.equal(DEFAULT_PAID_CEILING, 250);
  const ok = checkPaidCeiling(249);
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.remaining, 1);
  const stop = checkPaidCeiling(250);
  assert.equal(stop.ok, false);
  assert.match((stop as { error: string }).error, /ceiling reached/);
  assert.equal((stop as { used: number }).used, 250);
  // explicit raise
  assert.equal(checkPaidCeiling(250, 500).ok, true);
});

// ── F12b — lab_source path policy ──────────────────────────────────────────────
test('F12b: allowlisted source files are readable', () => {
  for (const p of ['lib/mcp-tools.ts', 'app/api/admin/backfill-stable-ref/route.ts', 'lib/lvc-proposal-core.ts']) {
    const d = decideLabSource(p);
    assert.equal(d.ok, true, p);
  }
  assert.deepEqual([...LAB_SOURCE_ALLOW_PREFIXES], ['lib/', 'app/api/']);
});

test('F12b: ../ traversal cannot escape, even disguised behind an allowed prefix', () => {
  for (const p of ['../.env', 'lib/../../etc/passwd', 'lib/../.env.local', '../../secrets.ts']) {
    const d = decideLabSource(p);
    assert.equal(d.ok, false, p);
  }
  // the lexical normaliser is the thing doing the work
  assert.equal(normalizeRepoPath('lib/../.env.local'), '.env.local');
  assert.equal(normalizeRepoPath('../x'), null);
  assert.equal(normalizeRepoPath('lib/./a/../b.ts'), 'lib/b.ts');
});

test('F12b: denylisted names are refused wherever they sit, including under lib/', () => {
  for (const p of ['lib/.env.ts', 'lib/secrets.ts', 'lib/my-credentials.ts', 'app/api/token-store.ts', 'lib/api_key.ts']) {
    const d = decideLabSource(p);
    assert.equal(d.ok, false, p);
    assert.equal((d as { reason: string }).reason, 'denylisted', p);
  }
  // …but an innocent word containing a denylisted substring is fine
  assert.equal(decideLabSource('lib/keyboard-shortcuts.ts').ok, true);
  assert.equal(decideLabSource('lib/monkey-patch.ts').ok, true);
});

test('F12b: absolute paths, non-source files and anything outside the seam are refused', () => {
  assert.equal((decideLabSource('/etc/passwd') as { reason: string }).reason, 'absolute');
  assert.equal((decideLabSource('scripts/seed.mjs') as { reason: string }).reason, 'not_allowlisted');
  assert.equal((decideLabSource('data/formulary-2026.json') as { reason: string }).reason, 'not_allowlisted');
  assert.equal((decideLabSource('lib/logo.png') as { reason: string }).reason, 'not_source_file');
  assert.equal((decideLabSource('') as { reason: string }).reason, 'empty');
});

// ── F13 — provenance on ingest ─────────────────────────────────────────────────
test('F13: corpus_add refuses a chunk with no citation', () => {
  const r = checkCitationFields({ source_release_year: 2024, license_status: 'open' });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /citation is required/);
});

test('F13: accepts any ONE of url/doi/pmid with year + licence', () => {
  for (const cite of [{ citation_url: 'https://x' }, { citation_doi: '10.1/x' }, { citation_pmid: '12345' }]) {
    const r = checkCitationFields({ ...cite, source_release_year: 2024, license_status: 'open' });
    assert.equal(r.ok, true, JSON.stringify(cite));
  }
});

test('F13: the internal-protocol escape bypasses the gate entirely', () => {
  const r = checkCitationFields({ provenance: INTERNAL_PROTOCOL });
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.normalized.provenance, INTERNAL_PROTOCOL);
});

test('F13: year and licence are validated, not merely present', () => {
  assert.equal(checkCitationFields({ citation_url: 'https://x', license_status: 'open' }).ok, false);
  assert.equal(checkCitationFields({ citation_url: 'https://x', source_release_year: 24, license_status: 'open' }).ok, false);
  assert.equal(checkCitationFields({ citation_url: 'https://x', source_release_year: 2024 }).ok, false);
  assert.equal(checkCitationFields({ citation_url: 'https://x', source_release_year: 2024, license_status: 'invented' }).ok, false);
});

// ── F14 — propose / ratify / gaps ──────────────────────────────────────────────
const EXISTING: ExistingStatement[] = [
  { id: 'h-1', statement: 'Avoid: Diagnosis mismatch' },
  { id: 'h-2', statement: 'Limit: Diagnosis-complaint mismatch' },
  { id: 'cwus-aace-003', statement: "Don't routinely test vitamin D levels in asymptomatic adults without a specific risk factor" },
];
const GOOD_CITE = { citation_url: 'https://example.org/guideline', source_release_year: 2024, license_status: 'open' as const };

test('F14: lvc_propose refuses an uncited proposal', () => {
  const r = parseProposeArgs({ statement: 'Avoid: something entirely novel about renal dosing' }, EXISTING);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /citation is required/);
});

test('F14 (A10.4): lvc_propose REFUSES a near-duplicate unless supersedes_id is supplied', () => {
  const dup = parseProposeArgs({ statement: 'Avoid: Diagnosis-presentation mismatch', ...GOOD_CITE }, EXISTING);
  assert.equal(dup.ok, false);
  assert.match((dup as { error: string }).error, /near-duplicate/);
  assert.ok((dup as { duplicates?: unknown[] }).duplicates?.length);

  // the same proposal WITH a deliberate supersede is allowed through
  const sup = parseProposeArgs({ statement: 'Avoid: Diagnosis-presentation mismatch', supersedes_id: 'h-1', ...GOOD_CITE }, EXISTING);
  assert.equal(sup.ok, true);
  assert.equal(sup.ok && sup.value.supersedes_id, 'h-1');
});

test('F14: a genuinely distinct cited statement is accepted', () => {
  const r = parseProposeArgs({ statement: 'Avoid: Concurrent oral and topical NSAIDs in the same prescription', ...GOOD_CITE }, EXISTING);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.value.citation.source_release_year, 2024);
});

test('F14: the duplicate detector recognises the measured rulebook variants', () => {
  // the five real "diagnosis … mismatch" variants from the evidence audit
  assert.ok(statementSimilarity('Avoid: Diagnosis mismatch', 'Avoid: Diagnosis documentation mismatch') >= 0.6);
  assert.ok(statementSimilarity('Avoid: Diagnosis mismatch', 'Limit: Diagnosis-complaint mismatch') >= 0.6);
  // …and does not collapse genuinely different concepts
  assert.ok(statementSimilarity('Avoid: Unindicated Vitamin D prescription', 'Avoid: Concurrent oral and topical NSAIDs') < 0.6);
  assert.equal(findNearDuplicates('Avoid: Concurrent oral and topical NSAIDs', EXISTING).length, 0);
});

test('F14: lvc_ratify refuses without confirm, with the default author, or without a rationale', () => {
  const base = { proposal_id: 'p-1', ratified_by: 'Dr Khatija', rationale: 'reviewed the evidence' };
  assert.equal(parseRatifyArgs({ ...base }).ok, false);                                  // no confirm
  assert.match((parseRatifyArgs({ ...base }) as { error: string }).error, /confirm:true/);

  const dflt = parseRatifyArgs({ ...base, confirm: true, ratified_by: DEFAULT_AUTHOR });
  assert.equal(dflt.ok, false);
  assert.match((dflt as { error: string }).error, /no user identity/);

  assert.equal(parseRatifyArgs({ proposal_id: 'p-1', confirm: true, ratified_by: 'V' }).ok, false);   // no rationale
  assert.equal(parseRatifyArgs({ ...base, confirm: true }).ok, true);
});

test('F14: lvc_ratify is PROMOTE-ONLY — it cannot create de novo', () => {
  const noId = parseRatifyArgs({ confirm: true, ratified_by: 'V', rationale: 'x', statement: 'a brand new rule' });
  assert.equal(noId.ok, false);
  assert.match((noId as { error: string }).error, /can never create/);
});

test('F14: only a proposed row is promotable; rejection is first-class, never a delete', () => {
  assert.equal(checkPromotable('proposed').ok, true);
  assert.equal(checkPromotable('ratified').ok, false);
  assert.equal(checkPromotable('rejected').ok, false);
  assert.equal(checkPromotable(null).ok, false);
  const rej = parseRatifyArgs({ proposal_id: 'p-1', confirm: true, ratified_by: 'V', rationale: 'r', decision: 'rejected', reason: 'duplicate of cwus-aace-003' });
  assert.equal(rej.ok, true);
  assert.equal(rej.ok && rej.value.decision, 'rejected');
  assert.equal(parseRatifyArgs({ proposal_id: 'p-1', confirm: true, ratified_by: 'V', rationale: 'r', decision: 'rejected' }).ok, false);
});

test('F14: lvc_gaps calls a never-fired rule a RETIREMENT candidate, not a citation candidate', () => {
  const rows: GapRow[] = [
    { id: 'never', statement: 'Avoid: something nobody sees', source: 'ehrc', citation_url: null, citation_doi: null, citation_pmid: null, source_release_year: null, license_status: null, fires: 0 },
    { id: 'lic', statement: 'Choosing Wisely statement', source: 'cwus', citation_url: 'https://cw', citation_doi: null, citation_pmid: null, source_release_year: 2024, license_status: null, fires: 320 },
    { id: 'cite', statement: 'Avoid: Non-evidence-based supplement prescription', source: 'ehrc', citation_url: null, citation_doi: null, citation_pmid: null, source_release_year: null, license_status: 'open', fires: 64 },
  ];
  const out = classifyGaps(rows);
  const by = Object.fromEntries(out.map((g) => [g.id, g.gap_class]));
  assert.equal(by.never, 'retirement_candidate');
  assert.equal(by.lic, 'license_exposure');
  assert.equal(by.cite, 'citation_candidate');
  // licence exposure outranks citation work — that is the evidence audit's core finding
  assert.equal(out[0].id, 'lic');
  assert.match(out.find((g) => g.id === 'never')!.why, /never fired/);
});

test('F14: gaps rank by fires within class', () => {
  const rows: GapRow[] = [
    { id: 'a', statement: 'a', source: null, citation_url: null, citation_doi: null, citation_pmid: null, source_release_year: null, license_status: 'open', fires: 10 },
    { id: 'b', statement: 'b', source: null, citation_url: null, citation_doi: null, citation_pmid: null, source_release_year: null, license_status: 'open', fires: 300 },
  ];
  const out = classifyGaps(rows);
  assert.equal(out[0].id, 'b');
});

// ── F16 — source weight cap ────────────────────────────────────────────────────
test('F16: lab:/labq: weights are clamped at 0.855 until promoted', () => {
  assert.equal(LAB_SOURCE_WEIGHT_CAP, 0.855);
  assert.equal(clampSourceWeight('labq:guidelines-lvc-22jul', 0.9025), 0.855);
  assert.equal(clampSourceWeight('lab:something', 0.95), 0.855);
  // already below the cap is untouched
  assert.equal(clampSourceWeight('labq:x', 0.5), 0.5);
  // a promoted batch (activation A/B recorded) may exceed it
  assert.equal(clampSourceWeight('labq:x', 0.9025, true), 0.9025);
  // non-lab sources are never clamped
  assert.equal(clampSourceWeight('choosing-wisely', 0.95), 0.95);
  assert.equal(clampSourceWeight('uptodate', 0.9), 0.9);
  assert.equal(clampSourceWeight(null, 0.9), 0.9);
});

test('F17: feedback_detail ADMITS scope=impact (it was write-only) and validates its tags', () => {
  assert.deepEqual([...DETAIL_SCOPES], ['finding', 'missed', 'audit', 'impact']);
  const q = buildDetailSql({ appSource: 'standalone', scope: 'impact', limit: 10 });
  assert.match(q.text, /f\.scope = \$/);
  assert.ok(q.params.includes('impact'));
  // its verdict whitelist is IMPACT_TAGS, not the finding verdicts
  assert.doesNotThrow(() => buildDetailSql({ appSource: 'standalone', scope: 'impact', verdict: 'changes_management', limit: 10 }));
  assert.throws(() => buildDetailSql({ appSource: 'standalone', scope: 'impact', verdict: 'true_positive', limit: 10 }), /unknown verdict/);
  // an unknown scope is still refused
  assert.throws(() => buildDetailSql({ appSource: 'standalone', scope: 'nonsense' as never, limit: 10 }), /unknown scope/);
});
