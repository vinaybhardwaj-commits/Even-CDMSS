/**
 * lib/__tests__/lvp-operator-core.test.ts — LVP L2: the operator's pure core.
 *
 * The load-bearing claims: model text never reaches the page unfiltered, a violation is rejected
 * ROW-WISE so one bad decoration cannot cost the others their copy, and the decoration path can
 * touch two strings and nothing else.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  forbiddenHits, LVP_FORBIDDEN_STRINGS, LVP_OPERATOR_MODEL_DEFAULT, LVP_OPERATOR_SYSTEM,
  LVP_TITLE_MAX, LVP_WHY_MAX, operatorModel, operatorUserMessage, parseOperatorOutput,
  screenDecorations, validateDecoration,
  type OperatorPatternInput,
} from '../lvp-operator-core.ts';
import { LVP_DECORATIONS_DDL, UPSERT_DECORATION_SQL } from '../lvp-operator.ts';
import { BEDROCK_MODELS, isKnownBedrockModel } from '../bedrock-core.ts';

const pattern = (id: string, over: Partial<OperatorPatternInput> = {}): OperatorPatternInput => ({
  pattern_id: id, concept_id: id.replace('pattern:', ''),
  direction: 'overuse', action: 'rx', target: 'montelukast_containing',
  volume_week: 31, doctor_count: 9,
  examples: ['12 Jul 2026 — montelukast prescribed for viral URTI'],
  ...over,
});

const good = { pattern_id: 'pattern:overuse:rx:x', title: 'Montelukast for viral sore throat', why: 'These may include courses started for a short viral illness. Worth a look.' };

// ══ the model (O12) ═════════════════════════════════════════════════════════════════════════════

test('the default model is Opus on Bedrock, and it is a model Bedrock actually serves', () => {
  assert.equal(LVP_OPERATOR_MODEL_DEFAULT, 'global.anthropic.claude-opus-4-6-v1');
  assert.ok(isKnownBedrockModel(LVP_OPERATOR_MODEL_DEFAULT),
    `the default must be in BEDROCK_MODELS: ${Object.keys(BEDROCK_MODELS).join(', ')}`);
  assert.equal(BEDROCK_MODELS[LVP_OPERATOR_MODEL_DEFAULT], 'Opus 4.6');
});

test('LVP_OPERATOR_MODEL overrides, and a blank or whitespace override does NOT', () => {
  assert.equal(operatorModel({}), LVP_OPERATOR_MODEL_DEFAULT);
  assert.equal(operatorModel({ LVP_OPERATOR_MODEL: '' }), LVP_OPERATOR_MODEL_DEFAULT);
  assert.equal(operatorModel({ LVP_OPERATOR_MODEL: '   ' }), LVP_OPERATOR_MODEL_DEFAULT);
  assert.equal(operatorModel({ LVP_OPERATOR_MODEL: 'global.anthropic.claude-sonnet-4-6' }), 'global.anthropic.claude-sonnet-4-6');
  assert.equal(operatorModel({ LVP_OPERATOR_MODEL: '  global.anthropic.claude-sonnet-4-6  ' }), 'global.anthropic.claude-sonnet-4-6');
});

// ══ the forbidden-strings filter (§5, acceptance 4) ═════════════════════════════════════════════

test('the forbidden list is exactly the ten strings L1 §4.6 forbids on this page', () => {
  assert.deepEqual([...LVP_FORBIDDEN_STRINGS], [
    'Ratify', 'physician-ratified', 'Even Adjudicated', 'Route to doctor', 'Valid signal',
    'Audit bug', 'Generate candidates', 'pending ratification', 'will affect the score',
    'metal detector',
  ]);
});

test('every forbidden string is caught, in any casing, anywhere in the text', () => {
  for (const f of LVP_FORBIDDEN_STRINGS) {
    assert.deepEqual(forbiddenHits(f), [f], `${f} must be caught verbatim`);
    assert.deepEqual(forbiddenHits(f.toUpperCase()), [f], `${f} must be caught upper-cased`);
    assert.deepEqual(forbiddenHits(`a sentence that says ${f.toLowerCase()} in the middle`), [f]);
  }
  assert.deepEqual(forbiddenHits('a clean sentence about montelukast'), []);
});

test('a decoration carrying a forbidden string is REJECTED, in either field', () => {
  assert.deepEqual(validateDecoration(good), []);
  const inTitle = validateDecoration({ ...good, title: 'Ratify this montelukast pattern' });
  assert.equal(inTitle.length, 1);
  assert.match(inTitle[0], /^title: forbidden on this page — Ratify$/);
  const inWhy = validateDecoration({ ...good, why: 'Worth a look; it will affect the score.' });
  assert.equal(inWhy.length, 1);
  assert.match(inWhy[0], /^why: forbidden on this page — will affect the score$/);
});

// ══ length caps (§5, acceptance 5) ═════════════════════════════════════════════════════════════

test('length caps are 90 and 400, measured on the TRIMMED string the card renders', () => {
  assert.equal(LVP_TITLE_MAX, 90);
  assert.equal(LVP_WHY_MAX, 400);
  assert.deepEqual(validateDecoration({ ...good, title: 'x'.repeat(90) }), [], '90 is allowed');
  assert.deepEqual(validateDecoration({ ...good, why: 'y'.repeat(400) }), [], '400 is allowed');
  assert.deepEqual(validateDecoration({ ...good, title: `  ${'x'.repeat(90)}  ` }), [], 'surrounding space is not length');

  const longTitle = validateDecoration({ ...good, title: 'x'.repeat(91) });
  assert.equal(longTitle.length, 1);
  assert.match(longTitle[0], /^title: 91 characters exceeds the 90-character cap$/);
  const longWhy = validateDecoration({ ...good, why: 'y'.repeat(401) });
  assert.match(longWhy[0], /^why: 401 characters exceeds the 400-character cap$/);
});

test('an empty or missing field is a REJECTION, not a silent stub fallback', () => {
  for (const f of ['title', 'why'] as const) {
    assert.ok(validateDecoration({ ...good, [f]: '' }).some((p) => p === `${f}: required`));
    assert.ok(validateDecoration({ ...good, [f]: '   ' }).some((p) => p === `${f}: required`));
    const missing: Record<string, unknown> = { ...good };
    delete missing[f];
    assert.ok(validateDecoration(missing).some((p) => p === `${f}: required`));
  }
  assert.deepEqual(validateDecoration({ ...good, pattern_id: '' }), ['pattern_id: required']);
  assert.deepEqual(validateDecoration(null), ['decoration: must be an object']);
  assert.deepEqual(validateDecoration('a string'), ['decoration: must be an object']);
});

// ══ ROW-WISE rejection (§5, acceptance 4 and 5) ════════════════════════════════════════════════

test('ROW-WISE: a violating decoration keeps its stub copy while every other pattern proceeds', () => {
  const { accepted, rejected } = screenDecorations([
    { pattern_id: 'p1', title: 'Clean title one', why: 'A clean argument.' },
    { pattern_id: 'p2', title: 'Ratify this one', why: 'A clean argument.' },
    { pattern_id: 'p3', title: 'x'.repeat(120), why: 'A clean argument.' },
    { pattern_id: 'p4', title: 'Clean title four', why: 'z'.repeat(401) },
    { pattern_id: 'p5', title: 'Clean title five', why: 'Another clean argument.' },
  ]);
  assert.deepEqual(accepted.map((d) => d.pattern_id), ['p1', 'p5'], 'the clean ones are written');
  assert.deepEqual(rejected.map((r) => r.pattern_id), ['p2', 'p3', 'p4'], 'the violations are not');
  assert.match(rejected[0].problems[0], /forbidden on this page/);
  assert.match(rejected[1].problems[0], /exceeds the 90-character cap/);
  assert.match(rejected[2].problems[0], /exceeds the 400-character cap/);
  // A whole run is never lost to one bad row.
  assert.equal(accepted.length + rejected.length, 5);
});

test('accepted decorations are stored trimmed — what was validated is what is written', () => {
  const { accepted } = screenDecorations([{ pattern_id: 'p1', title: '  Padded title  ', why: '  Padded why.  ' }]);
  assert.deepEqual(accepted, [{ pattern_id: 'p1', title: 'Padded title', why: 'Padded why.' }]);
});

// ══ output parsing ═════════════════════════════════════════════════════════════════════════════

const ALLOWED = ['pattern:a', 'pattern:b'];

test('the array is found through a markdown fence and through surrounding prose', () => {
  const body = '[{"pattern_id":"pattern:a","title":"T","why":"W"}]';
  for (const raw of [body, '```json\n' + body + '\n```', 'Here you go:\n' + body + '\nThanks!']) {
    assert.deepEqual(parseOperatorOutput(raw, ALLOWED), [{ pattern_id: 'pattern:a', title: 'T', why: 'W' }]);
  }
});

test('an UNKNOWN pattern_id is DROPPED, never mapped onto a card it might have meant', () => {
  const raw = '[{"pattern_id":"pattern:a","title":"T","why":"W"},{"pattern_id":"pattern:invented","title":"X","why":"Y"}]';
  assert.deepEqual(parseOperatorOutput(raw, ALLOWED).map((d) => d.pattern_id), ['pattern:a']);
});

test('a duplicated pattern_id keeps the FIRST occurrence', () => {
  const raw = '[{"pattern_id":"pattern:a","title":"first","why":"W"},{"pattern_id":"pattern:a","title":"second","why":"W"}]';
  assert.deepEqual(parseOperatorOutput(raw, ALLOWED).map((d) => d.title), ['first']);
});

test('unusable output parses to nothing, and nothing is what gets written', () => {
  for (const raw of ['', 'I cannot help with that.', '{"pattern_id":"pattern:a"}', '[', 'null', '[not json]']) {
    assert.deepEqual(parseOperatorOutput(raw, ALLOWED), [], `${JSON.stringify(raw)} must parse to []`);
  }
});

test('an omitted pattern is honoured: the operator may decline an item and it keeps stub copy', () => {
  // §5 tells the operator to omit an item it cannot argue for, rather than invent one.
  const raw = '[{"pattern_id":"pattern:b","title":"T","why":"W"}]';
  assert.deepEqual(parseOperatorOutput(raw, ALLOWED).map((d) => d.pattern_id), ['pattern:b']);
});

// ══ the user message: the shelved head only, and no PHI ════════════════════════════════════════

test('the user message carries the head\'s facts and nothing the operator was not given', () => {
  const msg = operatorUserMessage([pattern('pattern:overuse:rx:montelukast_containing')]);
  assert.match(msg, /^1 pattern on this week's shelf\./);
  assert.match(msg, /pattern_id: pattern:overuse:rx:montelukast_containing/);
  assert.match(msg, /findings this week: 31/);
  assert.match(msg, /distinct doctors: 9/);
  assert.match(msg, /montelukast prescribed for viral URTI/);
  assert.match(msg, /Return the JSON array now/);
});

test('a null doctor count and an empty example list are stated, never faked', () => {
  const msg = operatorUserMessage([pattern('pattern:p', { doctor_count: null, examples: [] })]);
  assert.match(msg, /distinct doctors: \(unknown\)/);
  assert.match(msg, /de-identified example lines: \(none available\)/);
  assert.doesNotMatch(msg, /distinct doctors: 0/, 'unknown is not zero');
});

test('plural agreement, because the operator reads this sentence too', () => {
  assert.match(operatorUserMessage([pattern('p1')]), /^1 pattern on/);
  assert.match(operatorUserMessage([pattern('p1'), pattern('p2')]), /^2 patterns on/);
});

// ══ the prompt itself (§5 voice) ═══════════════════════════════════════════════════════════════

test('the system prompt states every voice constraint §5 requires', () => {
  const p = LVP_OPERATOR_SYSTEM;
  assert.match(p, /You are an operator\./);
  assert.match(p, /not Even policy, it is not a physician's ruling/, 'not policy, not a physician\'s opinion');
  assert.match(p, /Do not assert that anything is wrong\./);
  assert.match(p, /Say what the pattern IS and why it is worth a look/);
  assert.match(p, /Do not tell the care manager to do anything/, 'no instruction — the shelf is not a queue');
  assert.match(p, /No blame\./);
  assert.match(p, /At most 90 characters/);
  assert.match(p, /At most 400 characters/);
  assert.match(p, /You are given no patient record and no note text/);
});

test('the prompt names every forbidden string, so the model is told before it is filtered', () => {
  for (const f of LVP_FORBIDDEN_STRINGS) {
    assert.ok(LVP_OPERATOR_SYSTEM.includes(f), `the prompt must name ${f}`);
  }
});

test('the prompt itself contains no instruction the filter would reject as page copy', () => {
  // The prompt legitimately NAMES the forbidden strings in its own ban list; what it must not do is
  // model them as acceptable output. The output contract is a bare JSON array and nothing else.
  assert.match(LVP_OPERATOR_SYSTEM, /Return ONLY a JSON array, no prose before or after it/);
  assert.match(LVP_OPERATOR_SYSTEM, /\{"pattern_id": "<the id exactly as given>", "title": "<= 90 chars", "why": "<= 400 chars"\}/);
});

// ══ the SQL and the migration (O14, §4) ════════════════════════════════════════════════════════

test('the reference .sql and the executable DDL agree — they cannot fork silently', () => {
  const migration = readFileSync(new URL('../../migrations/0040_lvp_decorations.sql', import.meta.url), 'utf8');
  const statements = migration
    .split('\n').filter((l) => !/^\s*--/.test(l)).join('\n')
    .split(/;\s*(?:\n|$)/).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  assert.deepEqual(statements, [LVP_DECORATIONS_DDL.replace(/\s+/g, ' ').trim()]);
});

test('migration 0040 is additive and single-target — it names no other table', () => {
  const migration = readFileSync(new URL('../../migrations/0040_lvp_decorations.sql', import.meta.url), 'utf8');
  assert.doesNotMatch(migration, /\bDROP\b/i);
  assert.doesNotMatch(migration, /^\s*UPDATE\b/im);
  assert.doesNotMatch(migration, /\bALTER\s+TABLE\b/i);
  const targets = [...migration.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
  assert.deepEqual(targets, ['lvp_decorations']);
  // SQL-comment-stripped (`--`, not `//`): the header legitimately EXPLAINS why lvp_hidden stays
  // append-only (O14), and a comment saying so is the opposite of a statement touching it.
  const sqlOnly = migration.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  assert.doesNotMatch(sqlOnly, /lvp_hidden/, 'no statement touches the human ledger');
});

test('O14: decorations UPSERT per pattern_id — machine output, not an append-only ledger', () => {
  assert.match(UPSERT_DECORATION_SQL, /INSERT INTO lvp_decorations/);
  assert.match(UPSERT_DECORATION_SQL, /ON CONFLICT \(pattern_id\) DO UPDATE/);
  assert.match(UPSERT_DECORATION_SQL, /SET title = EXCLUDED\.title, why = EXCLUDED\.why, model = EXCLUDED\.model/);
  assert.match(LVP_DECORATIONS_DDL, /pattern_id\s+text PRIMARY KEY/);
  // The four columns §4 specifies, and no fifth carrying anything identifying.
  const cols = [...LVP_DECORATIONS_DDL.matchAll(/^\s{2}(\w+)\s/gm)].map((m) => m[1]);
  assert.deepEqual(cols, ['pattern_id', 'title', 'why', 'model', 'generated_at']);
});

// ══ decoration-only, asserted against the store's source (acceptance 2 and 7) ═══════════════════

const STORE = readFileSync(new URL('../lvp-store.ts', import.meta.url), 'utf8');
const OPERATOR = readFileSync(new URL('../lvp-operator.ts', import.meta.url), 'utf8');

/** Source with `//` and block comments removed. Every "this file must not contain X" assertion runs
 *  over THIS: both modules' headers name the hazards they avoid (`noLocalFallback`, `lvp_hidden`,
 *  `openrouter`), and a prose mention of a hazard is the opposite of committing it. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
}
const OPERATOR_CODE = code(OPERATOR);

test('the decoration block writes ONLY title, why and model — no number, no order, no id', () => {
  const block = STORE.slice(STORE.indexOf('const decRows = await run(DECORATIONS_SQL'));
  const assignments = [...block.matchAll(/^\s+s\.(\w+) = /gm)].map((m) => m[1]).sort();
  assert.deepEqual(assignments, ['model', 'title', 'why'],
    'a decoration may touch two strings and the model label, and nothing else');
  for (const zone of ['volume_week', 'doctor_count', 'first_seen', 'examples', 'pill', 'pattern_id', 'concept_id']) {
    assert.equal(new RegExp(`s\\.${zone}\\s*=`).test(block), false, `${zone} must stay deterministic`);
  }
});

test('decoration runs AFTER shelving, so it cannot promote, reorder or cap a card', () => {
  const shelve = STORE.indexOf('const suggested = shelveSuggestions(candidates);');
  const decorate = STORE.indexOf('const decRows = await run(DECORATIONS_SQL');
  assert.ok(shelve > 0 && decorate > shelve, 'the shelf is decided before any decoration is read');
  // And the decoration read is scoped to the shelved head, so an off-shelf kind is never fetched.
  assert.match(STORE, /DECORATIONS_SQL, \[suggested\.map\(\(s\) => s\.pattern_id\)\]/);
});

test('a half-written decoration row decorates nothing — both zones or neither', () => {
  assert.match(STORE, /if \(!title \|\| !why\) continue;/);
});

test('the operator writes lvp_decorations and NOTHING else (acceptance 7 and 8)', () => {
  // `UPDATE` is excluded when it is the ON CONFLICT DO UPDATE clause, which targets no new table.
  const writes = [...OPERATOR_CODE.matchAll(/\b(?:INSERT INTO|DELETE FROM)\s+(\w+)|^UPDATE\s+(\w+)/gm)]
    .map((m) => m[1] ?? m[2]);
  assert.deepEqual([...new Set(writes)], ['lvp_decorations']);
  for (const forbidden of ['lvp_hidden', 'opd_gov_signal', 'mksap_chunks', 'even_lvc_assertions', 'opd_note_audits', 'lvc_recommendations']) {
    assert.equal(OPERATOR_CODE.includes(forbidden), false, `the operator must not name ${forbidden}`);
  }
  // R3-A is dormant and must not gain an importer.
  assert.equal(/rule-governance/.test(OPERATOR_CODE), false, 'the operator must not import R3-A');
});

test('O12/F11: the governed call names bedrock and NOTHING else — no ladder to fall down', () => {
  assert.match(OPERATOR_CODE, /\{ bedrock: model \}/);
  assert.equal(/openrouter/i.test(OPERATOR_CODE), false, 'never OpenRouter');
  assert.equal(/gemini/i.test(OPERATOR_CODE), false, 'never Gemini');
  assert.equal(/noLocalFallback/.test(OPERATOR_CODE), false, 'an explicit Bedrock target has nothing to switch off');
  // The model is refused before the transport, so an unlisted id can never be served by something else.
  assert.ok(OPERATOR_CODE.indexOf('assertKnownBedrockModel(model)') < OPERATOR_CODE.indexOf('await loadShelf()'),
    'the model is checked before any shelf read or provider call');
});
