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
import { LAB_TOOLS } from '../mcp-tools';
import { CORPUS_QUARANTINE_INSERT_SQL } from '../lab';
import { readFileSync } from 'node:fs';
import { applySaved, initProgress, type SavedEvent } from '../opd-feedback-ux-core';
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

// ── F6 UI contract — SavedEvent.category, applySaved semantics UNCHANGED ────────
test('F6 UI: SavedEvent carries category; applySaved dedupe semantics are unchanged', () => {
  const seed = initProgress({ total: 10, triagedRefs: ['a'], missed: 2 });
  // a missed save still bumps `missed` by exactly one, with or without a category
  const withCat: SavedEvent = { scope: 'missed', category: 'prescribing_safety' };
  const withoutCat: SavedEvent = { scope: 'missed' };
  assert.equal(applySaved(seed, withCat).missed, 3);
  assert.equal(applySaved(seed, withoutCat).missed, 3, 'category must not change the counter');
  assert.equal(applySaved(seed, withCat).triaged, seed.triaged, 'a missed save never bumps triaged');

  // finding dedupe is untouched: a NEW ref counts, an already-seen ref does not
  assert.equal(applySaved(seed, { findingRef: 'b' }).triaged, seed.triaged + 1);
  assert.equal(applySaved(seed, { findingRef: 'a' }).triaged, seed.triaged);
  assert.equal(applySaved(seed, { findingRef: 'a', category: 'coding' }).triaged, seed.triaged);
});

test('F6 UI: every category the controls offer is one the write path accepts', () => {
  // The controls render MISSED_CATEGORIES directly, so this pins the contract end-to-end: anything
  // a reviewer can click must parse. A divergence here is a 400 in a clinician's face.
  for (const c of MISSED_CATEGORIES) {
    const r = parseFeedbackBody({ auditId: AUDIT_ID, scope: 'missed', comment: 'x', category: c });
    assert.equal(r.ok, true, c);
  }
  assert.equal(MISSED_CATEGORIES.length, 7, 'the Review-Mode keys 1-7 map 1:1 onto the whitelist');
});

// ── Phase 2 WIRING — the tools exist, are shaped right, and reuse the cores ─────
type LooseTool = { name: string; description: string; inputSchema: { properties?: Record<string, unknown>; required?: readonly string[] } };
const TOOL = (n: string): LooseTool => {
  const t = (LAB_TOOLS as unknown as LooseTool[]).find((x) => x.name === n);
  assert.ok(t, `${n} must be registered`);
  return t;
};

test('wiring: the four new tools are registered with their required args', () => {
  for (const n of ['lab_source', 'corpus_add_batch', 'lvc_propose', 'lvc_ratify', 'lvc_gaps']) TOOL(n);
  assert.deepEqual([...(TOOL('lab_source').inputSchema.required ?? [])], ['path']);
  assert.deepEqual([...(TOOL('corpus_add_batch').inputSchema.required ?? [])], ['chunks']);
  assert.deepEqual([...(TOOL('lvc_propose').inputSchema.required ?? [])], ['statement']);
  // lvc_ratify's compensating controls are REQUIRED at the schema level, not just at runtime
  assert.deepEqual([...(TOOL('lvc_ratify').inputSchema.required ?? [])], ['proposal_id', 'confirm', 'ratified_by', 'rationale']);
});

test('wiring: corpus_add exposes all six F13 provenance fields', () => {
  const props = (TOOL('corpus_add').inputSchema.properties ?? {}) as Record<string, unknown>;
  for (const f of ['citation_url', 'citation_doi', 'citation_pmid', 'source_release_year', 'license_status', 'provenance']) {
    assert.ok(props[f], `corpus_add must expose ${f}`);
  }
});

test('wiring: F13 provenance reaches the INSERT, and quarantine stays invisible', () => {
  // The six columns are appended; the pre-F13 prefix and the literal false are untouched.
  assert.match(CORPUS_QUARANTINE_INSERT_SQL, /citation_url, citation_doi, citation_pmid, source_release_year, license_status, provenance\)/);
  assert.match(CORPUS_QUARANTINE_INSERT_SQL, /\$10, false, \$11, \$12, \$13, \$14, \$15, \$16\)/);
  assert.match(CORPUS_QUARANTINE_INSERT_SQL, /ON CONFLICT \(book, text_hash\) DO NOTHING/);
});

