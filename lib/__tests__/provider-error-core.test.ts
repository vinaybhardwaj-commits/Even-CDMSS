/**
 *   node --test --import tsx lib/__tests__/provider-error-core.test.ts
 *
 * 403-diagnosis kickoff (30 Jul 2026) — observability only, no behaviour change.
 *
 * MEASURED defect: the only record of a Vertex failure was String(e.message).slice(0, 200) into
 * a console.warn nothing reads, then a silent Ollama fallback returning 200. The 403 body's
 * error.status / error.message / error.details[] — the IAM-vs-quota discriminator — was
 * truncated away. These tests pin the full-capture serialiser, the in-flight accounting that
 * makes the §3 load-correlation hypothesis falsifiable, and the wiring in llm.ts / trace.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PROVIDER_ERROR_CAP, serializeProviderError, providerErrorPayload,
  beginProviderCall, endProviderCall, providerCallsInFlight,
} from '../provider-error-core.ts';

const LLM = readFileSync('lib/llm.ts', 'utf8');
const TRACE = readFileSync('lib/trace.ts', 'utf8');
const GCP = readFileSync('lib/gcp-auth.ts', 'utf8');

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · §4.1 — the serialiser captures the FULL error, 4000-char cap, never 200
// ═════════════════════════════════════════════════════════════════════════════════════════════

// A Vertex 403 as the OpenAI SDK surfaces it: .status HTTP + .error body.
const VERTEX_403 = {
  status: 403,
  message: '403 Permission denied',
  error: {
    code: 403,
    message: 'Permission "aiplatform.endpoints.predict" denied on resource "projects/clinical-infra/locations/asia-south1/publishers/google/models/gemini-2.5-pro" (or it may not exist).',
    status: 'PERMISSION_DENIED',
    details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'IAM_PERMISSION_DENIED', domain: 'aiplatform.googleapis.com' }],
  },
};

test('§4.1: a Vertex 403 body survives whole — status, message, details all captured', () => {
  const s = serializeProviderError(VERTEX_403);
  assert.equal(s.http_status, 403);
  assert.equal(s.error_status, 'PERMISSION_DENIED', 'THE discriminator: IAM denial vs RESOURCE_EXHAUSTED quota');
  assert.equal(s.error_code, 403);
  assert.ok(s.message.includes('aiplatform.endpoints.predict'), 'the FULL message — what distinguishes IAM from quota from disabled-API');
  assert.ok(s.details && s.details.includes('IAM_PERMISSION_DENIED'), 'details[] serialised');
});

test('§4.1: the cap is 4000, not 200 — a diagnostic longer than 200 chars survives', () => {
  assert.equal(PROVIDER_ERROR_CAP, 4000);
  const long = 'q'.repeat(5000);
  const s = serializeProviderError(new Error(long));
  assert.equal(s.message.length, 4000, 'capped at the generous ceiling');
  assert.ok(s.message.length > 200, 'and never at the old defect value');
});

test('§4.1: nested {error:{error:{…}}} unwraps; plain Error and junk degrade safely, never throw', () => {
  const nested = serializeProviderError({ error: { error: { message: 'quota exceeded', status: 'RESOURCE_EXHAUSTED', code: 429 } } });
  assert.equal(nested.error_status, 'RESOURCE_EXHAUSTED');
  assert.equal(nested.message, 'quota exceeded');
  assert.equal(serializeProviderError(new Error('boom')).message, 'boom');
  assert.equal(serializeProviderError('string error').message, 'string error');
  assert.equal(serializeProviderError(null).message, '');
  assert.equal(serializeProviderError(undefined).message, '');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · §4.2 — in-flight accounting: the field that makes the hypothesis falsifiable
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§4.2: begin/end account per provider; snapshot totals; end floors at 0', () => {
  // Drain any residue from other tests first.
  for (let i = 0; i < 50; i++) { endProviderCall('gemini'); endProviderCall('openrouter'); }
  assert.equal(providerCallsInFlight().total, 0);
  beginProviderCall('gemini'); beginProviderCall('gemini'); beginProviderCall('openrouter');
  const snap = providerCallsInFlight();
  assert.equal(snap.total, 3);
  assert.deepEqual(snap.by, { gemini: 2, openrouter: 1 });
  endProviderCall('gemini');
  assert.deepEqual(providerCallsInFlight().by, { gemini: 1, openrouter: 1 });
  endProviderCall('gemini'); endProviderCall('gemini');   // one extra — must floor, never go negative
  endProviderCall('openrouter');
  assert.equal(providerCallsInFlight().total, 0);
});

test('§4.2: providerErrorPayload carries inFlightAtError + provider/label/fellBackTo + the serialised error', () => {
  const p = providerErrorPayload({
    provider: 'gemini', label: 'audit', feature: null, fellBackTo: 'ollama',
    intendedModel: 'gemini-2.5-pro', fallbackModel: 'qwen2.5:14b',
    region: 'asia-south1', saIdentity: 'vertex-ai-external@clinical-infra.iam.gserviceaccount.com',
    error: VERTEX_403, inFlightAtError: { total: 5, by: { gemini: 5 } },
  });
  assert.equal(p.inFlightAtError, 5, 'the §3 discriminator — without it the hypothesis is unfalsifiable');
  assert.deepEqual(p.in_flight_by_provider, { gemini: 5 });
  assert.equal(p.error_status, 'PERMISSION_DENIED');
  assert.equal(p.region, 'asia-south1');
  assert.equal(p.fellBackTo, 'ollama');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · The wiring — llm.ts and trace.ts capture full, log loud, emit the event
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§4.1: the 200-char truncation is GONE from every provider-error path', () => {
  assert.ok(!LLM.includes('slice(0, 200)'), 'llm.ts no longer truncates the diagnostic');
  assert.ok(!TRACE.includes('slice(0, 200)'), 'trace.ts no longer truncates the diagnostic');
  assert.ok(!TRACE.includes('slice(0, 500)'), 'the provider_fallback event no longer truncates at 500 either');
  assert.ok(TRACE.includes('.slice(0, PROVIDER_ERROR_CAP)'), 'composeProviderFallbackError caps at 4000');
});

test('§4.3: the fallback is LOUD — console.error with the stable [provider-fallback] prefix, console.warn gone', () => {
  assert.equal((LLM.match(/console\.error\(`\[provider-fallback\]/g) || []).length, 2, 'both chatWithFallback provider branches');
  assert.equal((TRACE.match(/console\.error\(`\[provider-fallback\]/g) || []).length, 2, 'both tracedChat provider branches');
  assert.ok(!LLM.includes('console.warn(`[chatWithFallback]'), 'the warn nothing reads is replaced, not kept alongside');
});

test('§4.2: both tracedChat catches emit a provider_error event through the existing logEvent path', () => {
  assert.equal((TRACE.match(/logEvent\(traceId, 'provider_error', label, errPayload/g) || []).length, 2);
  assert.ok(!TRACE.includes('CREATE TABLE'), 'no new table, no migration — it rides trace_events');
});

test('§4.2: the in-flight snapshot is taken BEFORE the decrement — the failing call counts itself', () => {
  for (const src of [LLM, TRACE]) {
    let from = 0;
    let found = 0;
    for (;;) {
      const snapIdx = src.indexOf('const inFlightAtError = providerCallsInFlight();', from);
      if (snapIdx < 0) break;
      const endIdx = src.indexOf('endProviderCall(', snapIdx);
      assert.ok(endIdx > snapIdx && endIdx - snapIdx < 200, 'snapshot immediately precedes the decrement');
      from = snapIdx + 1;
      found++;
    }
    assert.equal(found, 2, 'both provider branches in each file');
  }
});

test('the payload names model, region and SA identity — and the SA getter exposes client_email ONLY', () => {
  assert.ok(LLM.includes('region: vertexRegion(), saIdentity: vertexSaEmail()'), 'gemini branch in llm.ts');
  assert.ok(TRACE.includes('region: vertexRegion(), saIdentity: vertexSaEmail()'), 'gemini branch in trace.ts');
  const fn = GCP.slice(GCP.indexOf('export function vertexSaEmail'), GCP.indexOf('}', GCP.indexOf('export function vertexSaEmail')) + 1);
  assert.ok(fn.includes('client_email'), 'returns the identity');
  assert.ok(!fn.includes('private_key'), 'NEVER key material');
});

test('§5 out of scope: no retry/backoff, no routing flag change, no quota logic', () => {
  assert.ok(!/for\s*\(.*attempt|retry|backoff/i.test(LLM), 'llm.ts gained no retry loop');
  // The fallback call count is unchanged: each provider branch still makes exactly ONE fallback
  // llm.chat call on error, and behaviour on success is byte-identical.
  assert.equal((LLM.match(/return llm\.chat\.completions\.create\(params\);/g) || []).length, 3, 'the three existing fallback/default sites, no more');
});
