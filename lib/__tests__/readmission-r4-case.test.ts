/**
 *   node --experimental-strip-types --test lib/__tests__/readmission-r4-case.test.ts
 * R4 — the case page (CDMSS-READMISSIONS-R4-PRD v1.0 §3 tests): the citation validator (valid /
 * invalid-id / empty / marker-without-ledger → stored valid:false, never rendered) · the relatedLvc
 * reducer, all four states + the denominator + both-ends verification · latest-audit-per-note ·
 * both UHID formats · UUID-form notes excluded · the narrative-absent page path · PHI source-reads
 * on the new fetches · the recon prompt builders BYTE-IDENTICAL to f09cb6f · the run type's typed
 * model guard + Opus pacing · why-flagged assembled by code · page gates · brief golden untouched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  buildCaseNarrative, buildLedger, denominatorLine, extractCitedIds, isUuidForm, latestAuditPerNote, lvcCandidates,
  priorNoteUniverse, reduceRelatedLvc, relatedLvcCopy, renderableNarrative, segmentNarrative, stripCaseArtefacts,
  toReviewStatus, uhidCandidates, validateCitations,
  NARRATIVE_BUDGET_MS, NARRATIVE_MAX_PER_TICK, NARRATIVE_MAX_TRIES, NARRATIVE_MODEL, NARRATIVE_MODEL_ID, NARRATIVE_VERSION,
  type AuditRow, type LvcCandidate,
} from '../readmission-narrative-core.ts';
import {
  buildFullReconPrompt, buildSecondAvoidablePrompt, buildConditionPassPrompt, buildOonPrompt, buildNarrativePrompt, parseNarrativeOutput,
} from '../readmission-prompts.ts';
import { planRunCreate, clampNPerTick } from '../backfill-runs-core.ts';
import { caseHref, whyFlaggedLines, narrativeStateCopy, type SurfaceFinding } from '../readmission-surface-core.ts';
import { priorPrescriptionsSql } from '../readmission/db13.ts';
import { liftAuditFindings } from '../readmission/opd-lvc.ts';
import { composeBrief } from '../readmission/brief.ts';
import { BEDROCK_MODELS } from '../bedrock-core.ts';

const code = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const LEDGER = ['S1', 'S2', 'R1', 'L1', 'LX1', 'OT1', 'PAC1', 'P1', 'T1', 'F1', 'IX1', 'RX1'];

// ── citations (R4-4) ────────────────────────────────────────────────────────────────────

test('extractCitedIds: single, list, mixed separators, dedup in first-appearance order; prose in brackets ignored', () => {
  assert.deepEqual(extractCitedIds('Flagged on day 4 [S1]. Hb fell [L1, S2] and rose [L1]. The patient [PATIENT] said [unknown].'), ['S1', 'L1', 'S2']);
  assert.deepEqual(extractCitedIds('[OT1; P1] [PAC1/RX1]'), ['OT1', 'P1', 'PAC1', 'RX1']);
  assert.deepEqual(extractCitedIds(''), []);
  assert.deepEqual(extractCitedIds(null), []);
});

test('validateCitations — the behaviour table: valid · unresolved id · empty · marker-without-ledger · no citations', () => {
  assert.deepEqual(validateCitations('A [S1]. B [L1, R1].', LEDGER), { valid: true, citedIds: ['S1', 'L1', 'R1'], invalidIds: [], reason: 'none' });
  assert.deepEqual(validateCitations('A [S1]. B [Z9].', LEDGER), { valid: false, citedIds: ['S1', 'Z9'], invalidIds: ['Z9'], reason: 'unresolved_ids' });
  assert.deepEqual(validateCitations('   ', LEDGER), { valid: false, citedIds: [], invalidIds: [], reason: 'empty' });
  assert.deepEqual(validateCitations('A [S1].', []), { valid: false, citedIds: ['S1'], invalidIds: ['S1'], reason: 'unresolved_ids' });   // marker, no ledger
  assert.deepEqual(validateCitations('An account with no markers at all.', LEDGER), { valid: false, citedIds: [], invalidIds: [], reason: 'no_citations' });
  // one bad id poisons the whole account (fail closed) even with many good ones
  const v = validateCitations('[S1] [S2] [R1] [L1] [OT1] [S99]', LEDGER);
  assert.equal(v.valid, false); assert.deepEqual(v.invalidIds, ['S99']);
});

test('buildCaseNarrative stores an INVALID narrative (for review) with valid:false and it is never renderable; a valid one is', () => {
  const bad = buildCaseNarrative({ text: 'Claim [S1] and [Q7].', ledgerIds: LEDGER, generatedAt: '2026-08-18T10:00:00Z', model: NARRATIVE_MODEL_ID, provider: 'bedrock', traceId: 't1', source: 'audit' });
  assert.equal(bad.valid, false); assert.deepEqual(bad.invalidIds, ['Q7']); assert.equal(bad.invalidReason, 'unresolved_ids');
  assert.equal(bad.text, 'Claim [S1] and [Q7].');   // stored
  assert.equal(renderableNarrative(bad), null);      // never rendered
  assert.equal(bad.version, NARRATIVE_VERSION); assert.equal(bad.model, NARRATIVE_MODEL_ID); assert.equal(bad.provider, 'bedrock');
  const good = buildCaseNarrative({ text: 'Claim [S1].', ledgerIds: LEDGER, generatedAt: 'g', model: NARRATIVE_MODEL_ID, provider: 'bedrock', traceId: null, source: 'backfill' });
  assert.equal(good.valid, true); assert.equal(renderableNarrative(good)?.text, 'Claim [S1].');
  assert.equal(renderableNarrative(null), null);
  assert.equal(renderableNarrative(undefined), null);
  // a stripped (list-payload) copy is not renderable either
  assert.equal(renderableNarrative(stripCaseArtefacts({ caseNarrative: good })!.caseNarrative), null);
});

test('segmentNarrative splits prose and markers for the page to link', () => {
  assert.deepEqual(segmentNarrative('A [S1] b [L1, R1].'), [
    { kind: 'text', text: 'A ' }, { kind: 'cite', ids: ['S1'], raw: '[S1]' }, { kind: 'text', text: ' b ' }, { kind: 'cite', ids: ['L1', 'R1'], raw: '[L1, R1]' }, { kind: 'text', text: '.' },
  ]);
});

test('narrativeStateCopy: absent → "no account written"; invalid → withheld + flagged; valid → empty copy', () => {
  assert.equal(narrativeStateCopy(undefined).state, 'absent');
  assert.match(narrativeStateCopy(null).copy, /No account written for this case yet/);
  assert.equal(narrativeStateCopy({ valid: false, text: 'x' }).state, 'invalid');
  assert.match(narrativeStateCopy({ valid: false, text: 'x' }).copy, /withheld.*Flagged for human review/);
  assert.equal(narrativeStateCopy({ valid: true, text: 'x [S1]' }).state, 'valid');
  assert.equal(narrativeStateCopy({ valid: true, text: '' }).state, 'invalid');   // valid flag but nothing to show is not a rendered account
});

// ── the ledger ──────────────────────────────────────────────────────────────────────────

test('buildLedger carries id / source / side / at / the reconciler\'s weight / text', () => {
  const l = buildLedger([
    { id: 'S1', source: 'index_summary', side: 'index', text: 'a' },
    { id: 'R1', source: 'readmit_summary', side: 'readmit', text: 'b' },
    { id: 'L1', source: 'lab', side: 'index', text: 'c', at: '2026-06-01', abnormal: true },
    { id: 'OT1', source: 'ot_note', side: 'readmit', text: 'd' },
    { id: 'F1', source: 'cm_form', text: 'e' },
  ], 'g', 'audit');
  assert.equal(l.version, 'ledger/1'); assert.equal(l.source, 'audit');
  assert.deepEqual(l.items.map((i) => [i.id, i.weight]), [['S1', 'interested'], ['R1', 'disinterested'], ['L1', 'disinterested'], ['OT1', 'disinterested'], ['F1', 'neither']]);
  assert.equal(l.items[2].abnormal, true); assert.equal(l.items[2].at, '2026-06-01'); assert.equal(l.items[4].side, null);
});

// ── the three-hop join helpers (pre-study) ──────────────────────────────────────────────

test('uhidCandidates: BOTH live UHID formats pass through untouched (no prefix assumption); trims, dedups, drops junk', () => {
  assert.deepEqual(uhidCandidates(['UHID-123456', ' AH2526/004321 ', 'UHID-123456', null, undefined, '', 'has space', 'AH2425/1']), ['UHID-123456', 'AH2526/004321', 'AH2425/1']);
});

test('isUuidForm: legacy UUID-form prescription ids are recognised (and nothing else)', () => {
  assert.equal(isUuidForm('3f2b1c4e-9a7d-4e21-8b6f-0c1d2e3f4a5b'), true);
  assert.equal(isUuidForm('AYYyW4CI29thGJIhO3Wq'), false);
  assert.equal(isUuidForm(''), false); assert.equal(isUuidForm(null), false);
});

test('priorNoteUniverse: UUID-form dropped, dedup, only notes dated BEFORE the readmission; undated kept', () => {
  const notes = [
    { uid: 'n1', createdAt: '2026-05-01T10:00:00Z' }, { uid: 'n1', createdAt: '2026-05-01T10:00:00Z' },
    { uid: '3f2b1c4e-9a7d-4e21-8b6f-0c1d2e3f4a5b', createdAt: '2026-05-02T10:00:00Z' },
    { uid: 'n2', createdAt: '2026-06-06T00:00:00+05:30' },   // after the readmit
    { uid: 'n3', createdAt: null }, { uid: '', createdAt: null },
  ];
  assert.deepEqual(priorNoteUniverse(notes, '2026-06-05T09:30:00+05:30').map((n) => n.uid), ['n1', 'n3']);
  assert.deepEqual(priorNoteUniverse(notes, null).map((n) => n.uid), ['n1', 'n2', 'n3']);
});

const arow = (o: Partial<AuditRow>): AuditRow => ({ auditId: 'a', uid: 'u', auditedAt: '2026-08-01T00:00:00Z', engineVersion: 'opd-note-audit/0.81.20', model: 'gemini-2.5-pro', noteDate: '2026-05-01T00:00:00Z', doctorUid: 'd', findings: [], ...o });

test('latestAuditPerNote: ONE row per note by the repo\'s canonical rule — numeric engine version outranks a later audited_at of an older version; audited_at breaks a same-version tie; mini rows excluded; sorted by note date', () => {
  const rows = [
    arow({ auditId: 'a1', uid: 'n1', auditedAt: '2026-08-09T00:00:00Z', engineVersion: 'opd-note-audit/0.81.9' }),    // re-run of an OLD version, later date
    arow({ auditId: 'a2', uid: 'n1', auditedAt: '2026-08-01T00:00:00Z', engineVersion: 'opd-note-audit/0.81.20' }),   // the current line — wins
    arow({ auditId: 'a3', uid: 'n2', auditedAt: '2026-08-01T00:00:00Z', engineVersion: 'opd-note-audit/0.81.21', noteDate: '2026-04-01T00:00:00Z' }),
    arow({ auditId: 'a4', uid: 'n2', auditedAt: '2026-08-02T00:00:00Z', engineVersion: 'opd-note-audit/0.81.21', noteDate: '2026-04-01T00:00:00Z' }),   // same version, later — wins
    arow({ auditId: 'a5', uid: 'n3', auditedAt: '2026-08-05T00:00:00Z', engineVersion: 'opd-note-audit/0.81.20-mini', model: 'qwen2.5:14b', noteDate: '2026-03-01T00:00:00Z' }),   // mini: excluded
  ];
  assert.deepEqual(latestAuditPerNote(rows).map((r) => r.auditId), ['a4', 'a2']);
});

test('opd-lvc hop-1 SQL is the canonical DISTINCT ON twin (never hand-written) with the engine-family filter', () => {
  const src = code('lib/readmission/opd-lvc.ts');
  assert.match(src, /canonicalDistinctOnSql\(\{/);
  assert.match(src, /engine_version ~ '\^opd-note-audit\/\[0-9\]\+/);
  assert.match(src, /excluded_reason <> 'llm_leg_failed'/);
  assert.ok(!/DISTINCT ON \(\s*uid\s*\)/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), 'no hand-written DISTINCT ON (uid) in code');
});

test('lvcCandidates: only low-value findings, keyed noteUid#findingRef, review status from the latest scope=finding verdict', () => {
  const rows = [arow({ auditId: 'a1', uid: 'n1', findings: [
    { subject: 'Serratiopeptidase', verdict: 'low-value', lvcCategory: 'supplement_polypharmacy', signalType: 'lvc', findingRef: 'f-1', rationale: 'r' },
    { subject: 'Amoxicillin', verdict: 'appropriate', lvcCategory: null, signalType: null, findingRef: 'f-2', rationale: null },
    { subject: 'CT head', verdict: 'low-value', lvcCategory: 'imaging', signalType: 'lvc', findingRef: null, rationale: null },
  ] })];
  const c = lvcCandidates(rows, new Map([['a1#f-1', 'true_positive']]));
  assert.deepEqual(c.map((x) => [x.key, x.reviewStatus]), [['n1#f-1', 'true_positive'], ['n1#idx2', 'unreviewed']]);
  assert.equal(toReviewStatus('nitpick'), 'nitpick'); assert.equal(toReviewStatus('weird'), 'unreviewed'); assert.equal(toReviewStatus(null), 'unreviewed');
});

test('liftAuditFindings tolerates string / object / junk and lifts ONLY the R4 fields', () => {
  const lifted = liftAuditFindings(JSON.stringify([{ subject: 'X', verdict: 'low-value', lvc_category: 'imaging', signal_type: 's', finding_ref: 'r', rationale: 'why', evidence: ['note text that must not surface'], patient_name: 'Asha' }, { nope: 1 }, null]));
  assert.deepEqual(lifted, [{ subject: 'X', verdict: 'low-value', lvcCategory: 'imaging', signalType: 's', findingRef: 'r', rationale: 'why' }]);
  assert.deepEqual(liftAuditFindings('not json'), []); assert.deepEqual(liftAuditFindings(null), []);
});

// ── relatedLvc reducer (R4-5 / R4-6 / R4-7) — all four states + the denominator ────────────

const cand = (key: string, ref: string | null = 'f-1'): LvcCandidate => ({ key, noteUid: key.split('#')[0], noteDate: '2026-05-01T00:00:00Z', engineVersion: 'e', reviewStatus: 'unreviewed', finding: { subject: 'Serratiopeptidase', verdict: 'low-value', lvcCategory: 'supplement_polypharmacy', signalType: 'lvc', findingRef: ref, rationale: null } });

test('reduceRelatedLvc: join_failed carries the hop and 0/0; the denominator line reads unknown', () => {
  const r = reduceRelatedLvc({ join: null, joinFailure: 'prescriptions', proposals: [{ key: 'n1#f-1', reason: 'x', readmitEvidenceIds: ['S1'] }], ledgerIds: LEDGER, generatedAt: 'g' });
  assert.equal(r.state, 'join_failed'); assert.equal(r.joinFailure, 'prescriptions'); assert.deepEqual(r.items, []); assert.equal(r.audited, 0);
  assert.equal(denominatorLine(r), 'unknown — records could not be joined');
  assert.match(relatedLvcCopy(r), /could not be joined/);
});

test('reduceRelatedLvc: no_audited_artefacts when audited = 0 (whatever the model proposed); the denominator is stated', () => {
  const r = reduceRelatedLvc({ join: { totalNotes: 7, audited: 0, candidates: [] }, proposals: [{ key: 'n1#f-1', reason: 'x', readmitEvidenceIds: ['S1'] }], ledgerIds: LEDGER, generatedAt: 'g' });
  assert.equal(r.state, 'no_audited_artefacts'); assert.equal(r.droppedProposals, 1);
  assert.equal(denominatorLine(r), "0 of this patient's 7 OPD notes before this readmission have been audited");
  assert.match(relatedLvcCopy(r), /absence of flags is not clean care/);
});

test('reduceRelatedLvc: none_related when audited notes carry no LVC finding, or when every proposal fails verification', () => {
  const r0 = reduceRelatedLvc({ join: { totalNotes: 3, audited: 2, candidates: [] }, proposals: [], ledgerIds: LEDGER, generatedAt: 'g' });
  assert.equal(r0.state, 'none_related'); assert.equal(denominatorLine(r0), "2 of this patient's 3 OPD notes before this readmission have been audited");
  const r1 = reduceRelatedLvc({ join: { totalNotes: 3, audited: 1, candidates: [cand('n1#f-1')] }, proposals: [
    { key: 'n9#zz', reason: 'unknown candidate', readmitEvidenceIds: ['S1'] },          // not shown → dropped
    { key: 'n1#f-1', reason: 'bad readmit id', readmitEvidenceIds: ['S1', 'Q9'] },       // one unresolved id → dropped
    { key: 'n1#f-1', reason: '', readmitEvidenceIds: ['S1'] },                           // no reason → dropped
    { key: 'n1#f-1', reason: 'no ids', readmitEvidenceIds: [] },                         // no readmit end → dropped
  ], ledgerIds: LEDGER, generatedAt: 'g' });
  assert.equal(r1.state, 'none_related'); assert.equal(r1.droppedProposals, 4); assert.deepEqual(r1.items, []);
  assert.equal(denominatorLine(r1), "1 of this patient's 3 OPD notes before this readmission has been audited");
});

test('reduceRelatedLvc: present — both ends verified, one item per candidate, review status stamped, concept label only', () => {
  const r = reduceRelatedLvc({ join: { totalNotes: 5, audited: 2, candidates: [cand('n1#f-1'), cand('n2#f-7')] }, proposals: [
    { key: 'n1#f-1', reason: 'Long-term supplement polypharmacy preceded the return.', readmitEvidenceIds: ['R1', 'L1'] },
    { key: 'n1#f-1', reason: 'duplicate', readmitEvidenceIds: ['R1'] },   // second proposal for the same candidate → dropped
  ], ledgerIds: LEDGER, generatedAt: 'g' });
  assert.equal(r.state, 'present'); assert.equal(r.items.length, 1); assert.equal(r.droppedProposals, 1);
  assert.deepEqual(r.items[0], { noteUid: 'n1', noteDate: '2026-05-01T00:00:00Z', concept: 'Serratiopeptidase', lvcCategory: 'supplement_polypharmacy', engineVersion: 'e', reviewStatus: 'unreviewed', reason: 'Long-term supplement polypharmacy preceded the return.', priorEvidence: 'f-1', readmitEvidenceIds: ['R1', 'L1'] });
  assert.equal(relatedLvcCopy(r), '1 prior finding related to this return');
  assert.equal(denominatorLine(r), "2 of this patient's 5 OPD notes before this readmission have been audited");
});

// ── the narrative prompt + parser; recon builders byte-identical ─────────────────────────

const cat = { items: [
  { id: 'S1', source: 'index_summary' as const, side: 'index' as const, text: 'diagnosis: fracture neck of femur' },
  { id: 'L1', source: 'lab' as const, side: 'index' as const, text: 'Hb: 9.1 g/dL', abnormal: true, at: '2026-06-01' },
  { id: 'OT1', source: 'ot_note' as const, side: 'index' as const, text: 'OT note' },
] };

test('the four recon builders are BYTE-IDENTICAL to f09cb6f (fingerprints computed at that SHA)', () => {
  const h = (o: unknown) => createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 16);
  assert.equal(h(buildFullReconPrompt(cat, { gapDays: 4, lane: 'tight_bounce', indexDepartment: 'Ortho', readmitDepartment: 'Ortho', sameDoctor: true, labProfile: 'has_late_labs' })), 'a65be27800b26f0e');
  assert.equal(h(buildSecondAvoidablePrompt(cat, { gapDays: 4, labProfile: 'has_late_labs' })), '3e11e8555c9ac2d6');
  assert.equal(h(buildConditionPassPrompt(cat, { gapDays: 4 })), '6a9f30d7f6926f5e');
  assert.equal(h(buildOonPrompt(cat, { reportedReadmitDate: '2026-06-05', labProfile: 'has_late_labs' })), 'a1513639455807b3');
});

test('buildNarrativePrompt: cites-only-the-ledger discipline, the denominator in the candidate block, no rupees / no patient names asked for; the three LVC framings', () => {
  const facts = { findingClass: 'even_even' as const, lane: 'tight_bounce', gapDays: 4, indexDepartment: 'Ortho', readmitDepartment: 'Ortho', planned: 'unplanned', sameCondition: 'same', avoidable: 'needs_adjudication', omissions: [{ claim: 'late culture', danger: 'moderate', evidenceIds: ['L1'] }], exculpatory: [], weakestStep: null, refusalRecord: [{ lookedFor: 'pac_note', found: false }] };
  const p = buildNarrativePrompt(cat, facts, { audited: 2, totalNotes: 5, candidates: [{ key: 'n1#f-1', noteDate: '2026-05-01', concept: 'Serratiopeptidase', lvcCategory: 'supplement_polypharmacy', rationale: 'r', reviewStatus: 'unreviewed' }], joinFailed: false });
  assert.match(p.system, /cite NOTHING that is not in the ledger/);
  assert.match(p.user, /EVIDENCE LEDGER \(cite ONLY these ids\):\n\[S1\]/);
  assert.match(p.user, /2 of this patient's 5 outpatient notes before this readmission were audited — the rest are UNAUDITED, not clean/);
  assert.match(p.user, /key n1#f-1 · 2026-05-01 · Serratiopeptidase \(supplement_polypharmacy\) · review: unreviewed · r/);
  assert.match(p.user, /Never name the patient\. Never write a rupee figure\. Never quote a prior OPD note\./);
  assert.match(p.user, /Looked for and NOT found: pac_note\./);
  const none = buildNarrativePrompt(cat, facts, { audited: 2, totalNotes: 5, candidates: [], joinFailed: false });
  assert.match(none.user, /none of the audited notes carries a low-value-care finding\. Return "related": \[\]/);
  const failed = buildNarrativePrompt(cat, facts, { audited: 0, totalNotes: 0, candidates: [], joinFailed: true });
  assert.match(failed.user, /outpatient records could not be joined\. Do not speculate/);
  const oon = buildNarrativePrompt(cat, { ...facts, findingClass: 'out_of_network', avoidable: null }, { audited: 0, totalNotes: 0, candidates: [], joinFailed: false });
  assert.match(oon.user, /out of network — the return was at another hospital; only the index stay is in evidence/);
  assert.match(oon.user, /medical-justification verdict none \(index side only\)/);
});

test('parseNarrativeOutput: fenced JSON, snake or camel readmit ids, junk related rows dropped, unparseable → null', () => {
  const t = '```json\n{"narrative":"Flagged [S1].","related":[{"key":"n1#f-1","reason":"r","readmit_evidence_ids":["L1"]},{"key":"","reason":"x"},{"key":"n2#f","reason":"y","readmitEvidenceIds":["S1"]}]}\n```';
  assert.deepEqual(parseNarrativeOutput(t), { narrative: 'Flagged [S1].', related: [{ key: 'n1#f-1', reason: 'r', readmitEvidenceIds: ['L1'] }, { key: 'n2#f', reason: 'y', readmitEvidenceIds: ['S1'] }] });
  assert.equal(parseNarrativeOutput('{"related":[]}'), null);
  assert.equal(parseNarrativeOutput('nonsense'), null);
  assert.deepEqual(parseNarrativeOutput('{"narrative":"x [S1]"}'), { narrative: 'x [S1]', related: [] });
});

// ── the run type on the rails (R4-8 / R4-11) ─────────────────────────────────────────────

test('planRunCreate accepts worker readmission for bedrock only; the exact Opus id is a known Bedrock model; n ≤ 2 for Opus', () => {
  const ok = planRunCreate({ worker: 'readmission', model: NARRATIVE_MODEL, dayFrom: '2026-08-18', dayTo: '2026-08-18', nPerTick: 8 });
  assert.equal(ok.ok, true);
  const vertex = planRunCreate({ worker: 'readmission', model: 'vertex:gemini-2.5-pro', dayFrom: '2026-08-18', dayTo: '2026-08-18' });
  assert.equal(vertex.ok, false); assert.match((vertex as { error: string }).error, /R4-11/);
  assert.equal(planRunCreate({ worker: 'opd', model: 'vertex:gemini-2.5-pro', dayFrom: '2026-08-18', dayTo: '2026-08-18' }).ok, true);   // OPD unchanged
  assert.equal(planRunCreate({ worker: 'nope', model: NARRATIVE_MODEL, dayFrom: '2026-08-18', dayTo: '2026-08-18' }).ok, false);
  assert.ok(Object.hasOwn(BEDROCK_MODELS, NARRATIVE_MODEL_ID), 'the narrative model is a known, priced Bedrock id');
  assert.equal(NARRATIVE_MAX_PER_TICK, 2); assert.equal(NARRATIVE_BUDGET_MS, 80_000); assert.equal(NARRATIVE_MAX_TRIES, 1);
  assert.equal(clampNPerTick(8), 8);   // the rails' clamp is unchanged; the readmission tick clamps to 2 on top
});

test('narrative-backfill: resolveNarrativeRunModel refuses every other Bedrock id (never downgrades); nPerTick clamped to 2', async () => {
  const m = await import('../readmission/narrative-backfill.ts');
  assert.equal(m.resolveNarrativeRunModel(NARRATIVE_MODEL).ok, true);
  const haiku = m.resolveNarrativeRunModel('bedrock:global.anthropic.claude-haiku-4-5-20251001-v1:0');
  assert.equal(haiku.ok, false); assert.match((haiku as { error: string }).error, /Opus 4\.6 on Bedrock everywhere/);
  assert.equal(m.resolveNarrativeRunModel('vertex:gemini-2.5-pro').ok, false);
  assert.equal(m.narrativeNPerTick(8), 2); assert.equal(m.narrativeNPerTick(1), 1); assert.equal(m.narrativeNPerTick('junk'), 2);
  const plan = m.planNarrativeRun({ model: NARRATIVE_MODEL, dayFrom: '2026-08-01', dayTo: '2026-08-18', nPerTick: 6 });
  assert.equal(plan.ok, true); assert.equal((plan as { nPerTick: number }).nPerTick, 2);
});

// ── SQL + PHI source-reads on the new fetches ────────────────────────────────────────────

test('hop-2 SQL: _parent_id + _create_time before the readmit; two columns, no PHI; invalid id → null', () => {
  const sql = priorPrescriptionsSql('AYYyW4CI29thGJIhO3Wq', '2026-06-05T09:30:00+05:30')!;
  assert.match(sql, /SELECT uid, _create_time\s+FROM "individuals-prescriptions"\s+WHERE _parent_id = 'AYYyW4CI29thGJIhO3Wq'\s+AND _create_time < '2026-06-05T09:30:00\+05:30'\s+ORDER BY _create_time DESC\s+LIMIT 500/);
  assert.doesNotMatch(priorPrescriptionsSql('AYYyW4CI29thGJIhO3Wq', null)!, /_create_time </);
  assert.equal(priorPrescriptionsSql("x'; DROP", null), null);
});

test('PHI source-read: the R4 sections name no patient_name / patient_mobile / telecom; note text reaches ONLY the deid path; no billing.ts import', () => {
  const db13 = code('lib/readmission/db13.ts');
  const r4 = db13.slice(db13.indexOf('R4 — the three-hop identity join'));
  const lvc = code('lib/readmission/opd-lvc.ts');
  const narr = code('lib/readmission/narrative.ts');
  const back = code('lib/readmission/narrative-backfill.ts');
  const page = code('components/care/ReadmissionCasePage.tsx');
  for (const [name, src] of [['db13 R4', r4], ['opd-lvc', lvc], ['narrative', narr], ['narrative-backfill', back], ['case page', page]] as const) {
    for (const col of ['patient_name', 'patient_mobile', 'telecom', 'address_details', 'primary_email_address']) {
      assert.ok(!new RegExp(`\\b${col}\\b`).test(src), `${name} must not name '${col}'`);
    }
    assert.ok(!/ipd-audit\/billing/.test(src), `${name} must not import lib/ipd-audit/billing`);
  }
  // the LVC rationale (note-derived) is scrubbed before the prompt, and never reaches the page type
  assert.match(narr, /rationale: c\.finding\.rationale \? deidText\(c\.finding\.rationale, a\.identity\) : null/);
  assert.match(narr, /concept: deidText\(c\.finding\.subject, a\.identity\)/);
  assert.ok(!/rationale/.test(page), 'the page never renders a finding rationale (note text) in v1');
  // no model call on any page-request path
  assert.ok(!/tracedChat|governedChat|bedrockGenerate|composeCaseArtefacts/.test(code('app/api/care/readmissions/case/route.ts')), 'the case route calls no model');
  assert.ok(!/tracedChat|governedChat|fetch\(['"`]https?/.test(page), 'the page component calls no model');
});

test('run.ts: the inline leg is on by default (measured fit, R4-11), opt-out READMIT_NARRATIVE_INLINE=0, guarded by Bedrock reachability, and runs AFTER the audit row is stored; recon legs untouched in shape', () => {
  const run = code('lib/readmission/run.ts');
  assert.match(run, /process\.env\.READMIT_NARRATIVE_INLINE === '0'\) return false;\s*\n\s*return probeReachable\('bedrock'\);/);
  const idxSave = run.indexOf("status: 'audited', finding,");
  const idxNarr = run.indexOf('composeCaseArtefacts({');
  assert.ok(idxSave > 0 && idxNarr > idxSave, 'the narrative leg follows saveAuditResult');
  assert.equal((run.match(/vertexPass\(traceId, 'readmit_/g) ?? []).length, 4, 'the four recon call sites are as before (oon, condition, recon_a, recon_b)');
});

// ── the surface: why-flagged (code), href, page gates ────────────────────────────────────

const f = (over: Partial<SurfaceFinding> = {}): SurfaceFinding => ({
  dedupKey: 'IP-1|IP-2', findingClass: 'even_even', lane: 'tight_bounce', auditStatus: 'audited',
  patientName: null, uhid: 'UH-1', ageGender: null, gapDays: 4,
  indexDepartment: 'Orthopaedics', readmitDepartment: 'Orthopaedics', indexDoctor: null, readmitDoctor: null,
  indexDischargeAt: '2026-06-01T10:00:00+05:30', readmitAdmitAt: '2026-06-05T09:30:00+05:30',
  payerIndex: 'Even', payerReadmit: 'Even', cmNote: null,
  planned: 'unplanned', sameCondition: 'same', avoidable: 'needs_adjudication',
  labTier: 'tier1', labTimingProfile: 'has_late_labs', nOmissions: 1,
  needsHumanReview: true, promotedToFull: false, notAuditableReason: null,
  finding: null, omissionEvidence: null, ...over,
});

test('whyFlaggedLines is assembled by code from detection facts — no nulls, the lane, the situation, human review, coverage; OON and delayed-SSI variants', () => {
  const lines = whyFlaggedLines(f());
  assert.match(lines[0], /^The patient was readmitted 4\.0 days after discharge \(discharged 1 Jun, readmitted 5 Jun\) to Orthopaedics following an index stay in Orthopaedics\.$/);
  assert.match(lines[1], /^Detection lane: Clearest signal · fast bounce — fast return to the same team\.$/);
  assert.ok(lines.some((l) => /unplanned and for the same condition/.test(l)));
  assert.ok(lines.some((l) => /routes this case to a human/.test(l)));
  assert.ok(lines.some((l) => /Evidence coverage: Lab-backed/.test(l)));
  assert.ok(lines.every((l) => !/null|undefined/.test(l)));
  const oon = whyFlaggedLines(f({ findingClass: 'out_of_network', readmitDepartment: null, planned: null, sameCondition: null, needsHumanReview: null, labTier: null }));
  assert.match(oon[0], /reported a readmission at another hospital around 5 Jun, after an Even discharge on 1 Jun — only the index stay is in evidence/);
  const ssi = whyFlaggedLines(f({ findingClass: 'delayed_ssi', readmitAdmitAt: null, gapDays: null }));
  assert.match(ssi[0], /delayed-SSI class/);
  assert.equal(caseHref('IP-2026-0101|IP-2026-0342'), '/care/readmissions/case/IP-2026-0101%7CIP-2026-0342');
});

test('page gates: the case page is gated identically to the board (both env flags + care unlock), validates the key, and the board card is a link to caseHref', () => {
  const page = code('app/care/readmissions/case/[key]/page.tsx');
  assert.match(page, /process\.env\.CCB_ENABLED !== '1'\) notFound\(\)/);
  assert.match(page, /process\.env\.READMISSIONS_SURFACE_ENABLED !== '1'\) notFound\(\)/);
  assert.match(page, /if \(!\(await isCareUnlocked\(\)\)\) redirect\('\/care\/login'\)/);
  assert.match(page, /\/\^\[A-Za-z0-9\/_:\|\.-\]\+\$\/\.test\(dedupKey\)/);
  const board = code('components/care/ReadmissionsBoard.tsx');
  assert.match(board, /router\.push\(href\)/); assert.match(board, /caseHref\(f\.dedupKey\)/);
  assert.match(board, /e\.stopPropagation\(\); setBusy\(true\); void downloadBrief/);   // the button never navigates
});

test('a narrative-absent row: the case route reports narrativeState absent and the brief golden is untouched (brief unchanged in R4)', () => {
  const route = code('app/api/care/readmissions/case/route.ts');
  assert.match(route, /narrativeState: !art\.caseNarrative \? 'absent' : narrative \? 'valid' : 'invalid'/);
  assert.match(route, /renderableNarrative\(art\.caseNarrative \?\? null\)/);
  // the brief composer does not read the R4 artefacts — the golden cannot move
  const brief = code('lib/readmission/brief.ts');
  assert.ok(!/caseNarrative|evidenceLedger|relatedLvc/.test(brief));
  const b = composeBrief({ row: f({ finding: { caseNarrative: { text: 'x [S1]', valid: true }, relatedLvc: { state: 'present', audited: 1, totalNotes: 2, items: [] } } }), indexExtract: null, readmitExtract: null });
  assert.ok(!/x \[S1\]|prior finding/.test(b.markdown));
});

// ── Addendum A1 — the stale-id filter on the REBUILT-ledger path ─────────────────────────

test('A1 pure: filterStaleIds keeps only ledger ids and counts the rest; scrubStaleIdMentions removes stale markers from free text, keeps prose brackets', async () => {
  const { filterStaleIds, scrubStaleIdMentions } = await import('../readmission-narrative-core.ts');
  assert.deepEqual(filterStaleIds(['S1', 'S99', 'L1', '', null, 'Q7'], LEDGER), { kept: ['S1', 'L1'], dropped: 2 });
  assert.deepEqual(scrubStaleIdMentions('late culture [S99] against [L1, S98] and [PATIENT] said so', LEDGER), { text: 'late culture against [L1] and [PATIENT] said so', dropped: 2 });
  assert.deepEqual(scrubStaleIdMentions(null, LEDGER), { text: null, dropped: 0 });
  assert.deepEqual(scrubStaleIdMentions('no markers here', LEDGER), { text: 'no markers here', dropped: 0 });
});

test('A1 end-to-end: on the rebuilt path a stale id is filtered BEFORE the prompt, a model echo of it fails validation, staleIdsDropped is stored; the inline path is unchanged', async () => {
  const { composeCaseArtefacts } = await import('../readmission/narrative.ts');
  const row = {
    dedup_key: 'IP-1|IP-2', finding_class: 'even_even', index_encounter_id: 'IP-1', readmit_encounter_id: 'IP-2', form_uid: null, uhid: 'UH-1',
    lane: 'tight_bounce', gap_days: 4, index_department: 'Ortho', readmit_department: 'Ortho', index_doctor: null, readmit_doctor: null,
    index_discharge_at: '2026-06-01T10:00:00+05:30', readmit_admit_at: '2026-06-05T09:30:00+05:30', cm_note: null, form_is_planned: null, form_same_condition: null,
  };
  const finding = {
    findingClass: 'even_even', verdictScope: 'pair', planned: { verdict: 'unplanned', confidence: 0.8, evidenceIds: ['S1'] }, sameCondition: null,
    // S99 / L77 were minted against the ORIGINAL catalog; the rebuilt ledger below has neither.
    omissions: [{ claim: 'late culture [S99]', danger: 'moderate', confidence: 'moderate', evidenceIds: ['L1', 'S99'] }],
    exculpatory: [{ claim: 'non-adherence', corroborated: false, corroboratingIds: ['L77'] }],
    avoidable: { verdict: 'needs_adjudication', evidenceIds: ['S1'] }, labProfile: 'has_late_labs', labTier: 'tier1',
    stabilityAssessment: 'unverifiable', corroborationTrack: 'prose_only', provenance: { interested: 1, disinterested: 1, ratio: 0.5, needsHumanReview: false },
    weakestStep: 'wound review [S99, S1]', refusalRecord: [{ lookedFor: 'pac_note', found: false, note: 'no row [L77]' }],
  } as never;
  const catalog = { items: [{ id: 'S1', source: 'index_summary' as const, side: 'index' as const, text: 'diagnosis: fracture' }, { id: 'L1', source: 'lab' as const, side: 'index' as const, text: 'Hb 9.1' }] };
  const join = async () => ({ ok: true, failure: null, totalNotes: 3, audited: 0, candidates: [] });
  const saved: Array<Record<string, unknown>> = [];
  const save = async (_k: string, art: Record<string, unknown>) => { saved.push(art); return true; };
  const seen: string[] = [];
  const echo = async (p: { system: string; user: string }) => { seen.push(p.user); return JSON.stringify({ narrative: 'Flagged on day 4 [S1]. The culture was late [S99].', related: [] }); };
  const base = { row: row as never, finding, catalog, identity: { names: [], uhids: [] }, traceId: 't', join, save, call: echo };

  // rebuilt path: S99 and L77 never reach the model; the echoed [S99] is invalid; count stored
  const r = await composeCaseArtefacts({ ...base, ledgerSource: 'reassembled', narrativeSource: 'backfill' });
  assert.equal(r.ok, true); assert.equal(r.valid, false); assert.equal(r.staleIdsDropped, 5);   // S99 (evidenceIds) + L77 (corroboratingIds) + S99 (claim) + S99 (weakest step) + L77 (refusal note)
  assert.ok(!/S99|L77/.test(seen[0]), 'stale ids never reach the prompt');
  assert.match(seen[0], /evidence L1\)/); assert.match(seen[0], /wound review \[S1\]/);
  const stored = saved[0].caseNarrative as { valid: boolean; invalidIds: string[]; staleIdsDropped: number };
  assert.equal(stored.valid, false); assert.deepEqual(stored.invalidIds, ['S99']); assert.equal(stored.staleIdsDropped, 5);

  // inline path: unchanged — its ledger IS the audit's, so nothing is filtered (S99 reaches the prompt as stored)
  seen.length = 0; saved.length = 0;
  const i = await composeCaseArtefacts({ ...base, ledgerSource: 'audit', narrativeSource: 'audit' });
  assert.equal(i.staleIdsDropped, 0); assert.match(seen[0], /evidence L1, S99/); assert.match(seen[0], /evidence L77/);
  assert.equal((saved[0].caseNarrative as { staleIdsDropped: number }).staleIdsDropped, 0);
});

test('A3: the worker clamps max to conc (waves = 1 by construction) — ?max=10 is unfireable', () => {
  const w = code('app/api/readmission/worker/route.ts');
  assert.match(w, /const max = Math\.min\(Math\.max\(1, Math\.min\(10, Number\(p\.get\('max'\) \|\| 3\)\)\), conc\);/);
  assert.match(w, /waves = 1 ENFORCED/);
});
