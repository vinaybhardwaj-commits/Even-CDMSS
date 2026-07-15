// Inquiry K1 — inquiry-eval-core (PRD §15): scorer determinism; the baseline harness runs on the
// 2 shipped fixture cases (placeholder:true — real gold lands via V ratification, D13).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseGold, scoreCase, aggregateScores, subjectMatches, isGenericQuestion, INQUIRY_GOLD_VERSION } from '../inquiry/inquiry-eval-core';
import { buildAskSet } from '../care-call-core';
import { deriveUnknowns } from '../inquiry/unknowns-core';
import { candidatesFromUnknowns } from '../inquiry/inquiry-core';
import type { DeidOpdCase } from '../opd-ingest-core';

const GOLD = JSON.parse(readFileSync(join(process.cwd(), 'data/inquiry-eval/inquiry-gold-1.0.json'), 'utf8'));

test('scorer is deterministic and the metric arithmetic is exact', () => {
  const bank = parseGold(GOLD);
  assert.equal(bank.version, INQUIRY_GOLD_VERSION);
  const c = bank.cases[0];
  const served = { asks: [{ id: 'MED_STATUS:insulin-glargine-lantus-100-iu-ml', family: 'MED_STATUS' as const, subject: 'Insulin glargine (Lantus 100 IU/ml)', question: 'Doctor prescribed Insulin glargine — are you taking it?' }], source: 'inquiry' };
  const a = scoreCase(c, served);
  const b = scoreCase(c, served);
  assert.deepEqual(a, b, 'double-scoring is identical');
  assert.equal(a.rightFirst, true);
  assert.equal(a.familyLegal, true);
  const agg = aggregateScores([
    { caseId: 'x', rightFirst: true, familyLegal: true, askCount: 4, genericCount: 1, fallback: false },
    { caseId: 'y', rightFirst: false, familyLegal: true, askCount: 4, genericCount: 0, fallback: true },
  ]);
  assert.equal(agg.runs, 2);
  assert.equal(agg.rightFirstRate, 0.5);
  assert.equal(agg.familyLegalityRate, 1);
  assert.equal(agg.genericRate, 0.125);
  assert.equal(agg.fallbackRate, 0.5);
  // matching primitives
  assert.ok(subjectMatches('Insulin glargine', 'Insulin glargine (Lantus 100 IU/ml)'));
  assert.equal(subjectMatches('Telmisartan', 'Atorvastatin'), false);
  assert.ok(isGenericQuestion({ subject: 'knee pain', question: 'How are you doing overall?' }));
  assert.equal(isGenericQuestion({ subject: 'knee pain', question: 'How is the knee pain today?' }), false);
});

test('baseline harness runs on the 2 shipped fixture cases (deterministic arm, no LLM)', () => {
  const bank = parseGold(GOLD);
  assert.equal(bank.cases.length, 2);
  assert.ok(bank.cases.every((c) => c.placeholder === true), 'shipped cases are placeholders — real gold is V-ratified');
  const scores = bank.cases.map((c) => {
    const episode = c.fixture.episode as unknown as DeidOpdCase;
    const served = buildAskSet(episode, c.fixture.keys);
    // the fixtures also exercise the derivation + candidate layers end-to-end
    const unknowns = deriveUnknowns({ episode, snapshot: (c.fixture.snapshot ?? null) as never, now: c.fixture.now });
    const cands = candidatesFromUnknowns(unknowns, episode, c.fixture.keys);
    assert.ok(cands.length >= served.asks.length, `${c.id}: candidates ⊇ baseline`);
    return scoreCase(c, { asks: served.asks, source: 'baseline' });
  });
  const agg = aggregateScores(scores);
  assert.equal(agg.runs, 2);
  assert.equal(agg.familyLegalityRate, 1, 'baseline family-legality 100% on fixtures');
  // PL01 baseline leads with the high-alert insulin (right first); PL02's baseline leads with the
  // follow-up (ask-set/0.1 §3.3 order) — the med-contradiction-first expectation is exactly what
  // the inquiry arm exists to beat.
  assert.equal(scores[0].rightFirst, true);
  assert.equal(scores[1].rightFirst, false);
  assert.equal(agg.fallbackRate, 0);
});
