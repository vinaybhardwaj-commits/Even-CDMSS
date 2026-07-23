// lib/__tests__/even-lvc-core.test.ts — PURE core of the Even LVC Adjudication System
// (CDMSS-EVEN-LVC-ADJUDICATION-SYSTEM-PRD-v1.0). Fixtures only (no DB / no LLM). Covers the 7 groups
// in the PRD Tests section + the de-identification and no-auto-retire invariants.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDigest, normalizeSubject, evenGenUserMessage, parseCandidatesJson, dedupeCandidates,
  isDuplicateCandidate, maxOrdinalForCategory, nextAssertionId, assignAssertionIds,
  computeOwnCases, rollupContests, evenChunkSection, normalizeAssertionText,
  LVC_GEN_CAT_MIN, LVC_GEN_TOPK, LVC_GEN_SUBJECT_MIN, LVC_CONTEST_FLAG, EVEN_DEDUP_COSINE,
  type DigestRow, type GenCandidate, type ExistingAssertion,
} from '../even-lvc-core.ts';

// ── (1) digest builder: CATEGORY-grain qualification + topK + singleton-drop + de-identification (§1.1) ──
test('buildDigest qualifies at the CATEGORY grain (≥ CAT_MIN total), drops singletons, emits ONLY {subject,count} + total', () => {
  // rows carry stray PHI-ish fields that MUST NOT survive into the digest
  const rows = [
    { lvc_category: 'antibiotic', subject: 'Azithromycin for viral URI', n: 40, doctor_uid: 'DOC1', uid: 'note-123', patient_name: 'X' },
    { lvc_category: 'antibiotic', subject: 'azithromycin for viral uri.', n: 5 },   // casing/punct variant → merges to 45
    { lvc_category: 'antibiotic', subject: 'Amoxicillin for cold', n: 8 },
    { lvc_category: 'antibiotic', subject: 'one-off brand xyz', n: 1 },             // singleton → dropped from subjects (kept in total)
    { lvc_category: 'imaging', subject: 'MRI for acute low back pain', n: 30 },      // category total 30 < 50 → dropped
  ] as unknown as DigestRow[];
  const digest = buildDigest(rows);   // defaults: catMin 50, topK 80, subjectMin 2

  const abx = digest.find((c) => c.lvc_category === 'antibiotic');
  assert.ok(abx, 'antibiotic qualifies (total ≥ CAT_MIN)');
  assert.equal(abx!.total, 54, 'total = full category sum incl. the singleton (45+8+1)');
  assert.deepEqual(abx!.subjects.map((s) => s.subject), ['azithromycin for viral uri', 'amoxicillin for cold'], 'singleton dropped; ordered by count desc');
  assert.equal(abx!.subjects[0].count, 45, 'casing/punct variants merge (40+5)');
  // de-identification: each exemplar has EXACTLY subject + count, nothing else
  for (const s of abx!.subjects) assert.deepEqual(Object.keys(s).sort(), ['count', 'subject']);
  assert.ok(!JSON.stringify(digest).includes('DOC1'), 'no doctor_uid leaks');
  assert.ok(!JSON.stringify(digest).includes('note-123'), 'no note uid leaks');
  assert.ok(!JSON.stringify(digest).includes('patient_name'), 'no PHI field leaks');
  assert.equal(digest.find((c) => c.lvc_category === 'imaging'), undefined, 'below-CAT_MIN category dropped entirely');
});

test('buildDigest: a FRAGMENTED category qualifies on TOTAL even when no single subject hits the old ≥20 floor (§1.1 core fix)', () => {
  // 30 distinct phrasings, each count 2 → total 60 ≥ CAT_MIN; NO subject reaches the retired subject-floor
  const fragmented = Array.from({ length: 30 }, (_, i) => ({ lvc_category: 'antihistamine_allergy', subject: `allergy phrasing ${i}`, n: 2 })) as unknown as DigestRow[];
  const digest = buildDigest(fragmented);
  const cat = digest.find((c) => c.lvc_category === 'antihistamine_allergy');
  assert.ok(cat, 'fragmented category qualifies on its total (the whole point of the fix)');
  assert.equal(cat!.total, 60);
  assert.equal(cat!.subjects.length, 30, 'all non-singleton subjects kept (≤ TOPK)');
  assert.ok(LVC_GEN_CAT_MIN === 50 && LVC_GEN_TOPK === 80 && LVC_GEN_SUBJECT_MIN === 2, 'constants wired');
});

