/**
 *   node --test --import tsx lib/__tests__/preop-narrative-core.test.ts
 *
 * B6 — the fact table the narrative is written from, and the validator that decides
 * whether the prose is ever seen. (The D4 boundary itself — what the model is shown, and
 * that it can never carry a score — is proven in preop-d4-boundary.test.ts.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildNarrativeFacts, buildNarrativePrompt, buildPreopNarrative, narrativeRenderable,
  narrativeSentences, parseNarrativeOutput,
  PREOP_NARRATIVE_BUDGET_MS, PREOP_NARRATIVE_MAX_PER_TICK, PREOP_NARRATIVE_MODEL_ID,
  PREOP_NARRATIVE_VERSION,
} from '../preop-narrative-core.ts';
import { composeSnapshot, PAC_NONE, type Observation, type SnapshotInput } from '../preop-assemble-core.ts';

const src = (p: string) => readFileSync(p, 'utf8');

const OBS: Observation[] = [
  { inputId: 'congestive_heart_failure', status: 'present', source: 'OPD', detail: 'heart failure (ICD I50.9)' },
  { inputId: 'diabetes_mellitus', status: 'present', source: 'BOOKING', detail: 'booking: diabetes' },
  { inputId: 'diabetes_uncomplicated', status: 'present', source: 'BOOKING', detail: 'booking: diabetes' },
  { inputId: 'high_risk_surgery', status: 'absent', source: 'BOOKING', detail: 'TKR' },
];
const snapArgs = (over: Partial<SnapshotInput> = {}): SnapshotInput => ({
  engineVersion: 'preop-risk/0.1',
  episode: {
    episodeKey: 'SC-N', individualUid: 'I1', uhid: 'U1', patientName: 'Someone Real',
    age: 72, sex: 'FEMALE', procedure: 'Total knee replacement', hospital: 'Even Hospital',
    surgeryDate: '2026-09-05', surgeon: null, department: null,
  },
  observations: OBS, pac: PAC_NONE, daysToSurgery: 9, reviewed: false,
  includeExtracted: false, bookingEnumerated: true, notClosedBy: ['insulin_treated_diabetes'],
  bookingOnly: false, computedAt: '2026-08-27T04:00:00Z',
  ...over,
});
const snap = composeSnapshot(snapArgs());
const facts = buildNarrativeFacts(snap);

// ── the fact table ──────────────────────────────────────────────────────────────

test('every fact is numbered F1..Fn with no gaps — the ids are what the prose cites', () => {
  assert.ok(facts.length > 8);
  facts.forEach((f, i) => assert.equal(f.id, `F${i + 1}`));
});

test('the table carries the computed bounds, the tier and the missing list', () => {
  const all = facts.map((f) => f.text).join('\n');
  assert.match(all, /RCRI \(Revised Cardiac Risk Index\) scores/);
  assert.match(all, /mFI-5 \(Modified Frailty Index\) scores/);
  assert.match(all, /Charlson Comorbidity Index scores/);
  assert.match(all, /Composite tier: (GREEN|AMBER|RED|CRITICAL)\./);
  assert.match(all, /Inputs still unknown[\s\S]*insulin_treated_diabetes/);
});

test('absent zero-weight Charlson categories are left out — nineteen rows would bury the six that matter', () => {
  const all = facts.map((f) => f.text).join('\n');
  assert.ok(!all.includes('"AIDS"'), 'an absent, unscoring category is the shape of the instrument, not a fact about the patient');
  assert.ok(all.includes('Charlson category "Congestive heart failure": PRESENT'));
});

test('a booking-only patient says so, and a PAC-less one says that too', () => {
  const thin = buildNarrativeFacts(composeSnapshot(snapArgs({ bookingOnly: true })));
  const all = thin.map((f) => f.text).join('\n');
  assert.match(all, /booking form is the only document on file/);
  assert.match(all, /No pre-anaesthesia check report is on file/);
});

test('the correlated-lenses caveat is a FACT, so the model can only ever restate it', () => {
  assert.ok(facts.some((f) => /correlated lenses, not independent confirmation/.test(f.text)));
});

// ── the prompt ──────────────────────────────────────────────────────────────────

test('the prompt forbids scoring, advice and uncited sentences in so many words', () => {
  const { system } = buildNarrativePrompt(facts);
  assert.match(system, /You do not score/);
  assert.match(system, /No advice, no diagnosis, no recommendation/);
  assert.match(system, /A sentence with no marker is thrown away/);
});

test('the user message is the fact list and nothing else', () => {
  const { user } = buildNarrativePrompt(facts);
  assert.ok(user.startsWith('FACTS:\n'));
  assert.equal(user.split('\n').length, facts.length + 1);
});

// ── parsing ─────────────────────────────────────────────────────────────────────

test('parse reads the JSON shape, a fenced JSON shape, and bare prose', () => {
  assert.equal(parseNarrativeOutput('{"narrative":"A [F1]."}'), 'A [F1].');
  assert.equal(parseNarrativeOutput('```json\n{"narrative":"B [F1]."}\n```'), 'B [F1].');
  assert.equal(parseNarrativeOutput('C [F1].'), 'C [F1].');
  assert.equal(parseNarrativeOutput('   '), null);
});

test('sentence splitting keeps the marker with its sentence', () => {
  const s = narrativeSentences('One [F1]. Two [F2]! Three [F3]?');
  assert.deepEqual(s, ['One [F1].', 'Two [F2]!', 'Three [F3]?']);
});

test('the marker scan does not skip every other sentence (a /g regex carries lastIndex)', () => {
  const n = buildPreopNarrative({
    text: 'A [F1]. B [F2]. C [F3]. D [F4]. E [F5].',
    facts, snapshotFingerprint: 'fp', generatedAt: 'now', model: 'm', provider: 'p', traceId: 't',
  });
  assert.deepEqual(n.uncitedSentences, []);
  assert.deepEqual(n.citedIds, ['F1', 'F2', 'F3', 'F4', 'F5']);
  assert.equal(n.valid, true);
});

// ── the validator's four verdicts ───────────────────────────────────────────────

const v = (text: string | null) => buildPreopNarrative({
  text, facts, snapshotFingerprint: 'fp', generatedAt: 'now', model: 'm', provider: 'p', traceId: 't',
});

test('empty, uncited, unresolved and clean each get their own verdict', () => {
  assert.equal(v(null).invalidReason, 'empty');
  assert.equal(v('There is no citation anywhere in this paragraph.').invalidReason, 'no_citations');
  assert.equal(v('The tier is set [F1]. Something else entirely.').invalidReason, 'uncited_sentence');
  assert.equal(v('The tier is set [F900].').invalidReason, 'unresolved_ids');
  assert.equal(v('The tier is set [F1]. It rests on the table above [F2].').invalidReason, 'none');
});

test('an invalid narrative keeps its text — stored for review, never rendered', () => {
  const n = v('No citations here at all.');
  assert.equal(n.valid, false);
  assert.equal(n.text, 'No citations here at all.');
  assert.equal(narrativeRenderable(n, 'fp'), false);
});

// ── the model, and the box it runs in ───────────────────────────────────────────

test('the narrative model is Opus 4.6 on Bedrock with no ladder behind it', () => {
  assert.equal(PREOP_NARRATIVE_MODEL_ID, 'global.anthropic.claude-opus-4-6-v1');
  const s = src('lib/preop/narrative.ts');
  assert.ok(s.includes('bedrock: PREOP_NARRATIVE_MODEL_ID'));
  assert.ok(s.includes('noLocalFallback: true'));
  assert.ok(s.includes('modelsAgree'), 'DEC-2: the served model is read back and a disagreement stores nothing');
});

test('the leg budget and the per-tick cap fit the worker box, and the box says so', () => {
  assert.equal(PREOP_NARRATIVE_BUDGET_MS, 80_000);
  assert.equal(PREOP_NARRATIVE_MAX_PER_TICK, 3);
  const worker = src('app/api/preop/worker/route.ts');
  assert.ok(worker.includes('PREOP_NARRATIVE_MAX_PER_TICK'), 'the covenant block must name the cap it depends on');
  assert.ok(worker.includes('PREOP_LLM_BUDGET_MS'), 'and the budget that binds it');
  assert.match(worker, /export const maxDuration = 300/);
});

test('the version is pinned', () => {
  assert.equal(PREOP_NARRATIVE_VERSION, 'preop-narrative/1');
});
