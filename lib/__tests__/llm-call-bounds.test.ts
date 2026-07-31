/**
 * lib/__tests__/llm-call-bounds.test.ts — D-1 (Right Care reliability §3, 31 Jul 2026):
 * bound every provider call.
 *
 *   node --test --import tsx lib/__tests__/llm-call-bounds.test.ts
 *
 * Kickoff §Tests 1–5. The constants are module-level env reads, so the matrix runs against the
 * exported pure resolvers (the resolveEnvRerankBackend pattern, ratified in Addendum B) and the
 * client constructions are pinned at the source. Test 5 is FUNCTIONAL: a local HTTP server that
 * accepts and never responds proves the ceiling fires, surfaces as a normal Error, and that
 * maxRetries 0 means exactly one wire call.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import OpenAI from 'openai';
import {
  resolveLlmTimeoutMs, resolveLlmMaxRetries,
  LLM_CALL_TIMEOUT_MS, LLM_MAX_RETRIES, LLM_AUDIT_TIMEOUT_MS,
} from '../llm.ts';

// ── §T1 — defaults, asserted not assumed (env unset in the test run) ──
test('T1: defaults are 90000 / 0 / 600000', () => {
  assert.equal(process.env.LLM_CALL_TIMEOUT_MS, undefined, 'precondition: env unset in tests');
  assert.equal(process.env.LLM_MAX_RETRIES, undefined, 'precondition: env unset in tests');
  assert.equal(process.env.LLM_AUDIT_TIMEOUT_MS, undefined, 'precondition: env unset in tests');
  assert.equal(LLM_CALL_TIMEOUT_MS, 90_000);
  assert.equal(LLM_MAX_RETRIES, 0);
  assert.equal(LLM_AUDIT_TIMEOUT_MS, 600_000);
});

// ── §T2 — env-overridable; non-numeric falls back, never NaN ──
test('T2: resolvers honour numeric overrides and fall back on garbage', () => {
  assert.equal(resolveLlmTimeoutMs('120000', 90_000), 120_000);
  assert.equal(resolveLlmTimeoutMs('45000.9', 90_000), 45_000);
  for (const bad of [undefined, '', 'abc', '0', '-5', 'NaN']) {
    const r = resolveLlmTimeoutMs(bad, 90_000);
    assert.equal(r, 90_000, `timeout ${JSON.stringify(bad)} must fall back, got ${r}`);
    assert.ok(Number.isFinite(r), 'never NaN');
  }
  assert.equal(resolveLlmMaxRetries('2'), 2);
  assert.equal(resolveLlmMaxRetries('1.7'), 1);
  assert.equal(resolveLlmMaxRetries('0'), 0);
  for (const bad of [undefined, '', 'abc', '-1']) {
    const r = resolveLlmMaxRetries(bad);
    assert.equal(r, 0, `retries ${JSON.stringify(bad)} must fall back to 0, got ${r}`);
    assert.ok(Number.isFinite(r), 'never NaN');
  }
});

// ── §T3 — all three clients constructed with explicit timeout + maxRetries ──
test('T3: every new OpenAI(...) in lib/llm.ts carries timeout + maxRetries', () => {
  const src = readFileSync('lib/llm.ts', 'utf8');
  const constructions = src.match(/new OpenAI\(\{[^}]*\}\)/gs) ?? [];
  assert.equal(constructions.length, 3, 'exactly the three known clients (ollama, openrouter, vertex)');
  for (const c of constructions) {
    assert.ok(c.includes('timeout: LLM_CALL_TIMEOUT_MS'), `construction missing explicit timeout: ${c.slice(0, 80)}…`);
    assert.ok(c.includes('maxRetries: LLM_MAX_RETRIES'), `construction missing explicit maxRetries: ${c.slice(0, 80)}…`);
  }
});

// ── §T4 — THE REGRESSION GUARD: the audit's effective ceiling is the 600 s override, not 90 s ──
test('T4: the audit call site passes LLM_AUDIT_TIMEOUT_MS and it clears the measured p75', () => {
  // Budget arithmetic: p75 is 425 s; the audit ceiling must clear it with margin and must be the
  // value the call site actually passes. 90 s would break the engine — assert the ordering.
  assert.ok(LLM_AUDIT_TIMEOUT_MS >= 425_000 + 60_000, 'audit ceiling must clear p75 (425 s) with margin');
  assert.ok(LLM_AUDIT_TIMEOUT_MS > LLM_CALL_TIMEOUT_MS, 'the audit override must exceed the general ceiling');

  // The audit's provider call names the override at the call site:
  const audit = readFileSync('lib/opd-note-audit.ts', 'utf8');
  assert.match(audit, /governedChat\(traceId, 'opd_audit_analyze', params, \{[^}]*timeoutMs: LLM_AUDIT_TIMEOUT_MS/s,
    'opd_audit_analyze must pass timeoutMs: LLM_AUDIT_TIMEOUT_MS');

  // …and the plumbing actually applies it as per-request { timeout } on every non-wrapper branch.
  const trace = readFileSync('lib/trace.ts', 'utf8');
  assert.ok(trace.includes("const reqOpts = opts?.timeoutMs ? { timeout: opts.timeoutMs } : undefined;"),
    'tracedChat must build per-request options from timeoutMs');
  assert.equal((trace.match(/completions\.create\((?:gParams|params)[^)]*, reqOpts\)/g) ?? []).length, 5,
    'tracedChat: gemini ×2 (stream_options retry twin) + ollama main + both fallback closures');
  assert.ok(trace.includes('return chatWithFallback(params, opts?.gemini, opts?.openrouter, opts?.timeoutMs);'),
    'governedChat must forward the ceiling on the TRACELESS path too (the lab runs trace:false)');
  const llmSrc = readFileSync('lib/llm.ts', 'utf8');
  assert.equal((llmSrc.match(/completions\.create\((?:gParams|params)[^)]*, reqOpts\)/g) ?? []).length, 4,
    'chatWithFallback: gemini + no-gemini ollama + both fallback returns');
});

// ── §T5 — a call exceeding its ceiling surfaces as a NORMAL error, once, and fast ──
test('T5: timeout fires as a catchable Error after exactly one wire call (maxRetries 0)', async () => {
  let hits = 0;
  const server = createServer((_req, _res) => { hits++; /* accept and never respond */ });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  try {
    const client = new OpenAI({ baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'x', timeout: 300, maxRetries: 0 });
    const t0 = Date.now();
    let caught: unknown = null;
    try {
      await client.chat.completions.create({ model: 'm', messages: [{ role: 'user', content: 'q' }] });
    } catch (e) { caught = e; }
    const elapsed = Date.now() - t0;
    assert.ok(caught instanceof Error, 'the ceiling must surface as a normal Error (soft-fail catchable)');
    assert.match(`${(caught as Error).name} ${(caught as Error).message} ${(caught as Error).constructor.name}`,
      /timed out|timeout|abort/i, `expected a timeout-class error, got ${(caught as Error).constructor.name}: ${(caught as Error).message}`);
    assert.ok(elapsed < 5_000, `must fail fast (took ${elapsed}ms)`);
    assert.equal(hits, 1, 'maxRetries 0 ⇒ exactly one wire call — no blind SDK retries');
  } finally {
    server.close();
  }
});
