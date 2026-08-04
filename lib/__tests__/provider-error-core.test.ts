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
  classifyProviderResponse, providerResponsePayload, providerResponseErrorMessage,
  ProviderResponseError, isProviderResponseError, USABLE_FINISH_REASONS,
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
  // Two tier catches (openrouter, gemini). V-a2 folded the bad-200 payload into the openrouter
  // catch's single emit (providerResponsePayload vs providerErrorPayload selected by the marked
  // error) — 3 → 2 call sites, still the SAME event channel, never a second failure channel.
  assert.equal((TRACE.match(/logEvent\(traceId, 'provider_error', label, errPayload/g) || []).length, 2);
  assert.ok(TRACE.includes('providerResponsePayload({'), 'the bad-200 payload shape survives the fold');
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

test('§5 superseded for OpenRouter ONLY by addendum F v2: retry exists, but ONLY via the shared policy module', () => {
  // The 403-diagnosis kickoff shipped observability with NO retry. Addendum F v2 task 1 then gave
  // the production bridge path the lab's bounded retry — deliberately, and deliberately NOT as a
  // second implementation: llm.ts may not carry its own loop/backoff, only the shared wrapper.
  assert.ok(LLM.includes("import { openrouterCreateWithRetry, createWithRetry } from './openrouter-retry';"),
    'the retry comes from the ONE shared policy module');
  assert.ok(!/openRouterBackoffMs|setTimeout\(/.test(LLM), 'llm.ts has no private backoff/timer of its own');
  // ⚠️ THIS ASSERTION INVERTED IN UNIT V-a1 (3 Aug 2026), and the inversion IS the unit.
  // It used to read "the Gemini branch gained no retry — only the bridge transport did", which was
  // true and safe only while Vertex was the FALLBACK. Vertex is about to become PRIMARY, and read
  // in source on 3 Aug its chat branch had no per-attempt abort deadline, no bounded retry, no
  // 429/5xx handling and no body classification. It now runs the SAME shared loop — still one
  // implementation, which is the property this test actually defends.
  // (V-a2: the Vertex arm lives inside the ladder loop now — slice from its beginProviderCall,
  // which follows the OpenRouter arm, to the end of the function.)
  const gem = LLM.slice(LLM.indexOf("beginProviderCall('gemini');"));
  assert.ok(gem.includes('await createWithRetry('), 'the Gemini branch now runs the shared policy too');
  assert.ok(gem.includes("provider: 'vertex',"), 'and identifies itself as vertex, not openrouter');
  assert.ok(!gem.includes('openrouterCreateWithRetry'),
    'but NOT through the OpenRouter wrapper — a vertex failure must never log as openrouter');
  // V-a2 (4 Aug 2026): the two per-branch fallback sites became ONE terminal disposition after
  // the cloud ladder, so the count is 2 — the no-cloud default path + the ladder terminal. Still
  // exactly one fallback llm.chat call per failed request, and success is byte-identical.
  assert.equal((LLM.match(/return llm\.chat\.completions\.create\(params, reqOpts\);/g) || []).length, 2, 'the default path + the ladder terminal, no more');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4 · The 200-that-is-not-a-completion check (bridge-empty-response kickoff, 31 Jul 2026)
//
// MEASURED: 1,523 of 3,963 gemini-2.5-pro responses on the bridge (38.4%) came back with no
// content, and not one body was captured — every guard from the 403 kickoff fires only on a
// THROWN exception, and OpenRouter reports provider failures as HTTP 200. Flash over the same
// window: 0 of 1,021. These tests pin the check, and pin that it does NOT touch a good response.
// ═════════════════════════════════════════════════════════════════════════════════════════════

const OK_RESPONSE = {
  id: 'gen-1', provider: 'Google', model: 'google/gemini-2.5-pro',
  choices: [{ finish_reason: 'stop', native_finish_reason: 'STOP', message: { role: 'assistant', content: '{"ok":true}' } }],
  usage: { prompt_tokens: 100, completion_tokens: 8, total_tokens: 108 },
};

// The shape the 38.4% actually arrive in: HTTP 200, finish_reason 'error', content empty.
const BAD_200 = {
  id: 'gen-2', provider: 'Google AI Studio', model: 'google/gemini-2.5-pro',
  choices: [{ finish_reason: 'error', native_finish_reason: 'OTHER', message: { role: 'assistant', content: '' } }],
  error: { code: 429, message: 'Provider returned error', metadata: { provider_name: 'Google AI Studio' } },
  usage: { prompt_tokens: 4211, completion_tokens: 0, total_tokens: 4211 },
};

test('§5.2: a good response is NOT reclassified — including a one-character answer', () => {
  assert.equal(classifyProviderResponse(OK_RESPONSE), null);
  assert.equal(classifyProviderResponse({ choices: [{ finish_reason: 'stop', message: { content: '1' } }] }), null,
    'a valid SHORT answer is a success — this is the regression the check must never cause');
  assert.equal(classifyProviderResponse({ choices: [{ message: { content: 'no finish_reason field' } }] }), null,
    'content present + finish_reason absent stays a success: content is the real signal');
  assert.equal(classifyProviderResponse({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 't' }] } }] }), null,
    'a tool-call response legitimately carries no content');
  assert.ok(USABLE_FINISH_REASONS.has('stop'));
});

