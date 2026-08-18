/**
 *   node --experimental-strip-types --test lib/__tests__/readmission-r43-ask.test.ts
 * R4.3 (CDMSS-READMISSIONS-R4.3-PRD v1.0) — ask the agent: the prompt fence · caps (question length,
 * history turns + tokens) · the answer verdict (citations enforced; the "record does not show"
 * path; withhold on any unresolved id) · answerCaseQuestion through a seam (answered / withheld /
 * model fault) · route source-reads (gates, the case-route read set, no identity to the model, no
 * store write) · UI pins (placeholder gone, chips, working copy, advisory) · both fingerprint sets
 * unchanged.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  askVerdict, capHistory, normaliseQuestion, parseAskReply,
  ASK_HISTORY_MAX_TOKENS, ASK_HISTORY_MAX_TURNS, ASK_PER_LOAD_LIMIT, ASK_QUESTION_MAX_CHARS, ASK_SUGGESTIONS, ASK_WITHHELD_COPY, ASK_WORKING_COPY,
  ASK_BUDGET_MS, ASK_MAX_TRIES, ASK_TEMPERATURE, type AskMaterial,
} from '../readmission-ask-core.ts';
import { buildAskPrompt, buildFullReconPrompt, buildSecondAvoidablePrompt, buildConditionPassPrompt, buildOonPrompt } from '../readmission-prompts.ts';
import { reconPromptFingerprints } from '../readmission-refresh-core.ts';
import { answerCaseQuestion, askMaterialFrom } from '../readmission/ask.ts';
import type { SurfaceFinding } from '../readmission-surface-core.ts';

const code = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

const material: AskMaterial = {
  ledger: [
    { id: 'S1', source: 'index_summary', side: 'index', at: null, weight: 'interested', text: 'diagnosis: fracture neck of femur' },
    { id: 'R1', source: 'readmit_summary', side: 'readmit', at: null, weight: 'disinterested', text: 'diagnosis: superficial SSI' },
    { id: 'L1', source: 'lab', side: 'index', at: '2026-05-31', weight: 'disinterested', text: 'Hb: 9.1 g/dL' },
    { id: 'OT1', source: 'ot_note', side: 'index', at: '2026-05-28', weight: 'interested', text: 'calcar crack, cerclage wire' },
    { id: 'F1', source: 'cm_form', side: null, at: null, weight: 'neither', text: 'Patient called on day 3' },
  ],
  account: 'A 58-year-old returned four days after a hemiarthroplasty with a discharging wound [S1, R1].',
  judgements: { planned: 'unplanned', sameCondition: 'same', justification: 'Needs adjudication', preventableInjury: 'Suspected', negligence: 'Unknown', findingClass: 'even_even', lane: 'tight_bounce', gapDays: 4 },
  coverage: [{ label: 'Index DS', state: 'present' }, { label: 'OT', state: 'present' }, { label: 'PAC', state: 'PAC none' }],
  bills: { index: { ok: true, groups: [{ serviceType: 'IP Package', netRs: 150000, lines: 1 }], totalRs: 150000, lines: 1 }, readmit: null, returnCell: 'bill not finalised' },
  refusals: [{ lookedFor: 'pac_note', note: 'no row in db13 for this stay/window' }],
};

// ── the prompt fence (R43-5) ─────────────────────────────────────────────────────────────

test('buildAskPrompt: answer ONLY from the material, say plainly when the record does not show, no diagnosis / treatment / legal conclusion, plain English, every sentence cites; the material rendered in words; no name anywhere', () => {
  const p = buildAskPrompt(material, [], 'Why is negligence unknown?');
  assert.match(p.system, /Answer ONLY from that material/);
  assert.match(p.system, /say plainly that the case record does not show it — never fill the gap from general medical knowledge/);
  assert.match(p.system, /Every factual sentence you write must carry a citation marker/);
  assert.match(p.system, /No diagnosis and no treatment advice/);
  assert.match(p.system, /No legal conclusion/);
  assert.match(p.system, /Plain clinical English\. Never internal system vocabulary/);
  assert.match(p.system, /Return STRICT JSON only: \{"answer"/);
  assert.match(p.user, /EVIDENCE LEDGER \(cite ONLY these ids\):\n\[S1\] \(discharge summary — first stay, first stay, treating team's own account\) diagnosis: fracture neck of femur/);
  assert.match(p.user, /\[F1\] \(care-manager follow-up form \(patient-reported\), patient-reported account\) Patient called on day 3/);
  assert.match(p.user, /negligence: Unknown \(advisory — not a court or council finding\)/);
  assert.match(p.user, /LOOKED FOR AND NOT FOUND: pac_note — no row in db13/);
  assert.match(p.user, /First stay: total ₹150000 over 1 line\(s\) — IP Package ₹150000 \[hospital bill\]\. Return stay: not available\./);
  assert.match(p.user, /QUESTION: Why is negligence unknown\?$/);
  assert.ok(!/Asha|Khan|UH-|UHID/.test(p.system + p.user), 'no identity in the prompt');
  const withHistory = buildAskPrompt(material, [{ question: 'Q one', answer: 'A one [S1].' }], 'And then?');
  assert.match(withHistory.user, /EARLIER IN THIS CONVERSATION \(context only — do not repeat\):\nQ1: Q one\nA1: A one \[S1\]\./);
  const noAccount = buildAskPrompt({ ...material, account: null, ledger: [] }, [], 'x');
  assert.match(noAccount.user, /\(no ledger stored for this case\)/); assert.match(noAccount.user, /\(no valid account stored for this case\)/);
});

// ── caps (R43-4 / R43-7) ─────────────────────────────────────────────────────────────────

test('normaliseQuestion: trims, collapses whitespace, strips control chars, rejects empty and over-long', () => {
  assert.deepEqual(normaliseQuestion('  Why   is\nnegligence unknown? '), { ok: true, question: 'Why is negligence unknown?' });
  assert.equal(normaliseQuestion('').ok, false); assert.equal(normaliseQuestion(null).ok, false); assert.equal(normaliseQuestion(42).ok, false);
  assert.equal(normaliseQuestion('a'.repeat(ASK_QUESTION_MAX_CHARS)).ok, true);
  const long = normaliseQuestion('a'.repeat(ASK_QUESTION_MAX_CHARS + 1));
  assert.equal(long.ok, false); assert.match((long as { error: string }).error, /too long — 500 characters/);
  assert.equal(ASK_QUESTION_MAX_CHARS, 500); assert.equal(ASK_PER_LOAD_LIMIT, 8);
});

test('capHistory: junk skipped, last ≤ 6 turns kept, then oldest dropped until the token cap fits', () => {
  assert.deepEqual(capHistory(null), []); assert.deepEqual(capHistory('x'), []); assert.deepEqual(capHistory([{ question: 'q' }, { answer: 'a' }, 7]), []);
  const many = Array.from({ length: 10 }, (_, i) => ({ question: `q${i}`, answer: `a${i}` }));
  assert.deepEqual(capHistory(many).map((t) => t.question), ['q4', 'q5', 'q6', 'q7', 'q8', 'q9']);
  assert.equal(ASK_HISTORY_MAX_TURNS, 6);
  const fat = Array.from({ length: 6 }, (_, i) => ({ question: `q${i}`, answer: 'x'.repeat(4_000) }));   // 6 × ~1000 tokens > 3000
  const kept = capHistory(fat);
  assert.ok(kept.length < 6 && kept.length >= 1); assert.equal(kept[kept.length - 1].question, 'q5');   // newest survives
  assert.ok(Math.ceil(kept.reduce((n, t) => n + t.question.length + t.answer.length, 0) / 4) <= ASK_HISTORY_MAX_TOKENS);
});

// ── the answer verdict (R43-3) ───────────────────────────────────────────────────────────

test('parseAskReply: fenced JSON, bare JSON, answerable false honoured, bare text → answerable, empty → null', () => {
  assert.deepEqual(parseAskReply('```json\n{"answer":"Because [S1].","answerable":true}\n```'), { answer: 'Because [S1].', answerable: true });
  assert.deepEqual(parseAskReply('{"answer":"The case record does not show an operative note.","answerable":false}'), { answer: 'The case record does not show an operative note.', answerable: false });
  assert.deepEqual(parseAskReply('Plain text [L1].'), { answer: 'Plain text [L1].', answerable: true });
  assert.equal(parseAskReply(''), null); assert.equal(parseAskReply(null), null); assert.equal(parseAskReply('{"answer":""}'), null);
});

test('askVerdict: valid citations → shown; any unresolved id → withheld; no markers on an answerable answer → withheld; "record does not show" (answerable:false, no markers) → shown; answerable:false WITH an unresolved id → withheld', () => {
  const ids = ['S1', 'R1', 'L1', 'OT1', 'F1'];
  assert.deepEqual(askVerdict({ answer: 'The wound was discharging [R1] after a hemiarthroplasty [S1].', answerable: true }, ids), { ok: true, answer: 'The wound was discharging [R1] after a hemiarthroplasty [S1].', citedIds: ['R1', 'S1'], invalidIds: [], reason: 'none' });
  const bad = askVerdict({ answer: 'The wound was discharging [R1] and the culture grew MRSA [R9].', answerable: true }, ids);
  assert.equal(bad.ok, false); assert.deepEqual(bad.invalidIds, ['R9']); assert.equal(bad.reason, 'unresolved_ids');
  const uncited = askVerdict({ answer: 'The wound was discharging.', answerable: true }, ids);
  assert.equal(uncited.ok, false); assert.equal(uncited.reason, 'no_citations');
  const notShown = askVerdict({ answer: 'The case record does not show a pre-anaesthesia check.', answerable: false }, ids);
  assert.equal(notShown.ok, true); assert.deepEqual(notShown.citedIds, []);
  const notShownBad = askVerdict({ answer: 'The record does not show it [Z9].', answerable: false }, ids);
  assert.equal(notShownBad.ok, false); assert.equal(notShownBad.reason, 'unresolved_ids');
  assert.equal(askVerdict(null, ids).ok, false); assert.equal(askVerdict(null, ids).reason, 'empty');
  assert.equal(ASK_WITHHELD_COPY, "The agent's answer failed its citation check and was not shown — try rephrasing the question.");
});

test('answerCaseQuestion through the seam: answered with citedIds; withheld on an invented id (never rendered, never retried); withheld on a model fault; the prompt carries the question and capped history', async () => {
  let calls = 0;
  const ok = await answerCaseQuestion({ dedupKey: 'k', material, history: [{ question: 'Q1', answer: 'A1 [S1].' }], question: 'Why is negligence unknown?', call: async (p) => { calls++; assert.match(p.user, /Q1: Q1\nA1: A1 \[S1\]\./); assert.match(p.user, /QUESTION: Why is negligence unknown\?/); return '{"answer":"The rule fires only on a named intra-operative event in usable operative-note text on an unplanned same-condition return; here the note records a calcar crack and cerclage wire [OT1] and the audit still read negligence as unknown [S1].","answerable":true}'; } });
  assert.equal(ok.outcome, 'answered'); assert.deepEqual(ok.verdict?.citedIds, ['OT1', 'S1']); assert.equal(calls, 1);
  const bad = await answerCaseQuestion({ dedupKey: 'k', material, history: [], question: 'What grew on culture?', call: async () => { calls++; return '{"answer":"MRSA grew on the swab [R7].","answerable":true}'; } });
  assert.equal(bad.outcome, 'withheld'); assert.equal(bad.reason, 'unresolved_ids'); assert.deepEqual(bad.verdict?.invalidIds, ['R7']); assert.equal(calls, 2, 'no silent retry');
  const fault = await answerCaseQuestion({ dedupKey: 'k', material, history: [], question: 'x', call: async () => { throw new Error('Bedrock 503'); } });
  assert.equal(fault.outcome, 'withheld'); assert.equal(fault.reason, 'model_unavailable');
  const notShown = await answerCaseQuestion({ dedupKey: 'k', material, history: [], question: 'What was the potassium?', call: async () => '{"answer":"The case record does not show a potassium value.","answerable":false}' });
  assert.equal(notShown.outcome, 'answered'); assert.equal(notShown.answerable, false); assert.deepEqual(notShown.verdict?.citedIds, []);
});

// ── the material: stored artefacts only, no identity ────────────────────────────────────

test('askMaterialFrom: ledger + valid account + judgements in words + coverage + bills + refusals; an INVALID account is not shown to the model; no name / uhid field exists on the material', () => {
  const row = {
    dedupKey: 'IP-1|IP-2', findingClass: 'even_even', lane: 'tight_bounce', auditStatus: 'audited', patientName: 'Asha Khan', uhid: 'UH-77812', ageGender: '58F', gapDays: 4,
    indexDepartment: 'Ortho', readmitDepartment: 'Ortho', indexDoctor: null, readmitDoctor: null, indexDischargeAt: '2026-06-01T10:00:00+05:30', readmitAdmitAt: '2026-06-05T09:30:00+05:30',
    payerIndex: 'Even', payerReadmit: 'Even', cmNote: null, planned: 'unplanned', sameCondition: 'same', avoidable: 'needs_adjudication', labTier: 'tier1', labTimingProfile: null, nOmissions: 1,
    needsHumanReview: true, promotedToFull: false, notAuditableReason: null, finding: null, omissionEvidence: null, preventableInjury: 'suspected', negligence: 'unknown',
    returnBill: { state: 'not_finalised', netRs: null, lines: null },
  } as unknown as SurfaceFinding;
  const blobObj = { evidenceLedger: { items: [{ id: 'S1', source: 'index_summary', side: 'index', weight: 'interested', text: 't' }, { source: 'lab', text: 'no id — dropped' }] }, caseNarrative: { text: 'Account [S1].', valid: true }, refusalRecord: [{ lookedFor: 'pac_note', found: false, note: 'n' }, { lookedFor: 'ot_note', found: true }] };
  const blob = blobObj as never;
  const m = askMaterialFrom(row, blob, { ok: true, groups: [], totalRs: 0, lines: 0 }, null);
  assert.deepEqual(m.ledger, [{ id: 'S1', source: 'index_summary', side: 'index', at: null, weight: 'interested', text: 't' }]);
  assert.equal(m.account, 'Account [S1].');
  assert.deepEqual(m.judgements, { planned: 'unplanned', sameCondition: 'same', justification: 'Needs adjudication', preventableInjury: 'Suspected', negligence: 'Unknown', findingClass: 'even_even', lane: 'tight_bounce', gapDays: 4 });
  assert.deepEqual(m.refusals, [{ lookedFor: 'pac_note', note: 'n' }]);
  assert.equal(m.bills.returnCell, 'bill not finalised');
  assert.ok(!('patientName' in m) && !('uhid' in m) && !JSON.stringify(m).includes('Asha') && !JSON.stringify(m).includes('UH-77812'), 'no identity on the material');
  const invalid = askMaterialFrom(row, { ...blobObj, caseNarrative: { text: 'Bad [Z9].', valid: false } } as never, null, null);
  assert.equal(invalid.account, null);
});

// ── the route + UI (source-read) ─────────────────────────────────────────────────────────

test('ask route: gates identical to the case route; reads = the case-route set only (pinned row + two bills); no identity to toFinding; no store write; a model fault is a withheld answer, not a 500', () => {
  const route = code('app/api/care/readmissions/ask/route.ts');
  const caseRoute = code('app/api/care/readmissions/case/route.ts');
  for (const gate of ["process.env.CCB_ENABLED === '1' && process.env.READMISSIONS_SURFACE_ENABLED === '1'", 'isCareUnlocked', 'isAdminUnlocked']) assert.ok(route.includes(gate) && caseRoute.includes(gate), gate);
  assert.match(route, /fetchFindingForSurface\(key, READMIT_ENGINE_VERSION\)/);
  assert.match(route, /fetchStayBillBreakdown\(indexId\)/);
  assert.match(route, /toFinding\(r, undefined, null, returnBill\)/);
  for (const forbidden of ['fetchExtractedCases', 'fetchLatestAuditsForNotes', 'fetchPriorPrescriptionDocs', 'resolveIndividualUid', 'fetchOtNotes', 'assembleForRow', 'saveCaseArtefacts', 'saveAuditResult', 'composeCaseArtefacts', 'metabaseQuery', 'namesFromAdt', 'identityFromSummaries']) {
    assert.ok(!route.includes(forbidden), `the ask route must not call ${forbidden}`);
  }
  const lib = code('lib/readmission/ask.ts');
  assert.ok(!/from '\.\/db13'|from '\.\/store'|saveCaseArtefacts|saveAuditResult|metabaseQuery/.test(lib.replace(/import type \{ StayBillBreakdown \} from '\.\/db13';/, '')), 'the ask lib reads nothing and writes nothing');
  assert.match(lib, /\{ bedrock: NARRATIVE_MODEL_ID, timeoutMs: ASK_BUDGET_MS, maxTries: ASK_MAX_TRIES \}/);
  assert.equal(ASK_BUDGET_MS, 90_000); assert.equal(ASK_MAX_TRIES, 1); assert.equal(ASK_TEMPERATURE, 0.1);
  assert.match(route, /outcome === 'withheld'/); assert.match(route, /copy: ASK_WITHHELD_COPY/);
});

test('UI: the placeholder string is gone from the repo; the three chips, the working copy, the advisory line and the per-load limit are wired', () => {
  const page = code('components/care/ReadmissionCasePage.tsx');
  assert.ok(!/coming in R4\.2|not yet available/.test(page));
  assert.match(page, /<AskTheAgent dedupKey=\{dedupKey\} known=\{known\} onJump=\{jump\} \/>/);
  assert.match(page, /ASK_SUGGESTIONS\.map/); assert.match(page, /\{ASK_WORKING_COPY\}/); assert.match(page, /\{ASK_ADVISORY\}/); assert.match(page, /ASK_PER_LOAD_LIMIT/); assert.match(page, /maxLength=\{ASK_QUESTION_MAX_CHARS\}/);
  assert.match(page, /\/api\/care\/readmissions\/ask/);
  assert.deepEqual([...ASK_SUGGESTIONS], ['Why was this case flagged?', 'What does the operative note show?', 'Why is negligence unknown?']);
  assert.equal(ASK_WORKING_COPY, 'The agent is reading the case — this takes about half a minute');
  // no persistence of the conversation anywhere
  assert.ok(!/localStorage|sessionStorage/.test(page));
});

// ── fingerprints (R43-6): recon + narrative unchanged, gate composition unchanged ─────────

test('both fingerprint sets unchanged: the four recon builders (sha16) and the refresh-gate string incl. its narrative component; the gate does not include the ask builder', () => {
  const cat = { items: [
    { id: 'S1', source: 'index_summary' as const, side: 'index' as const, text: 'diagnosis: fracture neck of femur' },
    { id: 'L1', source: 'lab' as const, side: 'index' as const, text: 'Hb: 9.1 g/dL', abnormal: true, at: '2026-06-01' },
    { id: 'OT1', source: 'ot_note' as const, side: 'index' as const, text: 'OT note' },
  ] };
  const h = (o: unknown) => createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 16);
  assert.equal(h(buildFullReconPrompt(cat, { gapDays: 4, lane: 'tight_bounce', indexDepartment: 'Ortho', readmitDepartment: 'Ortho', sameDoctor: true, labProfile: 'has_late_labs' })), 'a65be27800b26f0e');
  assert.equal(h(buildSecondAvoidablePrompt(cat, { gapDays: 4, labProfile: 'has_late_labs' })), '3e11e8555c9ac2d6');
  assert.equal(h(buildConditionPassPrompt(cat, { gapDays: 4 })), '6a9f30d7f6926f5e');
  assert.equal(h(buildOonPrompt(cat, { reportedReadmitDate: '2026-06-05', labProfile: 'has_late_labs' })), 'a1513639455807b3');
  assert.equal(reconPromptFingerprints(), '59fe9addffa993dc.22170f09ffd188c1.88b7fc2dd3d06b4b.8eb4054a9a6810f9.dad75db58c605cb4');
  assert.ok(!/buildAskPrompt/.test(code('lib/readmission-refresh-core.ts')), 'the ask builder is outside the gate fingerprint');
});
