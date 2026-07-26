// Concept Coder Phase 1 core (CDMSS-CONCEPT-CODER-PRD v1.0 §9). Pure-core tests only — no DB, no
// model calls. The extraction-call tests use a stub in place of governedChat, so "zero model calls"
// is asserted by counting invocations, not inferred.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeConceptSubject, normalizeSlot, composeConceptId, baseConceptId, computeReviewLane,
  validateExtraction, stampConcepts, pendingSubjects, isCodableFinding, resolveTarget,
  applyCollapseRules, isGuardedBrandToken, isConceptDirection, CONCEPT_DIRECTIONS,
  CLEAN_LANE_MIN_CONTEXT_FREE_SHARE, type ConceptAssignment, type TargetResolution,
} from '../even-concept-core';
import { normalizeSubject } from '../even-lvc-core';
import { computeOpdScore } from '../opd-note-score-core';

const lv = (over: Record<string, unknown> = {}) => ({
  subject: 'unindicated antibiotic prescription', verdict: 'low-value', confidence: 0.8,
  domain: 'appropriateness', rationale: 'r', ...over,
});

// ── normalisation compatibility (load-bearing: the 9,449 seeded norms use the house rule) ──
test('normalizeConceptSubject is byte-identical to the house normalizeSubject', () => {
  const cases = ['  Unindicated  Antibiotic ', 'CBC (Complete Blood Count).', 'x', '', '   ', 'a.b..', 'Montek LC...'];
  for (const c of cases) assert.equal(normalizeConceptSubject(c), normalizeSubject(c), JSON.stringify(c));
  assert.equal(normalizeConceptSubject(null), '');
  assert.equal(normalizeConceptSubject(undefined), '');
});

test('normalizeSlot strips inner colons so a slot can never inject an extra id segment', () => {
  assert.equal(normalizeSlot('rx:antibiotic'), 'rx antibiotic');
  assert.equal(composeConceptId({ direction: 'overuse', action: 'rx:evil', target: 'x' }), 'overuse:rx evil:x');
});

// ── composition ────────────────────────────────────────────────────────────────
test('composeConceptId builds direction:action:target and refuses a blank or bad slot', () => {
  assert.equal(composeConceptId({ direction: 'overuse', action: 'rx', target: 'antibiotic' }), 'overuse:rx:antibiotic');
  assert.equal(composeConceptId({ direction: 'overuse', action: '', target: 'antibiotic' }), null);
  assert.equal(composeConceptId({ direction: 'overuse', action: 'rx', target: '   ' }), null);
  assert.equal(composeConceptId({ direction: 'overuse', action: 'rx', target: 'null' }), null);
  // a direction outside the closed vocabulary can never compose (PRD §9)
  assert.equal(composeConceptId({ direction: 'exclude_test_note' as never, action: 'rx', target: 'x' }), null);
});

test('baseConceptId folds a context-qualified id onto its base', () => {
  assert.equal(baseConceptId('overuse:rx:antibiotic:viral urti'), 'overuse:rx:antibiotic');
  assert.equal(baseConceptId('overuse:rx:antibiotic'), 'overuse:rx:antibiotic');
});

test('the direction vocabulary is closed to exactly the four structural values', () => {
  assert.deepEqual([...CONCEPT_DIRECTIONS], ['overuse', 'underuse', 'documentation', 'process']);
  for (const d of CONCEPT_DIRECTIONS) assert.equal(isConceptDirection(d), true);
  for (const d of ['exclude_test_note', 'OVERUSE', 'misuse', '', null]) assert.equal(isConceptDirection(d), false, String(d));
});

// ── §7 formulary guard + stage order ───────────────────────────────────────────
test('§7 formulary guard: a "cbc" brand-TOKEN match does not resolve to pralidoxime', () => {
  const hostile = (t: string): TargetResolution | null =>
    t === 'cbc' ? { target: 'pralidoxime', tier: 'brand-token' } : null;
  assert.equal(resolveTarget('cbc', hostile), 'cbc');                       // guard holds the literal
  assert.equal(isGuardedBrandToken('cbc', 'brand-token'), true);
  for (const w of ['anti', 'skin', 'calcium']) assert.equal(isGuardedBrandToken(w, 'brand-token'), true, w);
  // the guard is specific to the brand-TOKEN tier — a brand-EXACT match is untouched
  assert.equal(isGuardedBrandToken('cbc', 'brand-exact'), false);
  const exact = (): TargetResolution => ({ target: 'amoxicillin', tier: 'brand-exact' });
  assert.equal(resolveTarget('mox 500', exact), 'amoxicillin');
});

