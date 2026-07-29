/**
 *   node --test --import tsx lib/__tests__/contradicted-by-structure.test.ts
 *
 * Audit-integrity batch, PHASE 2 (class A) — one neutralizer, eight arms.
 *
 * LLM findings that contradict structured data the engine already holds at scoring time: four
 * anti-diabetic agents called "no medication adjustments" (bug 1), an unindicated-investigation
 * flag on a note that ordered nothing (bug 2), three phantom antibiotics in one day (4b/5a/7a),
 * a rinse-off shampoo called "systemic" (4a), "indication not documented" beside the documented
 * indication (5c), the engine's own ratified vitamin-D rule overruled by a hallucination that
 * scored (6a), and a finding arguing with its own suggestion (7c).
 *
 * R-2: marked informational, NEVER dropped. And the one constraint above all others: a HIGH-VALUE
 * finding is never neutralized in any arm — 535 notes carry high-value antibiotic findings where
 * the antibiotic is correctly absent, and deleting that praise is the worst possible regression.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { neutralizeContradictedByStructure, type OpdFinding } from '../opd-note-audit-core.ts';
import type { DeidOpdCase, OpdMed } from '../opd-ingest-core.ts';

function mkCase(p: Partial<DeidOpdCase> = {}): DeidOpdCase {
  return {
    consultType: null, reasonForConsult: null, presentingComplaints: [], diagnosisCodes: [],
    impressionCodes: [], impressions: [], history: [], comorbidities: [], medications: [],
    investigations: [], advice: [], examination: [], allergies: null, followUpType: null, followUpDateSet: false, ...p,
  };
}
function mkFinding(p: Partial<OpdFinding>): OpdFinding {
  return {
    subject: 'x', verdict: 'low-value', confidence: 0.9, domain: 'appropriateness',
    rationale: '', evidence: [], estimates: [], citation_ids: [], source: 'llm', ...p,
  } as OpdFinding;
}
const N = neutralizeContradictedByStructure;

// The eight arms' exact signal_type strings (PRD §5.2, verbatim).
const SIGNALS = {
  1: 'contradicted_medication_present',
  2: 'contradicted_investigation_absent',
  3: 'contradicted_drug_class_absent',
  4: 'contradicted_route',
  5: 'contradicted_indication_present',
  6: 'contradicted_history',
  7: 'contradicted_ratified_rule',
  8: 'incoherent_with_suggestion',
} as const;

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Arm 1 — medication presence, absent-claim (bug 1: four anti-diabetic agents on the note)
// ═════════════════════════════════════════════════════════════════════════════════════════════

const BUG1 = mkFinding({
  subject: 'Plan lacks pharmacotherapy adjustment', verdict: 'context-dependent',
  rationale: 'The current plan only mentions dietary and lifestyle modifications without specific medication adjustments.',
});
const MEDS_CASE = mkCase({ medications: [{ brand: 'GLYCOMET TRIO', generic: 'Glimepiride + Metformin + Voglibose' } as OpdMed] });

test('arm 1: the bug-1 exhibit is neutralized when medications exist — and ONLY marked, never dropped', () => {
  const out = N([BUG1], MEDS_CASE);
  assert.equal(out.length, 1, 'R-2: mark, never drop');
  assert.equal(out[0].informational, true);
  assert.equal(out[0].signal_type, SIGNALS[1]);
  // verdict / domain / confidence / text untouched
  assert.equal(out[0].verdict, 'context-dependent');
  assert.equal(out[0].confidence, 0.9);
  assert.equal(out[0].rationale, BUG1.rationale);
});

test('arm 1: with ZERO medications the genuine claim stays raisable', () => {
  assert.notEqual(N([BUG1], mkCase())[0].informational, true);
});

test('arm 1 high-value guard: praise phrased around lifestyle-only plans survives', () => {
  const hv = mkFinding({ ...BUG1, verdict: 'high-value' });
  assert.notEqual(N([hv], MEDS_CASE)[0].informational, true);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Arm 2 — investigation presence (bug 2: nothing ordered, appropriateness fell 45 points)
// ═════════════════════════════════════════════════════════════════════════════════════════════

const BUG2 = mkFinding({
  subject: 'Unindicated investigation', verdict: 'low-value', confidence: 1.0,
  rationale: 'The note does not document any specific indication for investigations, and the presenting complaint of a resolved rash does not warrant further testing.',
});

test('arm 2: the bug-2 exhibit is neutralized when NO investigation was ordered', () => {
  const out = N([BUG2], mkCase({ investigations: [] }));
  assert.equal(out[0].informational, true);
  assert.equal(out[0].signal_type, SIGNALS[2]);
});

test('arm 2: with an investigation actually ordered the critique stays raisable', () => {
  assert.notEqual(N([BUG2], mkCase({ investigations: ['CBC'] }))[0].informational, true);
});

test('arm 2 high-value guard: praising restraint from testing survives', () => {
  const hv = mkFinding({ subject: 'Avoided unnecessary investigation', verdict: 'high-value', rationale: 'No unindicated investigation was ordered for this self-limiting rash.' });
  assert.notEqual(N([hv], mkCase({ investigations: [] }))[0].informational, true);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Arm 3 — drug-class (bugs 4b/5a/7a: three phantom antibiotics in one day)
// ═════════════════════════════════════════════════════════════════════════════════════════════

const PHANTOM_ABX = mkFinding({
  subject: 'Unindicated antibiotic prescription', verdict: 'low-value', confidence: 1.0,
  rationale: 'Antibiotics are generally not indicated for URTIs caused by viruses.',
});
const SYMPTOMATIC_MEDS = mkCase({ medications: [
  { brand: 'Dolo 650', generic: 'Paracetamol', therapeuticClass: 'Analgesic' } as OpdMed,
  { brand: 'LEVOCET', generic: 'Levocetirizine', therapeuticClass: 'Antihistamine' } as OpdMed,
] });

test('arm 3: a phantom antibiotic on symptomatic-only meds is neutralized (bug 4b/7a)', () => {
  const out = N([PHANTOM_ABX], SYMPTOMATIC_MEDS);
  assert.equal(out[0].informational, true);
  assert.equal(out[0].signal_type, SIGNALS[3]);
});

test('arm 3: fires on ZERO medications too (bug 5a — the ghost the B1 guard missed)', () => {
  const out = N([PHANTOM_ABX], mkCase({ medications: [] }));
  assert.equal(out[0].informational, true);
  assert.equal(out[0].signal_type, SIGNALS[3]);
});

test('arm 3: an ACTUAL antibiotic on the note keeps the stewardship finding scoring', () => {
  const abx = mkCase({ medications: [{ brand: 'Augmentin 625', generic: 'Amoxicillin + Clavulanate', therapeuticClass: 'Antibiotic' } as OpdMed] });
  assert.notEqual(N([PHANTOM_ABX], abx)[0].informational, true);
});

test('arm 3 THE 535-NOTE GUARD: high-value antibiotic-avoidance praise is NEVER neutralized', () => {
  const praise = mkFinding({ subject: 'Appropriate antibiotic avoidance', verdict: 'high-value', rationale: 'No antibiotic was prescribed for this viral URTI — guideline-concordant restraint.' });
  const out = N([praise], mkCase({ medications: [] }));
  assert.notEqual(out[0].informational, true, 'the worst possible regression in this phase');
});

test('arm 3 restricts to low-value/context-dependent: an uncertain-verdict mention passes through', () => {
  const unc = mkFinding({ ...PHANTOM_ABX, verdict: 'uncertain' });
  assert.notEqual(N([unc], mkCase({ medications: [] }))[0].informational, true);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Arm 4 — route (bug 4a: the rinse-off shampoo called a "systemic antifungal")
// ═════════════════════════════════════════════════════════════════════════════════════════════

const BUG4A = mkFinding({
  subject: 'Unindicated systemic antifungal', verdict: 'low-value',
  rationale: 'Pityriasis capitis simplex does not typically require systemic antifungals.',
});
const TOPICAL_MEDS = mkCase({ medications: [
  { brand: '8X Shampoo', generic: 'Ciclopirox + Zinc pyrithione', route: 'Topical', therapeuticClass: 'Antifungal' } as OpdMed,
  { brand: 'Minichek 5% Solution', generic: 'Minoxidil', route: 'local' } as OpdMed,   // register: `local` IS topical
] });

test('arm 4: "systemic" against all-topical medications is neutralized — incl. the `local` spelling', () => {
  const out = N([BUG4A], TOPICAL_MEDS);
  assert.equal(out[0].informational, true);
  assert.equal(out[0].signal_type, SIGNALS[4]);
});

test('arm 4: with a genuinely oral medication present the systemic critique stays', () => {
  const mixed = mkCase({ medications: [{ brand: 'Terbinafine 250', generic: 'Terbinafine', route: 'Oral' } as OpdMed] });
  assert.notEqual(N([BUG4A], mixed)[0].informational, true);
});

test('arm 4 high-value guard', () => {
  const hv = mkFinding({ ...BUG4A, subject: 'Avoided systemic antifungal', verdict: 'high-value' });
  assert.notEqual(N([hv], TOPICAL_MEDS)[0].informational, true);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Arm 5 — indication presence (bug 5c: azelaic acid "no indication" beside documented acne)
// ═════════════════════════════════════════════════════════════════════════════════════════════

const BUG5C = mkFinding({
  subject: 'Azelaic Acid indication for acne vulgaris', verdict: 'context-dependent',
  rationale: 'The use of azelaic acid is appropriate for treating acne vulgaris, but the note does not explicitly document an indication for this specific drug.',
});
const ACNE_CASE = mkCase({ impressions: ['Acne vulgaris', 'acne, pih'] });

test('arm 5: "indication not documented" naming the DOCUMENTED indication is neutralized', () => {
  const out = N([BUG5C], ACNE_CASE);
  assert.equal(out[0].informational, true);
  assert.equal(out[0].signal_type, SIGNALS[5]);
});

test('arm 5: when the note truly documents no matching condition, the gap stays raisable', () => {
  assert.notEqual(N([BUG5C], mkCase({ impressions: ['Tinea corporis'] }))[0].informational, true);
});

test('arm 5 high-value guard', () => {
  const hv = mkFinding({ ...BUG5C, verdict: 'high-value' });
  assert.notEqual(N([hv], ACNE_CASE)[0].informational, true);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Arm 6 — history presence
// ═════════════════════════════════════════════════════════════════════════════════════════════

const HIST_DENIAL = mkFinding({
  subject: 'History does not record fever pattern', verdict: 'context-dependent',
  rationale: 'The history does not mention fever with chills, which is relevant to the differential.',
});
const FEVER_CASE = mkCase({ presentingComplaints: ['fever with chills', 'body ache'] });

test('arm 6: a denied symptom that sits in the complaints is neutralized', () => {
  const out = N([HIST_DENIAL], FEVER_CASE);
  assert.equal(out[0].informational, true);
  assert.equal(out[0].signal_type, SIGNALS[6]);
});

test('arm 6: a genuinely missing history element stays raisable', () => {
  assert.notEqual(N([HIST_DENIAL], mkCase({ presentingComplaints: ['knee pain'] }))[0].informational, true);
});

test('arm 6 high-value guard', () => {
  const hv = mkFinding({ ...HIST_DENIAL, verdict: 'high-value' });
  assert.notEqual(N([hv], FEVER_CASE)[0].informational, true);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Arm 7 — ratified rule (bug 6a: the vitamin-D hallucination that overruled the engine's own rule)
// ═════════════════════════════════════════════════════════════════════════════════════════════

const DET_VITD = mkFinding({
  source: 'deterministic', verdict: 'uncertain', confidence: 0, informational: true,
  subject: 'Vitamin D repletion duration', signal_type: 'vitamin_d_repletion_duration',
  rationale: 'Weekly 60,000 IU for 8 weeks is standard repletion once low levels are established.',
});
const BUG6A = mkFinding({
  subject: 'Uprise-D3 dosing regimen', verdict: 'context-dependent', confidence: 0.85,
  rationale: 'The dosing regimen of vitamin D 60,000 IU weekly for 12 weeks may be overly cautious compared to standard guidelines.',
  signal_type: 'prescribing_review',
});

test('arm 7: the bug-6a exhibit — the scoring LLM contradiction of the ratified vitamin-D rule is neutralized', () => {
  const out = N([DET_VITD, BUG6A], mkCase());
  const det = out[0], llm = out[1];
  assert.equal(det.informational, true, 'the deterministic finding is untouched (already informational)');
  assert.equal(det.signal_type, 'vitamin_d_repletion_duration', 'never re-marked');
  assert.equal(llm.informational, true);
  assert.equal(llm.signal_type, SIGNALS[7]);
});

test('arm 7: an LLM finding about an UNRELATED molecule is untouched by the vitamin-D rule', () => {
  const other = mkFinding({ subject: 'Pantoprazole without indication', verdict: 'context-dependent', rationale: 'PPI has no documented acid-related indication.' });
  assert.notEqual(N([DET_VITD, other], mkCase())[0 + 1].informational, true);
});

test('arm 7 high-value guard: praise naming vitamin D survives beside the det rule', () => {
  const hv = mkFinding({ subject: 'Appropriate vitamin D repletion', verdict: 'high-value', rationale: 'Correct 60,000 IU weekly repletion for severe vitamin D deficiency.' });
  assert.notEqual(N([DET_VITD, hv], mkCase())[1].informational, true);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Arm 8 — suggestion coherence (bug 7c: the finding that argues with its own suggestion)
// ═════════════════════════════════════════════════════════════════════════════════════════════

const BUG7C = mkFinding({
  subject: 'Antibiotic therapy review', verdict: 'low-value',
  rationale: 'Antibiotic therapy appears unindicated for this presentation.',
});

test('arm 8: a finding calling a class unindicated while the suggestion says START it is incoherent', () => {
  const out = N([BUG7C], mkCase({ medications: [{ brand: 'Augmentin', generic: 'Amoxicillin + Clavulanate', therapeuticClass: 'Antibiotic' } as OpdMed] }),
    [{ priority: 1, text: 'Consider starting an antibiotic if symptoms persist beyond 5 days.' }]);
  assert.equal(out[0].informational, true);
  assert.equal(out[0].signal_type, SIGNALS[8]);
});

test('arm 8: coherent suggestion (stop/de-escalate) leaves the finding scoring', () => {
  const out = N([BUG7C], mkCase({ medications: [{ brand: 'Augmentin', generic: 'Amoxicillin + Clavulanate', therapeuticClass: 'Antibiotic' } as OpdMed] }),
    [{ priority: 1, text: 'Review the need for the antibiotic; discontinue if viral aetiology is confirmed.' }]);
  assert.notEqual(out[0].informational, true);
});

test('arm 8 high-value guard', () => {
  const hv = mkFinding({ ...BUG7C, subject: 'Antibiotic restraint', verdict: 'high-value' });
  const out = N([hv], mkCase(), [{ priority: 1, text: 'Start an antibiotic now.' }]);
  assert.notEqual(out[0].informational, true);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Family invariants
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('deterministic findings are NEVER touched, in any arm', () => {
  const det = mkFinding({ source: 'deterministic', subject: 'Unindicated antibiotic prescription', rationale: 'no antibiotic' });
  assert.notEqual(N([det], mkCase({ medications: [] }))[0].informational, true);
});

test('an already-informational finding is returned unchanged — never re-marked', () => {
  const info = mkFinding({ ...PHANTOM_ABX, informational: true, signal_type: 'quieted_thing' });
  const out = N([info], mkCase({ medications: [] }));
  assert.equal(out[0].signal_type, 'quieted_thing', 'signal_type must not be rewritten');
});

test('R-2: no arm ever DROPS a finding — count in equals count out', () => {
  const all = [BUG1, BUG2, PHANTOM_ABX, BUG4A, BUG5C, HIST_DENIAL, DET_VITD, BUG6A, BUG7C];
  const out = N(all, mkCase({ investigations: [] }), [{ priority: 1, text: 'Start an antibiotic.' }]);
  assert.equal(out.length, all.length);
});

test('the finalize() call sits beside the existing neutralizers, and line 972 is untouched', () => {
  const src = readFileSync('lib/opd-note-audit.ts', 'utf8');
  assert.ok(src.includes('out = neutralizeContradictedByStructure(out, oc, latestSuggestions);'));
  // B1 guard EXACTLY as written (PRD 5.4 — arm 3 covers the appropriateness ghost; widening B1
  // to drop across domains would conflict with R-2's mark-don't-drop).
  assert.ok(src.includes("if (noMeds) out = out.filter((f) => f.domain !== 'prescribing_safety');"));
  // The existing family is untouched.
  const core = readFileSync('lib/opd-note-audit-core.ts', 'utf8');
  assert.ok(core.includes("if (META_ACCURACY_RE.test(hay)) return { ...f, informational: true, signal_type: 'metadata_accuracy' };"));
  assert.ok(core.includes("return { ...f, informational: true, signal_type: 'screening_context' };"));
});