test('§2.1: the three failure rules — no choices, empty content, unusable finish_reason', () => {
  assert.equal(classifyProviderResponse(BAD_200)?.kind, 'empty_content');
  assert.equal(classifyProviderResponse({ choices: [] })?.kind, 'no_choices');
  assert.equal(classifyProviderResponse({ error: { message: 'upstream exploded' } })?.kind, 'no_choices');
  assert.equal(classifyProviderResponse(null)?.kind, 'no_choices');
  assert.equal(classifyProviderResponse({ choices: [{ finish_reason: 'stop', message: {} }] })?.kind, 'empty_content',
    'a missing content field is empty content');
  assert.equal(classifyProviderResponse({ choices: [{ finish_reason: 'length', message: { content: 'truncated {' } }] })?.kind, 'finish_reason',
    'truncated JSON is a failure even though bytes came back');
  assert.equal(classifyProviderResponse({ choices: [{ finish_reason: 'content_filter', message: { content: 'x' } }] })?.kind, 'finish_reason');
});

test('§2.1: a STREAM is never judged — it has no choices yet and would fail every rule', () => {
  assert.equal(classifyProviderResponse({ controller: new AbortController() }), null);
  assert.equal(classifyProviderResponse({ [Symbol.asyncIterator]: function* () {} }), null);
});

test('§2.2: the event carries the FULL body, both finish reasons, the served endpoint and the error object', () => {
  const d = classifyProviderResponse(BAD_200)!;
  assert.equal(d.finish_reason, 'error');
  assert.equal(d.native_finish_reason, 'OTHER');
  assert.equal(d.content_length, 0);
  assert.equal(d.served_by, 'Google AI Studio', 'WHICH Google endpoint served it — the pin hypothesis needs this');
  assert.ok(d.response_error?.includes('429'), 'the error object OpenRouter returned survives');
  assert.ok(d.body?.includes('"native_finish_reason":"OTHER"'), 'the WHOLE body is kept — it is the entire diagnostic payload');

  const p = providerResponsePayload({
    provider: 'openrouter', label: 'opd_audit_analyze', feature: null, fellBackTo: 'none',
    intendedModel: 'google/gemini-2.5-pro', fallbackModel: null, region: null, saIdentity: null,
    inFlightAtError: { total: 7, by: { openrouter: 7 } }, defect: d,
  });
  assert.equal(p.failure_class, 'bad_response_200', 'distinguishable from a thrown provider error');
  assert.equal(p.defect, 'empty_content');
  assert.equal(p.served_by, 'Google AI Studio');
  assert.equal(p.inFlightAtError, 7, 'load correlation stays falsifiable on the 200 path too');
  assert.ok(String(p.response_body).length > 0);
  assert.ok(String(p.message).includes('finish_reason=error'), 'the message alone diagnoses, for callers that only log .message');
});

test('§5.1: the caller sees a FAILURE, not an empty string — and the error is marked, not laundered', () => {
  const d = classifyProviderResponse(BAD_200)!;
  const e = new ProviderResponseError(d, 'openrouter', 'google/gemini-2.5-pro');
  assert.ok(e instanceof Error);
  assert.ok(isProviderResponseError(e), 'marked so a provider catch can tell it from a transport error');
  assert.ok(!isProviderResponseError(new Error('transport')));
  assert.ok(e.message.includes('NOT a completion'));
  assert.ok(e.message.includes('served_by=Google AI Studio'));
  assert.ok(providerResponseErrorMessage(d, 'openrouter', null).includes('model=null'), 'total — null model still renders');
});

