// LAB-MCP-V2 §6.3 + the kickoff's SQL/SCHEMA HONESTY clause.
//
// The honest answer to "list every inferred SQL string" turned out to be "there are none":
// lib/lab-v2/sources/opd.ts writes no SQL at all. It freezes its inputs by calling the
// live production readers — `fetchOpdNoteByUid` and `fetchPatientHistoryBundle` for db13,
// and the audit engine's own `getLvcRules` and `doctorSpecialtyFor` for production Neon.
// These tests hold that property in place, because the moment a query is copied into the
// lab it can drift from the one the engine actually runs, and a frozen input that differs
// from what production would have read is a silently wrong experiment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PRICING_VERSION, costMicrousd, isSupportedModel, modelsFor, priceFor } from '../pricing';
import { canonicalJson, hash } from '../contracts';

test('sources/opd.ts contains NO SQL of its own — every input comes from a live reader', () => {
  const src = readFileSync('lib/lab-v2/sources/opd.ts', 'utf8');
  assert.ok(src.includes('fetchOpdNoteByUid'), 'the note comes from the existing db13 reader');
  assert.ok(src.includes('fetchPatientHistoryBundle'), 'complexity comes from the existing db13 reader');
  assert.ok(src.includes('getLvcRules'), 'the rule snapshot comes from the engine\'s own reader');
  assert.ok(src.includes('doctorSpecialtyFor'), 'the specialty comes from the engine\'s own reader');
  // Not one statement-shaped literal anywhere in the file.
  assert.ok(!/\b(SELECT|INSERT|UPDATE|DELETE)\s+[\w"*]/i.test(src), 'no SQL may be written in the lab source layer');
});

test('the engine still owns the two production-Neon queries, and exports its readers', () => {
  const engine = readFileSync('lib/opd-note-audit.ts', 'utf8');
  assert.ok(engine.includes("SELECT id, keywords, category FROM lvc_recommendations WHERE status = 'active'"));
  assert.ok(engine.includes('SELECT doctor_uid, speciality FROM doctor_directory WHERE speciality IS NOT NULL'));
  assert.ok(/export async function getLvcRules/.test(engine), 'the lab freezes by calling this');
  assert.ok(/export async function doctorSpecialtyFor/.test(engine), 'and this');
});

// ── §6.3 pricing ─────────────────────────────────────────────────────────────────────
test('§6.3: cost is integer microusd, floored on both legs', () => {
  // Haiku 4.5: $1/M in, $5/M out → 1e6 and 5e6 microusd per million tokens.
  const model = 'global.anthropic.claude-haiku-4-5-20251001-v1:0';
  assert.equal(costMicrousd('bedrock', model, 1_000_000, 0), 1_000_000);
  assert.equal(costMicrousd('bedrock', model, 0, 1_000_000), 5_000_000);
  assert.equal(costMicrousd('bedrock', model, 1500, 300), Math.floor(1500) + Math.floor(1500));
  // No float ever reaches a budget row.
  assert.ok(Number.isInteger(costMicrousd('bedrock', model, 1234, 567)!));
});

test('§6.3: local execution is free and an unpriced model is null, never guessed', () => {
  assert.equal(costMicrousd('ollama', 'anything-at-all', 999_999, 999_999), 0);
  assert.equal(priceFor('openrouter', 'a-model-nobody-priced'), null);
  assert.equal(costMicrousd('openrouter', 'a-model-nobody-priced', 100, 100), null);
  assert.equal(isSupportedModel('openrouter', 'a-model-nobody-priced'), false);
  assert.ok(isSupportedModel('bedrock', 'global.anthropic.claude-haiku-4-5-20251001-v1:0'));
});

test('§6.1: model_capabilities advertises only priced targets', () => {
  for (const m of modelsFor('bedrock')) assert.ok(isSupportedModel('bedrock', m));
  assert.ok(modelsFor('bedrock').length >= 3);
  assert.ok(PRICING_VERSION.startsWith('lab-v2-pricing/'), 'the version is bumped whenever a rate moves');
});

// ── §4.1 object identity ─────────────────────────────────────────────────────────────
test('§4.1: canonical JSON sorts keys at every depth so the same body is the same hash', () => {
  const a = { b: 1, a: { d: [3, 2, 1], c: 'x' } };
  const b = { a: { c: 'x', d: [3, 2, 1] }, b: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(hash(a), hash(b));
  // Array ORDER is meaningful (a dataset's case list, an experiment's arm list) and is preserved.
  assert.notEqual(hash({ x: [1, 2] }), hash({ x: [2, 1] }));
});
