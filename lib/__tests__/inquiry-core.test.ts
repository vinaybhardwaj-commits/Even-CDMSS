// Inquiry K1 — inquiry-core (PRD §15): candidate mapping per kind (incl. unmappable → dropped);
// validation rejects foreign ids / rewritten family/subject / over-length / generic; high-alert-
// always-first guarantee; cap 5; fallback on zero valid picks; ask-set/0.1 byte-identity of the
// fallback output vs buildAskSet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  candidatesFromUnknowns, droppedUnknowns, validateSelection, parseSelection,
  assembleInquiryAskSet, fallbackAskSet, runInquirySelection, questionMentionsSubject,
  INQUIRY_VERSION, INQUIRY_ASK_SET_VERSION, INQUIRY_SELECT_SYSTEM,
  type CandidateAsk, type SelectionPick,
} from '../inquiry/inquiry-core';
import { buildAskSet, ASK_SET_VERSION } from '../care-call-core';
import type { UnknownItem } from '../inquiry/unknowns-core';
import type { DeidOpdCase } from '../opd-ingest-core';

const KEYS = { presc_uid: 'presc123', individual_uid: 'indiv123', uhid: null, note_date: '2026-07-09' };

function mkCase(over: Partial<DeidOpdCase> = {}): DeidOpdCase {
  return {
    consultType: null, reasonForConsult: null, presentingComplaints: [], diagnosisCodes: [], impressionCodes: [],
    impressions: [], history: [], comorbidities: [], medications: [], investigations: [], advice: [], examination: [],
    allergies: 'nil', followUpType: null, followUpDateSet: false, ...over,
  };
}