test('buildDigest: topK truncates to the highest-count exemplars', () => {
  const rows = [
    { lvc_category: 'supplement_polypharmacy', subject: 'Multivitamin for fatigue', n: 20 },
    { lvc_category: 'supplement_polypharmacy', subject: 'Vitamin D for tiredness', n: 15 },
    { lvc_category: 'supplement_polypharmacy', subject: 'B12 for weakness', n: 10 },
    { lvc_category: 'supplement_polypharmacy', subject: 'a singleton', n: 1 },
  ] as unknown as DigestRow[];
  const d = buildDigest(rows, { catMin: 40, topK: 2 });   // total 46 ≥ 40 ⇒ qualifies; keep top 2
  assert.equal(d.length, 1);
  assert.equal(d[0].total, 46, 'total includes the singleton');
  assert.deepEqual(d[0].subjects.map((s) => s.subject), ['multivitamin for fatigue', 'vitamin d for tiredness'], 'top 2 by count, singleton excluded');
});

test('normalizeSubject collapses casing/whitespace/trailing period', () => {
  assert.equal(normalizeSubject('  Azithromycin   for  URI. '), 'azithromycin for uri');
});

// ── (2) dedup: same-category near-dupes (text-eq + cosine≥0.90), incl. vs rejected ──
test('isDuplicateCandidate drops same-category text-eq / cosine≥0.90, incl. against rejected; keeps cross-category', () => {
  const cand: GenCandidate = { lvc_category: 'antibiotic', assertion_text: 'Antibiotics are low-value for uncomplicated viral URI.', rationale: null, supporting: [] };
  const existing: ExistingAssertion[] = [
    { id: 'elv-antibiotic-001', lvc_category: 'antibiotic', assertion_text: 'Antibiotics are low-value for uncomplicated viral URI', status: 'active' },
  ];
  // text-equality (normalized) ⇒ dup even with a similarity fn that says 0
  assert.equal(isDuplicateCandidate(cand, existing, () => 0), true, 'normalized text equality ⇒ dup');

  const near: GenCandidate = { ...cand, assertion_text: 'Do not prescribe antibiotics for simple viral upper-respiratory infections.' };
  assert.equal(isDuplicateCandidate(near, existing, () => 0.95), true, 'cosine ≥ 0.90 ⇒ dup');
  assert.equal(isDuplicateCandidate(near, existing, () => 0.80), false, 'cosine < 0.90 ⇒ not a dup');

  // vs a REJECTED row (dedup memory) still counts
  const rej: ExistingAssertion[] = [{ id: 'elv-antibiotic-009', lvc_category: 'antibiotic', assertion_text: near.assertion_text, status: 'rejected' }];
  assert.equal(isDuplicateCandidate(near, rej, () => 0.99), true, 'near-dup of a rejected row ⇒ dropped');

  // cross-category never dedups even at cosine 1.0
  const other: ExistingAssertion[] = [{ id: 'elv-imaging-001', lvc_category: 'imaging', assertion_text: cand.assertion_text, status: 'active' }];
  assert.equal(isDuplicateCandidate(cand, other, () => 1.0), false, 'cross-category ⇒ never a dup');
});

test('dedupeCandidates removes intra-batch dupes and caps', () => {
  const a: GenCandidate = { lvc_category: 'antibiotic', assertion_text: 'A statement one', rationale: null, supporting: [] };
  const dupOfA: GenCandidate = { lvc_category: 'antibiotic', assertion_text: 'A statement one.', rationale: null, supporting: [] };
  const b: GenCandidate = { lvc_category: 'imaging', assertion_text: 'B statement two', rationale: null, supporting: [] };
  const out = dedupeCandidates([a, dupOfA, b], [], () => 0, 10, EVEN_DEDUP_COSINE);
  assert.deepEqual(out.map((c) => c.assertion_text), ['A statement one', 'B statement two'], 'intra-batch dup dropped');
  const capped = dedupeCandidates([a, b], [], () => 0, 1);
  assert.equal(capped.length, 1, 'cap honoured');
});

// ── (3) rollupContests + flip at threshold, NO auto-retire ─────────────────────
test('rollupContests counts per assertion and flips ONLY active→contested at ≥ flag; never auto-retires', () => {
  const assertions = [
    { id: 'elv-antibiotic-001', status: 'active' as const, contest_count: 0 },
    { id: 'elv-imaging-001', status: 'active' as const, contest_count: 0 },
    { id: 'elv-imaging-002', status: 'contested' as const, contest_count: 6 },
    { id: 'elv-supplement_polypharmacy-001', status: 'retired' as const, contest_count: 9 },
    { id: 'elv-antibiotic-002', status: 'pending' as const, contest_count: 0 },
  ];
  const contestRows = [
    ...Array.from({ length: LVC_CONTEST_FLAG }, () => ({ assertion_id: 'elv-antibiotic-001' })),  // exactly 5 ⇒ flip
    { assertion_id: 'elv-imaging-001' }, { assertion_id: 'elv-imaging-001' },                     // 2 ⇒ stays active
    ...Array.from({ length: 20 }, () => ({ assertion_id: 'elv-supplement_polypharmacy-001' })),   // retired stays retired
    { assertion_id: null }, { assertion_id: '' },                                                 // ignored
  ];
  const out = rollupContests(assertions, contestRows, LVC_CONTEST_FLAG);
  const by = Object.fromEntries(out.map((r) => [r.id, r]));
  assert.equal(by['elv-antibiotic-001'].status, 'contested', 'active at threshold ⇒ contested');
  assert.equal(by['elv-antibiotic-001'].contest_count, 5);
  assert.equal(by['elv-antibiotic-001'].changed, true);
  assert.equal(by['elv-imaging-001'].status, 'active', 'below threshold ⇒ stays active');
  assert.equal(by['elv-imaging-002'].status, 'contested', 'already contested ⇒ unchanged (no re-flip, no retire)');
  assert.equal(by['elv-supplement_polypharmacy-001'].status, 'retired', 'retired NEVER auto-changes even at 20 contests');
  assert.equal(by['elv-antibiotic-002'].status, 'pending', 'pending never flips');
});