test('§2.2/§2.3: the response is validated per attempt, the event is emitted, and the bad-200 path DOES NOT fall back', () => {
  // Since addendum F v2 the validation lives INSIDE the shared retry wrapper (every non-streaming
  // attempt is classified; only the spent budget throws the MARKED error). The transports keep
  // their §2.2 obligations — emit the payload, log loud — and §2.3 is enforced where the marked
  // error is caught: the isProviderResponseError branch must rethrow BEFORE any Ollama fallback
  // is reachable.
  const RETRY = readFileSync('lib/openrouter-retry.ts', 'utf8');
  // Unit V-a1 made the classifier injectable (`classify`) so the loop can serve Vertex's NATIVE
  // :generateContent shape too. The DEFAULT is still classifyProviderResponse, so every attempt on
  // every current call site is validated exactly as before — that is what this pins.
  assert.ok(RETRY.includes('const classify = cfg.classify ?? classifyProviderResponse;'),
    'classifyProviderResponse is still the default validator');
  assert.ok(RETRY.includes('const defect = classify(res);'), 'every attempt is validated in the wrapper');
  assert.ok(RETRY.includes('new ProviderResponseError(defect,'), 'the terminal empty-200 throws the marked error');
  // V-a2 (4 Aug 2026): §2.3 moved from inside each catch to the LADDER's terminal disposition —
  // the ladder may carry a bad-200 from OpenRouter to the direct Vertex tier (that broker failure
  // class is exactly what the direct call heals), but once every cloud tier has failed, a marked
  // OpenRouter error still rethrows BEFORE the Ollama fallback is reachable.
  for (const [name, src] of [['llm.ts', LLM], ['trace.ts', TRACE]] as const) {
    assert.ok(src.includes('providerResponsePayload({'), `${name} emits the §2.2 payload`);
    assert.ok(src.includes('[provider-bad-response]'), `${name} logs loud with a stable, distinct prefix`);
    const at = src.indexOf("if (lastTier === 'openrouter' && isProviderResponseError(lastErr)) throw lastErr;");
    assert.ok(at > -1, `${name}: the terminal disposition rethrows the marked error`);
    // The terminal Ollama call comes strictly AFTER the marked-error rethrow, so a marked error
    // can never reach it. (Search from `at`: earlier llm.chat sites are the pre-ladder default
    // path, which no failed cloud call can reach.)
    const fb = src.indexOf('llm.chat.completions.create(params, reqOpts)', at);
    assert.ok(fb > at, `${name}: NO Ollama fallback before the marked-error rethrow (§2.3) — the honest outcome is degraded`);
  }
});

test('§2.1: the check runs only when the provider actually served — never after a fallback', () => {
  // Structural now, not conditional: classification happens inside openrouterCreateWithRetry on
  // the OpenRouter response BEFORE any fallback exists, and a fallen-back Ollama result is
  // produced by llm.chat.completions.create and never passes through the wrapper. What must hold
  // in trace.ts is the ORDER: the terminal marked-error rethrow comes before the fallback call.
  const at = TRACE.indexOf("isProviderResponseError(lastErr)) throw lastErr;");
  const fb = TRACE.indexOf('runOllamaFallback(lastTier');
  assert.ok(at > -1 && fb > at, 'the marked error is filtered out before the Ollama fallback is reachable');
});

test('§6 out of scope: no retry, no backoff, and the Google provider pin is untouched', () => {
  assert.ok(!/setTimeout\(|sleep\(|backoff/i.test(TRACE.slice(TRACE.indexOf('const defect = classifyProviderResponse'), TRACE.indexOf('} else if (useGemini)'))),
    'no retry/backoff was smuggled in with the instrumentation');
  assert.ok(LLM.includes("only: ['google-vertex', 'google-ai-studio']"), 'the pin is unchanged — relaxing it is V\'s decision');
  assert.ok(LLM.includes('allow_fallbacks: false'));
});
