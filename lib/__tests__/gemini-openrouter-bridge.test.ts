/**
 *   node --test --import tsx lib/__tests__/gemini-openrouter-bridge.test.ts
 *
 * Gemini-via-OpenRouter BRIDGE (30 Jul 2026) — temporary, flag-gated, retires when
 * aiplatform.googleapis.com is re-enabled on clinical-infra.
 *
 * Every Vertex call has 403d SERVICE_DISABLED since 26 Jul 12:50 UTC; 367 OPD audits were served
 * by qwen2.5:14b under a hardcoded 'gemini-2.5-pro' label (T-5). These tests pin: the flag gate
 * (unset ⇒ byte-identical), the two traps that WILL fire on the first call if unhandled
 * (A-12 reasoning-disable 400; token headroom), the Google provider pin, the central slug
 * derivation in both transports, and the worker's served-model column fix.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openrouterGeminiSlug, buildOpenrouterParams, OPENROUTER_GOOGLE_PROVIDER_PIN } from '../llm.ts';

const LLM = readFileSync('lib/llm.ts', 'utf8');
const TRACE = readFileSync('lib/trace.ts', 'utf8');
const WORKER = readFileSync('app/api/opd-audit/worker/route.ts', 'utf8');
const CHANGELOG = readFileSync('lib/opd-audit-changelog.ts', 'utf8');

function withFlag<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.GEMINI_VIA_OPENROUTER;
  if (value === undefined) delete process.env.GEMINI_VIA_OPENROUTER;
  else process.env.GEMINI_VIA_OPENROUTER = value;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.GEMINI_VIA_OPENROUTER;
    else process.env.GEMINI_VIA_OPENROUTER = prev;
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · The flag gate — unset is byte-identical to today
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('flag unset ⇒ undefined, ALWAYS — the bridge does not exist without GEMINI_VIA_OPENROUTER=1', () => {
  withFlag(undefined, () => {
    assert.equal(openrouterGeminiSlug('gemini-2.5-pro'), undefined);
    assert.equal(openrouterGeminiSlug('google/gemini-2.5-pro'), undefined);
  });
  withFlag('0', () => assert.equal(openrouterGeminiSlug('gemini-2.5-pro'), undefined));
  withFlag('true', () => assert.equal(openrouterGeminiSlug('gemini-2.5-pro'), undefined, "only the exact string '1' opens the bridge"));
});

test('flag=1 ⇒ the OpenRouter slug, google/-prefixed exactly once; no model ⇒ undefined', () => {
  withFlag('1', () => {
    assert.equal(openrouterGeminiSlug('gemini-2.5-pro'), 'google/gemini-2.5-pro');
    assert.equal(openrouterGeminiSlug('gemini-2.5-flash'), 'google/gemini-2.5-flash');
    assert.equal(openrouterGeminiSlug('google/gemini-2.5-pro'), 'google/gemini-2.5-pro', 'already-prefixed passes through');
    assert.equal(openrouterGeminiSlug(undefined), undefined);
    assert.equal(openrouterGeminiSlug(''), undefined);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · Trap 1 (A-12) — Gemini 2.5 cannot disable thinking
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('trap 1: a Gemini slug NEVER receives reasoning:{enabled:false} — the A-12 400 destroyed a diagnosis for 36h', () => {
  const p = buildOpenrouterParams('google/gemini-2.5-pro', { messages: [], max_tokens: 900 });
  assert.ok(!('reasoning' in p), 'no reasoning key at all — absent, not enabled:true');
});

test('trap 1 control: a NON-Gemini slug reproduces the pre-bridge behaviour byte-for-byte', () => {
  const p = buildOpenrouterParams('qwen/qwen3-32b', { messages: [], max_tokens: 700 });
  assert.deepEqual(p.reasoning, { enabled: false }, 'the critic bounded-verdict default holds');
  assert.equal(p.max_tokens, 700, 'no headroom added');
  assert.ok(!('provider' in p), 'no pin on non-Gemini slugs');
  const own = buildOpenrouterParams('qwen/qwen3-32b', { messages: [], reasoning: { enabled: true } });
  assert.deepEqual(own.reasoning, { enabled: true }, 'a caller-supplied reasoning always wins');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · Trap 2 — token headroom, same +8192 the Vertex branch applies
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('trap 2: a Gemini slug gets baseMax + 8192 — Pro spends output budget on reasoning FIRST', () => {
  assert.equal(buildOpenrouterParams('google/gemini-2.5-pro', { max_tokens: 2200 }).max_tokens, 2200 + 8192);
  assert.equal(buildOpenrouterParams('google/gemini-2.5-pro', {}).max_tokens, 1024 + 8192, 'default base 1024, same as the Vertex branch');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4 · The Google provider pin
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the pin: Google-operated providers only, no fallbacks — slugs read off the endpoints listing 30 Jul 2026', () => {
  assert.deepEqual(OPENROUTER_GOOGLE_PROVIDER_PIN, { allow_fallbacks: false, only: ['google-vertex', 'google-ai-studio'] });
  const p = buildOpenrouterParams('google/gemini-2.5-pro', {});
  assert.deepEqual(p.provider, OPENROUTER_GOOGLE_PROVIDER_PIN, 'every Gemini-slug request carries it');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5 · Central derivation — no call site can be missed; explicit openrouter always wins
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('both transports derive the slug centrally; a caller-supplied openrouter slug takes precedence', () => {
  assert.ok(LLM.includes('const orModel = openrouterModel || openrouterGeminiSlug(geminiModel);'), 'chatWithFallback');
  assert.ok(TRACE.includes('const orSlug = opts?.openrouter || openrouterGeminiSlug(opts?.gemini);'), 'tracedChat');
  assert.ok(TRACE.includes('const orParams = buildOpenrouterParams(orSlug as string, rest as Record<string, unknown>);'));
  assert.ok(LLM.includes('const orParams = buildOpenrouterParams(orModel, rest as Record<string, unknown>);'));
});

test('the Ollama last-leg fallback is untouched in both transports', () => {
  assert.equal((LLM.match(/return llm\.chat\.completions\.create\(params\);/g) || []).length, 3, 'chatWithFallback: both provider catches + the default path');
  assert.ok(TRACE.includes("runOllamaFallback('openrouter', servedModel, oe, () => llm.chat.completions.create(params))"));
  assert.ok(TRACE.includes("runOllamaFallback('gemini', servedModel, ge, () => llm.chat.completions.create(params))"));
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 6 · Commit 2 (T-5) — the worker records what actually SERVED
// ═════════════════════════════════════════════════════════════════════════════════════════════

test("T-5: the hardcoded 'gemini-2.5-pro' literal is GONE from the worker — it hid this incident for four days", () => {
  assert.ok(!WORKER.includes("model: 'gemini-2.5-pro'"), 'no literal remains');
  assert.equal((WORKER.match(/servedModelFor\(audit\.traceId\)/g) || []).length, 2, 'both save sites derive from the served trace');
});

test('T-5: servedModelFor reads the POST-fallback model from the audit trace, null when unknown', () => {
  assert.ok(WORKER.includes("kind IN ('llm_response', 'llm_stream_usage')"));
  assert.ok(WORKER.includes("stage = 'opd_audit_analyze'"), 'the main audit leg, not an incidental call');
  assert.ok(WORKER.includes('if (!traceId) return null;'));
  assert.ok(WORKER.includes('catch { return null; }'), 'an honest gap, never a guess — and never a failed audit');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 7 · The changelog carries the step-change warning in the same commit
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('changelog: the bridge entry exists, scoring:false, and names the step change as a provider restoration', () => {
  assert.ok(CHANGELOG.includes('GEMINI_VIA_OPENROUTER=1'));
  assert.ok(CHANGELOG.includes('Expect the scores to take a visible step'));
  assert.ok(CHANGELOG.includes('RESTORATION of the intended provider, not a recalibration'));
  const entry = CHANGELOG.slice(CHANGELOG.indexOf('Gemini via OpenRouter'), CHANGELOG.indexOf('Nightly OPD audit worker'));
  assert.ok(entry.length > 0, 'entry sits newest-first, above the cron entry');
});