const unk = (o: Partial<UnknownItem> & { kind: UnknownItem['kind']; subject: string }): UnknownItem => ({
  id: `unk-${o.kind}:${o.subject.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
  detail: o.detail ?? `${o.subject} detail`, criticality: o.criticality ?? 'review',
  sourceRefs: o.sourceRefs ?? ['src-1'],
  stateRef: o.stateRef ?? { kind: 'member', version: 'member-state/1.1', computedAt: null },
  ...o,
});

test('version constants match the PRD exactly', () => {
  assert.equal(INQUIRY_VERSION, 'inquiry/0.1');
  assert.equal(INQUIRY_ASK_SET_VERSION, 'ask-set/0.2');
  assert.equal(ASK_SET_VERSION, 'ask-set/0.1');
  assert.ok(INQUIRY_SELECT_SYSTEM.length > 100);
});

test('candidate mapping per kind (PRD §5 table) — family and skeleton per kind', () => {
  const episode = mkCase();
  const unknowns: UnknownItem[] = [
    unk({ kind: 'med_contradiction', subject: 'Atorvastatin' }),
    unk({ kind: 'unknown_finding', subject: 'chest pain' }),
    unk({ kind: 'missing_critical', subject: 'smoking status' }),
    unk({ kind: 'care_gap', subject: 'Vitamin D', detail: 'severely abnormal (8) ng/ml — not rechecked in 1.1y' }),
    unk({ kind: 'followup_open', subject: 'Repeat HbA1c after 3 months' }),
    unk({ kind: 'allergy_unconfirmed', subject: 'allergies' }),
  ];
  const cands = candidatesFromUnknowns(unknowns, episode, KEYS);
  const byFam = (f: string, re: RegExp) => cands.find((c) => c.family === f && re.test(c.question));
  assert.ok(byFam('MED_STATUS', /stopped Atorvastatin — how is it now/), 'med_contradiction → MED_STATUS skeleton');
  assert.ok(byFam('COMPLAINT_STATUS', /How is chest pain now\?/), 'unknown_finding → COMPLAINT_STATUS');
  assert.ok(byFam('COMPLAINT_STATUS', /How is smoking status now\?/), 'missing_critical → COMPLAINT_STATUS');
  assert.ok(byFam('FOLLOWUP_ACTION', /Vitamin D was .*book a repeat test/), 'care_gap → FOLLOWUP_ACTION');
  assert.ok(byFam('FOLLOWUP_ACTION', /Doctor advised Repeat HbA1c/), 'followup_open → FOLLOWUP_ACTION (ask-set/0.1 phrasing)');
  assert.ok(byFam('ALLERGY_CONFIRM', /medicine allergies/), 'allergy_unconfirmed → ALLERGY_CONFIRM');
  for (const c of cands) assert.match(c.id, /^(MED_STATUS|FOLLOWUP_ACTION|COMPLAINT_STATUS|ALLERGY_CONFIRM|OUTSIDE_RECORDS):/, 'deterministic family:slug id');
});

test('baseline buildAskSet asks are also candidates (why baseline, unknownIds [])', () => {
  const episode = mkCase({ medications: [{ generic: 'Metformin' }], presentingComplaints: ['cough'] });
  const cands = candidatesFromUnknowns([], episode, KEYS);
  const base = buildAskSet(episode, KEYS);
  for (const a of base.asks) {
    const c = cands.find((x) => x.id === a.id)!;
    assert.ok(c, `baseline candidate ${a.id}`);
    assert.equal(c.why, 'baseline');
    assert.deepEqual(c.unknownIds, []);
  }
});

test('instability_input / unmappable unknowns produce no candidate and land in dropped', () => {
  const unknowns = [unk({ kind: 'instability_input', subject: 'BP' })];
  const cands = candidatesFromUnknowns(unknowns, mkCase(), KEYS);
  assert.equal(cands.some((c) => c.subject === 'BP'), false);
  const dropped = droppedUnknowns(unknowns, cands);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].kind, 'instability_input');
});

test('same-id candidates merge (allergy unknown merges into the baseline allergy ask)', () => {
  const episode = mkCase({ allergies: null });
  const u = unk({ kind: 'allergy_unconfirmed', subject: 'allergies' });
  const cands = candidatesFromUnknowns([u], episode, KEYS);
  const allergy = cands.filter((c) => c.family === 'ALLERGY_CONFIRM');
  assert.equal(allergy.length, 1, 'no duplicate ALLERGY_CONFIRM candidate');
  assert.deepEqual(allergy[0].unknownIds, [u.id]);
});

test('validateSelection: foreign id rejected; duplicate rejected; ≤3 picks', () => {
  const cands = candidatesFromUnknowns([unk({ kind: 'unknown_finding', subject: 'knee pain' })], mkCase(), KEYS);
  const id = 'COMPLAINT_STATUS:knee-pain';
  const picks: SelectionPick[] = [
    { id: 'MED_STATUS:not-a-candidate', question: 'Are you taking not-a-candidate medicine?' },
    { id, question: 'How is the knee pain today?' },
    { id, question: 'Duplicate — how is the knee pain?' },
  ];
  const valid = validateSelection(picks, cands);
  assert.equal(valid.length, 1);
  assert.equal(valid[0].ask.id, id);
  const many: SelectionPick[] = cands.slice(0, 4).map((c) => ({ id: c.id, question: c.question }));
  assert.ok(validateSelection(many.concat(many), cands).length <= 3, 'never more than 3 picks');
});

test('validateSelection: rewritten family/subject never survive — candidate fields win', () => {
  const u = unk({ kind: 'med_contradiction', subject: 'Atorvastatin' });
  const cands = candidatesFromUnknowns([u], mkCase(), KEYS);
  const c = cands.find((x) => x.family === 'MED_STATUS')!;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const evil: any = { id: c.id, family: 'OUTSIDE_RECORDS', subject: 'something else', question: 'Are you still taking Atorvastatin these days?' };
  const valid = validateSelection([evil], cands);
  assert.equal(valid.length, 1);
  assert.equal(valid[0].ask.family, 'MED_STATUS');
  assert.equal(valid[0].ask.subject, 'Atorvastatin');
});

test('validateSelection: over-length and empty questions are rejected', () => {
  const cands = candidatesFromUnknowns([unk({ kind: 'unknown_finding', subject: 'back pain' })], mkCase(), KEYS);
  const id = 'COMPLAINT_STATUS:back-pain';
  assert.equal(validateSelection([{ id, question: 'x'.repeat(161) }], cands).length, 0);
  assert.equal(validateSelection([{ id, question: '   ' }], cands).length, 0);
  assert.equal(validateSelection([{ id, question: 'How is your back pain now?' }], cands).length, 1);
});

test('validateSelection: a generic question (no subject token) is replaced by the candidate skeleton', () => {
  const cands = candidatesFromUnknowns([unk({ kind: 'unknown_finding', subject: 'migraine headaches' })], mkCase(), KEYS);
  const id = 'COMPLAINT_STATUS:migraine-headaches';
  const valid = validateSelection([{ id, question: 'And how are you feeling overall?' }], cands);
  assert.equal(valid.length, 1);
  assert.equal(valid[0].ask.question, 'How is migraine headaches now?');   // skeleton restored
  assert.equal(questionMentionsSubject('migraine headaches', 'And how are you feeling overall?'), false);
});

test('assembly: every high-alert MED_STATUS ask is ALWAYS first, regardless of picks', () => {
  const episode = mkCase({
    medications: [{ generic: 'Insulin glargine', highAlert: true }, { generic: 'Telmisartan' }],
    presentingComplaints: ['dizziness'],
  });
  const u = unk({ kind: 'unknown_finding', subject: 'blurred vision' });
  const cands = candidatesFromUnknowns([u], episode, KEYS);
  const pick = validateSelection([{ id: 'COMPLAINT_STATUS:blurred-vision', question: 'Any blurred vision since the visit?' }], cands);
  const out = assembleInquiryAskSet(episode, KEYS, cands, pick);
  assert.equal(out.source, 'inquiry');
  assert.equal(out.ask_set_version, 'ask-set/0.2');
  assert.equal(out.asks[0].family, 'MED_STATUS');
  assert.equal(out.asks[0].meta?.highAlert, true);
  assert.equal(out.asks[1].id, 'COMPLAINT_STATUS:blurred-vision');   // then the picks, in order
});

test('assembly: total cap stays 5 and the overflow list is preserved', () => {
  // 2 high-alert meds (always first) + 3 picks would already fill the set — the deterministic
  // follow-up/allergy backfill must respect the cap, and everything unserved lands in overflow.
  const episode = mkCase({
    medications: [{ generic: 'Insulin glargine', highAlert: true }, { generic: 'Warfarin', highAlert: true }, { generic: 'Amlodipine' }],
    presentingComplaints: ['cough', 'fever'],
    allergies: null,
    advice: ['Repeat CBC after 1 week'],
  });
  const unknowns = [unk({ kind: 'unknown_finding', subject: 'night sweats' }), unk({ kind: 'unknown_finding', subject: 'blurred vision' }), unk({ kind: 'care_gap', subject: 'HbA1c', detail: 'abnormal (9.1) % — not rechecked in 8mo' })];
  const cands = candidatesFromUnknowns(unknowns, episode, KEYS);
  const picks = validateSelection([
    { id: 'COMPLAINT_STATUS:night-sweats', question: 'Any night sweats still?' },
    { id: 'COMPLAINT_STATUS:blurred-vision', question: 'Any blurred vision since the visit?' },
    { id: 'FOLLOWUP_ACTION:hba1c', question: 'Your HbA1c needs a repeat — shall I book it?' },
  ], cands);
  const out = assembleInquiryAskSet(episode, KEYS, cands, picks);
  assert.equal(out.asks.length, 5, 'total cap stays 5');
  assert.equal(out.asks[0].meta?.highAlert, true);
  assert.equal(out.asks[1].meta?.highAlert, true);
  assert.ok(out.overflow.length >= 1, 'overflow preserved');
  assert.ok(out.overflow.some((o) => o.family === 'FOLLOWUP_ACTION'), 'unserved deterministic asks recorded in overflow');
  const ids = new Set(out.asks.map((a) => a.id));
  assert.equal(ids.size, 5, 'no duplicate served asks');
});

test('fallback byte-identity: zero valid picks ⇒ buildAskSet verbatim as ask-set/0.1', async () => {
  const episode = mkCase({ medications: [{ generic: 'Metformin', highAlert: false }], presentingComplaints: ['cough'], allergies: null });
  const base = buildAskSet(episode, KEYS);
  // zero valid picks via assembly
  const cands = candidatesFromUnknowns([], episode, KEYS);
  const out = assembleInquiryAskSet(episode, KEYS, cands, []);
  assert.equal(out.source, 'deterministic_fallback');
  assert.equal(out.ask_set_version, 'ask-set/0.1');
  assert.deepEqual(out.asks, base.asks);         // byte-identity of the served set
  assert.deepEqual(out.overflow, base.overflow);
  // and via the full runner with a model that returns only foreign ids
  const r = await runInquirySelection(episode, KEYS, [], {
    generate: async () => '{"picks":[{"id":"MED_STATUS:never-served","question":"Are you taking the never-served medicine?"}]}',
  });
  assert.equal(r.source, 'deterministic_fallback');
  assert.deepEqual(r.asks, base.asks);
  assert.deepEqual(r.overflow, base.overflow);
});

test('runInquirySelection: generate throw / invalid JSON / timeout all degrade to the fallback', async () => {
  const episode = mkCase({ medications: [{ generic: 'Amlodipine' }] });
  const base = buildAskSet(episode, KEYS);
  const check = (r: { asks: unknown; source: string; ask_set_version: string }) => {
    assert.equal(r.source, 'deterministic_fallback');
    assert.equal(r.ask_set_version, 'ask-set/0.1');
    assert.deepEqual(r.asks, base.asks);
  };
  check(await runInquirySelection(episode, KEYS, [], { generate: async () => { throw new Error('gemini down'); } }));
  check(await runInquirySelection(episode, KEYS, [], { generate: async () => 'sorry, I cannot produce JSON today' }));
  check(await runInquirySelection(episode, KEYS, [], {
    generate: () => new Promise((res) => setTimeout(() => res('{"picks":[]}'), 80)),
    timeoutMs: 10,
  }));
});

test('runInquirySelection happy path: validated picks served as ask-set/0.2 with askMeta derivation', async () => {
  const episode = mkCase({ medications: [{ generic: 'Insulin glargine', highAlert: true }], allergies: null });
  const u = unk({ kind: 'care_gap', subject: 'Vitamin D', detail: 'severely abnormal (8) ng/ml — not rechecked in 1.1y', criticality: 'safety' });
  const r = await runInquirySelection(episode, KEYS, [u], {
    generate: async () => JSON.stringify({ picks: [{ id: 'FOLLOWUP_ACTION:vitamin-d', question: 'Your Vitamin D was very low — shall I book a repeat test?', why: 'stale critical result' }] }),
  });
  assert.equal(r.source, 'inquiry');
  assert.equal(r.ask_set_version, 'ask-set/0.2');
  assert.equal(r.asks[0].meta?.highAlert, true, 'high-alert still first');
  const picked = r.asks.find((a) => a.id === 'FOLLOWUP_ACTION:vitamin-d')!;
  assert.ok(picked);
  const meta = r.askMeta.find((m) => m.askId === picked.id)!;
  assert.deepEqual(meta.unknownIds, [u.id]);
  assert.equal(meta.why, 'stale critical result');
  assert.ok(r.candidateCount >= 2);
});

test('parseSelection tolerates prose around the JSON and rejects malformed shapes', () => {
  assert.ok(parseSelection('Here you go:\n{"picks":[{"id":"a","question":"q"}]}\nthanks'));
  assert.equal(parseSelection('no json here'), null);
  assert.equal(parseSelection('{"picks":"nope"}'), null);
  assert.equal(parseSelection('{"picks":[{"id":1,"question":"q"}]}'), null);
});

test('fallbackAskSet is buildAskSet verbatim (deep-equal asks + overflow)', () => {
  const episode = mkCase({ medications: [{ generic: 'X' }, { generic: 'Y' }], presentingComplaints: ['a', 'b'], allergies: null });
  const fb = fallbackAskSet(episode, KEYS);
  const base = buildAskSet(episode, KEYS);
  assert.deepEqual({ asks: fb.asks, overflow: fb.overflow }, base);
  assert.equal(fb.ask_set_version, 'ask-set/0.1');
  assert.equal(fb.source, 'deterministic_fallback');
});

// keep the type visible to the compiler so the exported shape can't silently narrow
const _t: CandidateAsk | null = null;
void _t;