// ── (4) own_cases ───────────────────────────────────────────────────────────────
test('computeOwnCases true only when ratifier name is among the supporting doctor_uids', () => {
  assert.equal(computeOwnCases('Zaki', ['DOC_A', 'Zaki', 'DOC_B']), true);
  assert.equal(computeOwnCases('Zaki', ['DOC_A', 'DOC_B']), false, 'roster reviewer not among doctors ⇒ false (the common case)');
  assert.equal(computeOwnCases('', ['']), false, 'empty ratifier ⇒ false');
});

// ── (5) evenCandidateAccepted lives in normative-grounding-core; exercised there. ──
// (see lib/__tests__/normative-grounding.test.ts — even gate + leg wiring + merge ordering)

// ── (7) id-ordinal generation ─────────────────────────────────────────────────
test('id-ordinal: elv-<category>-<padded>, per-category, monotone; batch ids do not collide', () => {
  const existing = ['elv-antibiotic-001', 'elv-antibiotic-003', 'elv-imaging-001'];
  assert.equal(maxOrdinalForCategory('antibiotic', existing), 3);
  assert.equal(nextAssertionId('antibiotic', existing), 'elv-antibiotic-004');
  assert.equal(nextAssertionId('imaging', existing), 'elv-imaging-002');
  assert.equal(nextAssertionId('supplement_polypharmacy', existing), 'elv-supplement_polypharmacy-001');

  const batch: GenCandidate[] = [
    { lvc_category: 'antibiotic', assertion_text: 'x1', rationale: null, supporting: [] },
    { lvc_category: 'antibiotic', assertion_text: 'x2', rationale: null, supporting: [] },
    { lvc_category: 'imaging', assertion_text: 'y1', rationale: null, supporting: [] },
  ];
  const ids = assignAssertionIds(batch, existing).map((x) => x.id);
  assert.deepEqual(ids, ['elv-antibiotic-004', 'elv-antibiotic-005', 'elv-imaging-002'], 'intra-batch ordinals advance');
});

// ── parsing (feeds generation; must never throw on a bad reply) ─────────────────
test('parseCandidatesJson: tolerant of fences/prose/object-wrap; drops malformed + hallucinated categories', () => {
  const allowed = ['antibiotic', 'imaging'];
  const raw = 'Here you go:\n```json\n[{"lvc_category":"antibiotic","assertion_text":"A","rationale":"r","supporting":[{"subject":"Azithro","count":40}]},'
    + '{"lvc_category":"cardiology","assertion_text":"nope"},'   // hallucinated category → dropped
    + '{"lvc_category":"imaging","assertion_text":""},'          // empty text → dropped
    + '{"assertion_text":"no category"}]\n```';
  const out = parseCandidatesJson(raw, allowed);
  assert.equal(out.length, 1);
  assert.equal(out[0].lvc_category, 'antibiotic');
  assert.equal(out[0].supporting[0].subject, 'azithro');
  assert.deepEqual(parseCandidatesJson('not json at all'), [], 'garbage ⇒ [] (never throws)');
  assert.deepEqual(parseCandidatesJson('{"candidates":[{"lvc_category":"imaging","assertion_text":"Z"}]}').map((c) => c.lvc_category), ['imaging'], 'object-wrapped array accepted');
});

test('evenGenUserMessage only references shown categories/subjects + surfaces the category total (§1.1)', () => {
  const prompt = evenGenUserMessage([{ lvc_category: 'antibiotic', subjects: [{ subject: 'azithromycin for viral uri', count: 45 }], total: 53 }], 25);
  assert.match(prompt, /category: antibiotic/);
  assert.match(prompt, /53 low-value findings total/);
  assert.match(prompt, /azithromycin for viral uri \(seen 45×\)/);
  assert.match(prompt, /up to 25 candidate/);
});

test('evenChunkSection / normalizeAssertionText helpers', () => {
  assert.equal(evenChunkSection('active', 2), 'active/v2');
  assert.equal(evenChunkSection('active', 0), 'active/v1', 'version floors at 1');
  assert.equal(normalizeAssertionText('  Foo BAR.  '), 'foo bar');
});