test('wiring: every new tool description states its WRITE-CLASS (F3 discipline held)', () => {
  for (const n of ['lab_source', 'corpus_add_batch', 'lvc_propose', 'lvc_ratify', 'lvc_gaps']) {
    assert.match(TOOL(n).description, /WRITE-CLASS:/, n);
  }
  // and the one that actually touches the live rulebook says so
  assert.match(TOOL('lvc_ratify').description, /PRODUCTION-WRITE/);
  assert.match(TOOL('lab_source').description, /read-only/);
});

test('wiring: lvc_propose never claims to write the rulebook; lvc_ratify is promote-only', () => {
  assert.match(TOOL('lvc_propose').description, /NEVER written/);
  assert.match(TOOL('lvc_ratify').description, /PROMOTE-ONLY|never create/i);
  assert.match(TOOL('lvc_gaps').description, /RETIREMENT candidate/);
});

// ── F14 schema correction (26 Jul, orchestrator-validated live) ─────────────────
// These pin the five faults against the SOURCE TEXT of lib/mcp-tools.ts. They are deliberately
// text-level: the faults were column NAMES in inferred SQL, which no type system catches and no
// pure-core test can reach. All five failed CLOSED, so nothing was corrupted — but lvc_propose
// refused every proposal and every promotion would have errored on a null id.
const MCP_SRC = readFileSync(new URL('../mcp-tools.ts', import.meta.url), 'utf8');

test('F14 faults 1a + 7: ALL THREE lvc_recommendations query sites use `society`, never `source`', () => {
  // FAULT 7's lesson, pinned: the original guard was scoped to the two sites named in correction 1
  // (the dedup set and the promotion INSERT) and therefore could not catch the third — the lvc_gaps
  // SELECT — which only surfaced when the tool was actually CALLED against production. This
  // assertion is now written over the whole file so a fourth site cannot appear unnoticed.
  assert.match(MCP_SRC, /SELECT id::text AS id, statement, society AS source, 'live' AS status FROM lvc_recommendations/);  // 1a dedup
  assert.match(MCP_SRC, /SELECT r\.id::text AS id, r\.statement, r\.society AS source,/);                                   // 7  lvc_gaps
  assert.match(MCP_SRC, /\(id, region, society, statement, rationale/);                                                     // 1b INSERT
  // NOTHING anywhere SELECTS a bare `source` column off that table or its alias. Scoped to the
  // SQL shape — `r.source` in JS is legitimate, since it reads the row returned BY the alias.
  assert.doesNotMatch(MCP_SRC, /statement, source,[^\n]*FROM lvc_recommendations/);
  assert.doesNotMatch(MCP_SRC, /r\.statement, r\.source/);
  assert.doesNotMatch(MCP_SRC, /SELECT[^`]*\br\.source\b/);
});

test('F14 fault 6: region is supplied — the NOT NULL set is exactly id, region, society, statement', () => {
  // MEASURED live: those four are NOT NULL with no default. All four are supplied.
  assert.match(MCP_SRC, /VALUES \('ehrc-' \|\| gen_random_uuid\(\)::text, 'IN', 'EHRC', \$1,/);
  assert.match(MCP_SRC, /\(id, region, society, statement,/);
  // status stays unsupplied — it defaults to 'active'
  assert.doesNotMatch(MCP_SRC, /\(id, region, society, statement, status/);
});

test('F14 fault 1b: the promoted row is society=EHRC, UPPERCASE', () => {
  assert.match(MCP_SRC, /gen_random_uuid\(\)::text, 'IN', 'EHRC',/);
  // lowercase would mis-segment every society comparison against the existing 67 house rows
  assert.doesNotMatch(MCP_SRC, /,\s*'ehrc',\s*\$1/);
});

test('F14 faults 2-4: the promotion INSERT names the three audit columns 0024 adds', () => {
  for (const col of ['proposed_by', 'ratified_by', 'ratified_at']) {
    assert.ok(MCP_SRC.includes(col), `promotion INSERT must carry ${col}`);
  }
  assert.match(MCP_SRC, /source_release_year, license_status, provenance, proposed_by, ratified_by, ratified_at\)/);
});

test('F14 fault 5: `id` is supplied explicitly, matching the ehrc-<uuid> convention', () => {
  // id is text NOT NULL with NO DEFAULT — an unsupplied id fails every promotion
  assert.match(MCP_SRC, /\(id, region, society, statement, rationale, citation_url/);
  assert.match(MCP_SRC, /'ehrc-' \|\| gen_random_uuid\(\)::text/);
  assert.match(MCP_SRC, /RETURNING id/);
});

test('F14: migration 0024 is additive, idempotent, and targets ONE table', () => {
  const sql = readFileSync(new URL('../../migrations/0024_lvc_recommendations_ratification_columns.sql', import.meta.url), 'utf8');
  for (const col of ['proposed_by', 'ratified_by', 'ratified_at']) {
    assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${col}`));
  }
  assert.doesNotMatch(sql, /\bDROP\b/i);
  assert.doesNotMatch(sql, /^\s*UPDATE\b/im);
  // one migration, one table — mixing targets is how the 0023 wrong-table defect happened
  assert.doesNotMatch(sql, /ALTER TABLE mksap_chunks/);
  assert.doesNotMatch(sql, /ALTER TABLE corpus\b/);
});

