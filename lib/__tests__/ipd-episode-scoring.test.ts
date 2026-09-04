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
  applyTierCRule, applySeverityCap, entryWasUncited, attachAttribution, attributedParty, completenessPct,
  countFindings, divergenceIndex, normalizeFidelityFindings, evidenceTiersOf, finalizeFindings,
  parseFindings, resolveFindingCitations, validateCommentary, asLvcCategory, SEVERITY_PENALTY,
  PARSE_FRAGMENT_CHARS, classifyCitationProvenance, applyLiteratureCap, findingHasTierAEvidence, scoringStatusFor,
  storedDivergenceIndex, impliedFindingType, capSeverityAt, CAP_SEVERITY_CEILING,
  divergenceBandFor, bandIsUncertain, DIVERGENCE_BANDS, BAND_THRESHOLDS, INDEX_REPEAT_SPREAD,
  dropJudgedOmissions, enforceUnassessable, findingsFromResolved, domainForSection,
  buildExpectationDigest, buildDiffUser, applyBillingOnlyCap, notesOnDay, missingDischargeDayNote,
  subjectWords, SUBJECT_CONCEPTS,
  type EpisodeFinding, type Severity, type Verdict, type Domain, type AuditPass,
  type DigestSource,
} from '../ipd-episode/judge-core';
import {
  checkpointEntryRefs, parseExpectedCourse, buildRetrievalQuery, renderExpectedCourse,
  ordinalForChunkId, countUncitedEntries, everyEntryUncited, buildCheckpointUser,
  capExpectedCourse, MAX_ENTRIES_PER_CATEGORY,
  clinicalTerms, retrievalIsOffTopic, assessTopicality, offTopicThreshold, retrievedTitles, RETRIEVED_TITLE_CHARS,
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
  group_size: 1, grouped_refs: [], grouped_days: [],
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

// ── 7. THE SEVERITY CAP, NARROWED (round 14 item 10) ─────────────────────────────────────────
//
// Was two caps — uncited-expectation and literature-only — stacked on one ceiling. On IPNO-416 they
// took ALL 58 major findings between them, which killed the 8-point term and reduced the index to
// 100 − 4 × (divergent count). And they bit hardest on the best findings: "no stent assessment in
// any of seven notes" and "no note at all on the discharge day" rest on the record and cite no
// guideline, because none is needed to observe that a note is missing.
//
// One rule now: keep the blinded proposed severity if there is EITHER a citation (literature
// counts) OR corroborating Tier A evidence. Cap only when there is neither.

const tierA = (table = 'kx_clinical_template_progress_reports') =>
  [{ source_table: table, source_record_id: 'r1', source_timestamp: null }];
const tierC = [{ source_table: 'some_other_table', source_record_id: 'r9', source_timestamp: null }];
// Tier B: enough to survive the Tier C rewrite, not enough to lift the severity cap. The two rules
// are separate, and a fixture that conflates them tests neither.
const tierB = [{ source_table: 'kx_clinical_template_shift_handovers', source_record_id: 'h1', source_timestamp: null }];

test('item 10: a citation alone keeps major — literature counts', () => {
  const r = applySeverityCap(f({ finding_id: '1', severity: 'major', verdict: 'divergent', citation_ids: [7788], evidence_basis: [] }));
  assert.equal(r.capped, false);
  assert.equal(r.finding.severity, 'major');
});

test('item 10: Tier A record evidence alone keeps major — THE TWO FINDINGS THAT MATTERED MOST', () => {
  // "no stent assessment in any of seven progress notes" — no citation, real record evidence.
  const r = applySeverityCap(f({ finding_id: '1', severity: 'major', verdict: 'divergent', citation_ids: [], evidence_basis: tierA() }));
  assert.equal(r.capped, false);
  assert.equal(r.finding.severity, 'major', 'no guideline is needed to observe that a note is missing');
  for (const t of ['kx_ip_admissions', 'kx_billing_records', 'kx_lab_reports', 'kx_discharge_summary_records']) {
    assert.equal(applySeverityCap(f({ finding_id: t, severity: 'major', citation_ids: [], evidence_basis: tierA(t) })).capped, false, t);
  }
});

test('item 10: NEITHER citation nor Tier A evidence is the only thing capped', () => {
  const r = applySeverityCap(f({ finding_id: '1', severity: 'major', verdict: 'divergent', citation_ids: [], evidence_basis: [] }));
  assert.equal(r.capped, true);
  assert.equal(r.finding.severity, 'moderate', 'the ceiling is moderate, not minor');
  assert.equal(r.finding.verdict, 'divergent', 'the verdict is not the cap’s business');
  // Tier C evidence is not corroboration
  assert.equal(applySeverityCap(f({ finding_id: '2', severity: 'major', citation_ids: [], evidence_basis: tierC })).capped, true);
});

test('item 10: the cap touches severity only, and never raises one', () => {
  const bare = (severity: 'major' | 'moderate' | 'minor') =>
    applySeverityCap(f({ finding_id: severity, severity, verdict: 'divergent', citation_ids: [], evidence_basis: [] }));
  assert.equal(bare('major').finding.severity, 'moderate');
  assert.equal(bare('major').capped, true);
  assert.equal(bare('moderate').capped, false);
  assert.equal(bare('minor').finding.severity, 'minor');
  assert.equal(CAP_SEVERITY_CEILING, 'moderate');
  assert.equal(capSeverityAt('minor', 'moderate'), 'minor', 'a ceiling never raises');
});

test('item 10: no verdict is erased by the cap — the IP-1286 concordant-erasure guard still holds', () => {
  for (const verdict of ['concordant', 'unassessable', 'context_dependent', 'divergent'] as const) {
    const r = applySeverityCap(f({ finding_id: verdict, severity: 'minor', verdict, citation_ids: [], evidence_basis: [] }));
    assert.equal(r.finding.verdict, verdict, `${verdict} must survive the cap intact`);
    assert.equal(r.capped, false, 'a minor finding is already at the ceiling');
  }
});

test('item 10: a fidelity finding is capped by the SAME rule — it has the record to stand on', () => {
  const a2 = (basis: typeof tierC) => f({
    finding_id: 'a2', pass: 'fidelity', domain: 'documentation', finding_type: 'commission',
    severity: 'major', checkpoint_ref: null, citation_ids: [], evidence_basis: basis,
  });
  assert.equal(applySeverityCap(a2(tierA('kx_discharge_summary_records'))).capped, false,
    'A2 cites the discharge record, which is Tier A — it keeps its weight');
  assert.equal(applySeverityCap(a2(tierC)).capped, true, 'and an A2 finding on nothing is capped like any other');
});

test('item 10: THE ONE CAP DOES NOT STACK — a literature-cited finding is no longer capped at all', () => {
  const res = finalizeFindings([
    f({ finding_id: 'lit', severity: 'major', verdict: 'divergent', checkpoint_ref: 'cp-d0/diagnostics/1', citation_ids: [7788], evidence_basis: tierB }),
  ], refs([['cp-d0/diagnostics/1', [7788]]]), [], 0, SOURCES, NORMATIVE);
  const only = res.findings[0];
  assert.equal(only.citation_provenance, 'literature', 'provenance is still classified and stored');
  assert.equal(only.capped, false, 'but it no longer silences the finding');
  assert.equal(only.severity, 'major');
  assert.equal(res.divergence_index, 92, 'one MAJOR divergent finding — the 8-point term is reachable again');
});

test('item 10: the uncited-ENTRY count survives as a report number, capping nothing', () => {
  const map = refs([['cp-d0/diagnostics/1', []]]);
  assert.equal(entryWasUncited(f({ finding_id: '1', checkpoint_ref: 'cp-d0/diagnostics/1' }), map), true);
  assert.equal(entryWasUncited(f({ finding_id: '2', checkpoint_ref: 'cp-d0/diagnostics/1' }), refs([['cp-d0/diagnostics/1', [4021]]])), false);
  assert.equal(entryWasUncited(f({ finding_id: '3', checkpoint_ref: null }), map), true, 'measured against nothing');
  assert.equal(entryWasUncited(f({ finding_id: '4', checkpoint_ref: 'cp-d9/x/7' }), map), true, 'unresolvable ref');
  assert.equal(entryWasUncited(f({ finding_id: '5', pass: 'fidelity', checkpoint_ref: null }), map), false, 'A2 has no entry to cite');

  // it is counted, and it caps nothing on its own: this finding has Tier A evidence
  const res = finalizeFindings([
    f({ finding_id: 'a', severity: 'major', verdict: 'divergent', checkpoint_ref: 'cp-d0/diagnostics/1', citation_ids: [], evidence_basis: tierA() }),
  ], map, [], 0, SOURCES, NORMATIVE);
  assert.equal(res.n_uncited_entries, 1, 'the expectation was uncited, and that is recorded');
  assert.equal(res.n_uncited_capped, 0, 'and nothing was capped for it');
  assert.equal(res.findings[0].severity, 'major');
});

test('item 10: the cap remains auditable from the stored finding, not from a response string', () => {
  const map = refs([['cp-d0/diagnostics/1', [4021]]]);
  const res = finalizeFindings([
    f({ finding_id: 'capped', severity: 'major', verdict: 'divergent', checkpoint_ref: 'cp-d0/diagnostics/1', citation_ids: [], evidence_basis: tierB }),
    f({ finding_id: 'clean', severity: 'moderate', verdict: 'divergent', checkpoint_ref: 'cp-d0/diagnostics/1', citation_ids: [4021], evidence_basis: tierB }),
  ], map, [], 0, SOURCES, NORMATIVE);
  const capped = res.findings.find((x) => x.finding_id === 'capped')!;
  assert.equal(capped.capped, true);
  assert.equal(capped.verdict_before_cap, 'divergent', 'what the model said, before code intervened');
  assert.equal(capped.severity_before_cap, 'major');
  assert.equal(capped.verdict, 'divergent', 'the verdict survives — only severity moved');
  assert.equal(capped.severity, 'moderate');
  assert.equal(res.findings.find((x) => x.finding_id === 'clean')!.capped, false);
  assert.equal(res.capped_finding_ids.size, res.findings.filter((x) => x.capped).length);
});

const CHUNKS = [4021, 7788, 1503];

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

// ── round 9: the band, and why the number is not shown ──────────────────────────────────────

test('the four bands and their thresholds', () => {
  assert.deepEqual([...DIVERGENCE_BANDS],
    ['no divergence found', 'minor divergence', 'moderate divergence', 'substantial divergence']);
  assert.deepEqual(BAND_THRESHOLDS, { minor: 90, moderate: 70, substantial: 45 });
  assert.equal(divergenceBandFor(100), 'no divergence found');
  assert.equal(divergenceBandFor(90), 'no divergence found', 'inclusive lower bound');
  assert.equal(divergenceBandFor(89), 'minor divergence');
  assert.equal(divergenceBandFor(70), 'minor divergence');
  assert.equal(divergenceBandFor(69), 'moderate divergence');
  assert.equal(divergenceBandFor(45), 'moderate divergence');
  assert.equal(divergenceBandFor(44), 'substantial divergence');
  assert.equal(divergenceBandFor(0), 'substantial divergence');
});

test('the bands are NOT the discharge engine’s A–E letters — both appear on one screen', () => {
  for (const b of DIVERGENCE_BANDS) {
    assert.ok(!/^[A-E]$/.test(b), `${b} must not collide with ipd_discharge_audits.band`);
    assert.ok(b.includes(' '), 'named in words, so two bands on one row cannot be confused');
  }
});

test('an unscorable episode has NO band — a null index must not acquire a reassuring word', () => {
  assert.equal(divergenceBandFor(null), null);
  assert.equal(bandIsUncertain(null), false);
  // and the pipeline derives the band from the STORED index, which is null under these statuses
  assert.equal(divergenceBandFor(storedDivergenceIndex(100, 'no_expectations')), null);
  assert.equal(divergenceBandFor(storedDivergenceIndex(41, 'incomplete_checkpoints')), null);
  assert.equal(divergenceBandFor(storedDivergenceIndex(41, 'ok')), 'substantial divergence');
});

test('band_uncertain fires within the MEASURED repeat-run spread of any threshold', () => {
  assert.equal(INDEX_REPEAT_SPREAD, 5, 'IP-1286: 40, 37, 36, 41, 36 on identical input');
  for (const t of [90, 70, 45]) {
    assert.equal(bandIsUncertain(t), true, `${t} is a threshold`);
    assert.equal(bandIsUncertain(t + 5), true, 'the far edge is still uncertain');
    assert.equal(bandIsUncertain(t - 5), true);
    assert.equal(bandIsUncertain(t + 6), false, 'six points clear is confident');
    assert.equal(bandIsUncertain(t - 6), false);
  }
});

test('the IP-1286 five-run readings all band the same way, and all read as near-boundary', () => {
  // 36–41 sits 4–9 under the 45 threshold, which is exactly the case the flag exists for
  const readings = [40, 37, 36, 41, 36];
  const bands = new Set(readings.map((r) => divergenceBandFor(r)));
  assert.equal(bands.size, 1, 'the band is stable across the spread that moves the number');
  assert.equal([...bands][0], 'substantial divergence');
  // 40 is 5 from the 45 threshold and 41 is 4 — both uncertain. 37 (8 clear) and 36 (9 clear)
  // are confidently inside the band. Three of five readings of ONE admission are confident, two
  // are not, which is the honest picture of an instrument with this spread.
  assert.deepEqual(readings.map(bandIsUncertain), [true, false, false, true, false]);
});

test('the band survives the whole spread only because it is wider than the spread', () => {
  // a reading at a threshold moves band on a re-run — which is what band_uncertain is for
  assert.equal(divergenceBandFor(44), 'substantial divergence');
  assert.equal(divergenceBandFor(46), 'moderate divergence');
  assert.equal(bandIsUncertain(44) && bandIsUncertain(46), true);
});

// ── round 8: a missing checkpoint must not score, and the course is bounded ──────────────────

test('ANY errored or empty checkpoint makes the episode not scorable, and the index NULL', () => {
  // five runs of IP-1286 lost their day-2 checkpoint to a max_tokens truncation and scored `ok`
  // on the remaining three quarters, every time, with a number a clinician could read
  const st = scoringStatusFor({ totalExpectedEntries: 45, findings: [], cappedFindingIds: new Set(), incompleteCheckpoints: 1 });
  assert.equal(st, 'incomplete_checkpoints');
  assert.equal(storedDivergenceIndex(41, st), null, 'a score against a course with a hole in it is not a score');
});

test('incomplete_checkpoints outranks every other status', () => {
  // it is tested FIRST: an episode can be both incomplete and all-capped, and incomplete is worse
  assert.equal(scoringStatusFor({
    totalExpectedEntries: 0, findings: [], cappedFindingIds: new Set(), incompleteCheckpoints: 2,
  }), 'incomplete_checkpoints');
  const f1 = f({ finding_id: 'a' });
  assert.equal(scoringStatusFor({
    totalExpectedEntries: 10, findings: [f1], cappedFindingIds: new Set(['a']), incompleteCheckpoints: 1,
  }), 'incomplete_checkpoints');
});

test('a complete episode is unaffected', () => {
  assert.equal(scoringStatusFor({ totalExpectedEntries: 45, findings: [], cappedFindingIds: new Set(), incompleteCheckpoints: 0 }), 'ok');
  assert.equal(scoringStatusFor({ totalExpectedEntries: 45, findings: [], cappedFindingIds: new Set() }), 'ok', 'absent means none');
  assert.equal(storedDivergenceIndex(41, 'ok'), 41);
});

test('the expected course is capped at four per category, keeping the model’s own ordering', () => {
  assert.equal(MAX_ENTRIES_PER_CATEGORY, 4);
  const mk = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({
    item: `${prefix}${i + 1}`, by_day: 0, rationale: 'r', citation_ids: [], matcher: null,
    proposed_severity: 'moderate' as const,
  }));
  const course = {
    expected_diagnostics: mk(7, 'dx'), expected_therapeutics: mk(6, 'tx'),
    expected_monitoring: mk(2, 'mon').map((e) => ({ ...e, frequency: 'daily' })),
    escalation_triggers: mk(5, 'esc').map((e) => ({ ...e, trigger: e.item, action: 'act' })),
    expected_los_days: 3, expected_disposition: 'home', uncertainty: [],
  };
  const { course: capped, truncated } = capExpectedCourse(course);
  assert.equal(capped!.expected_diagnostics.length, 4);
  assert.equal(capped!.expected_therapeutics.length, 4);
  assert.equal(capped!.expected_monitoring.length, 2, 'a category under the cap is untouched');
  assert.equal(capped!.escalation_triggers.length, 4);
  assert.equal(truncated, 3 + 2 + 0 + 1);
  // ordering preserved: the prompt asks for most-consequential-first, so the tail is what goes
  assert.equal(capped!.expected_diagnostics[0].item, 'dx1');
  assert.equal(capped!.expected_diagnostics[3].item, 'dx4');
});

