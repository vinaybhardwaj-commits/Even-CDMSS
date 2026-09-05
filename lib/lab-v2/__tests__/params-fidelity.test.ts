/**
 * LAB-MCP-V2 decision 23 — the lab transport must send the SAME request body production sends.
 *
 * WHY THIS FILE EXISTS. Live run `1716bbe2` (one OPD note, Vertex gemini-2.5-pro) came back
 * execution_status succeeded, attribution verified, 13,904 microusd charged, five retrieval
 * sources — and zero findings, `llmLegFailed: true`. The cause was not the engine and not the
 * fence: `governedLabChat`'s vertex branch sent the engine's RAW params, while production's
 * `tracedChat` vertex branch first strips the Ollama-only fields and, because Gemini 2.5 Pro
 * spends output tokens on thinking BEFORE it writes any content, raises `max_tokens` by 8192.
 * The lab therefore asked a thinking model for 2,200 output tokens with a 4,096-token thinking
 * budget. It thought, ran out, returned empty content, and billed for it. The S0 retry did it
 * again. Everything downstream reported success, because every one of those signals was true.
 *
 * A test that stubs the ENGINE cannot catch this, and a test that asserts the lab "calls the
 * shared helper" only catches it while the helper is shared. So this captures the actual wire
 * body from both paths and demands they be deep-equal. It is the only shape of test that fails
 * when the two transports drift, which is the failure that actually happened.
 *
 * The stub is `globalThis.fetch`, which sits below the OpenAI SDK: what it records is the JSON
 * that would have gone to Vertex. The Vertex token mint is a fetch too, so one stub serves both
 * hops; the service-account key is a throwaway RSA pair generated here, so the JWT signs for
 * real and nothing leaves the process.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
// ⚠️ FIRST. Installs the fetch stub and the Vertex env before the OpenAI SDK shim and
// lib/llm.ts are loaded. See that file for why neither can be done afterwards.
import { setFetchHandler } from './fetch-stub';
import { tracedChat, governedLabChat } from '../../trace';

const MODEL = 'gemini-2.5-pro';
const OR_SLUG = 'google/gemini-2.5-pro';

/** The params object `defaultGenerate` builds for the gemini path (lib/opd-note-audit.ts:1082). */
function auditParams() {
  return {
    model: 'qwen2.5:14b',
    messages: [
      { role: 'system', content: 'SYSTEM' },
      { role: 'user', content: 'USER' },
    ],
    temperature: 0,
    max_tokens: 2200,
    options: { num_ctx: 8192 },
    keep_alive: '15m',
    seed: 42,
    top_p: 1,
    google: { thinking_config: { thinking_budget: 4096 } },
  };
}

interface Captured { url: string; body: Record<string, unknown> }

/** Run `fn` with fetch stubbed; return every non-token request body it produced. */
async function capture(fn: () => Promise<unknown>): Promise<Captured[]> {
  const seen: Captured[] = [];
  const previous = setFetchHandler(async (url, init) => {
    // Hop 1: the Vertex OAuth token mint. Serve a token so the client can be constructed.
    if (url.includes('oauth2.googleapis.com') || url.endsWith('/token')) {
      return new Response(JSON.stringify({ access_token: 'test-token', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    // Hop 2: the completion. THIS is the body under test.
    seen.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response(JSON.stringify({
      id: 'test', object: 'chat.completion', created: 0, model: OR_SLUG,
      choices: [{ index: 0, message: { role: 'assistant', content: '{"findings":[]}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  try { await fn(); } finally { setFetchHandler(previous); }
  return seen;
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
  return fn().then((r) => { restore(); return r; }, (e) => { restore(); throw e; });
}

function throwawaySaKey(): string {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return JSON.stringify({
    client_email: 'lab-v2-test@example.iam.gserviceaccount.com',
    private_key: privateKey,
    token_uri: 'https://oauth2.googleapis.com/token',
  });
}

// ── vertex ───────────────────────────────────────────────────────────────────────────
const VERTEX_ENV = {
  GCP_SA_KEY: throwawaySaKey(),
  // OpenRouter OFF, so the cloud ladder is Vertex alone and nothing else can serve the call.
  OPENROUTER_API_KEY: undefined,
  GEMINI_VIA_OPENROUTER: undefined,
  LLM_PIPELINE: undefined,
};

test('decision 23: governedLabChat sends the vertex body tracedChat sends, field for field', async () => {
  const production = await withEnv(VERTEX_ENV, () =>
    capture(() => tracedChat('test-trace', 'opd_audit_analyze', auditParams(), { gemini: MODEL, timeoutMs: 380_000, maxTries: 1 })));
  const lab = await withEnv(VERTEX_ENV, () =>
    capture(() => governedLabChat('vertex', MODEL, auditParams(), 380_000)));

  assert.equal(production.length, 1, 'production issued exactly one completion request');
  assert.equal(lab.length, 1, 'the lab issued exactly one completion request');

  // The whole point: the two bodies must be indistinguishable.
  assert.deepEqual(lab[0].body, production[0].body);
});

test('decision 23: and that shared body is the NORMALISED one, not the engine\'s raw params', async () => {
  const [captured] = await withEnv(VERTEX_ENV, () =>
    capture(() => governedLabChat('vertex', MODEL, auditParams(), 380_000)));
  const body = captured.body;

  // The defect, stated as an assertion. 2200 + 8192: Gemini 2.5 Pro spends output tokens on
  // thinking first, so the engine's Ollama-tuned cap left nothing for the JSON answer.
  assert.equal(body.max_tokens, 10_392, 'the +8192 thinking headroom must be present');

  // Vertex rejects unknown fields; these two are Ollama-only and must be stripped.
  assert.equal('options' in body, false, 'options (num_ctx) must not reach Vertex');
  assert.equal('keep_alive' in body, false, 'keep_alive must not reach Vertex');

  // Everything the engine meant to send survives, including the thinking budget.
  assert.equal(body.model, 'google/gemini-2.5-pro', 'publisher-prefixed');
  assert.equal(body.temperature, 0);
  assert.equal(body.seed, 42);
  assert.equal(body.top_p, 1);
  assert.deepEqual(body.google, { thinking_config: { thinking_budget: 4096 } });
  assert.equal((body.messages as unknown[]).length, 2);
});

// ── openrouter ───────────────────────────────────────────────────────────────────────
const OR_ENV = {
  OPENROUTER_API_KEY: 'test-or-key',
  OPENROUTER_BASE_URL: 'https://openrouter.test/api/v1',
  // Vertex OFF (no SA key), so the ladder is OpenRouter alone.
  GCP_SA_KEY: undefined,
  GEMINI_VIA_OPENROUTER: undefined,
  LLM_PIPELINE: undefined,
};

test('decision 23: the openrouter bodies match too (they already shared buildOpenrouterParams)', async () => {
  const production = await withEnv(OR_ENV, () =>
    capture(() => tracedChat('test-trace', 'opd_audit_analyze', auditParams(), { openrouter: OR_SLUG, timeoutMs: 380_000, maxTries: 1 })));
  const lab = await withEnv(OR_ENV, () =>
    capture(() => governedLabChat('openrouter', OR_SLUG, auditParams(), 380_000)));

  assert.equal(production.length, 1);
  assert.equal(lab.length, 1);
  assert.deepEqual(lab[0].body, production[0].body);
  // This path was already correct — both sides route through buildOpenrouterParams — and the
  // test is here so a future edit cannot quietly break the branch that was never broken.
  assert.equal('options' in lab[0].body, false);
  assert.equal('keep_alive' in lab[0].body, false);
});