test('migration 0023 targets mksap_chunks and never a table called `corpus`', () => {
  const sql = readFileSync(new URL('../../migrations/0023_lvc_proposals_and_provenance.sql', import.meta.url), 'utf8');
  assert.match(sql, /ALTER TABLE mksap_chunks ADD COLUMN IF NOT EXISTS citation_url/);
  assert.doesNotMatch(sql, /ALTER TABLE corpus\b/);
  assert.doesNotMatch(sql, /\bDROP\b/i);
  // the header comment must not name the wrong table either — it did, and the file itself
  // corrected that name 6 lines further down, which is exactly how a stale comment misleads
  assert.doesNotMatch(sql, /column names on `corpus`/);
});

test('0023 and the runtime DDL agree on lvc_ratifications.promoted_id', () => {
  // THE DRIFT THIS PINS: lvc_ratify's INSERT supplies promoted_id and the runtime DDL in
  // mcp-tools.ts always created it, but 0023 omitted it — so whichever ran FIRST decided whether
  // the column existed, and CREATE TABLE IF NOT EXISTS silently made the loser a no-op. Found by V
  // when applying 0023 live. Both definitions must now carry it, and the ALTER converges a database
  // whose table was created by the runtime path before the column existed there.
  const sql = readFileSync(new URL('../../migrations/0023_lvc_proposals_and_provenance.sql', import.meta.url), 'utf8');
  const mcp = readFileSync(new URL('../mcp-tools.ts', import.meta.url), 'utf8');
  assert.match(sql, /promoted_id\s+text,/, '0023 CREATE TABLE must declare promoted_id');
  assert.match(sql, /ALTER TABLE lvc_ratifications ADD COLUMN IF NOT EXISTS promoted_id text;/);
  assert.match(mcp, /promoted_id text,\n\s*created_at timestamptz NOT NULL DEFAULT now\(\)\n\)`;/);
  assert.match(mcp, /INSERT INTO lvc_ratifications \(proposal_id, decision, ratified_by, rationale, promoted_id\)/);
});

test('0023 remains a NO-OP on re-run: every statement is guarded, nothing destructive', () => {
  const sql = readFileSync(new URL('../../migrations/0023_lvc_proposals_and_provenance.sql', import.meta.url), 'utf8');
  const stripped = sql.replace(/--.*$/gm, '');
  // \s in the filter so `created_at ...` inside a CREATE TABLE body is not mistaken for a statement
  for (const stmt of stripped.split('\n').map((l) => l.trim()).filter((l) => /^(ALTER|CREATE)\s/i.test(l))) {
    assert.match(stmt, /IF NOT EXISTS/i, `unguarded statement would fail a re-run: ${stmt.slice(0, 80)}`);
  }
  assert.doesNotMatch(stripped, /\b(DROP|TRUNCATE|DELETE)\b/i);
  assert.doesNotMatch(stripped, /^\s*UPDATE\b/im);
});

// ── F11 option 3 — Lab-MCP side ────────────────────────────────────────────────
const HAS_MODEL = ['mini_analyze', 'lab_ddx', 'lab_ask'];
const NO_MODEL = ['lab_appropriateness', 'lab_pathway', 'lab_case_audit'];

test('F11: exactly the three honourable probe tools expose `model` and `ceiling`', () => {
  for (const n of HAS_MODEL) {
    const props = (TOOL(n).inputSchema.properties ?? {}) as Record<string, unknown>;
    assert.ok(props.model, `${n} must expose model`);
    assert.ok(props.ceiling, `${n} must expose ceiling`);
  }
});

test('F11: the three unwired-route probes have NO model param and SAY why (A4)', () => {
  for (const n of NO_MODEL) {
    const props = (TOOL(n).inputSchema.properties ?? {}) as Record<string, unknown>;
    assert.equal(props.model, undefined, `${n} must NOT expose model — it would silently do nothing`);
    assert.equal(props.ceiling, undefined, `${n} must NOT expose ceiling`);
    // and the description must state the limitation so no caller infers coverage
    assert.match(TOOL(n).description, /NO `model` PARAMETER/, n);
    assert.match(TOOL(n).description, /LOCAL MAC-MINI only/, n);
    assert.match(TOOL(n).description, /do not infer coverage/, n);
  }
});

test('F11: the model param resolves all three prefixes and errors loud on unknown', () => {
  const mini = 'qwen2.5:14b';
  const ol = resolveProvider('ollama:qwen2.5:14b', mini);
  assert.equal(ol.ok && ol.provider, 'ollama');
  const o = resolveProvider('openrouter:google/gemini-2.5-flash', mini);
  assert.equal(o.ok && o.provider, 'openrouter');
  assert.equal(o.ok && o.model, 'google/gemini-2.5-flash', 'the RESOLVED string is stored, never the prefixed request');
  const vx = resolveProvider('vertex:gemini-2.5-pro', mini);
  assert.equal(vx.ok && vx.provider, 'vertex');
  const bad = resolveProvider('gpt5:turbo', mini);
  assert.equal(bad.ok, false);
  assert.match((bad as { error: string }).error, /Never falls back/);
});

test('F11: omitted model ⇒ the local mini, byte-identical, and NOT paid', () => {
  const d = resolveProvider(undefined, 'qwen2.5:14b');
  assert.equal(d.ok && d.provider, 'ollama');
  assert.equal(d.ok && d.model, 'qwen2.5:14b');
  assert.equal(d.ok && d.paid, false, 'a free local run must never consume paid budget');
  // the request body/headers are only augmented when a model is asked for
  const SRC = readFileSync(new URL('../mcp-tools.ts', import.meta.url), 'utf8');
  assert.match(SRC, /return m \? \{ \.\.\.base, labModel: m \} : base;/);
  assert.match(SRC, /return S\(a\.model\)\.trim\(\) \? \{ \[LAB_ORIGIN_HEADER\]: LAB_ORIGIN_VALUE/);
});

test('F11: the paid ceiling stops at N and reports; free runs never count', () => {
  assert.equal(DEFAULT_PAID_CEILING, 250);
  assert.equal(checkPaidCeiling(249).ok, true);
  const stop = checkPaidCeiling(250);
  assert.equal(stop.ok, false);
  assert.match((stop as { error: string }).error, /ceiling reached/);
  assert.equal(checkPaidCeiling(250, 500).ok, true, 'raised only by passing it explicitly');
});

test('F11: provider is recorded on lab_analyses alongside the RESOLVED model', () => {
  const LAB_SRC = readFileSync(new URL('../lab.ts', import.meta.url), 'utf8');
  assert.match(LAB_SRC, /ALTER TABLE lab_analyses ADD COLUMN IF NOT EXISTS provider text/);
  assert.match(LAB_SRC, /input_preview, output, model, latency_ms, provider\)/);
  assert.match(LAB_SRC, /r\.provider \?\? null/);
  // the ceiling counts PROVIDER, not model — a free local run must not consume budget
  assert.match(LAB_SRC, /provider IS NOT NULL AND provider <> 'ollama'/);
  const SRC = readFileSync(new URL('../mcp-tools.ts', import.meta.url), 'utf8');
  assert.match(SRC, /provider: M\.provider, model: M\.model,/);
  // ⚠️ REPHRASED 7 Aug 2026 (F11 DEC-2), same property. The requested provider/model still reach
  // the pending row through one expression — it is now named `requested`, because that is what it
  // is: a statement of intent. It is what the row OPENS with, no longer what the row is allowed to
  // END with. On a checked probe the final columns are settled against the trace (see
  // lib/lab-attribution-core.ts and lib/__tests__/lab-attribution.test.ts), after a run stored a
  // Bedrock claim over three qwen legs.
  assert.match(SRC, /const requested = \{ provider: opts\.provider \?\? 'ollama', model: opts\.model \?\? MINI_MODEL \};/);
  assert.match(SRC, /inputPreview: opts\.inputPreview, model: requested\.model, provider: requested\.provider,/);
});

test('F11: NO route file was touched in this build', () => {
  // the two wired routes keep exactly the wiring shipped in cfc995b; nothing here edits a route
  for (const r of ['ask', 'ddx']) {
    const src = readFileSync(new URL(`../../app/api/${r}/route.ts`, import.meta.url), 'utf8');
    assert.match(src, /resolveLabOverride/, `${r} stays wired`);
  }
  for (const r of ['appropriateness', 'pathway/skeleton', 'doc-audit/analyze']) {
    const src = readFileSync(new URL(`../../app/api/${r}/route.ts`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /resolveLabOverride/, `${r} stays unwired`);
  }
});

test('F11: the engine label is DERIVED from the resolved provider, not hardcoded', () => {
  const SRC = readFileSync(new URL('../mcp-tools.ts', import.meta.url), 'utf8');
  // the two probes whose provider can actually vary
  assert.match(SRC, /engine: `ddx-route\/\$\{engineSuffix\(M\.provider\)\}`/);
  assert.match(SRC, /engine: `ask-route\/\$\{engineSuffix\(M\.provider\)\}`/);
  // neither still carries the hardcoded literal that stamped Vertex runs as 'mini'
  assert.doesNotMatch(SRC, /engine: 'ask-route\/mini'/);
  assert.doesNotMatch(SRC, /engine: 'ddx-route\/mini'/);
  // …while the three probes that genuinely CANNOT vary keep their literal, because it is TRUE
  for (const lit of ["appropriateness-route/mini", "pathway-route/mini", "doc-audit-route/mini"]) {
    assert.ok(SRC.includes(`engine: '${lit}'`), `${lit} is accurate — those tools have no model param`);
  }
});

test('F11: ollama maps back to "mini" so every historical label is preserved exactly', () => {
  const SRC = readFileSync(new URL('../mcp-tools.ts', import.meta.url), 'utf8');
  assert.match(SRC, /return provider === 'ollama' \? 'mini' : provider;/);
  // i.e. a free run still writes 'ask-route/mini' — nothing reading this column has to change
});

test('F11: mini_analyze TEXT mode refuses a model rather than accepting and ignoring it', () => {
  const SRC = readFileSync(new URL('../mcp-tools.ts', import.meta.url), 'utf8');
  assert.match(SRC, /text mode runs on the local mini only and cannot honour a model/);
  // and it records its provider explicitly rather than leaving it null
  assert.match(SRC, /model: MINI_MODEL, provider: 'ollama', latencyMs/);
});
