/**
 * lib/__tests__/ipd-episode-scoring.test.ts — PRD §13 items 5–11, 16 and 17. Pure core only.
 *
 * EVERY RULE HERE IS TESTED AS CODE, NOT AS PROMPT TEXT. That is the whole design: the prompts
 * state the Tier C rule, the uncited cap, the A2 domain fence and the commentary ban on numbers,
 * and then this layer re-applies each of them to whatever actually came back. A prompt is an
 * instruction; only these functions are a guarantee.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyTierCRule, applyUncitedCap, attachAttribution, attributedParty, completenessPct,
  countFindings, divergenceIndex, normalizeFidelityFindings, evidenceTiersOf, finalizeFindings,
  parseFindings, resolveFindingCitations, validateCommentary, asLvcCategory, SEVERITY_PENALTY,
  PARSE_FRAGMENT_CHARS, classifyCitationProvenance, applyLiteratureCap, scoringStatusFor,
  storedDivergenceIndex, impliedFindingType, capSeverityAt, CAP_SEVERITY_CEILING,
  dropJudgedOmissions, enforceUnassessable, findingsFromResolved, domainForSection,
  type EpisodeFinding, type Severity, type Verdict, type Domain, type AuditPass,
} from '../ipd-episode/judge-core';
import {
  checkpointEntryRefs, parseExpectedCourse, buildRetrievalQuery, renderExpectedCourse,
  ordinalForChunkId, countUncitedEntries, everyEntryUncited, buildCheckpointUser,
  clinicalTerms, retrievalIsOffTopic, assessTopicality, retrievedTitles, RETRIEVED_TITLE_CHARS,
  drugBaseName, clinicalTextForQuery, stripPersonNames, clinicalWordsOnly, MIN_SHARED_TERMS,
  type CheckpointEntryRef,
} from '../ipd-episode/checkpoint-core';
import { checkpointModel, IPD_EPISODE_CHECKPOINT_MODEL_DEFAULT } from '../ipd-episode/checkpoint';
import { judgeModel, IPD_EPISODE_JUDGE_MODEL_DEFAULT } from '../ipd-episode/judge';
import { assertKnownBedrockModel, isKnownBedrockModel } from '../bedrock-core';
import { skipIsRetryable, SKIP_RETRY_DAYS } from '../ipd-episode/store';
import { IPD_EPISODE_CHECKPOINT_SYSTEM, IPD_EPISODE_DIFF_SYSTEM } from '../ipd-episode/prompts';
import type { EpisodeEvent } from '../ipd-episode/assemble-core';

const f = (o: Partial<EpisodeFinding> & { finding_id: string }): EpisodeFinding => ({
  // NB: defaults to `commission` since decision 33 — a JUDGED omission is dropped, so an
  // omission-by-default fixture would silently test nothing. Resolver findings set `resolution`.
  pass: 'divergence' as AuditPass, finding_type: 'commission', verdict: 'divergent' as Verdict,
  domain: 'diagnostics' as Domain, day_index: 0, checkpoint_ref: null, statement: 'a statement',
  severity: 'minor' as Severity, evidence_tier: 'A',
  evidence_basis: [{ source_table: 'kx_clinical_template_progress_reports', source_record_id: 'n1', source_timestamp: null }],
  author_name: null, author_role: null, responsible_clinician_id: null, lvc_category: null,
  citation_ids: [], citation_provenance: null,
  verdict_before_cap: null, severity_before_cap: null, capped: false,
  resolution: null, matcher_kind: null, matcher_terms: null, matched_term: null, confound: null,
  ...o,
});

const refs = (entries: [string, number[]][]): Map<string, CheckpointEntryRef> =>
  new Map(entries.map(([ref, citation_ids]) => [ref, { ref, citation_ids }]));

// ── 5. divergence index ──────────────────────────────────────────────────────────────────────

test('divergence index: 100 minus 8·major + 4·moderate + 1·minor', () => {
  assert.equal(SEVERITY_PENALTY.major, 8);
  assert.equal(SEVERITY_PENALTY.moderate, 4);
  assert.equal(SEVERITY_PENALTY.minor, 1);
  assert.equal(divergenceIndex([]), 100);
  assert.equal(divergenceIndex([f({ finding_id: '1', severity: 'major' })]), 92);
  assert.equal(divergenceIndex([f({ finding_id: '1', severity: 'moderate' })]), 96);
  assert.equal(divergenceIndex([f({ finding_id: '1', severity: 'minor' })]), 99);
  assert.equal(divergenceIndex([
    f({ finding_id: '1', severity: 'major' }), f({ finding_id: '2', severity: 'moderate' }), f({ finding_id: '3', severity: 'minor' }),
  ]), 100 - 13);
});

test('divergence index floors at zero and never goes negative', () => {
  const many = Array.from({ length: 20 }, (_, i) => f({ finding_id: String(i), severity: 'major' }));
  assert.equal(divergenceIndex(many), 0);
});

test('divergence index: only `divergent` contributes — the other three verdicts are free', () => {
  for (const verdict of ['context_dependent', 'unassessable', 'concordant'] as Verdict[]) {
    assert.equal(divergenceIndex([f({ finding_id: '1', severity: 'major', verdict })]), 100, verdict);
  }
});

test('divergence index: A1 and A2 findings BOTH count, on one shared penalty (decision 16)', () => {
  const both = [
    f({ finding_id: 'a1', pass: 'divergence', severity: 'major' }),
    f({ finding_id: 'a2', pass: 'fidelity', domain: 'documentation', finding_type: 'commission', severity: 'moderate' }),
  ];
  assert.equal(divergenceIndex(both), 100 - 12);
});

// ── 6. the Tier C rule ───────────────────────────────────────────────────────────────────────

test('Tier C rule: a divergent finding resting only on Tier C sources is rewritten to unassessable', () => {
  const only_c = f({ finding_id: '1', evidence_basis: [{ source_table: 'kx_radiology_reports', source_record_id: 'r1', source_timestamp: null }] });
  const res = applyTierCRule(only_c);
  assert.equal(res.rewritten, true);
  assert.equal(res.finding.verdict, 'unassessable');
});

test('Tier C rule: an EMPTY evidence basis is rewritten too — an uncited claim is not a verdict', () => {
  const res = applyTierCRule(f({ finding_id: '1', evidence_basis: [] }));
  assert.equal(res.rewritten, true);
  assert.equal(res.finding.verdict, 'unassessable');
});

test('Tier C rule: a MIXED A-and-C basis is left alone — one real source is enough', () => {
  const mixed = f({ finding_id: '1', evidence_basis: [
    { source_table: 'kx_radiology_reports', source_record_id: 'r1', source_timestamp: null },
    { source_table: 'kx_billing_records', source_record_id: 'b1', source_timestamp: null },
  ] });
  const res = applyTierCRule(mixed);
  assert.equal(res.rewritten, false);
  assert.equal(res.finding.verdict, 'divergent');
});

test('Tier C rule reads the SOURCE TABLE, not the model’s own evidence_tier claim', () => {
  // the model says tier A; the basis says radiology, which this mirror does not hold
  const lying = f({ finding_id: '1', evidence_tier: 'A', evidence_basis: [{ source_table: 'kx_radiology_reports', source_record_id: 'r1', source_timestamp: null }] });
  assert.equal(applyTierCRule(lying).finding.verdict, 'unassessable');
});

test('Tier C rule touches only `divergent` findings — a context_dependent one is already honest', () => {
  const cd = f({ finding_id: '1', verdict: 'context_dependent', evidence_basis: [] });
  assert.equal(applyTierCRule(cd).rewritten, false);
  assert.equal(applyTierCRule(cd).finding.verdict, 'context_dependent');
});

// ── 7. the uncited cap ───────────────────────────────────────────────────────────────────────

test('uncited cap: an A1 finding on an entry with no citations is capped to moderate, verdict intact', () => {
  const map = refs([['cp-d1/diagnostics/1', []]]);
  const res = applyUncitedCap(f({ finding_id: '1', severity: 'major', verdict: 'divergent', checkpoint_ref: 'cp-d1/diagnostics/1' }), map);
  assert.equal(res.capped, true);
  assert.equal(res.finding.severity, 'moderate');
  assert.equal(res.finding.verdict, 'divergent');
});

test('uncited cap does NOT apply to a fidelity finding — A2 measures against the record, not an expectation', () => {
  const map = refs([['cp-d1/diagnostics/1', []]]);
  const a2 = f({ finding_id: '1', pass: 'fidelity', domain: 'documentation', finding_type: 'commission', severity: 'major', checkpoint_ref: 'cp-d1/diagnostics/1' });
  const res = applyUncitedCap(a2, map);
  assert.equal(res.capped, false);
  assert.equal(res.finding.severity, 'major');
});

test('uncited cap: BOTH the finding and its entry must cite — one alone is not enough', () => {
  const map = refs([['cp-d1/diagnostics/1', [4021]]]);
  const both = applyUncitedCap(f({ finding_id: '1', severity: 'major', checkpoint_ref: 'cp-d1/diagnostics/1', citation_ids: [4021] }), map);
  assert.equal(both.capped, false, 'entry cited AND finding cited');
  assert.equal(both.finding.severity, 'major');

  // ⚠️ THE IP-1286 DEFECT: the entry was cited, the finding cited nothing, and the old rule read
  // only the entry — so the major VTE finding kept full weight and supplied 8 of 12 penalty points
  const findingUncited = applyUncitedCap(f({ finding_id: '2', severity: 'major', checkpoint_ref: 'cp-d1/diagnostics/1', citation_ids: [] }), map);
  assert.equal(findingUncited.capped, true, 'a finding that cites nothing is not grounded, whatever its entry did');
  assert.equal(findingUncited.finding.severity, 'moderate');
  assert.equal(findingUncited.finding.verdict, 'divergent', 'and its verdict is untouched');

  const entryUncited = applyUncitedCap(f({ finding_id: '3', severity: 'major', checkpoint_ref: 'cp-d1/therapeutics/9', citation_ids: [4021] }), refs([['cp-d1/therapeutics/9', []]]));
  assert.equal(entryUncited.capped, true, 'an ungrounded expectation caps too');
});

test('THE CAP TOUCHES SEVERITY ONLY — an uncited finding keeps its verdict, including divergent', () => {
  const map = refs([['cp-d0/diagnostics/1', []]]);
  const r = applyUncitedCap(f({ finding_id: 'x', severity: 'major', verdict: 'divergent', checkpoint_ref: 'cp-d0/diagnostics/1' }), map);
  assert.equal(r.capped, true);
  assert.equal(r.finding.severity, 'moderate', 'the ceiling is moderate, not minor');
  assert.equal(r.finding.verdict, 'divergent', 'the verdict is not the cap’s business');
});

test('the cap no longer ERASES concordant findings — the defect that cost IP-1286 nine of thirteen', () => {
  const map = refs([['cp-d0/diagnostics/1', []]]);
  for (const verdict of ['concordant', 'unassessable', 'context_dependent', 'divergent'] as const) {
    const r = applyUncitedCap(f({ finding_id: verdict, severity: 'minor', verdict, checkpoint_ref: 'cp-d0/diagnostics/1' }), map);
    assert.equal(r.finding.verdict, verdict, `${verdict} must survive the cap intact`);
    assert.equal(r.capped, false, 'a minor finding is already at the ceiling, so nothing changes');
  }
});

test('the ceiling lowers a major and leaves moderate and minor alone', () => {
  const map = refs([['cp-d0/diagnostics/1', []]]);
  const at = (severity: 'major' | 'moderate' | 'minor') =>
    applyUncitedCap(f({ finding_id: severity, severity, verdict: 'divergent', checkpoint_ref: 'cp-d0/diagnostics/1' }), map);
  assert.equal(at('major').finding.severity, 'moderate');
  assert.equal(at('major').capped, true);
  assert.equal(at('moderate').capped, false);
  assert.equal(at('minor').finding.severity, 'minor');
});

test('THE TWO CEILINGS ARE ONE CEILING — they do not stack down to minor', () => {
  assert.equal(CAP_SEVERITY_CEILING, 'moderate');
  assert.equal(capSeverityAt('major', 'moderate'), 'moderate');
  assert.equal(capSeverityAt('minor', 'moderate'), 'minor', 'a ceiling never raises');
  assert.equal(capSeverityAt(capSeverityAt('major', 'moderate'), 'moderate'), 'moderate', 'idempotent');

  // uncited AND literature-only: both caps fire, and the result is moderate — not minor
  const map = refs([['cp-d0/diagnostics/1', []]]);
  const res = finalizeFindings([
    f({ finding_id: 'both', severity: 'major', verdict: 'divergent', checkpoint_ref: 'cp-d0/diagnostics/1', citation_ids: [7788] }),
  ], map, [], 0, SOURCES, NORMATIVE);
  const only = res.findings[0];
  assert.equal(only.severity, 'moderate', 'stacking would have produced minor');
  assert.equal(only.verdict, 'divergent');
  assert.equal(only.citation_provenance, 'literature');
  assert.equal(res.divergence_index, 96, 'one moderate divergent finding');
});

test('uncited cap: a NULL checkpoint_ref is capped — an A1 finding measured against nothing is the case the cap exists for', () => {
  const map = refs([['cp-d1/diagnostics/1', [4021]]]);
  const res = applyUncitedCap(f({ finding_id: '1', severity: 'major', verdict: 'divergent', checkpoint_ref: null }), map);
  assert.equal(res.capped, true);
  assert.equal(res.finding.severity, 'moderate');
  assert.equal(res.finding.verdict, 'divergent');
});

test('uncited cap: an UNRESOLVABLE checkpoint_ref is capped too — citing nothing must not beat citing badly', () => {
  const map = refs([['cp-d1/diagnostics/1', [4021]]]);
  const res = applyUncitedCap(f({ finding_id: '1', severity: 'major', verdict: 'divergent', checkpoint_ref: 'cp-d9/diagnostics/7' }), map);
  assert.equal(res.capped, true);
  assert.equal(res.finding.severity, 'moderate');
});

test('uncited cap: capping the ungrounded cases removes the evasion — a major A1 finding cannot score by citing nothing', () => {
  const map = refs([['cp-d0/diagnostics/1', [4021]]]);
  const grounded = f({ finding_id: 'grounded', severity: 'major', checkpoint_ref: 'cp-d0/diagnostics/1', citation_ids: [4021] });
  const evasive = f({ finding_id: 'evasive', severity: 'major', checkpoint_ref: null });
  const res = finalizeFindings([grounded, evasive], map, [], 0, SOURCES, NORMATIVE);
  assert.equal(res.n_uncited_capped, 1);
  // the grounded major scores 8; the ungrounded one is now moderate and divergent, so it scores 4
  assert.equal(res.divergence_index, 100 - 12);
});

test('the cap is auditable from the stored finding, not from a response string', () => {
  const map = refs([['cp-d0/diagnostics/1', []]]);
  const res = finalizeFindings([
    f({ finding_id: 'capped', severity: 'major', verdict: 'divergent', checkpoint_ref: 'cp-d0/diagnostics/1' }),
    f({ finding_id: 'clean', severity: 'moderate', verdict: 'divergent', checkpoint_ref: 'cp-d0/diagnostics/1', citation_ids: [4021] }),
  ], refs([['cp-d0/diagnostics/1', [4021]]]), [], 0, SOURCES, NORMATIVE);
  const capped = res.findings.find((x) => x.finding_id === 'capped')!;
  assert.equal(capped.capped, true);
  assert.equal(capped.verdict_before_cap, 'divergent', 'what the model said, before code intervened');
  assert.equal(capped.severity_before_cap, 'major');
  assert.equal(capped.verdict, 'divergent', 'the verdict survives — only severity moved');
  assert.equal(capped.severity, 'moderate');
  const clean = res.findings.find((x) => x.finding_id === 'clean')!;
  assert.equal(clean.capped, false);
  assert.equal(clean.verdict_before_cap, 'divergent');
  // capped_count is recountable from the findings themselves
  assert.equal(res.capped_finding_ids.size, res.findings.filter((x) => x.capped).length);
});

// the ordered mksap_chunks ids a checkpoint's retrieval returned; the prompt showed them as [1][2][3]
const CHUNKS = [4021, 7788, 1503];

test('checkpoint entry refs address every entry of an expected course, section by section', () => {
  const course = parseExpectedCourse(JSON.stringify({
    expected_diagnostics: [{ item: 'CBC', by_day: 0, rationale: 'r', citation_ids: [1] }, { item: 'CRP', by_day: 1, rationale: 'r', citation_ids: [] }],
    expected_therapeutics: [{ item: 'IV fluids', by_day: 0, rationale: 'r', citation_ids: [] }],
    expected_monitoring: [{ item: 'hourly urine output', frequency: 'hourly', rationale: 'r', citation_ids: [2] }],
    escalation_triggers: [{ trigger: 'SBP < 90', action: 'escalate', citation_ids: [] }],
    expected_los_days: 3, expected_disposition: 'home', uncertainty: ['no vitals in this substrate'],
  }), CHUNKS);
  assert.ok(course);
  const r = checkpointEntryRefs('cp-d0', course);
  assert.deepEqual(r.map((x) => x.ref), [
    'cp-d0/diagnostics/1', 'cp-d0/diagnostics/2', 'cp-d0/therapeutics/1', 'cp-d0/monitoring/1', 'cp-d0/escalation/1',
  ]);
  assert.deepEqual(r.find((x) => x.ref === 'cp-d0/diagnostics/1')!.citation_ids, [4021]);
  assert.deepEqual(r.find((x) => x.ref === 'cp-d0/diagnostics/2')!.citation_ids, []);
});

test('an entry’s citation ordinal is resolved to the REAL chunk id it stood for', () => {
  const course = parseExpectedCourse(JSON.stringify({
    expected_diagnostics: [{ item: 'CBC', by_day: 0, rationale: 'r', citation_ids: [1, 3] }],
    expected_monitoring: [{ item: 'urine output', frequency: 'hourly', rationale: 'r', citation_ids: [2] }],
  }), CHUNKS);
  assert.deepEqual(course!.expected_diagnostics[0].citation_ids, [4021, 1503]);
  assert.deepEqual(course!.expected_monitoring[0].citation_ids, [7788]);
});

test('the entry and the checkpoint row now speak ONE vocabulary — both are chunk ids', () => {
  const course = parseExpectedCourse(JSON.stringify({
    expected_diagnostics: [{ item: 'CBC', by_day: 0, rationale: 'r', citation_ids: [2] }],
  }), CHUNKS);
  const entryIds = course!.expected_diagnostics[0].citation_ids;
  // before the mapping this was [2], which the row's citation_ids would have read as chunk 2 —
  // a real passage nobody was shown
  assert.deepEqual(entryIds, [7788]);
  for (const id of entryIds) assert.ok(CHUNKS.includes(id), 'every entry citation is one of the row’s own chunk ids');
});

test('an ordinal outside [1..k] is dropped, never renumbered and never passed through as an id', () => {
  const course = parseExpectedCourse(JSON.stringify({
    expected_diagnostics: [{ item: 'CBC', by_day: 0, rationale: 'r', citation_ids: [1, 9, 0, -2, 3] }],
  }), CHUNKS);
  assert.deepEqual(course!.expected_diagnostics[0].citation_ids, [4021, 1503]);
  // 9 must not survive as the literal 9 — that would be a citation to chunk 9
  assert.ok(!course!.expected_diagnostics[0].citation_ids.includes(9));
});

test('with no excerpts retrieved, every entry citation resolves to nothing', () => {
  const course = parseExpectedCourse(JSON.stringify({
    expected_diagnostics: [{ item: 'CBC', by_day: 0, rationale: 'r', citation_ids: [1, 2] }],
  }), []);
  assert.deepEqual(course!.expected_diagnostics[0].citation_ids, []);
});

test('the diff prompt is rendered back in ORDINALS, from the stored chunk ids', () => {
  const course = parseExpectedCourse(JSON.stringify({
    expected_diagnostics: [{ item: 'CBC', by_day: 0, rationale: 'r', citation_ids: [1, 3] }],
    expected_therapeutics: [{ item: 'IV fluids', by_day: 0, rationale: 'r', citation_ids: [] }],
  }), CHUNKS);
  const rendered = renderExpectedCourse('cp-d0', 0, 'daily', course, CHUNKS);
  assert.match(rendered, /\[citations 1, 3\]/, 'the model is shown the numbering it is asked to cite by');
  assert.match(rendered, /\[no citation\]/);
  assert.ok(!rendered.includes('4021'), 'raw chunk ids are never put in front of a model to transcribe');
  assert.equal(ordinalForChunkId(7788, CHUNKS), 2);
  assert.equal(ordinalForChunkId(999, CHUNKS), 0, 'a chunk this checkpoint never carried has no ordinal');
});

// ── items 1 and 2: the citation grounding failure measured on IP-1286 ────────────────────────

test('the checkpoint user message states the ordinal range as a NUMBER, twice', () => {
  const msg = buildCheckpointUser({
    checkpointId: 'cp-d0', checkpointType: 'daily', dayIndex: 0,
    cutoffAt: '2026-08-01T18:20:00.000Z', admissionContext: 'Speciality: General Medicine',
    events: [],
    excerpts: [1, 2, 3].map((n) => ({ id: n * 100, label: `src ${n}`, text: `excerpt ${n}` })),
  });
  assert.match(msg, /excerpts are numbered 1 to 3/, 'the legal range is stated, not implied by the block count');
  assert.match(msg, /citation_ids value between 1 and 3/, 'and restated in the closing instruction');
  assert.match(msg, /\[1\] src 1/, 'the excerpts themselves are numbered');
});

test('with no excerpts retrieved, the message says empty citations are expected — the one honest case', () => {
  const msg = buildCheckpointUser({
    checkpointId: 'cp-d0', checkpointType: 'daily', dayIndex: 0,
    cutoffAt: '2026-08-01T18:20:00.000Z', admissionContext: 'x', events: [], excerpts: [],
  });
  assert.match(msg, /none were retrieved/);
  assert.ok(!/numbered 1 to 0/.test(msg), 'it must not ask for a citation in an empty range');
});

test('the checkpoint prompt forbids filing missing care as uncertainty', () => {
  assert.match(IPD_EPISODE_CHECKPOINT_SYSTEM, /UNCERTAINTY IS NOT A PLACE TO PUT MISSING CARE/);
  assert.match(IPD_EPISODE_CHECKPOINT_SYSTEM, /belongs in the expected course, as an expectation, EVEN WHEN/);
  assert.match(IPD_EPISODE_CHECKPOINT_SYSTEM, /VTE prophylaxis/, 'the worked example is the case that vanished');
  assert.match(IPD_EPISODE_CHECKPOINT_SYSTEM, /an expectation you demoted to a note about uncertainty is nothing at all/);
});

test('the checkpoint prompt states the cap correctly — severity only, not verdict', () => {
  assert.match(IPD_EPISODE_CHECKPOINT_SYSTEM, /its severity is capped at moderate/);
  assert.ok(!IPD_EPISODE_CHECKPOINT_SYSTEM.includes('capped to minor and context_dependent'),
    'the old verdict-overriding text must not survive anywhere');
});

test('the diff prompt states that concordant is a VERDICT, not a finding_type', () => {
  assert.match(IPD_EPISODE_DIFF_SYSTEM, /"concordant" is a VERDICT/);
  assert.match(IPD_EPISODE_DIFF_SYSTEM, /Do not put "concordant" in finding_type/);
  assert.match(IPD_EPISODE_DIFF_SYSTEM, /finding_type is exactly one of: commission \| timing \| sequencing/);
  assert.match(IPD_EPISODE_DIFF_SYSTEM, /DO NOT REPORT OMISSIONS/, 'decision 33: code owns them');
  assert.match(IPD_EPISODE_DIFF_SYSTEM, /an audit that records only what went wrong is a defect list/);
});

test('the checkpoint prompt requires a citation per entry and shows a worked example', () => {
  assert.match(IPD_EPISODE_CHECKPOINT_SYSTEM, /MUST carry at least one of those numbers/);
  assert.match(IPD_EPISODE_CHECKPOINT_SYSTEM, /"citation_ids": \[3\]/, 'a worked example with a real number');
  // ⚠️ THE OLD TEXT INVITED THE FAILURE. It read "leave citation_ids empty — that is honest and
  // expected" and "do not pad citations". 42 of 42 entries came back uncited: the prompt working
  // as written. Neither sentence may return.
  assert.ok(!IPD_EPISODE_CHECKPOINT_SYSTEM.includes('that is honest and expected'));
  assert.ok(!IPD_EPISODE_CHECKPOINT_SYSTEM.includes('do not pad citations'));
});

test('item 4: an uncited expectation must still be EMITTED — an empty course is the worse failure', () => {
  assert.match(IPD_EPISODE_CHECKPOINT_SYSTEM, /STILL EMIT IT, WITH EMPTY citation_ids/);
  assert.match(IPD_EPISODE_CHECKPOINT_SYSTEM, /AN EMPTY EXPECTED COURSE IS THE WORST OUTPUT/);
  assert.match(IPD_EPISODE_CHECKPOINT_SYSTEM, /Never withhold an expectation because you cannot cite it/);
  // round 3 told it to return fewer entries rather than uncited ones — that instruction produced
  // the empty courses item 5 now has to defend against, and it must not come back
  assert.ok(!IPD_EPISODE_CHECKPOINT_SYSTEM.includes('return fewer entries rather than a list of uncited ones'));
  // the citation requirement itself survives
  assert.match(IPD_EPISODE_CHECKPOINT_SYSTEM, /MUST carry at least one of those numbers/);
});

test('uncited entries are COUNTED, never repaired by guessing a citation', () => {
  const course = parseExpectedCourse(JSON.stringify({
    expected_diagnostics: [
      { item: 'CBC', by_day: 0, rationale: 'r', citation_ids: [1] },
      { item: 'CRP', by_day: 1, rationale: 'r', citation_ids: [] },
    ],
    expected_therapeutics: [{ item: 'IV fluids', by_day: 0, rationale: 'r', citation_ids: [] }],
  }), CHUNKS);
  const { uncited, total } = countUncitedEntries(course);
  assert.equal(total, 3);
  assert.equal(uncited, 2);
  // the uncited entries keep their empty arrays — nothing was attached on a text overlap
  assert.deepEqual(course!.expected_diagnostics[1].citation_ids, []);
  assert.deepEqual(course!.expected_therapeutics[0].citation_ids, []);
});

test('everyEntryUncited detects the IP-1286 shape, and only that shape', () => {
  const all = parseExpectedCourse(JSON.stringify({
    expected_diagnostics: [{ item: 'CBC', by_day: 0, rationale: 'r', citation_ids: [] }],
    expected_therapeutics: [{ item: 'fluids', by_day: 0, rationale: 'r', citation_ids: [] }],
  }), CHUNKS);
  assert.equal(everyEntryUncited(all, 3), true, 'excerpts were available and nothing cited them');
  // not the shape: retrieval returned nothing, so there was nothing to cite
  assert.equal(everyEntryUncited(all, 0), false);
  const some = parseExpectedCourse(JSON.stringify({
    expected_diagnostics: [{ item: 'CBC', by_day: 0, rationale: 'r', citation_ids: [1] }, { item: 'CRP', by_day: 0, rationale: 'r', citation_ids: [] }],
  }), CHUNKS);
  assert.equal(everyEntryUncited(some, 3), false, 'one grounded entry is not the failure');
  assert.equal(everyEntryUncited(null, 3), false);
});

// ── decision 33: code owns omissions, and unassessable must be earned ────────────────────────

test('the diff pass may no longer emit omissions — code decided them, a second answer is dropped', () => {
  const list = [
    f({ finding_id: 'a1-om', pass: 'divergence', finding_type: 'omission' }),
    f({ finding_id: 'a1-com', pass: 'divergence', finding_type: 'commission' }),
    f({ finding_id: 'a1-tim', pass: 'divergence', finding_type: 'timing' }),
    f({ finding_id: 'a2', pass: 'fidelity', domain: 'documentation', finding_type: 'commission' }),
  ];
  const { kept, dropped } = dropJudgedOmissions(list);
  assert.equal(dropped, 1);
  assert.deepEqual(kept.map((x) => x.finding_id), ['a1-com', 'a1-tim', 'a2']);
});

test('but a RESOLVER omission survives — it is the omission analysis, not a second opinion', () => {
  const list = [
    f({ finding_id: 'judged', pass: 'divergence', finding_type: 'omission', resolution: null }),
    f({ finding_id: 'resolved', pass: 'divergence', finding_type: 'omission', resolution: 'absent_class_present' }),
  ];
  const { kept, dropped } = dropJudgedOmissions(list);
  assert.equal(dropped, 1);
  assert.deepEqual(kept.map((x) => x.finding_id), ['resolved']);
});

test('unassessable must be EARNED: a claim citing Tier A evidence is rewritten to context_dependent', () => {
  // the IP-1286 defect exactly: 23 unassessable verdicts across three runs, none with an empty
  // basis, ten of them citing Tier A
  const lying = f({ finding_id: 'x', verdict: 'unassessable',
    evidence_basis: [{ source_table: 'kx_billing_records', source_record_id: 'b1', source_timestamp: null }] });
  const r = enforceUnassessable(lying);
  assert.equal(r.rejected, true);
  assert.equal(r.finding.verdict, 'context_dependent', 'the verdict that actually means "unclear"');
});

test('unassessable stands when the record genuinely cannot answer', () => {
  const empty = f({ finding_id: 'a', verdict: 'unassessable', evidence_basis: [] });
  assert.equal(enforceUnassessable(empty).rejected, false);
  const onlyC = f({ finding_id: 'b', verdict: 'unassessable',
    evidence_basis: [{ source_table: 'kx_radiology_reports', source_record_id: 'r1', source_timestamp: null }] });
  assert.equal(enforceUnassessable(onlyC).rejected, false);
  // and a resolver finding is exempt — code established the gap, it was not claimed
  const resolved = f({ finding_id: 'c', verdict: 'unassessable', resolution: 'absent_class_missing',
    evidence_basis: [{ source_table: 'kx_billing_records', source_record_id: 'b1', source_timestamp: null }] });
  assert.equal(enforceUnassessable(resolved).rejected, false);
});

test('both rules run inside finalizeFindings and are counted', () => {
  const res = finalizeFindings([
    f({ finding_id: 'om', pass: 'divergence', finding_type: 'omission' }),
    f({ finding_id: 'un', pass: 'divergence', finding_type: 'commission', verdict: 'unassessable',
        evidence_basis: [{ source_table: 'kx_lab_reports', source_record_id: 'l1', source_timestamp: null }] }),
  ], new Map(), [], 0, SOURCES, NORMATIVE);
  assert.equal(res.n_judged_omissions_dropped, 1);
  assert.equal(res.counters.n_judged_omissions_dropped, 1);
  assert.equal(res.n_unassessable_rejected, 1);
  assert.equal(res.counters.n_unassessable_rejected, 1);
  assert.equal(res.findings.length, 1);
  assert.equal(res.findings[0].verdict, 'context_dependent');
});

test('resolver outcomes become findings that carry how they were decided', () => {
  const events: EpisodeEvent[] = [];
  const built = findingsFromResolved([{
    entry: { ref: 'cp-d0/therapeutics/1', checkpointId: 'cp-d0', dayIndex: 0, section: 'therapeutics',
             item: 'VTE prophylaxis', rationale: 'r', byDay: 0, citationIds: [4021],
             matcher: { kind: 'drug', terms: ['enoxaparin'] }, proposedSeverity: 'major' },
    outcome: { resolution: 'absent_class_present', verdict: 'divergent', severity: 'major',
               statement: 'no matching drug record', matchedEvent: null, matchedTerm: null, confound: null },
  }], domainForSection);
  const [fd] = built;
  assert.equal(fd.resolution, 'absent_class_present');
  assert.equal(fd.verdict, 'divergent');
  assert.equal(fd.severity, 'major');
  assert.equal(fd.domain, 'therapeutics');
  assert.equal(fd.matcher_kind, 'drug');
  assert.deepEqual(fd.matcher_terms, ['enoxaparin']);
  assert.deepEqual(fd.citation_ids, [4021], 'it inherits the entry’s citations by construction');
  assert.equal(fd.checkpoint_ref, 'cp-d0/therapeutics/1');
  assert.equal(events.length, 0);
});

test('a resolver DIVERGENT finding scores — this is the omission signal the audit exists for', () => {
  const built = findingsFromResolved([{
    entry: { ref: 'cp-d0/therapeutics/1', checkpointId: 'cp-d0', dayIndex: 0, section: 'therapeutics',
             item: 'VTE prophylaxis', rationale: 'r', byDay: 0, citationIds: [4021],
             matcher: { kind: 'drug', terms: ['enoxaparin'] }, proposedSeverity: 'major' },
    outcome: { resolution: 'absent_class_present', verdict: 'divergent', severity: 'major',
               statement: 's', matchedEvent: null, matchedTerm: null, confound: null },
  }], domainForSection);
  const map = refs([['cp-d0/therapeutics/1', [4021]]]);
  const res = finalizeFindings(built, map, [], 0, SOURCES, NORMATIVE);
  assert.equal(res.findings[0].verdict, 'divergent', 'the Tier C rule must not erase a code-established absence');
  assert.equal(res.divergence_index, 92, 'a major divergence costs 8');
});

// ── item 8: the citation that was being lost ────────────────────────────────────────────────

test('a finding with no citations of its own INHERITS its entry’s — where the id was lost', () => {
  const entries = refs([['cp-d0/diagnostics/1', [4021, 7788]]]);
  const chunks = new Map<string, readonly number[]>([['cp-d0', [4021, 7788, 1503]]]);
  const out = resolveFindingCitations(
    [f({ finding_id: 'x', checkpoint_ref: 'cp-d0/diagnostics/1', citation_ids: [] })], chunks, entries,
  );
  assert.deepEqual(out[0].citation_ids, [4021, 7788],
    '26 of 30 findings were uncited while every checkpoint carried 8 ids — nothing carried them across');
});

test('a finding that DID cite keeps its own citation, not the entry’s', () => {
  const entries = refs([['cp-d0/diagnostics/1', [4021, 7788]]]);
  const chunks = new Map<string, readonly number[]>([['cp-d0', [4021, 7788, 1503]]]);
  const out = resolveFindingCitations(
    [f({ finding_id: 'x', checkpoint_ref: 'cp-d0/diagnostics/1', citation_ids: [3] })], chunks, entries,
  );
  assert.deepEqual(out[0].citation_ids, [1503], 'ordinal 3 of that checkpoint');
});

// ── item 6: per-checkpoint ordinal resolution ────────────────────────────────────────────────

test('A1 citations are resolved against the checkpoint the finding REFERENCES, not a global ceiling', () => {
  const map = new Map<string, readonly number[]>([
    ['cp-d0', [4021, 7788, 1503, 66, 77, 88, 99, 100]],  // k = 8
    ['cp-d3', [5150, 5151]],                              // k = 2
  ]);
  const out = resolveFindingCitations([
    f({ finding_id: 'wide', checkpoint_ref: 'cp-d0/diagnostics/1', citation_ids: [1, 3] }),
    f({ finding_id: 'narrow', checkpoint_ref: 'cp-d3/therapeutics/1', citation_ids: [2] }),
  ], map);
  assert.deepEqual(out[0].citation_ids, [4021, 1503]);
  assert.deepEqual(out[1].citation_ids, [5151]);
});

test('an ordinal valid on the WIDEST checkpoint is dropped on a narrow one — the bug a global max hid', () => {
  const map = new Map<string, readonly number[]>([
    ['cp-d0', [4021, 7788, 1503, 66, 77, 88, 99, 100]],
    ['cp-d3', [5150, 5151]],
  ]);
  // "[6]" was legitimate against cp-d0's eight excerpts; against cp-d3's two it means nothing
  const out = resolveFindingCitations([f({ finding_id: 'x', checkpoint_ref: 'cp-d3/diagnostics/1', citation_ids: [6] })], map);
  assert.deepEqual(out[0].citation_ids, [], 'it resolves to nothing rather than to chunk 6 or to cp-d0’s sixth');
});

test('a finding whose ref names no known checkpoint keeps no citations, and fidelity findings carry none', () => {
  const map = new Map<string, readonly number[]>([['cp-d0', [4021, 7788]]]);
  const out = resolveFindingCitations([
    f({ finding_id: 'orphan', checkpoint_ref: 'cp-d9/diagnostics/1', citation_ids: [1] }),
    f({ finding_id: 'noref', checkpoint_ref: null, citation_ids: [1] }),
    f({ finding_id: 'a2', pass: 'fidelity', domain: 'documentation', finding_type: 'commission', checkpoint_ref: null, citation_ids: [1] }),
  ], map);
  for (const o of out) assert.deepEqual(o.citation_ids, [], o.finding_id);
});

// ── 8. the A2 domain drop ────────────────────────────────────────────────────────────────────

test('A2 DOMAIN is a drop: a fidelity finding in therapeutics is dropped and counted, never relabelled', () => {
  const list = [
    f({ finding_id: 'a2-1', pass: 'fidelity', domain: 'documentation', finding_type: 'commission' }),
    f({ finding_id: 'a2-2', pass: 'fidelity', domain: 'therapeutics', finding_type: 'commission' }),
    f({ finding_id: 'a1-1', pass: 'divergence', domain: 'therapeutics' }),
  ];
  const { kept, dropped, normalized } = normalizeFidelityFindings(list);
  assert.equal(dropped, 1);
  assert.equal(normalized, 0);
  assert.deepEqual(kept.map((x) => x.finding_id), ['a2-1', 'a1-1']);
  assert.ok(!kept.some((x) => x.pass === 'fidelity' && x.domain !== 'documentation'));
});

test('A2 SHAPE is a normalisation: a wrong finding_type or a stray checkpoint_ref is fixed, not thrown away', () => {
  const list = [
    f({ finding_id: 'a2-type', pass: 'fidelity', domain: 'documentation', finding_type: 'omission', checkpoint_ref: null }),
    f({ finding_id: 'a2-ref', pass: 'fidelity', domain: 'documentation', finding_type: 'commission', checkpoint_ref: 'cp-d0/diagnostics/1' }),
    f({ finding_id: 'a2-both', pass: 'fidelity', domain: 'documentation', finding_type: 'timing', checkpoint_ref: 'cp-d1/therapeutics/2' }),
  ];
  const { kept, dropped, normalized } = normalizeFidelityFindings(list);
  assert.equal(dropped, 0, 'a mislabelled field is not a reason to discard a real finding');
  assert.equal(normalized, 3);
  for (const k of kept) {
    assert.equal(k.finding_type, 'commission');
    assert.equal(k.checkpoint_ref, null);
    assert.equal(k.domain, 'documentation');
  }
});

test('normalisation leaves a well-formed A2 finding and every A1 finding completely alone', () => {
  const list = [
    f({ finding_id: 'a2-ok', pass: 'fidelity', domain: 'documentation', finding_type: 'commission', checkpoint_ref: null }),
    f({ finding_id: 'a1-1', pass: 'divergence', finding_type: 'omission', checkpoint_ref: 'cp-d0/diagnostics/1' }),
  ];
  const { kept, dropped, normalized } = normalizeFidelityFindings(list);
  assert.equal(dropped, 0);
  assert.equal(normalized, 0);
  assert.deepEqual(kept, list);
});

test('n_dropped_invalid counts A2 DOMAIN drops only — nothing else is folded into it', () => {
  const list = [
    f({ finding_id: 'a2-1', pass: 'fidelity', domain: 'documentation', finding_type: 'commission' }),
    f({ finding_id: 'a2-2', pass: 'fidelity', domain: 'escalation', finding_type: 'commission' }),
    // a normalised A2 finding is KEPT, so it must not appear in the counter either
    f({ finding_id: 'a2-3', pass: 'fidelity', domain: 'documentation', finding_type: 'omission' }),
  ];
  const res = finalizeFindings(list, new Map(), []);
  assert.equal(res.counters.n_dropped_invalid, 1, 'exactly the one domain violation');
  assert.equal(res.n_fidelity_normalized, 1);
  assert.equal(res.counters.n_findings, 2);
});

test('every discard is counted: parse failures join A2 domain drops in n_dropped_invalid (item 5)', () => {
  const text = JSON.stringify({ findings: [
    { finding_id: 'ok', finding_type: 'commission', verdict: 'divergent', domain: 'documentation', severity: 'minor', statement: 'a' },
    // no statement, and no domain that resolves — both unrepairable
    { finding_id: 'junk', finding_type: 'commission', verdict: 'divergent', domain: 'vibes', severity: 'minor', statement: 'a' },
    { finding_id: 'junk2', finding_type: 'commission', verdict: 'divergent', domain: 'documentation', severity: 'minor' },
  ] });
  const parsed = parseFindings(text, { pass: 'fidelity', idPrefix: 'a2' });
  assert.equal(parsed.unparseable, 2);
  const res = finalizeFindings(parsed.findings, new Map(), [], parsed.unparseable);
  // ⚠️ this REVERSES round 2's separation, on the orchestrator's instruction: a discard that leaves
  // every counter at 0 is indistinguishable from a clean run
  assert.equal(res.counters.n_dropped_invalid, 2, 'the total discard count');
  assert.equal(res.counters.n_parse_failed, 2, 'broken out by cause');
  assert.ok(res.counters.n_dropped_invalid > 0, 'no discard may leave every counter at 0');
});

test('n_dropped_invalid is the SUM of both causes, and n_parse_failed isolates the second', () => {
  const list = [
    f({ finding_id: 'kept', pass: 'fidelity', domain: 'documentation', finding_type: 'commission' }),
    f({ finding_id: 'domain-drop', pass: 'fidelity', domain: 'escalation', finding_type: 'commission' }),
  ];
  const res = finalizeFindings(list, new Map(), [], 3);
  assert.equal(res.counters.n_parse_failed, 3);
  assert.equal(res.counters.n_dropped_invalid, 4, '1 domain drop + 3 parse failures');
});

// ── item 4: the repair pass ──────────────────────────────────────────────────────────────────

test('a finding that is well-formed except for ONE bad enum value is repaired, not discarded', () => {
  const text = JSON.stringify({ findings: [
    // plural/singular drift on domain — resolves to exactly one legal value
    { finding_id: 'd', finding_type: 'omission', verdict: 'divergent', domain: 'diagnostic', severity: 'major', statement: 'a' },
    // unknown severity → moderate, the middle of the scale
    { finding_id: 's', finding_type: 'omission', verdict: 'divergent', domain: 'diagnostics', severity: 'severe', statement: 'a' },
    // unknown verdict → unassessable, never a scoring one
    { finding_id: 'v', finding_type: 'omission', verdict: 'wrong', domain: 'diagnostics', severity: 'minor', statement: 'a' },
  ] });
  const { findings, unparseable, repaired } = parseFindings(text, { pass: 'divergence', idPrefix: 'a1' });
  assert.equal(unparseable, 0, 'all three survive');
  assert.equal(repaired, 3);
  assert.equal(findings[0].domain, 'diagnostics');
  assert.equal(findings[1].severity, 'moderate');
  assert.equal(findings[2].verdict, 'unassessable', 'an unreadable verdict must never become a scoring one');
});

test('the repair never resolves an ambiguous or absent value — it drops, and says why', () => {
  const text = JSON.stringify({ findings: [
    { finding_id: 'a', finding_type: 'omission', verdict: 'divergent', domain: 'vibes', severity: 'minor', statement: 'a' },
    { finding_id: 'b', finding_type: 'nonsense', verdict: 'divergent', domain: 'diagnostics', severity: 'minor', statement: 'a' },
    { finding_id: 'c', finding_type: 'omission', verdict: 'divergent', domain: 'diagnostics', severity: 'minor' },
  ] });
  const { findings, unparseable, failures } = parseFindings(text, { pass: 'divergence', idPrefix: 'a1' });
  assert.equal(findings.length, 0);
  assert.equal(unparseable, 3);
  assert.equal(failures.length, 3, 'every discard is recorded');
  assert.match(failures[0].error, /no statement|domain/);
  assert.ok(failures.every((x) => x.fragment.length > 0), 'each carries the raw fragment');
});

test('the repair never swaps a near-miss for its opposite', () => {
  // 'omission' and 'commission' are one edit apart and mean opposite things — an edit-distance
  // matcher would confidently pick the wrong one. Prefix matching cannot.
  const text = JSON.stringify({ findings: [
    { finding_id: 'x', finding_type: 'ommission', verdict: 'divergent', domain: 'diagnostics', severity: 'minor', statement: 'a' },
  ] });
  const { findings, unparseable } = parseFindings(text, { pass: 'divergence', idPrefix: 'a1' });
  assert.equal(findings.length, 0, 'a typo that could be either is dropped, never guessed');
  assert.equal(unparseable, 1);
});

// ── round 6 item 6: the detector, against THIS RUN's actual retrieved titles ─────────────────

test('an ICMR hospital-acquired-pneumonia chunk is OFF TOPIC for a clean elective hernia case', () => {
  // the query IP-1286 actually built for a hernia repair
  const query = 'Open inguinal hernia repair reducible right groin lump CEFAZOLIN PARACETAMOL Complete Blood Count';
  // the four chunks that took slots 2, 4, 6, 8 of every checkpoint in trace 0a5551e6
  const icmr = [
    { label: 'ICMR AMR — Hospital-acquired pneumonia', text: 'Empirical antimicrobial therapy for hospital-acquired and ventilator-associated pneumonia in adult patients; de-escalation and duration of therapy.' },
    { label: 'ICMR AMR — Pelvic inflammatory disease', text: 'Antimicrobial management of pelvic infections; culture and susceptibility guidance for organisms implicated in pelvic inflammatory disease.' },
    { label: 'ICMR AMR — Hospital-acquired pneumonia (2)', text: 'Risk factors for multidrug-resistant organisms in hospital-acquired pneumonia; empirical regimen selection.' },
    { label: 'ICMR AMR — Hospital-acquired pneumonia (3)', text: 'Duration of antimicrobial therapy in nosocomial pneumonia and criteria for stopping treatment.' },
  ];
  const r = assessTopicality(query, icmr);
  assert.equal(r.offTopicCount, 4, 'every one of them is unrelated to a hernia repair');
  assert.equal(r.offTopic, true);
});

test('sharing ONE generic clinical word is not topicality — the reason the detector read 1, 0, 1, 0', () => {
  const query = 'Open inguinal hernia repair CEFAZOLIN';
  // it shares "antimicrobial"/"therapy"/"infection" with the query's antibiotic — and nothing else.
  // The old any-one-term rule scored this on topic and reported a slate half like it as fine.
  const one = assessTopicality(query, [
    { label: 'ICMR AMR', text: 'Empirical antimicrobial therapy for hospital-acquired pneumonia; infection management in adults.' },
  ]);
  assert.equal(one.offTopicCount, 1);
  assert.ok(MIN_SHARED_TERMS >= 2, 'two distinctive terms, because one is coincidence often enough');
});

test('a genuinely relevant chunk still reads as on topic', () => {
  const query = 'Open inguinal hernia repair reducible right groin lump CEFAZOLIN';
  const r = assessTopicality(query, [
    { label: 'StatPearls — Inguinal hernia', text: 'Open inguinal hernia repair with mesh; groin anatomy and recurrence.' },
  ]);
  assert.equal(r.offTopicCount, 0);
  assert.equal(r.offTopic, false);
});

test('a mixed slate counts precisely, and the boolean follows the majority', () => {
  const query = 'inguinal hernia repair groin mesh';
  const on = { label: 'Inguinal hernia', text: 'mesh repair of the groin' };
  const off = { label: 'ICMR AMR pneumonia', text: 'nosocomial pneumonia antimicrobial therapy' };
  assert.equal(assessTopicality(query, [on, on, on, on, off, off, off, off]).offTopicCount, 4);
  assert.equal(assessTopicality(query, [on, on, on, on, off, off, off, off]).offTopic, false, 'half is not a majority');
  assert.equal(assessTopicality(query, [on, on, on, off, off, off, off, off]).offTopic, true);
});

// ── round 6 item 7: names and inventory residue never reach retrieval ────────────────────────

test('an author name is stripped from the query — it is never a clinical term', () => {
  const text = 'Dr Testperson Alpha reviewed the patient; reducible right groin lump, for repair';
  const stripped = stripPersonNames(text, ['Dr Testperson Alpha']);
  assert.ok(!stripped.includes('Testperson') && !stripped.includes('Alpha'));
  assert.ok(stripped.includes('reducible right groin lump'), 'the clinical content survives');
  // and the Dr-title shape catches a name no field declared
  assert.ok(!stripPersonNames('Seen by Dr Testperson Beta overnight', []).includes('Testperson'));
});

test('clinicalWordsOnly drops the residue that made a query end in a code or a unit', () => {
  assert.equal(clinicalWordsOnly('SODIUM CHLORIDE 0.9% 500ML'), 'SODIUM CHLORIDE');
  assert.equal(clinicalWordsOnly('CBC 2 x 500 mg'), '');
  assert.equal(clinicalWordsOnly('reducible right groin lump'), 'reducible right groin lump');
});

test('names and identifiers are stripped end to end, in the built query', () => {
  const { query } = buildRetrievalQuery({
    eventsBeforeCutoff: [
      // the whitelist already dropped speciality_code at assembly; the name arrives inside the
      // narrative itself, which is what stripPersonNames is for
      ev({ event_id: 'n', summary: 'x', author_name: 'Dr Testperson Alpha',
           detail: { query_narrative: 'Dr Testperson Alpha notes reducible right groin lump' } }),
    ],
    authorNames: ['Dr Testperson Alpha'],
  });
  assert.ok(query.includes('reducible right groin lump'));
  for (const noise of ['Testperson', 'Alpha']) {
    assert.ok(!query.includes(noise), `'${noise}' must not reach retrieval`);
  }
});

// ── round 6 item 8: the day 0 fallback cannot reach past the cut-off ─────────────────────────

test('the day 0 fallback takes OT names from the CUT-OFF WINDOW, so it can never add hindsight', () => {
  // an in-window OT note is already picked up by rule 1, so the fallback is a deliberate no-op —
  // which is the point: there is no path by which a post-cut-off surgery name selects day 0 evidence
  const inWindow = buildRetrievalQuery({
    eventsBeforeCutoff: [ev({ event_id: 'ot', event_type: 'ot_note', detail: { surgery_name: 'Open inguinal hernia repair' } })],
    isDayZero: true,
    episodeSurgeryNames: ['Open inguinal hernia repair'],
  });
  assert.equal(inWindow.query, 'Open inguinal hernia repair');
  assert.equal(inWindow.day0FromOt, false, 'rule 1 supplied it — the fallback was never reached');

  // nothing in the window and nothing passed: the query stays thin, as instructed
  const thin = buildRetrievalQuery({
    eventsBeforeCutoff: [ev({ event_id: 'adm', event_type: 'admission', summary: 'x' })],
    isDayZero: true,
    episodeSurgeryNames: [],
  });
  assert.equal(thin.query, '', 'a thin day 0 query is the honest answer');
  assert.equal(thin.day0FromOt, false);
});

// ── round 5 item 2: an audit that cannot record what went right is not an audit ──────────────

test('finding_type "concordant" is repaired, not discarded — it killed 5 real findings on IP-1286', () => {
  const observations = [
    'Diet was tolerated from day 1 as expected',
    'Vital signs remained stable throughout',
    'Dressing stayed dry and intact',
    'Glucose was monitored at the expected frequency',
    'Patient was ambulating on the first post-operative day',
  ];
  const text = JSON.stringify({
    findings: observations.map((statement, i) => ({
      finding_id: `c${i}`, finding_type: 'concordant', verdict: 'concordant',
      domain: 'monitoring', severity: 'minor', statement,
    })),
  });
  const { findings, unparseable, repaired } = parseFindings(text, { pass: 'divergence', idPrefix: 'a1' });
  assert.equal(unparseable, 0, 'none may be discarded — every one is a correct observation');
  assert.equal(findings.length, 5);
  assert.equal(repaired, 5);
  for (const fn of findings) {
    assert.equal(fn.verdict, 'concordant', 'concordant is the VERDICT');
    assert.ok((['omission', 'commission', 'timing', 'sequencing'] as string[]).includes(fn.finding_type),
      'and the type is one of the four legal ones');
  }
});

test('the implied type is inferred from the statement, defaulting to omission', () => {
  assert.equal(impliedFindingType('Antibiotics were given on schedule'), 'commission');
  assert.equal(impliedFindingType('Glucose was monitored at the expected frequency'), 'commission');
  assert.equal(impliedFindingType('The scan was done 12 hours after it was due'), 'timing');
  assert.equal(impliedFindingType('Cultures were taken prior to the first dose'), 'sequencing');
  assert.equal(impliedFindingType('Nothing in the record speaks to this'), 'omission', 'the default');
  assert.equal(impliedFindingType(''), 'omission');
});

test('a concordant finding does not inflate the type counters, whichever type it was repaired to', () => {
  const text = JSON.stringify({ findings: [
    { finding_id: 'a', finding_type: 'concordant', verdict: 'concordant', domain: 'monitoring', severity: 'minor', statement: 'Glucose was monitored as expected' },
    { finding_id: 'b', finding_type: 'commission', verdict: 'divergent', domain: 'therapeutics', severity: 'minor', statement: 'An unexpected antibiotic was started' },
  ] });
  const { findings } = parseFindings(text, { pass: 'divergence', idPrefix: 'a1' });
  const c = countFindings(findings, 0);
  assert.equal(c.n_concordant, 1);
  assert.equal(c.n_commission, 1, 'only the real commission counts');
  assert.equal(c.n_findings, 2);
});

test('a concordant finding scores nothing, so recording what went right cannot move the index', () => {
  const text = JSON.stringify({ findings: [
    { finding_id: 'a', finding_type: 'concordant', verdict: 'concordant', domain: 'monitoring', severity: 'major', statement: 'Vitals stable' },
  ] });
  const { findings } = parseFindings(text, { pass: 'divergence', idPrefix: 'a1' });
  assert.equal(divergenceIndex(findings), 100);
});

// ── item 3: what was discarded is kept ───────────────────────────────────────────────────────

test('every discarded finding is captured with its raw fragment and the error that killed it', () => {
  const long = 'x'.repeat(4000);
  const text = JSON.stringify({ findings: [
    { finding_id: 'big', finding_type: 'omission', verdict: 'divergent', domain: 'vibes', severity: 'minor', statement: long },
  ] });
  const { failures } = parseFindings(text, { pass: 'divergence', idPrefix: 'a1' });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].fragment.length, PARSE_FRAGMENT_CHARS, 'truncated to 1000 chars');
  assert.match(failures[0].error, /domain/);
});

test('a response with no findings array is itself recorded as a failure, not a silent zero', () => {
  const { failures, findings } = parseFindings('I could not complete this task.', { pass: 'divergence', idPrefix: 'a1' });
  assert.equal(findings.length, 0);
  assert.equal(failures.length, 1);
  assert.match(failures[0].error, /no findings array/);
});

// ── item 6: a concordant finding is not a commission ─────────────────────────────────────────

test('a concordant fidelity finding is NOT forced to commission and does not inflate n_commission', () => {
  const list = [
    f({ finding_id: 'unsupported', pass: 'fidelity', domain: 'documentation', finding_type: 'commission', verdict: 'divergent' }),
    f({ finding_id: 'confirmed', pass: 'fidelity', domain: 'documentation', finding_type: 'omission', verdict: 'concordant' }),
  ];
  const { kept } = normalizeFidelityFindings(list);
  const confirmed = kept.find((x) => x.finding_id === 'confirmed')!;
  assert.notEqual(confirmed.finding_type, 'commission',
    'a confirmation that the summary IS supported must not be relabelled an unsupported claim');
  assert.equal(confirmed.checkpoint_ref, null, 'its checkpoint_ref is still normalised — A2 has none either way');
  const c = countFindings(kept, 0);
  assert.equal(c.n_commission, 1, 'only the real commission counts');
  assert.equal(c.n_concordant, 1);
});

test('the four type counters exclude concordant findings, and sum to n_findings − n_concordant', () => {
  const list = [
    f({ finding_id: '1', finding_type: 'omission', verdict: 'divergent' }),
    f({ finding_id: '2', finding_type: 'commission', verdict: 'context_dependent' }),
    f({ finding_id: '3', finding_type: 'commission', verdict: 'concordant' }),
    f({ finding_id: '4', finding_type: 'timing', verdict: 'concordant' }),
  ];
  const c = countFindings(list, 0);
  assert.equal(c.n_commission, 1, 'the concordant commission is excluded');
  assert.equal(c.n_timing, 0);
  assert.equal(c.n_omission, 1);
  assert.equal(c.n_concordant, 2);
  assert.equal(c.n_omission + c.n_commission + c.n_timing + c.n_sequencing, c.n_findings - c.n_concordant);
});

// ── item 8: provenance, and what literature alone may claim ──────────────────────────────────

// choosing-wisely is normative (DEFAULT_NORMATIVE_SOURCES); statpearls and a journal are not
const NORMATIVE = ['choosing-wisely', 'lab:guidelines-even-protocols'];
const SOURCES = new Map<number, string>([
  [4021, 'choosing-wisely'],
  [7788, 'statpearls'],
  [1503, 'lab:guidelines-even-protocols'],
  [9001, 'surgical-journal'],
]);

test('citations are classified normative / literature / mixed, and no citations is null', () => {
  const c = (ids: number[]) => classifyCitationProvenance(ids, SOURCES, NORMATIVE);
  assert.equal(c([4021]), 'normative');
  assert.equal(c([4021, 1503]), 'normative', 'both are on the allowlist');
  assert.equal(c([7788]), 'literature');
  assert.equal(c([7788, 9001]), 'literature');
  assert.equal(c([4021, 7788]), 'mixed');
  assert.equal(c([]), null, 'no citations is an absence, not a kind');
});

test('a chunk whose source was never recorded counts as literature, never as normative', () => {
  // the conservative reading: treating an unknown source as a standard would lift a cap on nothing
  assert.equal(classifyCitationProvenance([55555], SOURCES, NORMATIVE), 'literature');
  assert.equal(classifyCitationProvenance([4021, 55555], SOURCES, NORMATIVE), 'mixed');
});

test('THE CAP: a major finding standing only on literature is cut to moderate, and stays divergent', () => {
  const lit = f({ finding_id: 'x', severity: 'major', verdict: 'divergent', citation_ids: [7788], citation_provenance: 'literature' });
  const res = applyLiteratureCap(lit);
  assert.equal(res.capped, true);
  assert.equal(res.finding.severity, 'moderate');
  assert.equal(res.finding.verdict, 'divergent',
    'the record can still show the course left the expected one — literature bounds how loudly, not whether');
});

test('the cap does not touch a normative or mixed finding, nor a finding already below major', () => {
  for (const prov of ['normative', 'mixed'] as const) {
    const r = applyLiteratureCap(f({ finding_id: 'x', severity: 'major', citation_provenance: prov }));
    assert.equal(r.capped, false, prov);
    assert.equal(r.finding.severity, 'major', `one normative citation is enough to lift the cap (${prov})`);
  }
  for (const sev of ['moderate', 'minor'] as const) {
    const r = applyLiteratureCap(f({ finding_id: 'x', severity: sev, citation_provenance: 'literature' }));
    assert.equal(r.capped, false);
    assert.equal(r.finding.severity, sev);
  }
  // no citations at all: the uncited cap already owns that case
  assert.equal(applyLiteratureCap(f({ finding_id: 'x', severity: 'major', citation_provenance: null })).capped, false);
});

test('the cap runs inside finalizeFindings, and shows up in the score', () => {
  const map = refs([['cp-d0/diagnostics/1', [7788]], ['cp-d0/therapeutics/1', [4021]]]);
  const res = finalizeFindings([
    // grounded on a cited entry, but the citation is a StatPearls chunk → major becomes moderate
    f({ finding_id: 'lit', severity: 'major', verdict: 'divergent', checkpoint_ref: 'cp-d0/diagnostics/1', citation_ids: [7788] }),
    // grounded on a guideline → keeps its 8 points
    f({ finding_id: 'norm', severity: 'major', verdict: 'divergent', checkpoint_ref: 'cp-d0/therapeutics/1', citation_ids: [4021] }),
  ], map, [], 0, SOURCES, NORMATIVE);
  assert.equal(res.n_literature_capped, 1);
  assert.equal(res.findings.find((x) => x.finding_id === 'lit')!.severity, 'moderate');
  assert.equal(res.findings.find((x) => x.finding_id === 'lit')!.citation_provenance, 'literature');
  assert.equal(res.findings.find((x) => x.finding_id === 'norm')!.severity, 'major');
  assert.equal(res.findings.find((x) => x.finding_id === 'norm')!.citation_provenance, 'normative');
  // 8 for the guideline-backed major + 4 for the capped one
  assert.equal(res.divergence_index, 100 - 12);
});

test('provenance_counts is the measurement V asked for: how much of the score rests on guidelines', () => {
  const map = refs([['cp-d0/diagnostics/1', [4021]]]);
  const res = finalizeFindings([
    f({ finding_id: 'a', checkpoint_ref: 'cp-d0/diagnostics/1', citation_ids: [4021] }),
    f({ finding_id: 'b', checkpoint_ref: 'cp-d0/diagnostics/1', citation_ids: [7788] }),
    f({ finding_id: 'c', checkpoint_ref: 'cp-d0/diagnostics/1', citation_ids: [4021, 7788] }),
    f({ finding_id: 'd', checkpoint_ref: 'cp-d0/diagnostics/1', citation_ids: [] }),
  ], map, [], 0, SOURCES, NORMATIVE);
  assert.deepEqual(res.provenance_counts, { normative: 1, literature: 1, mixed: 1, none: 1 });
});

// ── 9. completeness ──────────────────────────────────────────────────────────────────────────

test('completeness: nine-source denominator; all nine present is 100', () => {
  assert.equal(completenessPct([
    'kx_ip_admissions', 'kx_clinical_template_progress_reports', 'kx_billing_records', 'kx_lab_reports',
    'kx_discharge_summary_records', 'kx_clinical_template_initial_assessment_adults',
    'kx_clinical_template_shift_handovers', 'kx_clinical_template_ot_notes', 'kx_ip_transfers',
  ]), 100);
});

test('completeness: the floor is 33 — selection already requires three of the nine', () => {
  assert.equal(completenessPct(['kx_ip_admissions', 'kx_clinical_template_progress_reports', 'kx_discharge_summary_records']), 33);
  assert.equal(completenessPct(['kx_ip_admissions', 'kx_clinical_template_progress_reports', 'kx_discharge_summary_records', 'kx_billing_records']), 44);
});

test('completeness ignores a table that is not one of the nine, and never double-counts one', () => {
  assert.equal(completenessPct(['kx_ip_admissions', 'kx_ip_admissions', 'kx_radiology_reports']), 11);
});

test('evidence_tiers records which source tables appeared, by tier', () => {
  const t = evidenceTiersOf(['kx_ip_admissions', 'kx_ip_transfers', 'kx_billing_records']);
  assert.deepEqual(t.A, ['kx_billing_records', 'kx_ip_admissions']);
  assert.deepEqual(t.B, ['kx_ip_transfers']);
  assert.deepEqual(t.C, []);
});

// ── 10. author attribution ───────────────────────────────────────────────────────────────────

const NOTE_EVENT: EpisodeEvent = {
  event_id: 'note-n1', occurred_at: '2026-08-02T04:00:00.000Z', day_index: 0, event_type: 'note',
  summary: 'ward round', detail: {}, author_name: 'Dr Testperson Alpha', author_role: 'RMO',
  responsible_clinician_id: 'DOC-77',
  provenance: { source_table: 'kx_clinical_template_progress_reports', source_record_id: 'n1', source_timestamp: '2026-08-02T04:00:00.000Z' },
  evidence_tier: 'A',
};

test('attribution: a note-derived finding carries BOTH the author and the responsible clinician', () => {
  const attached = attachAttribution(f({ finding_id: '1' }), [NOTE_EVENT]);
  assert.equal(attached.author_name, 'Dr Testperson Alpha');
  assert.equal(attached.author_role, 'RMO');
  assert.equal(attached.responsible_clinician_id, 'DOC-77');
});

test('attribution: a DOCUMENTATION finding is the author’s; every other domain is the responsible clinician’s', () => {
  const doc = attachAttribution(f({ finding_id: '1', domain: 'documentation', pass: 'fidelity', finding_type: 'commission' }), [NOTE_EVENT]);
  assert.deepEqual(attributedParty(doc), { kind: 'author', value: 'Dr Testperson Alpha' });
  const ther = attachAttribution(f({ finding_id: '2', domain: 'therapeutics' }), [NOTE_EVENT]);
  assert.deepEqual(attributedParty(ther), { kind: 'responsible_clinician', value: 'DOC-77' });
});

test('attribution: an unattributable finding is reported unattributed, never assigned to the nearest name', () => {
  const orphan = f({ finding_id: '1', evidence_basis: [{ source_table: 'kx_billing_records', source_record_id: 'b-999', source_timestamp: null }] });
  const attached = attachAttribution(orphan, [NOTE_EVENT]);
  assert.equal(attached.author_name, null);
  assert.equal(attributedParty(attached), null);
});

// ── 11. commentary rejection ─────────────────────────────────────────────────────────────────

test('commentary: a score field anywhere in the object graph is rejected', () => {
  for (const body of [
    { narrative: 'n', outcome_context: 'o', score: 71 },
    { narrative: 'n', outcome_context: 'o', findings_context: [{ finding_id: 'a1-1', note: 'x', severity: 'major' }] },
    { narrative: 'n', outcome_context: 'o', summary: { divergence_index: 88 } },
  ]) {
    const v = validateCommentary(JSON.stringify(body), ['a1-1']);
    assert.equal(v.ok, false, JSON.stringify(body));
  }
});

test('commentary: an unknown finding_id is rejected', () => {
  const v = validateCommentary(JSON.stringify({
    narrative: 'n', outcome_context: 'o', findings_context: [{ finding_id: 'invented-9', note: 'x' }],
  }), ['a1-1']);
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /unknown finding_id/);
});

test('commentary: valid prose annotating a real finding is accepted', () => {
  const v = validateCommentary(JSON.stringify({
    narrative: 'A short admission that ran close to the expected course.',
    outcome_context: 'The outcome makes the day-1 omission look less consequential than it reads.',
    findings_context: [{ finding_id: 'a1-1', note: 'hindsight makes this look harsh' }],
  }), ['a1-1']);
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.equal(v.commentary.findings_context.length, 1);
    assert.match(v.commentary.narrative, /short admission/);
  }
});

test('commentary: an empty or unparseable response is rejected rather than stored as blank prose', () => {
  assert.equal(validateCommentary('', ['a1-1']).ok, false);
  assert.equal(validateCommentary('sorry, I cannot', ['a1-1']).ok, false);
  assert.equal(validateCommentary(JSON.stringify({ findings_context: [] }), ['a1-1']).ok, false);
});

// ── parsing and enums ────────────────────────────────────────────────────────────────────────

test('parsing repairs what it can and drops what it cannot, never inventing a scoring verdict', () => {
  const text = JSON.stringify({ findings: [
    { finding_id: 'ok', finding_type: 'omission', verdict: 'divergent', domain: 'diagnostics', severity: 'minor', statement: 'a', day_index: 1, evidence_basis: [{ source_table: 'kx_billing_records', source_record_id: 'b1' }] },
    // REPAIRED (item 4): an unreadable verdict lands on unassessable, which scores nothing
    { finding_id: 'bad-verdict', finding_type: 'omission', verdict: 'terrible', domain: 'diagnostics', severity: 'minor', statement: 'a' },
    // DROPPED: no statement, and no domain that resolves to exactly one legal value
    { finding_id: 'no-statement', finding_type: 'omission', verdict: 'divergent', domain: 'diagnostics', severity: 'minor' },
    { finding_id: 'bad-domain', finding_type: 'omission', verdict: 'divergent', domain: 'vibes', severity: 'minor', statement: 'a' },
  ] });
  const { findings, unparseable, repaired } = parseFindings(text, { pass: 'divergence', idPrefix: 'a1' });
  assert.equal(findings.length, 2);
  assert.equal(unparseable, 2);
  assert.equal(repaired, 1);
  assert.equal(findings[0].finding_id, 'a1-ok');
  assert.equal(findings[0].pass, 'divergence');
  assert.equal(findings[1].verdict, 'unassessable', 'the repaired one cannot carry a penalty');
});

test('lvc_category rides only on a commission finding in therapeutics or diagnostics, and only a known value', () => {
  const mk = (domain: string, finding_type: string, lvc_category: string) => JSON.stringify({ findings: [
    { finding_id: 'x', finding_type, verdict: 'divergent', domain, severity: 'minor', statement: 'a', lvc_category },
  ] });
  const one = (t: string) => parseFindings(t, { pass: 'divergence', idPrefix: 'a1' }).findings[0];
  assert.equal(one(mk('therapeutics', 'commission', 'antibiotic')).lvc_category, 'antibiotic');
  assert.equal(one(mk('diagnostics', 'commission', 'imaging')).lvc_category, 'imaging');
  assert.equal(one(mk('monitoring', 'commission', 'antibiotic')).lvc_category, null, 'wrong domain');
  assert.equal(one(mk('therapeutics', 'omission', 'antibiotic')).lvc_category, null, 'wrong finding type');
  assert.equal(one(mk('therapeutics', 'commission', 'made_up_tag')).lvc_category, null, 'unknown value → null');
  assert.equal(asLvcCategory('other'), 'other');
  assert.equal(asLvcCategory('nope'), null);
});

test('counters tally every dimension the audit row stores', () => {
  const list = [
    f({ finding_id: '1', pass: 'divergence', finding_type: 'omission', verdict: 'divergent', severity: 'major' }),
    f({ finding_id: '2', pass: 'divergence', finding_type: 'timing', verdict: 'context_dependent' }),
    f({ finding_id: '3', pass: 'divergence', finding_type: 'sequencing', verdict: 'concordant' }),
    f({ finding_id: '4', pass: 'fidelity', domain: 'documentation', finding_type: 'commission', verdict: 'unassessable', lvc_category: null }),
    f({ finding_id: '5', pass: 'divergence', finding_type: 'commission', domain: 'therapeutics', verdict: 'divergent', severity: 'minor', lvc_category: 'antibiotic' }),
  ];
  const c = countFindings(list, 2);
  assert.equal(c.n_findings, 5);
  assert.equal(c.n_divergence_pass, 4);
  assert.equal(c.n_fidelity_pass, 1);
  assert.equal(c.n_omission, 1);
  assert.equal(c.n_commission, 2);
  assert.equal(c.n_timing, 1);
  // finding '3' is a CONCORDANT sequencing finding — a confirmation, not a sequencing error (item 6)
  assert.equal(c.n_sequencing, 0);
  assert.equal(c.n_divergent, 2);
  assert.equal(c.n_context_dependent, 1);
  assert.equal(c.n_unassessable, 1);
  assert.equal(c.n_concordant, 1);
  assert.equal(c.n_low_value, 1);
  assert.equal(c.n_dropped_invalid, 2);
});

test('finalizeFindings applies the whole chain in one place, so its order cannot drift between callers', () => {
  // cp-d1/… carried no citation; cp-d0/… did — so only findings against cp-d0 escape the cap
  const map = refs([['cp-d1/diagnostics/1', []], ['cp-d0/diagnostics/1', [4021]]]);
  const res = finalizeFindings([
    // capped by the uncited rule (major → minor / context_dependent), so it scores 0
    f({ finding_id: 'capped', severity: 'major', checkpoint_ref: 'cp-d1/diagnostics/1' }),
    // grounded, so the cap does not fire — but its basis is empty, so the Tier C rule rewrites it
    f({ finding_id: 'tierc', severity: 'major', checkpoint_ref: 'cp-d0/diagnostics/1', citation_ids: [4021], evidence_basis: [] }),
    // dropped: a fidelity finding outside documentation
    f({ finding_id: 'dropped', pass: 'fidelity', domain: 'monitoring', finding_type: 'commission', severity: 'major' }),
    // normalised, not dropped: right domain, wrong finding_type, and NOT concordant — so §3.5's
    // fixed type applies to it (a concordant A2 finding is left alone, per item 6)
    f({ finding_id: 'normalised', pass: 'fidelity', domain: 'documentation', finding_type: 'omission', severity: 'minor', verdict: 'context_dependent' }),
    // the only finding that actually scores
    f({ finding_id: 'real', severity: 'moderate', checkpoint_ref: 'cp-d0/diagnostics/1', citation_ids: [4021] }),
  ], map, [NOTE_EVENT], 0, SOURCES, NORMATIVE);
  assert.equal(res.n_uncited_capped, 1);
  assert.equal(res.n_tier_c_rewritten, 1);
  assert.equal(res.n_fidelity_normalized, 1);
  assert.equal(res.counters.n_dropped_invalid, 1, 'the domain violation, and only it');
  assert.equal(res.counters.n_findings, 4);
  // 'capped' is now moderate + divergent (4), 'real' is moderate + divergent (4), 'tierc' is
  // unassessable (0) — the cap no longer zeroes a finding by rewriting its verdict
  assert.equal(res.divergence_index, 100 - 8);
});

test('the cap and the Tier C rule now do different jobs, so both apply', () => {
  // ungrounded AND unsupported. The cap lowers severity and leaves the verdict; the Tier C rule
  // then rewrites the verdict, because a divergent claim resting on no evidence is still
  // unassessable. They no longer collide over one field.
  const res = finalizeFindings([f({ finding_id: 'both', severity: 'major', verdict: 'divergent', checkpoint_ref: null, evidence_basis: [] })], new Map(), []);
  assert.equal(res.n_uncited_capped, 1, 'severity capped');
  assert.equal(res.n_tier_c_rewritten, 1, 'and the verdict rewritten, by the rule that owns verdicts');
  assert.equal(res.findings[0].severity, 'moderate');
  assert.equal(res.findings[0].verdict, 'unassessable');
  assert.equal(res.divergence_index, 100, 'unassessable scores nothing');
});

// ── retrieval query ──────────────────────────────────────────────────────────────────────────

// ── item 1: the query is built from clinical content, never administrative words ─────────────

const ev = (o: Partial<EpisodeEvent> & { event_id: string }): EpisodeEvent => ({
  occurred_at: '2026-08-02T04:00:00.000Z', day_index: 0, event_type: 'note', summary: '', detail: {},
  author_name: null, author_role: null, responsible_clinician_id: null,
  provenance: { source_table: 't', source_record_id: o.event_id, source_timestamp: null },
  evidence_tier: 'A', ...o,
});

const CLINICAL_EVENTS: EpisodeEvent[] = [
  ev({ event_id: 'ot', event_type: 'ot_note', detail: { surgery_name: 'Open inguinal hernia repair' } }),
  ev({ event_id: 'n-old', occurred_at: '2026-08-01T20:00:00.000Z', summary: 'older note', detail: { query_narrative: 'older note' } }),
  ev({ event_id: 'n-new', occurred_at: '2026-08-02T04:00:00.000Z', summary: 'right groin swelling, reducible', detail: { query_narrative: 'right groin swelling, reducible' } }),
  ev({ event_id: 'p1', event_type: 'order', day_index: 1, detail: { service_type: 'Pharmacy', ordered_item_name: 'CEFAZOLIN 1G' } }),
  ev({ event_id: 'p2', event_type: 'order', day_index: 1, detail: { service_type: 'Pharmacy', ordered_item_name: 'PARACETAMOL 1G' } }),
  ev({ event_id: 'p-old', event_type: 'order', day_index: 0, detail: { service_type: 'Pharmacy', ordered_item_name: 'OLDER DRUG' } }),
  ev({ event_id: 'lab', event_type: 'lab_order', detail: { service_name: 'Complete Blood Count' } }),
];

test('the query is built from clinical content in the stated priority', () => {
  const { query: q } = buildRetrievalQuery({ eventsBeforeCutoff: CLINICAL_EVENTS });
  // 1 surgery, 2 initial assessment, 3 latest note, 4 latest day's drugs, 5 labs
  assert.match(q, /^Open inguinal hernia repair/);
  assert.ok(q.includes('right groin swelling'), 'the latest progress note before the cut-off');
  assert.ok(!q.includes('older note'));
  // ⚠️ PHARMACY ITEM NAMES ARE NO LONGER IN THE QUERY (round 7 item 7): a SKU cannot be told from
  // a drug brand without the category join decision 17 dropped, and ABSTACK/SODIUM proved it twice
  assert.ok(!q.includes('CEFAZOLIN') && !q.includes('PARACETAMOL'), 'drug names are the resolver’s job, not retrieval’s');
  assert.ok(!q.includes('OLDER DRUG'), 'only the latest documented drug day');
  assert.ok(q.includes('Complete Blood Count'), 'lab service names');
});

test('the extracted case CANNOT reach the query — hindsight is not a retrieval input', () => {
  // the builder takes one argument and there is no field to smuggle a diagnosis through
  const { query: q } = buildRetrievalQuery({ eventsBeforeCutoff: CLINICAL_EVENTS });
  for (const hindsight of ['Right inguinal hernia', 'Hernioplasty', 'discharged', 'recovered']) {
    assert.ok(!q.includes(hindsight), `'${hindsight}' comes from the discharge summary and must never steer retrieval`);
  }
});

test('the initial assessment survives alongside the notes — it is often day 0’s only clinical text', () => {
  const withAssessment: EpisodeEvent[] = [
    ev({ event_id: 'ia', event_type: 'initial_assessment', occurred_at: '2026-08-01T19:00:00.000Z', summary: 'x', detail: { query_narrative: 'painful irreducible right groin lump, vomiting' } }),
    ev({ event_id: 'n', occurred_at: '2026-08-02T04:00:00.000Z', summary: 'x', detail: { query_narrative: 'post-op observation' } }),
  ];
  const { query: q } = buildRetrievalQuery({ eventsBeforeCutoff: withAssessment });
  assert.ok(q.includes('painful irreducible right groin lump'), 'the admission-time picture is kept');
  assert.ok(q.includes('post-op observation'), 'and the latest note too — they do not compete for one slot');
});

test('a day 0 window with nothing clinical yields a THIN query, not a backfilled one', () => {
  // the admission event alone: no note, no assessment, no order, no lab
  const { query: q, day0FromOt } = buildRetrievalQuery({
    eventsBeforeCutoff: [ev({ event_id: 'adm', event_type: 'admission', summary: 'Admission type direct_admission · to General Surgery' })],
  });
  assert.equal(q, '', 'nothing clinical was documented, and the query says exactly that');
  assert.equal(day0FromOt, false, 'no OT note to fall back to');
  // and an empty query is never judged off-topic — that is a different failure with its own column
  assert.equal(retrievalIsOffTopic(q, [{ label: 'anything', text: 'anything' }]), false);
});

test('NO administrative word can reach the query — this was the IP-1286 root cause', () => {
  // the builder has no parameter for any of them any more, so the only way in would be an event
  // detail, and none of these is read
  const { query: q } = buildRetrievalQuery({
    eventsBeforeCutoff: [
      ...CLINICAL_EVENTS,
      ev({ event_id: 'adm', event_type: 'admission', summary: 'Admission type direct_admission · from OPD · to General Surgery · ward 3B', detail: { ward: '3B', admission_type: 'direct_admission', admit_source: 'OPD', treating_department_name: 'General Surgery', facility_name: 'Even Hospital' } }),
    ],
  });
  for (const admin of ['direct_admission', 'OPD', 'General Surgery', '3B', 'Even Hospital']) {
    assert.ok(!q.includes(admin), `'${admin}' must not appear — it retrieves staffing literature`);
  }
});

test('the query works with no OT note — notes, drugs and labs alone', () => {
  const { query: q } = buildRetrievalQuery({
    eventsBeforeCutoff: CLINICAL_EVENTS.filter((e) => e.event_type !== 'ot_note'),
  });
  assert.ok(q.includes('right groin swelling') && q.includes('Complete Blood Count'));
  assert.ok(!q.includes('hernia repair'));
});

test('the query survives an empty event list', () => {
  assert.equal(buildRetrievalQuery({ eventsBeforeCutoff: [] }).query, '');
});

// ── round 5 items 3 and 4: what goes into the query ──────────────────────────────────────────

test('admission remarks are back in the query — written at the door, so no hindsight', () => {
  const { query } = buildRetrievalQuery({
    eventsBeforeCutoff: [ev({ event_id: 'adm', event_type: 'admission', summary: 'x' })],
    remarks: 'painful right inguinal swelling for 3 days',
  });
  assert.ok(query.includes('painful right inguinal swelling'),
    'stripping this left the day 0 query empty — 9 of 11 uncited findings were day 0');
});

test('the day 0 fallback fires only at day 0, only when the query is otherwise empty, and is flagged', () => {
  const empty = [ev({ event_id: 'adm', event_type: 'admission', summary: 'x' })];
  const withOt = { eventsBeforeCutoff: empty, episodeSurgeryNames: ['Open inguinal hernia repair'] };

  const day0 = buildRetrievalQuery({ ...withOt, isDayZero: true });
  assert.equal(day0.query, 'Open inguinal hernia repair');
  assert.equal(day0.day0FromOt, true, 'the row is stamped so the frequency is measurable');

  const laterDay = buildRetrievalQuery({ ...withOt, isDayZero: false });
  assert.equal(laterDay.query, '', 'a later checkpoint does not reach outside its window');
  assert.equal(laterDay.day0FromOt, false);

  // and it never displaces a real query
  const real = buildRetrievalQuery({ eventsBeforeCutoff: CLINICAL_EVENTS, isDayZero: true, episodeSurgeryNames: ['SOMETHING ELSE'] });
  assert.ok(!real.query.includes('SOMETHING ELSE'));
  assert.equal(real.day0FromOt, false);
});

test('drug base names, not SKUs: pack sizes, supplier codes and forms are dropped', () => {
  assert.equal(drugBaseName("ABSTACK 30-.-5MM-COVIDEN-1's"), 'ABSTACK');
  assert.equal(drugBaseName("EMESET 2ML INJ-1's"), 'EMESET');
  assert.equal(drugBaseName('PARACETAMOL 1G'), 'PARACETAMOL');
  assert.equal(drugBaseName('CEFAZOLIN 1G INJ'), 'CEFAZOLIN');
  // an unrecognised shape is left alone rather than mangled
  assert.equal(drugBaseName('Complete Blood Count'), 'Complete Blood Count');
  assert.equal(drugBaseName(''), '');
});

test('identifiers and codes never reach the query, only narrative does', () => {
  const summary = 'speciality_code: SURG-01 · department_id: 7f3a9c21-11ee · T-3: reducible right groin lump · visit_type_id: 4 · module: ipd';
  const cleaned = clinicalTextForQuery(summary);
  assert.ok(cleaned.includes('reducible right groin lump'), 'the narrative survives');
  for (const noise of ['SURG-01', '7f3a9c21-11ee', 'speciality_code', 'department_id', 'visit_type_id', 'module']) {
    assert.ok(!cleaned.includes(noise), `'${noise}' is an identifier, not a clinical term`);
  }
});

test('the SKU and identifier stripping actually reaches the built query', () => {
  const { query } = buildRetrievalQuery({
    eventsBeforeCutoff: [
      ev({ event_id: 'n', summary: 'x', detail: { query_narrative: 'reducible right groin lump' } }),
      ev({ event_id: 'p', event_type: 'order', detail: { service_type: 'Pharmacy', ordered_item_name: "EMESET 2ML INJ-1's" } }),
    ],
  });
  assert.ok(query.includes('reducible right groin lump'));
  assert.ok(!query.includes('EMESET') && !query.includes("1's") && !query.includes('2ML'),
    'inventory strings do not reach retrieval at all any more');
});

// ── round 5 item 6: topicality that can actually fire ────────────────────────────────────────

test('off-topic is judged per excerpt and fires on a MAJORITY', () => {
  const query = 'inguinal hernia repair mesh';
  const on = { label: 'Inguinal hernia', text: 'mesh repair technique' };
  const off = (n: number) => ({ label: `Pneumonia guidance ${n}`, text: 'ventilator associated pneumonia therapy' });

  // the IP-1286 shape: half the slate unrelated. The all-or-nothing rule scored this false.
  const half = assessTopicality(query, [on, on, off(1), off(2)]);
  assert.equal(half.offTopicCount, 2);
  assert.equal(half.offTopic, false, 'exactly half is not a majority');

  const most = assessTopicality(query, [on, off(1), off(2), off(3)]);
  assert.equal(most.offTopicCount, 3);
  assert.equal(most.offTopic, true, 'a majority fires the boolean');
  assert.equal(most.total, 4);
});

test('the count is reported even when the boolean does not fire — that is what makes it checkable', () => {
  const r = assessTopicality('hernia repair', [
    { label: 'Hernia', text: 'repair' },
    { label: 'Staffing', text: 'rotational scheduling models' },
  ]);
  assert.equal(r.offTopic, false);
  assert.equal(r.offTopicCount, 1, 'the unrelated excerpt is still counted');
});

test('nothing to judge yields zero and false, not a false alarm', () => {
  assert.deepEqual(assessTopicality('', [{ label: 'a', text: 'b' }]), { offTopic: false, offTopicCount: 0, total: 1 });
  assert.deepEqual(assessTopicality('hernia', []), { offTopic: false, offTopicCount: 0, total: 0 });
});

// ── items 2 and 3: what came back, and whether it was on topic ───────────────────────────────

test('retrieved titles are the first 100 chars of each excerpt, in order', () => {
  const titles = retrievedTitles([
    { label: 'StatPearls · Inguinal Hernia', text: 'x'.repeat(500) },
    { label: 'CW · Surgery', text: 'short' },
  ]);
  assert.equal(titles.length, 2);
  assert.equal(titles[0].length, RETRIEVED_TITLE_CHARS);
  assert.match(titles[0], /^StatPearls · Inguinal Hernia/);
  assert.match(titles[1], /^CW · Surgery — short$/);
});

test('off-topic is true when NO excerpt shares a clinical term with the query', () => {
  const query = 'Open inguinal hernia repair Right inguinal hernia CEFAZOLIN';
  // the IP-1286 shape: a hernia repair answered with paediatric rotation and obstetric staffing
  assert.equal(retrievalIsOffTopic(query, [
    { label: 'Paediatric rotation staffing', text: 'Rotational scheduling for residents on paediatric wards.' },
    { label: 'Obstetric staffing models', text: 'Midwifery ratios and obstetric unit coverage.' },
  ]), true);
  // one shared clinical term is enough to call it on topic
  assert.equal(retrievalIsOffTopic(query, [
    { label: 'Paediatric rotation staffing', text: 'Rotational scheduling.' },
    { label: 'Inguinal hernia repair', text: 'Mesh hernia repair technique.' },
  ]), false);
});

test('off-topic is false when there is nothing to judge — that is a different failure', () => {
  assert.equal(retrievalIsOffTopic('', [{ label: 'a', text: 'b' }]), false, 'no query');
  assert.equal(retrievalIsOffTopic('hernia repair', []), false, 'no excerpts — retrieval_failed owns that');
});

test('clinical terms ignore stopwords, short words and bare numbers', () => {
  const t = clinicalTerms('The patient was given 500 mg of CEFAZOLIN for the hernia');
  assert.ok(t.has('cefazolin') && t.has('hernia'));
  for (const stop of ['the', 'was', 'given', 'patient', '500', 'mg']) {
    assert.ok(!t.has(stop), `'${stop}' carries no clinical signal`);
  }
});

// ── item 5: a defaulted 100 is the most dangerous output this engine can produce ──────────────

test('no expectation anywhere ⇒ no_expectations, and the stored index is NULL not 100', () => {
  const status = scoringStatusFor({ totalExpectedEntries: 0, findings: [], cappedFindingIds: new Set() });
  assert.equal(status, 'no_expectations');
  assert.equal(storedDivergenceIndex(100, status), null,
    'a perfect-looking 100 on an unmeasured episode is exactly what must never be stored');
});

test('every finding capped ⇒ all_capped, so a high number is not presented as a clean run', () => {
  const findings = [f({ finding_id: 'a' }), f({ finding_id: 'b' })];
  const status = scoringStatusFor({
    totalExpectedEntries: 12, findings, cappedFindingIds: new Set(['a', 'b']),
  });
  assert.equal(status, 'all_capped');
  // the index is still stored for all_capped — it is real arithmetic, just weak evidence
  assert.equal(storedDivergenceIndex(98, status), 98);
});

test('a genuinely concordant episode is `ok` — an empty finding list is not a failure', () => {
  assert.equal(scoringStatusFor({ totalExpectedEntries: 12, findings: [], cappedFindingIds: new Set() }), 'ok');
  assert.equal(storedDivergenceIndex(100, 'ok'), 100);
});

test('one uncapped finding is enough to make the episode scorable', () => {
  const findings = [f({ finding_id: 'a' }), f({ finding_id: 'b' })];
  assert.equal(scoringStatusFor({
    totalExpectedEntries: 12, findings, cappedFindingIds: new Set(['a']),
  }), 'ok');
});

test('finalizeFindings reports which findings were capped, so the status can be computed', () => {
  const map = refs([['cp-d0/diagnostics/1', []]]);
  const res = finalizeFindings([
    f({ finding_id: 'capped', severity: 'major', checkpoint_ref: 'cp-d0/diagnostics/1' }),
  ], map, [], 0, SOURCES, NORMATIVE);
  assert.ok(res.capped_finding_ids.has('capped'));
  assert.equal(scoringStatusFor({
    totalExpectedEntries: 3, findings: res.findings, cappedFindingIds: res.capped_finding_ids,
  }), 'all_capped');
});

// ── 16. the skip retry window ────────────────────────────────────────────────────────────────

test('skip retry: a skip whose discharge is 15 days old is not selected again', () => {
  assert.equal(SKIP_RETRY_DAYS, 14);
  const now = new Date('2026-09-02T00:00:00.000Z');
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
  assert.equal(skipIsRetryable(daysAgo(15), now), false);
  assert.equal(skipIsRetryable(daysAgo(14), now), false, 'the window closes AT 14 days');
  assert.equal(skipIsRetryable(daysAgo(13), now), true);
  assert.equal(skipIsRetryable(daysAgo(0), now), true);
});

test('skip retry: an undateable skip keeps being retried — the engine does not stop looking at what it cannot date', () => {
  assert.equal(skipIsRetryable(null), true);
  assert.equal(skipIsRetryable('not a date'), true);
});

// ── 17. the model environment ────────────────────────────────────────────────────────────────

test('model env: the two defaults are real entries in the Bedrock allowlist', () => {
  assert.equal(IPD_EPISODE_CHECKPOINT_MODEL_DEFAULT, 'global.anthropic.claude-haiku-4-5-20251001-v1:0');
  assert.equal(IPD_EPISODE_JUDGE_MODEL_DEFAULT, 'global.anthropic.claude-opus-4-6-v1');
  assert.ok(isKnownBedrockModel(IPD_EPISODE_CHECKPOINT_MODEL_DEFAULT));
  assert.ok(isKnownBedrockModel(IPD_EPISODE_JUDGE_MODEL_DEFAULT));
  assert.doesNotThrow(() => assertKnownBedrockModel(IPD_EPISODE_CHECKPOINT_MODEL_DEFAULT));
  assert.doesNotThrow(() => assertKnownBedrockModel(IPD_EPISODE_JUDGE_MODEL_DEFAULT));
});

test('model env: an override is honoured; an unknown id is REFUSED before any work, never fallen back from', () => {
  assert.equal(checkpointModel({}), IPD_EPISODE_CHECKPOINT_MODEL_DEFAULT);
  assert.equal(checkpointModel({ IPD_EPISODE_CHECKPOINT_MODEL: '  ' }), IPD_EPISODE_CHECKPOINT_MODEL_DEFAULT);
  assert.equal(checkpointModel({ IPD_EPISODE_CHECKPOINT_MODEL: 'global.anthropic.claude-sonnet-4-6' }), 'global.anthropic.claude-sonnet-4-6');
  assert.equal(judgeModel({ IPD_EPISODE_JUDGE_MODEL: 'global.anthropic.claude-sonnet-4-6' }), 'global.anthropic.claude-sonnet-4-6');
  // the refusal is the point: a mistyped variable must cost a throw, not a silently cheaper grader
  assert.throws(() => assertKnownBedrockModel(judgeModel({ IPD_EPISODE_JUDGE_MODEL: 'gpt-4o' })), /unknown model/);
  assert.throws(() => assertKnownBedrockModel(checkpointModel({ IPD_EPISODE_CHECKPOINT_MODEL: 'claude-haiku-4-5' })), /unknown model/);
});
