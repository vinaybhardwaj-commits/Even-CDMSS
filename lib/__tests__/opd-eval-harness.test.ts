// lib/__tests__/opd-eval-harness.test.ts — R-11 Stage 2 Phase 2 lab eval harness. Verifies the
// eval overrides (normative-leg force + OpenRouter generation) and, critically, that the production
// audit path is byte-identical with NO eval config. No DB / no network (fetch injected).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { opdRetrieveOpts, buildOpenRouterBody, openRouterGenerate, AUDIT_EVAL_THINKING_BUDGET } from '../opd-note-audit.ts';
import { AUDIT_LLM_SEED } from '../llm.ts';
import { parseBatchState, LB_KEYS } from '../lab-batch-core.ts';

const TODAY = { topK: 8, useReranker: true, useSourceWeights: true, hybrid: true };

// ── Test 1 — NO eval config ⇒ opdRetrieveOpts byte-identical to today (scoring-path guard) ──
test('no eval config ⇒ opdRetrieveOpts byte-identical to today', () => {
  assert.deepEqual(opdRetrieveOpts(false, {}), TODAY);
  assert.deepEqual(opdRetrieveOpts(false, {}, undefined), TODAY);
  assert.deepEqual(opdRetrieveOpts(true, {}, undefined), TODAY);
  assert.deepEqual(opdRetrieveOpts(false, { OPD_NORMATIVE_LEG_ENABLED: '0' }, undefined), TODAY);
  assert.deepEqual(opdRetrieveOpts(false, {}, false), TODAY);
  assert.ok(!('useNormativeLeg' in opdRetrieveOpts(false, {}, false)));
});

// ── Test 2 — evalNormativeLeg:true forces the leg on even on the mini path (bypasses !mini) ──
test('evalNormativeLeg:true ⇒ useNormativeLeg true regardless of mini / env', () => {
  assert.equal(opdRetrieveOpts(true, {}, true).useNormativeLeg, true);                              // mini + no env
  assert.equal(opdRetrieveOpts(true, { OPD_NORMATIVE_LEG_ENABLED: '0' }, true).useNormativeLeg, true); // mini + env off
  assert.equal(opdRetrieveOpts(false, {}, true).useNormativeLeg, true);
  assert.deepEqual(opdRetrieveOpts(true, {}, true), { ...TODAY, useNormativeLeg: true });
});

// ── Test 3 — evalModel routes to OpenRouter with the DETERMINISM config (Audit-Determinism §8d) ──
test('buildOpenRouterBody carries the eval determinism config: temp0 + top_p1 + seed + reasoning-pin + provider-pin', () => {
  const body = buildOpenRouterBody('google/gemini-2.5-pro', 'SYS', 'USR');
  assert.equal(body.model, 'google/gemini-2.5-pro');
  assert.deepEqual(body.messages, [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'USR' }]);
  assert.equal(body.temperature, 0, 'greedy');
  assert.equal(body.top_p, 1, 'canonical top_p');
  assert.equal(body.seed, AUDIT_LLM_SEED, 'fixed decode seed (lever 2)');
  assert.deepEqual(body.reasoning, { max_tokens: AUDIT_EVAL_THINKING_BUDGET }, 'pinned thinking budget (lever 3)');
  assert.deepEqual(body.provider, { allow_fallbacks: false, require_parameters: true }, 'provider-pin: no cross-backend fallback, seed-honoring provider only (lever 4)');
});

// ── Phase-1 guard: the PRODUCTION (non-eval) generate params must stay byte-identical (lab-only) ──
test('production defaultGenerate params are untouched — no seed/top_p/provider-pin leaked into the prod path', () => {
  const src = readFileSync('lib/opd-note-audit.ts', 'utf8');
  const from = src.indexOf('const isReasoning');
  const to = src.indexOf("promptRef: 'opd-note-audit-core/OPD_AUDIT_SYSTEM'");
  assert.ok(from >= 0 && to > from, 'located the production defaultGenerate params block');
  const prodBlock = src.slice(from, to);
  assert.ok(!/\bseed\b/.test(prodBlock), 'no decode seed in the production params (Phase 1 is lab-only)');
  assert.ok(!/allow_fallbacks|require_parameters|top_p|reasoning:/.test(prodBlock), 'no provider-pin / top_p / reasoning-pin in production params');
  assert.match(prodBlock, /temperature: isReasoning \? 0 : 0\.2/, 'production temperature policy unchanged (0.2 default)');
});

test('openRouterGenerate posts to the OpenRouter endpoint at temp 0 and returns the completion', async () => {
  const prev = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-key';
  try {
    let captured: { url: string; body: Record<string, unknown>; auth: string } | null = null;
    const fakeFetch = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
      captured = { url, body: JSON.parse(init.body), auth: init.headers.Authorization };
      return new Response(JSON.stringify({ choices: [{ message: { content: 'AUDIT-JSON' } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await openRouterGenerate('any/model-id', 'SYS', 'USR', fakeFetch);
    assert.equal(out, 'AUDIT-JSON');
    assert.equal(captured!.url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(captured!.body.temperature, 0);
    assert.equal(captured!.body.model, 'any/model-id');
    assert.equal(captured!.auth, 'Bearer test-key');
  } finally {
    if (prev === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = prev;
  }
});

test('openRouterGenerate throws (does not silently fall back) when the key is missing', async () => {
  const prev = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    await assert.rejects(openRouterGenerate('m', 's', 'u', (async () => new Response('', { status: 200 })) as unknown as typeof fetch),
      /OPENROUTER_API_KEY/);
  } finally {
    if (prev !== undefined) process.env.OPENROUTER_API_KEY = prev;
  }
});

// ── Test 4 — the eval path writes lab_analyses ONLY; it can never write opd_note_audits ──
test('the lab-batch eval path never writes opd_note_audits (structural guard)', () => {
  const src = readFileSync('lib/lab-batch.ts', 'utf8');
  assert.ok(src.includes('saveLabAnalysis'), 'the eval path must write via saveLabAnalysis (lab_analyses)');
  // the ONLY writers of opd_note_audits are saveOpdAudit / the opd-audit-store module — neither may appear
  assert.ok(!src.includes('saveOpdAudit'), 'the eval path must NOT call saveOpdAudit (the opd_note_audits writer)');
  assert.ok(!/opd-audit-store/.test(src), 'the eval path must not reach the opd_note_audits store module');
  assert.ok(!/INSERT\s+INTO\s+opd_note_audits/i.test(src), 'the eval path must not INSERT into opd_note_audits');
});

// ── batch state carries the eval config; absent ⇒ off/null (today's behaviour) ──
test('parseBatchState reads the eval config; absent ⇒ off / null', () => {
  const off = parseBatchState({});
  assert.equal(off.evalNormativeLeg, false);
  assert.equal(off.evalModel, null);
  const on = parseBatchState({ [LB_KEYS.evalNormativeLeg]: '1', [LB_KEYS.evalModel]: 'google/gemini-3.1-flash-lite' } as Record<string, string>);
  assert.equal(on.evalNormativeLeg, true);
  assert.equal(on.evalModel, 'google/gemini-3.1-flash-lite');
});