test('capping a null course is a no-op', () => {
  assert.deepEqual(capExpectedCourse(null), { course: null, truncated: 0 });
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

test('ROUND 14 ITEM 7: a mixed slate counts precisely, and a QUARTER fires the boolean', () => {
  const query = 'inguinal hernia repair groin mesh';
  const on = { label: 'Inguinal hernia', text: 'mesh repair of the groin' };
  const off = { label: 'ICMR AMR pneumonia', text: 'nosocomial pneumonia antimicrobial therapy' };
  const slate = (nOff: number) => [...Array(8 - nOff).fill(on), ...Array(nOff).fill(off)];
  assert.equal(assessTopicality(query, slate(4)).offTopicCount, 4);
  // THE IPNO-416 SHAPE: four of eight off topic reported `false` under the majority rule, on every
  // checkpoint of the episode. It was raised three times before the test itself was changed.
  assert.equal(assessTopicality(query, slate(4)).offTopic, true, 'four of eight is not a near miss');
  assert.equal(assessTopicality(query, slate(2)).offTopic, true, 'a quarter is the threshold');
  assert.equal(assessTopicality(query, slate(1)).offTopic, false, 'one unlucky excerpt is not a signal');
  assert.equal(offTopicThreshold(8), 2);
  assert.equal(offTopicThreshold(4), 2, 'the minimum of two holds on a short slate');
  assert.equal(offTopicThreshold(20), 5);
});

test('ROUND 14 ITEM 7: topicality is judged on the TITLE — a long body shares words with anything', () => {
  // The real IPNO-416 day-2 slate: adult nephrology query, paediatric oncology and paediatric
  // hyperkalaemia among the excerpts. Their BODIES share generic clinical vocabulary with the
  // query; their titles share nothing, which is the honest reading.
  const query = 'bilateral acute pyelonephritis hydroureteronephrosis stenting urosepsis pancreatitis';
  const paedOnc = {
    label: 'Tintinallis-Emergency-Medicine-9e · 145 Oncologic Emergencies in Infants and Children',
    text: 'acute renal failure tumour lysis syndrome hyperkalaemia urgent management pyelonephritis urosepsis',
  };
  assert.equal(assessTopicality(query, [paedOnc]).offTopicCount, 1,
    'the body borrows the query’s own words; the title says what the passage is about');
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

test('item 10: provenance is still MEASURED, and no longer capped — literature keeps its weight', () => {
  const map = refs([['cp-d0/diagnostics/1', [7788]], ['cp-d0/therapeutics/1', [4021]]]);
  const res = finalizeFindings([
    // a StatPearls chunk. Was capped to moderate; now keeps major, because a passage saying what is
    // known is support for an expectation even though it is not a standard.
    f({ finding_id: 'lit', severity: 'major', verdict: 'divergent', checkpoint_ref: 'cp-d0/diagnostics/1', citation_ids: [7788] }),
    f({ finding_id: 'norm', severity: 'major', verdict: 'divergent', checkpoint_ref: 'cp-d0/therapeutics/1', citation_ids: [4021] }),
  ], map, [], 0, SOURCES, NORMATIVE);
  assert.equal(res.n_literature_capped, 1, 'still counted, so "how much rests on literature" stays answerable');
  const lit = res.findings.find((x) => x.finding_id === 'lit')!;
  assert.equal(lit.citation_provenance, 'literature', 'and still classified on the row');
  assert.equal(lit.severity, 'major', 'but the grade survives');
  assert.equal(lit.capped, false);
  assert.equal(res.findings.find((x) => x.finding_id === 'norm')!.severity, 'major');
  assert.equal(res.divergence_index, 100 - 16, 'two majors, both at full weight');
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
    // measured against an UNCITED entry, but standing on a Tier A progress note — since item 10
    // that is support enough, so it keeps major and the uncited entry is merely counted
    f({ finding_id: 'uncited_entry', severity: 'major', checkpoint_ref: 'cp-d1/diagnostics/1' }),
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
  assert.equal(res.n_uncited_capped, 0, 'item 10: Tier A evidence lifts the cap');
  assert.equal(res.n_uncited_entries, 1, 'and the uncited expectation is still recorded');
  assert.equal(res.n_tier_c_rewritten, 1);
  assert.equal(res.n_fidelity_normalized, 1);
  assert.equal(res.counters.n_dropped_invalid, 1, 'the domain violation, and only it');
  assert.equal(res.counters.n_findings, 4);
  // 'uncited_entry' is MAJOR + divergent (8) since item 10 — Tier A evidence lifts the cap;
  // 'real' is moderate + divergent (4); 'tierc' is unassessable (0). The cap still never zeroes a
  // finding by rewriting its verdict.
  assert.equal(res.divergence_index, 100 - 12);
});

test('the cap and the Tier C rule now do different jobs, so both apply', () => {
  // ungrounded AND unsupported. The cap lowers severity and leaves the verdict; the Tier C rule
  // then rewrites the verdict, because a divergent claim resting on no evidence is still
  // unassessable. They no longer collide over one field.
  const res = finalizeFindings([f({ finding_id: 'both', severity: 'major', verdict: 'divergent', checkpoint_ref: null, citation_ids: [], evidence_basis: [] })], new Map(), []);
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
  // ⚠️ ROUND 14 ITEM 8 REVERSED THIS ASSERTION, deliberately. The older note used to be excluded,
  // and that is what emptied IPNO-416's day-3 query when the latest note happened to be a terse
  // "clinically better, euvolemic" — leaving the surgery name alone to steer retrieval, which
  // returned eight stent documents and produced six stent findings. A patient's problems do not
  // disappear because today's note is short.
  assert.ok(q.includes('older note'), 'the accumulated problem list, not the most recent note alone');
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

test('off-topic is judged per excerpt, and a quarter of the slate fires it (item 7)', () => {
  const query = 'inguinal hernia repair mesh';
  const on = { label: 'Inguinal hernia mesh', text: 'mesh repair technique' };
  const off = (n: number) => ({ label: `Pneumonia guidance ${n}`, text: 'ventilator associated pneumonia therapy' });

  // the IP-1286 shape: half the slate unrelated. All-or-nothing scored it false, then majority did.
  const half = assessTopicality(query, [on, on, off(1), off(2)]);
  assert.equal(half.offTopicCount, 2);
  assert.equal(half.offTopic, true, 'half a slate off topic is a signal, not a near miss');

  const most = assessTopicality(query, [on, off(1), off(2), off(3)]);
  assert.equal(most.offTopicCount, 3);
  assert.equal(most.offTopic, true);
  assert.equal(most.total, 4);
});

test('the count is reported even when the boolean does not fire — that is what makes it checkable', () => {
  // one off topic out of four: counted, but below the two-excerpt minimum, so the flag stays down
  const r = assessTopicality('hernia repair groin mesh', [
    { label: 'Inguinal hernia repair', text: 'x' },
    { label: 'Hernia mesh repair', text: 'x' },
    { label: 'Groin hernia repair', text: 'x' },
    { label: 'Staffing rotas', text: 'rotational scheduling models' },
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
    // no citation AND no Tier A evidence — the one shape item 10 still caps
    f({ finding_id: 'capped', severity: 'major', checkpoint_ref: 'cp-d0/diagnostics/1', citation_ids: [],
        evidence_basis: [{ source_table: 'kx_clinical_template_shift_handovers', source_record_id: 'h1', source_timestamp: null }] }),
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


// ═══════════════════════════════════════════════════════════════════════════════════════════════
// ROUND 13 ITEM 3 · THE EXPECTATION DIGEST
//
// The diff pass was sent 50,978 characters of expected courses for IP-1483 — every entry with its
// rationale, matcher, proposed severity and citation ordinals, restated by every checkpoint that
// raised it. Since decision 33 A1 emits no omissions, so none of that apparatus is what it reads
// with; it needs to know what was anticipated. These tests pin what survives the cut and, more
// importantly, what must NOT be lost with the rest: the entry ref that `checkpoint_ref`, the
// uncited cap and citation inheritance all resolve against.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

const entry = (item: string, by_day: number | null, citation_ids: number[] = []) => ({
  item, by_day, rationale: 'because the guideline says so', citation_ids,
  matcher: { kind: 'lab' as const, terms: ['cbc', 'complete blood count'] },
  proposed_severity: 'major' as const,
});

const src = (checkpointId: string, dayIndex: number, course: Partial<{
  expected_diagnostics: ReturnType<typeof entry>[];
  expected_therapeutics: ReturnType<typeof entry>[];
  expected_monitoring: { item: string; frequency: string; rationale: string; citation_ids: number[]; matcher: { kind: 'note'; terms: string[] }; proposed_severity: 'minor' }[];
  escalation_triggers: { trigger: string; action: string; citation_ids: number[]; matcher: { kind: 'other'; terms: string[] }; proposed_severity: 'moderate' }[];
}>): DigestSource => ({
  checkpointId, dayIndex,
  course: {
    expected_diagnostics: [], expected_therapeutics: [], expected_monitoring: [], escalation_triggers: [],
    expected_los_days: 4, expected_disposition: 'home', uncertainty: ['the excerpts were quiet'],
    ...course,
  },
});

test('digest: one expectation stated by four checkpoints becomes ONE line that keeps all four refs', () => {
  const d = buildExpectationDigest([
    src('cp-d0', 0, { expected_diagnostics: [entry('Serum creatinine', 1)] }),
    src('cp-d1', 1, { expected_diagnostics: [entry('Serum creatinine', 2)] }),
    src('cp-d2', 2, { expected_diagnostics: [entry('serum   CREATININE', 3)] }),
    src('cp-d3', 3, { expected_diagnostics: [entry('Serum creatinine', 4)] }),
  ]);
  assert.equal(d.entries.length, 1, 'one distinct expectation');
  assert.equal(d.ungroupedCount, 4, 'standing for four expected-course entries');
  // NOTHING IS DISCARDED — the same guarantee round 12 gives resolver grouping.
  assert.deepEqual(d.entries[0].memberRefs,
    ['cp-d0/diagnostics/1', 'cp-d1/diagnostics/1', 'cp-d2/diagnostics/1', 'cp-d3/diagnostics/1']);
  // whitespace and case are normalised exactly as round 12's matcher-less fallback normalises
  assert.equal(d.entries[0].item, 'Serum creatinine');
});

test('digest: the EARLIEST by_day wins — a timing finding is measured against the earlier deadline', () => {
  const d = buildExpectationDigest([
    src('cp-d0', 0, { expected_diagnostics: [entry('Blood cultures', 3)] }),
    src('cp-d1', 1, { expected_diagnostics: [entry('Blood cultures', 1)] }),
    src('cp-d2', 2, { expected_diagnostics: [entry('Blood cultures', 2)] }),
  ]);
  assert.equal(d.entries[0].byDay, 1);
  assert.match(d.text, /by day 1/);
});

test('digest: the representative ref is the earliest CITED member, so the cap never loses evidence', () => {
  // cp-d0 raised it uncited; cp-d2 raised the same expectation with a citation. Taking the
  // earliest unconditionally would hand applyUncitedCap an uncited ref and cap a grounded
  // expectation — the citation-losing defect round 11 item 8 was written to end.
  const d = buildExpectationDigest([
    src('cp-d0', 0, { expected_diagnostics: [entry('Chest radiograph', 1, [])] }),
    src('cp-d1', 1, { expected_diagnostics: [entry('Chest radiograph', 1, [])] }),
    src('cp-d2', 2, { expected_diagnostics: [entry('Chest radiograph', 1, [7])] }),
  ]);
  assert.equal(d.entries[0].ref, 'cp-d2/diagnostics/1');
  assert.equal(d.entries[0].memberRefs.length, 3, 'and every member is still addressable');
});

test('digest: with no member cited anywhere, the representative is simply the earliest', () => {
  const d = buildExpectationDigest([
    src('cp-d1', 1, { expected_diagnostics: [entry('Lactate', 1, [])] }),
    src('cp-d2', 2, { expected_diagnostics: [entry('Lactate', 1, [])] }),
  ]);
  assert.equal(d.entries[0].ref, 'cp-d1/diagnostics/1');
});

test('digest: sections never merge, and each is rendered under its own heading', () => {
  const d = buildExpectationDigest([
    src('cp-d0', 0, {
      expected_diagnostics: [entry('Potassium', 1)],
      expected_therapeutics: [entry('Potassium', 1)],   // same text, different section
      expected_monitoring: [{ item: 'Urine output', frequency: 'hourly', rationale: 'r', citation_ids: [2], matcher: { kind: 'note', terms: ['urine'] }, proposed_severity: 'minor' }],
      escalation_triggers: [{ trigger: 'SBP < 90', action: 'call the intensivist', citation_ids: [], matcher: { kind: 'other', terms: [] }, proposed_severity: 'moderate' }],
    }),
  ]);
  assert.equal(d.entries.length, 4, 'the same text in two sections is two expectations');
  for (const heading of ['DIAGNOSTICS', 'THERAPEUTICS', 'MONITORING', 'ESCALATION TRIGGERS']) {
    assert.ok(d.text.includes(heading), `${heading} is rendered`);
  }
  assert.match(d.text, /SBP < 90 → call the intensivist/, 'a trigger renders as trigger → action');
});

test('digest: monitoring and escalation carry no by_day rather than a made-up one', () => {
  const d = buildExpectationDigest([
    src('cp-d0', 0, {
      expected_monitoring: [{ item: 'Neuro obs', frequency: '4 hourly', rationale: 'r', citation_ids: [], matcher: { kind: 'note', terms: [] }, proposed_severity: 'minor' }],
    }),
  ]);
  assert.equal(d.entries[0].byDay, null);
  assert.ok(!/by day/.test(d.text), 'and nothing in the text claims one');
});

test('digest: the rationale, the matcher, the severity and the citations do NOT reach the prompt', () => {
  const d = buildExpectationDigest([
    src('cp-d0', 0, { expected_diagnostics: [entry('Serum creatinine', 1, [4, 9])] }),
  ]);
  const user = buildDiffUser({ admissionContext: 'ctx', events: [], digest: d });
  assert.ok(!user.includes('because the guideline says so'), 'no rationale');
  assert.ok(!user.includes('complete blood count'), 'no matcher terms');
  assert.ok(!/proposed_severity|\bmajor\b/.test(user), 'no proposed severity');
  assert.ok(!/citations? \d|\[citations/.test(user), 'no citation ordinals');
  // and the two things that MUST survive
  assert.ok(user.includes('cp-d0/diagnostics/1'), 'the entry ref survives — checkpoint_ref needs it');
  assert.ok(user.includes('Serum creatinine'), 'the expectation itself survives');
});

test('digest: the prompt states the reduction, so a reader can see what was collapsed', () => {
  const many = buildExpectationDigest([
    src('cp-d0', 0, { expected_diagnostics: [entry('Serum creatinine', 1)] }),
    src('cp-d1', 1, { expected_diagnostics: [entry('Serum creatinine', 1)] }),
  ]);
  assert.match(buildDiffUser({ admissionContext: 'c', events: [], digest: many }),
    /1 distinct expectation, stated 2 times across the checkpoints/);
  const one = buildExpectationDigest([src('cp-d0', 0, { expected_diagnostics: [entry('Serum creatinine', 1)] })]);
  assert.match(buildDiffUser({ admissionContext: 'c', events: [], digest: one }), /\(1 expectation\)/);
});

test('digest: a checkpoint that produced no course contributes nothing and breaks nothing', () => {
  const d = buildExpectationDigest([
    { checkpointId: 'cp-d0', dayIndex: 0, course: null },
    src('cp-d1', 1, { expected_diagnostics: [entry('CBC', 2)] }),
  ]);
  assert.equal(d.entries.length, 1);
  assert.equal(d.entries[0].ref, 'cp-d1/diagnostics/1');
  const empty = buildExpectationDigest([{ checkpointId: 'cp-d0', dayIndex: 0, course: null }]);
  assert.equal(empty.entries.length, 0);
  assert.match(buildDiffUser({ admissionContext: 'c', events: [], digest: empty }),
    /no checkpoint produced an expected course/);
});

test('digest: an entry ref it emits always resolves in checkpointEntryRefs — the cap depends on it', () => {
  const course = src('cp-d2', 2, {
    expected_diagnostics: [entry('CBC', 1, [3])],
    expected_therapeutics: [entry('Ceftriaxone', 0, [])],
  }).course!;
  const d = buildExpectationDigest([{ checkpointId: 'cp-d2', dayIndex: 2, course }]);
  const known = new Set(checkpointEntryRefs('cp-d2', course).map((r) => r.ref));
  for (const e of d.entries) {
    assert.ok(known.has(e.ref), `${e.ref} is a real entry ref`);
    for (const m of e.memberRefs) assert.ok(known.has(m), `${m} is a real entry ref`);
  }
});

test('digest: it is materially smaller than the full render it replaces', () => {
  const sources = [0, 1, 2, 3, 4, 5, 6].map((day) => src(`cp-d${day}`, day, {
    expected_diagnostics: [entry('Serum creatinine and electrolytes', day + 1, [1]), entry('Complete blood count', day + 1, [2])],
    expected_therapeutics: [entry('Empirical antibiotics per local policy', day, [3])],
  }));
  const digest = buildExpectationDigest(sources);
  const full = sources.map((s) => renderExpectedCourse(s.checkpointId, s.dayIndex, 'daily', s.course, [1, 2, 3])).join('\n\n');
  assert.equal(digest.entries.length, 3, 'three distinct expectations across seven checkpoints');
  assert.equal(digest.ungroupedCount, 21);
  assert.ok(digest.text.length * 4 < full.length,
    `the digest (${digest.text.length}) is a small fraction of the full render (${full.length})`);
});


// ═══════════════════════════════════════════════════════════════════════════════════════════════
// ROUND 14 ITEMS 1, 2b AND 4 — BILLING, THE MISSING NOTE, AND SUBJECT GROUPING
// ═══════════════════════════════════════════════════════════════════════════════════════════════

const billingBasis = [{ source_table: 'kx_billing_records', source_record_id: 'b1', source_timestamp: null }];
const noteBasis = [{ source_table: 'kx_clinical_template_progress_reports', source_record_id: 'n1', source_timestamp: null }];
const evt = (o: Partial<EpisodeEvent> & { event_id: string }): EpisodeEvent => ({
  occurred_at: '2026-08-02T04:00:00.000Z', day_index: 0, event_type: 'note', summary: '', detail: {},
  author_name: null, author_role: null, responsible_clinician_id: null,
  provenance: { source_table: 'kx_clinical_template_progress_reports', source_record_id: o.event_id, source_timestamp: null },
  evidence_tier: 'A', ...o,
});

test('ITEM 1: a billing-only commission on an uncorroborated day is held to minor, with the caveat', () => {
  // a1-F15 on IPNO-416: a 15-line discharge-morning pharmacy batch — syringes, an enema,
  // nebulisers, thiamine — read as "possible septic shock with arrhythmia", four hours before a
  // normal discharge.
  const f15 = f({
    finding_id: 'a1-F15', finding_type: 'commission', severity: 'major', verdict: 'divergent',
    day_index: 3, evidence_basis: billingBasis, citation_ids: [4021],
  });
  const r = applyBillingOnlyCap(f15, [evt({ event_id: 'n0', day_index: 0 })]);
  assert.equal(r.capped, true);
  assert.equal(r.finding.severity, 'minor', 'below the ordinary moderate ceiling');
  assert.match(r.finding.statement, /Billing records dispensing, not administration/,
    'the caveat is in the statement a reader sees, not only in the arithmetic');
});

test('ITEM 1: a note on that day — any note — lifts the billing ceiling', () => {
  const f15 = f({ finding_id: 'x', finding_type: 'commission', severity: 'major', day_index: 3, evidence_basis: billingBasis });
  assert.equal(applyBillingOnlyCap(f15, [evt({ event_id: 'n3', day_index: 3 })]).capped, false,
    'code asks only whether a clinician wrote anything to check the claim against — never whether it supports it');
  assert.equal(notesOnDay([evt({ event_id: 'n3', day_index: 3 })], 3), true);
  assert.equal(notesOnDay([evt({ event_id: 'n0', day_index: 0 })], 3), false);
});

test('ITEM 1: mixed evidence is not billing-only, and an omission is not a commission', () => {
  const mixed = f({ finding_id: 'm', finding_type: 'commission', severity: 'major', day_index: 3,
    evidence_basis: [...billingBasis, ...noteBasis] });
  assert.equal(applyBillingOnlyCap(mixed, []).capped, false, 'the note is real evidence');
  const omission = f({ finding_id: 'o', finding_type: 'omission', severity: 'major', day_index: 3, evidence_basis: billingBasis });
  assert.equal(applyBillingOnlyCap(omission, []).capped, false,
    'an ABSENCE of billing is a different claim from a narrative built on billing');
});

test('ITEM 1: the billing ceiling is not lifted by a citation — order of the two caps', () => {
  const cited = f({ finding_id: 'c', finding_type: 'commission', severity: 'major', verdict: 'divergent',
    day_index: 3, evidence_basis: billingBasis, citation_ids: [4021] });
  const res = finalizeFindings([cited], new Map(), [evt({ event_id: 'n0', day_index: 0 })], 0, SOURCES, NORMATIVE);
  assert.equal(res.findings[0].severity, 'minor',
    'a guideline saying the drug should be given does not turn a dispensing line into an administration record');
  assert.equal(res.n_billing_only_capped, 1);
});

test('ITEM 2b: no progress note on the discharge day is raised by CODE, as a major finding', () => {
  const events = [
    evt({ event_id: 'n0', day_index: 0 }), evt({ event_id: 'n1', day_index: 1 }),
    evt({ event_id: 'disch', day_index: 3, event_type: 'discharge' }),
  ];
  const finding = missingDischargeDayNote(events, 3);
  assert.ok(finding, 'nothing expected it, so nothing else could have found it');
  assert.equal(finding!.severity, 'major');
  assert.equal(finding!.domain, 'documentation');
  assert.equal(finding!.verdict, 'divergent');
  assert.equal(finding!.day_index, 3);
  assert.equal(finding!.evidence_tier, 'A');
  assert.ok(finding!.evidence_basis.length, 'it cites a real note from another day — the table was in use');
  // and item 10 lets it keep major: Tier A evidence, no citation needed
  assert.equal(applySeverityCap(finding!).capped, false);
});

test('ITEM 2b: a note ON the discharge day means no finding; a handover is not a progress note', () => {
  const base = [evt({ event_id: 'n0', day_index: 0 }), evt({ event_id: 'disch', day_index: 2, event_type: 'discharge' })];
  assert.equal(missingDischargeDayNote([...base, evt({ event_id: 'n2', day_index: 2 })], 2), null);
  const handoverOnly = [...base, evt({ event_id: 'h2', day_index: 2, event_type: 'handover' })];
  assert.ok(missingDischargeDayNote(handoverOnly, 2), 'a nursing handover is not the entry a discharge decision rests on');
});

test('ITEM 2b: a same-day admission and discharge raises nothing', () => {
  const events = [evt({ event_id: 'disch', day_index: 0, event_type: 'discharge' })];
  assert.equal(missingDischargeDayNote(events, 0), null, 'a LOS-0 stay is a different kind of episode');
});

test('ITEM 4: the six stent findings become one class — subject, not term list', () => {
  // The real IPNO-416 wordings, verbatim from the stored checkpoints.
  const wordings = [
    'Stent patency and complications (flank pain, fever, sepsis signs)',
    'Stent-related symptoms (dysuria, urgency, frequency, gross hematuria) and signs of stent migration',
    'Stent function and complications (flank pain, hematuria, fever, signs of obstruction or migration)',
  ];
  const subjects = new Set(wordings.map((item) => subjectWords(item).join('+')));
  assert.equal(subjects.size, 1, 'three phrasings, one subject');
  assert.equal([...subjects][0], 'stent');
});

test('ITEM 4: a purpose clause is not part of the subject', () => {
  const a = subjectWords('Serum creatinine and electrolytes (K, Na) to assess acute-on-chronic kidney function');
  const b = subjectWords('Renal function test (creatinine, urea, electrolytes including potassium) to assess trend');
  assert.deepEqual(a, b, 'the two wordings the digest could not merge in round 13');
});

test('ITEM 4: qualifiers do not split a class, but a different subject still does', () => {
  assert.deepEqual(subjectWords('Repeat complete blood count'), subjectWords('Complete blood count'),
    'whether it is a repeat is the day window’s business, not the subject’s');
  assert.notDeepEqual(subjectWords('serum creatinine'), subjectWords('blood culture'));
});

test('ITEM 4: an escalation trigger groups on the trigger, not on the action it names', () => {
  const a = subjectWords('Severe flank pain or gross hematuria → Urgent urology review');
  const b = subjectWords('Severe flank pain or gross hematuria → CT imaging and nephrology referral');
  assert.deepEqual(a, b, 'the same trigger is the same expectation whoever it routes to');
});

test('ITEM 4: text with no recognised concept falls back to its own words and groups only with itself', () => {
  const odd = subjectWords('bespoke unclassifiable instruction');
  assert.ok(odd.length > 0);
  assert.notDeepEqual(odd, subjectWords('another bespoke instruction'));
});

test('ITEM 4: every canonical concept is reachable as a word in its own right', () => {
  // The defect that made the first version of this key useless: `stent` was a VALUE of the synonym
  // map and not a KEY, so the word "stent" itself was not recognised as a concept.
  for (const concept of SUBJECT_CONCEPTS) {
    assert.deepEqual(subjectWords(concept), [concept], `"${concept}" canonicalises to itself`);
  }
});