test('§7 stage order: the collapse rule runs AFTER formulary resolution', () => {
  // "montek lc" resolving to bare montelukast then collapsing yields montelukast_containing; collapsing
  // FIRST would have nothing to collapse and would leave the brand. Order is load-bearing (PRD §7).
  const formulary = (t: string): TargetResolution | null =>
    t === 'montek lc' ? { target: 'montelukast+levocetirizine', tier: 'brand-exact' } : null;
  assert.equal(resolveTarget('montek lc', formulary), 'montelukast_containing');
  assert.equal(applyCollapseRules('montelukast'), 'montelukast_containing');
  assert.equal(applyCollapseRules('levocetirizine+montelukast'), 'montelukast_containing');
  assert.equal(applyCollapseRules('amoxicillin'), 'amoxicillin');
});

test('a resolver that throws never loses the literal target', () => {
  assert.equal(resolveTarget('antibiotic', () => { throw new Error('boom'); }), 'antibiotic');
  assert.equal(resolveTarget('antibiotic', null), 'antibiotic');
});

// ── §9 known-answer ────────────────────────────────────────────────────────────
test('§9 known-answer: every montelukast-bearing string resolves to overuse:rx:montelukast_containing', () => {
  // The seed's montelukast family, as written by the Research Team (brand, combination and generic
  // spellings). MEASURED against the shipped seed: the concept carries 175 strings, not the 118 the
  // PRD's §9 text states — see the build report. The INVARIANT under test is that they all agree.
  const strings = [
    'levocetirizine+montelukast', 'montelukast+levocetirizine', 'unindicated montelukast',
    'montelukast for acute urti', 'montek lc for common cold', 'fixed dose combination of montelukast',
  ];
  const formulary = (t: string): TargetResolution | null =>
    t.startsWith('montek') ? { target: 'montelukast+levocetirizine', tier: 'brand-exact' } : null;
  const ids = new Set(strings.map((s) => {
    const target = resolveTarget(s.includes('montek') ? 'montek lc' : 'montelukast', formulary);
    return composeConceptId({ direction: 'overuse', action: 'rx', target });
  }));
  assert.deepEqual([...ids], ['overuse:rx:montelukast_containing']);
});

// ── §4 review lanes ────────────────────────────────────────────────────────────
test('§9 review_lane: clean for montelukast (0 contexts), context for antibiotic (163 contexts)', () => {
  // Volumes are the shipped seed's, measured: montelukast 302 findings all context-free; antibiotic
  // 976 findings of which 38.3% are context-free (163 distinct contexts).
  assert.equal(computeReviewLane(302, 302), 'clean');
  assert.equal(computeReviewLane(976, 374), 'context');
  // and the two other concepts the PRD names in §4
  assert.equal(computeReviewLane(773, 518), 'context');   // investigation, 67.0% context-free
  assert.equal(computeReviewLane(508, 494), 'clean');     // diagnosis-complaint concordance, 97.2%
});

test('review_lane is a deterministic threshold on the context-free VOLUME share', () => {
  assert.equal(CLEAN_LANE_MIN_CONTEXT_FREE_SHARE, 0.80);
  assert.equal(computeReviewLane(100, 80), 'clean');      // exactly at the threshold
  assert.equal(computeReviewLane(100, 79), 'context');
  assert.equal(computeReviewLane(0, 0), 'clean');         // no volume ⇒ nothing to drill into
  assert.equal(computeReviewLane(-5, 3), 'clean');        // never throws on nonsense
});

// ── §9 extraction validation ───────────────────────────────────────────────────
test('§9: a valid extraction composes; context is optional and normalised', () => {
  const r = validateExtraction('{"direction":"overuse","action":"RX","target":"Antibiotic","context":"Viral URTI"}');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.conceptId, 'overuse:rx:antibiotic');
  assert.equal(r.slots.context, 'viral urti');
  const noCtx = validateExtraction('{"direction":"underuse","action":"rx","target":"levothyroxine","context":""}');
  assert.equal(noCtx.ok && noCtx.slots.context, null);
});

