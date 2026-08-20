// lib/__tests__/lvp-core.test.ts — Low-value patterns L1 pure core (LVP-L1 kickoff §4.3, O3, O10,
// acceptance 7 + 8). Pure — no DB, no LLM, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LVP_CAP, LVP_FLOOR, conceptIdFromPatternId, formatDisplayDate, parseConceptId, patternIdFor,
  patternTitle, shelveSuggestions, statusPill, stripIdentifiers, whyText,
} from '../lvp-core';

// ── concept-id parsing + stable id ──────────────────────────────────────────────────────────────
test('parseConceptId splits direction:action:target; target keeps spaces and extra colons verbatim', () => {
  assert.deepEqual(parseConceptId('overuse:rx:antibiotic'), { direction: 'overuse', action: 'rx', target: 'antibiotic' });
  assert.deepEqual(
    parseConceptId('documentation:documentation:diagnosis-complaint concordance'),
    { direction: 'documentation', action: 'documentation', target: 'diagnosis-complaint concordance' },
  );
  assert.deepEqual(parseConceptId('overuse:rx:vitamin d: high dose'), { direction: 'overuse', action: 'rx', target: 'vitamin d: high dose' });
});

test('patternIdFor is pattern:{concept_id} verbatim, even with spaces', () => {
  const cid = 'documentation:documentation:diagnosis-complaint concordance';
  assert.equal(patternIdFor(cid), `pattern:${cid}`);
  assert.equal(conceptIdFromPatternId(patternIdFor(cid)), cid);
  assert.equal(conceptIdFromPatternId('not-a-pattern'), null);
});

// ── the exact stub title table (§4.3) ───────────────────────────────────────────────────────────
test('stub title templates — the exact table, sentence-cased', () => {
  assert.equal(patternTitle({ direction: 'overuse', action: 'rx', target: 'antibiotic' }), 'Possible overuse: antibiotic prescriptions');
  assert.equal(patternTitle({ direction: 'overuse', action: 'duplication', target: 'pantoprazole' }), 'Duplicate therapy: pantoprazole');
  assert.equal(patternTitle({ direction: 'overuse', action: 'investigation', target: 'vitamin D assay' }), 'Low-value investigation: vitamin D assay');
  assert.equal(patternTitle({ direction: 'overuse', action: 'investigations', target: 'thyroid panel' }), 'Low-value investigation: thyroid panel');
  assert.equal(patternTitle({ direction: 'overuse', action: 'combo_rx', target: 'aceclofenac+serratiopeptidase' }), 'Fixed-dose combination: aceclofenac+serratiopeptidase');
  assert.equal(patternTitle({ direction: 'overuse', action: 'polypharmacy', target: '6+ molecules' }), 'Polypharmacy: 6+ molecules');
  assert.equal(patternTitle({ direction: 'documentation', action: 'documentation', target: 'diagnosis-complaint concordance' }), 'Not documented: diagnosis-complaint concordance');
  assert.equal(patternTitle({ direction: 'process', action: 'recording', target: 'follow-up interval' }), 'Not recorded: follow-up interval');
  assert.equal(patternTitle({ direction: 'underuse', action: 'rx', target: 'statin in diabetes' }), 'Possible underuse: statin in diabetes');
  // fallback: {action}: {target}, sentence-cased
  assert.equal(patternTitle({ direction: 'overuse', action: 'novel_action', target: 'x' }), 'Novel_action: x');
  assert.equal(patternTitle({ direction: 'mystery', action: 'act', target: 'y' }), 'Act: y');
});

test('status pill: overuse → not a ding; other directions → probably not overuse', () => {
  assert.equal(statusPill('overuse'), 'not a ding');
  assert.equal(statusPill('documentation'), 'probably not overuse');
  assert.equal(statusPill('process'), 'probably not overuse');
  assert.equal(statusPill('underuse'), 'probably not overuse');
});

test('whyText is the stub sentence — a count, not an argument', () => {
  const w = whyText(101, 'overuse:rx:antibiotic');
  assert.ok(w.includes('grouped 101 similar low-value findings'));
  assert.ok(w.includes('`overuse:rx:antibiotic`'));
  assert.ok(w.includes('This is a count, not an argument.'));
  assert.ok(w.includes('L2 operator'));
});

// ── de-id strip (O10, acceptance 7) ─────────────────────────────────────────────────────────────
test('strip: a 10-digit mobile number is removed', () => {
  assert.equal(stripIdentifiers('call 9876543210 for reports'), 'call [number] for reports');
  assert.equal(stripIdentifiers('reach at +91 9876543210 today'), 'reach at [number] today');
});

test('strip: a UH-shaped id is removed', () => {
  assert.equal(stripIdentifiers('patient UH-2024-00123 reviewed'), 'patient [id] reviewed');
  assert.equal(stripIdentifiers('UHID 44821 on file'), '[id] on file');
});

test('strip: an email is removed', () => {
  assert.equal(stripIdentifiers('sent to vinay.bhardwaj@example.in yesterday'), 'sent to [email] yesterday');
});

test('strip: clinical text without identifiers passes through unchanged', () => {
  const s = 'Etoricoxib 90mg prescribed for viral fever without documented indication';
  assert.equal(stripIdentifiers(s), s);
});

// ── shelving: overuse-first, floor, cap (O3, acceptance 8) ──────────────────────────────────────
const card = (direction: string, volume_week: number, id: string) => ({ direction, volume_week, id });

test('shelve: a documentation kind outranking overuse kinds by volume still sorts AFTER them', () => {
  const rows = [
    card('documentation', 50, 'doc-big'),      // outranks every overuse card by volume
    card('overuse', 43, 'etoricoxib'),
    card('overuse', 101, 'antibiotic'),
    card('process', 12, 'proc'),
    card('overuse', 11, 'montelukast'),
    card('underuse', 9, 'under'),
  ];
  assert.deepEqual(shelveSuggestions(rows).map((r) => r.id), [
    'antibiotic', 'etoricoxib', 'montelukast',  // overuse first, by volume desc
    'doc-big', 'proc', 'under',                 // then the rest, by volume desc
  ]);
});

test('shelve: floor — volume_week below 5 never makes the shelf', () => {
  const rows = [card('overuse', 5, 'at-floor'), card('overuse', 4, 'below'), card('documentation', 4, 'doc-below')];
  assert.deepEqual(shelveSuggestions(rows).map((r) => r.id), ['at-floor']);
  assert.equal(LVP_FLOOR, 5);
});

test('shelve: cap — never more than 23 cards', () => {
  const rows = Array.from({ length: 40 }, (_, i) => card(i % 2 ? 'overuse' : 'process', 100 - i, `c${i}`));
  const out = shelveSuggestions(rows);
  assert.equal(out.length, 23);
  assert.equal(LVP_CAP, 23);
  // every overuse card admitted before any non-overuse card
  const firstNonOveruse = out.findIndex((r) => r.direction !== 'overuse');
  assert.ok(out.slice(0, firstNonOveruse).every((r) => r.direction === 'overuse'));
});

// ── date display ────────────────────────────────────────────────────────────────────────────────
test('formatDisplayDate: YYYY-MM-DD → plain clinical English; null/garbage → null', () => {
  assert.equal(formatDisplayDate('2026-07-12'), '12 Jul 2026');
  assert.equal(formatDisplayDate('2026-08-01'), '1 Aug 2026');
  assert.equal(formatDisplayDate(null), null);
  assert.equal(formatDisplayDate('not-a-date'), null);
});
