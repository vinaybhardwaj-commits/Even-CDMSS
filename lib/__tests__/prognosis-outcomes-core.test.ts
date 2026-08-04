/**
 *   node --test --import tsx lib/__tests__/prognosis-outcomes-core.test.ts
 *
 * PX Phase 2 (outcome linkage) — PRD §7, every test that needs no database.
 *
 * The scenario these defend: lib/ipd-audit/store.ts upserts with
 * `ON CONFLICT (document_id, engine_version) DO UPDATE SET ... report = EXCLUDED.report`, so a
 * re-audit rewrites the complications array in place and an engine bump writes a whole new row.
 * A stored integer index therefore silently re-points; the hash does not. `unresolved` is a
 * first-class state — the block changed under a recorded outcome — never an error and never an
 * excuse to fall back to the index.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import {
  OUTCOME_SOURCES, OUTCOME_CLASSIFICATIONS, isOutcomeSource, isOutcomeClassification,
  normalizeComplicationName, complicationHash, isComplicationHash,
  deriveClassification, resolveComplicationHash,
  currentRows, followUpBucket, inOverWarningDenominator,
} from '../prognosis-outcomes-core';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §7.1 · Hash stability
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§7.1 hash stability: spacing and casing variants produce the SAME hash', () => {
  const h = complicationHash('Surgical site infection');
  for (const variant of [
    'surgical site infection',
    '  Surgical Site Infection  ',
    'SURGICAL   SITE\tINFECTION',
    'surgical\n site  infection',
  ]) {
    assert.equal(complicationHash(variant), h, `variant ${JSON.stringify(variant)}`);
  }
  // …and a genuinely different name produces a different hash.
  assert.notEqual(complicationHash('surgical site bleeding'), h);
});

test('the hash is EXACTLY sha256(normalized) hex first 16 — the stored contract, pinned', () => {
  // Pinned against an independent computation so a refactor cannot silently change stored
  // bindings: every previously stored hash would orphan.
  const name = '  Deep  Vein THROMBOSIS ';
  const expected = createHash('sha256').update('deep vein thrombosis', 'utf8').digest('hex').slice(0, 16);
  assert.equal(complicationHash(name), expected);
  assert.equal(expected.length, 16);
  assert.ok(isComplicationHash(expected));
  assert.ok(!isComplicationHash(expected + 'a'), '17 chars is not a stored hash');
  assert.ok(!isComplicationHash(expected.toUpperCase()), 'hex is lower-case');
});

test('normalization is trim + lower-case + collapse internal whitespace, nothing more', () => {
  assert.equal(normalizeComplicationName('  A   B\t\nC '), 'a b c');
  // Deliberately NOT stripped: punctuation and diacritics. Adding a step later would orphan
  // every stored hash, so the contract is pinned narrow.
  assert.equal(normalizeComplicationName('Post-op ileus (paralytic)'), 'post-op ileus (paralytic)');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §7.2 · Re-audit resilience — a reordered complications array still resolves by hash
// ═════════════════════════════════════════════════════════════════════════════════════════════

const BLOCK_AT_LINK_TIME = [
  { complication: 'Surgical site infection' },
  { complication: 'Deep vein thrombosis' },
  { complication: 'Anastomotic leak' },
];

test('§7.2 re-audit resilience: the array reorders, the hash still finds the right complication', () => {
  // Linked to DVT while it sat at index 1.
  const linkedHash = complicationHash('Deep vein thrombosis');
  // The re-audit rewrote the block; DVT now sits at index 0 and index 1 holds something else.
  const reordered = [
    { complication: 'Deep  Vein Thrombosis' },   // same name, different spacing — same hash
    { complication: 'Anastomotic leak' },
    { complication: 'Surgical site infection' },
  ];
  const r = resolveComplicationHash(linkedHash, reordered);
  assert.deepEqual(r, { status: 'matched', index: 0, complication: 'Deep  Vein Thrombosis' });
  // The advisory integer (1 at link time) now points at 'Anastomotic leak'. Resolution never
  // consulted it — resolveComplicationHash does not even accept an index parameter.
  assert.notEqual((reordered[1] as { complication: string }).complication.toLowerCase(), 'deep vein thrombosis');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §7.3 · Engine bump — unchanged name resolves; changed name renders unresolved
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§7.3 engine bump: an outcome linked at engine A resolves against engine B when the name survived', () => {
  const linkedAtEngineA = complicationHash('Anastomotic leak');
  const blockAtEngineB = [
    { complication: 'Postoperative pneumonia' },
    { complication: 'anastomotic  LEAK' },       // reworded only in case/spacing ⇒ same binding
  ];
  const r = resolveComplicationHash(linkedAtEngineA, blockAtEngineB);
  assert.equal(r.status, 'matched');
});

test('§7.3 engine bump: a renamed complication renders UNRESOLVED — never re-pointed by index', () => {
  const linkedAtEngineA = complicationHash('Anastomotic leak');
  // Engine B rephrased the complication. The old index (2) is even in range — and must be ignored.
  const blockAtEngineB = [
    { complication: 'Surgical site infection' },
    { complication: 'Deep vein thrombosis' },
    { complication: 'Anastomotic dehiscence with leak' },
  ];
  const r = resolveComplicationHash(linkedAtEngineA, blockAtEngineB);
  assert.deepEqual(r, { status: 'unresolved' },
    'unresolved is the honest answer: the block changed under a recorded outcome');
});

test('a NULL hash reads as unpredicted, and junk shapes never throw', () => {
  assert.deepEqual(resolveComplicationHash(null, BLOCK_AT_LINK_TIME), { status: 'unpredicted' });
  assert.deepEqual(resolveComplicationHash(undefined, BLOCK_AT_LINK_TIME), { status: 'unpredicted' });
  assert.deepEqual(resolveComplicationHash('', BLOCK_AT_LINK_TIME), { status: 'unpredicted' });
  assert.deepEqual(resolveComplicationHash('deadbeefdeadbeef', []), { status: 'unresolved' });
  assert.deepEqual(
    resolveComplicationHash('deadbeefdeadbeef', [{ complication: 123 as unknown as string }]),
    { status: 'unresolved' }, 'a malformed block entry is skipped, not thrown on');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §7.5 · Classification derivation — four values, from form state, never typed
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§7.5 each classification is produced by the correct form state', () => {
  const h = complicationHash('Surgical site infection');
  assert.deepEqual(
    deriveClassification({ noAdverseOutcome: false, benefitFailure: false, matchedComplicationHash: h }),
    { classification: 'predicted_occurred', matchedComplicationHash: h });
  assert.deepEqual(
    deriveClassification({ noAdverseOutcome: false, benefitFailure: false, matchedComplicationHash: null }),
    { classification: 'unpredicted_occurred', matchedComplicationHash: null });
  assert.deepEqual(
    deriveClassification({ noAdverseOutcome: false, benefitFailure: true, matchedComplicationHash: null }),
    { classification: 'benefit_failure', matchedComplicationHash: null });
  assert.deepEqual(
    deriveClassification({ noAdverseOutcome: true, benefitFailure: false, matchedComplicationHash: null }),
    { classification: 'no_adverse_outcome', matchedComplicationHash: null });
});

test('§7.5 no_adverse_outcome FORCES a null complication hash, whatever the form held', () => {
  const h = complicationHash('Deep vein thrombosis');
  const d = deriveClassification({ noAdverseOutcome: true, benefitFailure: true, matchedComplicationHash: h });
  assert.equal(d.classification, 'no_adverse_outcome', 'and it wins over the benefit-failure tick');
  assert.equal(d.matchedComplicationHash, null, 'the select was disabled; a stale value must not persist');
});

test('the vocabularies are exactly the PRD’s', () => {
  assert.deepEqual([...OUTCOME_SOURCES], ['complaint', 'readmission', 'revisit', 'reoperation', 'call', 'other']);
  assert.deepEqual([...OUTCOME_CLASSIFICATIONS], ['predicted_occurred', 'unpredicted_occurred', 'benefit_failure', 'no_adverse_outcome']);
  assert.ok(isOutcomeSource('readmission'));
  assert.ok(!isOutcomeSource('slack'));
  assert.ok(isOutcomeClassification('no_adverse_outcome'));
  assert.ok(!isOutcomeClassification('resolved'));
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §7.4 (pure half) · Supersede reading rules — the DB write is pinned in the store tests
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§7.4 currentRows: the default view shows only non-superseded rows; history shows all', () => {
  const rows = [
    { id: 1, superseded: true, classification: 'predicted_occurred' },
    { id: 2, superseded: false, classification: 'predicted_occurred' },
  ];
  assert.deepEqual(currentRows(rows).map((r) => r.id), [2], 'exactly one non-superseded row after a correction');
  assert.equal(rows.length, 2, 'the history toggle has both to show — nothing is deleted');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §7.6 (pure mirror) · The denominator rule the metrics view must implement
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§7.6 a document with no rows is not_followed_up and OUTSIDE the over-warning denominator', () => {
  assert.equal(followUpBucket([]), 'not_followed_up');
  assert.equal(inOverWarningDenominator([]), false);
});

test('§7.6 an event row alone follows the document up but does NOT admit it to the over-warning denominator', () => {
  const rows = [{ classification: 'predicted_occurred' as const, superseded: false }];
  assert.equal(followUpBucket(rows), 'followed_up');
  assert.equal(inOverWarningDenominator(rows), false,
    'one recorded event proves someone looked at ONE outcome, not that the rest never occurred');
});

test('§7.6 a no_adverse_outcome row admits the document; a superseded one does not', () => {
  assert.equal(inOverWarningDenominator([{ classification: 'no_adverse_outcome', superseded: false }]), true);
  assert.equal(inOverWarningDenominator([{ classification: 'no_adverse_outcome', superseded: true }]), false);
  assert.equal(followUpBucket([{ classification: 'no_adverse_outcome', superseded: true }]), 'not_followed_up',
    'a fully superseded history means nobody currently vouches for follow-up');
});

test('§7.6 no_adverse alongside an event row: followed up, in the denominator, both persist', () => {
  const rows = [
    { classification: 'predicted_occurred' as const, superseded: false },
    { classification: 'no_adverse_outcome' as const, superseded: false },
  ];
  assert.equal(followUpBucket(rows), 'followed_up');
  assert.equal(inOverWarningDenominator(rows), true);
});