test('§9: unparseable extraction ⇒ reject, no stamp', () => {
  for (const bad of ['', '   ', 'not json at all', '[1,2,3]', 'null', '{"direction":']) {
    const r = validateExtraction(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
  assert.equal((validateExtraction('not json') as { reason: string }).reason, 'not_json');
  assert.equal((validateExtraction('[1]') as { reason: string }).reason, 'not_object');
});

test('§9: a direction outside the closed vocabulary is rejected, never coerced', () => {
  const r = validateExtraction('{"direction":"exclude_test_note","action":"rx","target":"x"}');
  assert.equal(r.ok, false);
  assert.equal((r as { reason: string }).reason, 'bad_direction');
  const r2 = validateExtraction('{"direction":"misuse","action":"rx","target":"x"}');
  assert.equal((r2 as { reason: string }).reason, 'bad_direction');
});

test('a missing slot is a reject, not a partial stamp', () => {
  assert.equal((validateExtraction('{"direction":"overuse","action":"","target":"x"}') as { reason: string }).reason, 'missing_slot');
  assert.equal((validateExtraction('{"direction":"overuse","action":"rx"}') as { reason: string }).reason, 'missing_slot');
});

test('a ```json fence is tolerated; nothing else is repaired', () => {
  const r = validateExtraction('```json\n{"direction":"process","action":"followup","target":"referral"}\n```');
  assert.equal(r.ok && r.conceptId, 'process:followup:referral');
});

// ── stamping ───────────────────────────────────────────────────────────────────
const LOOKUP = (m: Record<string, ConceptAssignment>) => (n: string) => m[n] ?? null;

test('§9 exact-lookup hit stamps the seeded concept with ZERO model calls', () => {
  let calls = 0;
  const lookup = (n: string) => { calls++; return n === 'unindicated antibiotic prescription' ? { concept_id: 'overuse:rx:antibiotic', context: null } : null; };
  const { findings, stamped } = stampConcepts([lv()], lookup);
  assert.equal(stamped, 1);
  assert.equal((findings[0] as Record<string, unknown>).concept_id, 'overuse:rx:antibiotic');
  assert.equal((findings[0] as Record<string, unknown>).concept_context, null);
  assert.equal(calls, 1);   // one cache probe, no extraction
});

test('a lookup miss leaves the finding byte-identical (PRD §7 fail-safe)', () => {
  const f = lv();
  const { findings, stamped } = stampConcepts([f], () => null);
  assert.equal(stamped, 0);
  assert.equal(findings[0], f);                    // the SAME object — untouched
  assert.equal((findings[0] as Record<string, unknown>).concept_id, undefined);
});

test('an already-coded finding is never re-stamped (a string is extracted once, ever)', () => {
  const f = lv({ concept_id: 'overuse:rx:antibiotic', concept_context: 'viral urti' });
  const { findings, stamped } = stampConcepts([f], () => ({ concept_id: 'overuse:rx:OTHER', context: null }));
  assert.equal(stamped, 0);
  assert.equal(findings[0], f);
});

test('only low-value, non-informational findings are codable', () => {
  assert.equal(isCodableFinding(lv()), true);
  assert.equal(isCodableFinding(lv({ verdict: 'high-value' })), false);
  assert.equal(isCodableFinding(lv({ informational: true })), false);
  assert.equal(isCodableFinding(lv({ subject: '   ' })), false);
  const mixed = [lv(), lv({ verdict: 'high-value', subject: 'good' }), lv({ informational: true, subject: 'info' })];
  const { stamped } = stampConcepts(mixed, () => ({ concept_id: 'overuse:rx:x', context: null }));
  assert.equal(stamped, 1);
});

test('a throwing lookup never throws out of stampConcepts', () => {
  const { findings, stamped } = stampConcepts([lv()], () => { throw new Error('db down'); });
  assert.equal(stamped, 0);
  assert.equal((findings[0] as Record<string, unknown>).concept_id, undefined);
});

test('pendingSubjects dedupes, skips coded/uncodable, and honours the known-set', () => {
  const fs = [lv(), lv(), lv({ subject: 'Unindicated  Antibiotic Prescription' }), lv({ subject: 'other string' }),
    lv({ concept_id: 'x:y:z', subject: 'already coded' }), lv({ verdict: 'high-value', subject: 'hv' })];
  assert.deepEqual(pendingSubjects(fs, () => false), ['unindicated antibiotic prescription', 'other string']);
  assert.deepEqual(pendingSubjects(fs, (n) => n === 'other string'), ['unindicated antibiotic prescription']);
});

test('§9 cache miss → extract once → cached; a repeated string makes NO second call', () => {
  // Reproduces the tick's dedup contract with the pure pieces it is built from: the tick collects
  // pendingSubjects across the whole batch into a Set, filters by the cache, and extracts only the
  // residue. 40 findings carrying the same string must cost exactly ONE extraction, and re-running
  // the tick after the cache is populated must cost ZERO.
  const batch = Array.from({ length: 40 }, (_, i) => lv({ subject: i % 2 ? 'Unindicated antibiotic prescription' : 'unindicated  antibiotic   prescription' }));
  batch.push(lv({ subject: 'a second distinct string' }));

  const cache = new Map<string, ConceptAssignment>();
  let extractions = 0;
  const runTick = () => {
    const norms = new Set(pendingSubjects(batch as never, () => false));
    const misses = [...norms].filter((n) => !cache.has(n));
    for (const n of misses) { extractions++; cache.set(n, { concept_id: 'overuse:rx:antibiotic', context: null }); }
    return stampConcepts(batch as never, (n) => cache.get(n) ?? null);
  };

  const first = runTick();
  assert.equal(extractions, 2, '41 findings over 2 distinct strings must cost exactly 2 extractions');
  assert.equal(first.stamped, 41);

  const second = runTick();
  assert.equal(extractions, 2, 'a second tick over cached strings must make no further call');
  assert.equal(second.stamped, 41);
});

// ── §9 SCORE-INVARIANCE — the hard invariant (PRD §3, §6 Phase 1 gate) ─────────
test('§9 score-invariance: stamping 240 audits changes no headline, band, domain score or confidence', () => {
  const N = 240;
  const before: ReturnType<typeof computeOpdScore>[] = [];
  const after: ReturnType<typeof computeOpdScore>[] = [];
  let totalStamped = 0;

  for (let i = 0; i < N; i++) {
    // A varied but deterministic audit: different finding mixes, coverage, PDQI and continuity, so the
    // assertion spans real score range rather than one repeated fixture.
    const nLow = i % 5, nHigh = i % 3;
    const findings: Record<string, unknown>[] = [];
    for (let k = 0; k < nLow; k++) findings.push(lv({ subject: `low ${k} of ${i}`, confidence: 0.5 + (k % 5) / 10 }));
    for (let k = 0; k < nHigh; k++) findings.push(lv({ subject: `high ${k}`, verdict: 'high-value', domain: 'prescribing_safety' }));
    findings.push(lv({ subject: `info ${i}`, informational: true }));

    const scoreInput = (fs: Record<string, unknown>[]) => ({
      findings: fs.filter((f) => !f.informational).map((f) => ({ verdict: f.verdict as never, confidence: f.confidence as number, domain: f.domain as never })),
      completenessCoverage: (i % 6) / 5,
      pdqi9: { thorough: 1 + (i % 5), accurate: 1 + ((i + 2) % 5), useful: 3 } as never,
      patientCentred: { present: i % 3, total: 2 },
    });

    before.push(computeOpdScore(scoreInput(findings)));
    // stamp every codable finding — a hit for all of them, the maximum-mutation case
    const res = stampConcepts(findings as never, (n) => ({ concept_id: 'overuse:rx:antibiotic', context: n.includes('low') ? 'viral urti' : null }));
    totalStamped += res.stamped;
    after.push(computeOpdScore(scoreInput(res.findings as never)));
  }

  assert.ok(totalStamped >= 200, `expected ≥200 stamps across the corpus, got ${totalStamped}`);
  for (let i = 0; i < N; i++) {
    assert.equal(after[i].headline, before[i].headline, `note_quality_index moved on audit ${i}`);
    assert.equal(after[i].band, before[i].band, `band moved on audit ${i}`);
    assert.equal(after[i].confidence, before[i].confidence, `confidence moved on audit ${i}`);
    assert.deepEqual(after[i].domains, before[i].domains, `a domain score moved on audit ${i}`);
    assert.deepEqual(after[i].pdqi9, before[i].pdqi9, `pdqi9 moved on audit ${i}`);
    assert.deepEqual(after[i].flags, before[i].flags, `flags moved on audit ${i}`);
  }
});

test('§3 score-invariance, structurally: stamping adds exactly two keys and mutates nothing else', () => {
  const f = lv({ finding_ref: 'abc', signal_type: 'appropriateness_low_value', lvc_category: 'antibiotic', citation_ids: [1, 2] });
  const { findings } = stampConcepts([f], () => ({ concept_id: 'overuse:rx:antibiotic', context: 'viral urti' }));
  const out = findings[0] as Record<string, unknown>;
  const added = Object.keys(out).filter((k) => !(k in (f as Record<string, unknown>)));
  assert.deepEqual(added.sort(), ['concept_context', 'concept_id']);
  for (const k of Object.keys(f as Record<string, unknown>)) {
    assert.deepEqual(out[k], (f as Record<string, unknown>)[k], `field ${k} was mutated`);
  }
  assert.notEqual(out, f);   // and the original object is not mutated in place
  assert.equal((f as Record<string, unknown>).concept_id, undefined);
});
