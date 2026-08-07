/**
 *   node --test --import tsx lib/__tests__/bedrock-transport.test.ts
 *
 * BEDROCK S1 (Units A + B, 7 Aug 2026) — auth, client, dispatch.
 *
 * WHAT IS PROVABLE WITHOUT AWS, AND WHY THAT IS THE RIGHT LINE. Three of this build's four
 * verification steps need a deployment (a live probe, a refusal probe, a 61-minute warm instance).
 * The DECISIONS underneath them do not, and those are what this file pins:
 *   1 · the ID-token claim shape — the one thing that makes the exchange return an id_token;
 *   2 · the credential refresh decision — the 61-minute test, expressed as arithmetic;
 *   3 · the Converse mapping, both directions — including the two mappings that are load-bearing
 *       rather than cosmetic (stopReason → finish_reason, and usage → the cost tracker's shape);
 *   4 · the F11 wiring: an explicit bedrock target has no ladder behind it, on BOTH governedChat
 *       arms, and it can never be silently dropped.
 *
 * Nothing here opens a socket. There is no AWS credential in CI and there must never need to be.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BEDROCK_MODELS, BEDROCK_ENV_VARS, assertKnownBedrockModel, bedrockConfiguredFrom,
  bedrockModelLabel, credentialsUsable, CREDENTIAL_REFRESH_SKEW_MS, fromConverseOutput,
  idTokenClaims, isKnownBedrockModel, mapStopReason, messageText, singleChunkStream,
  toConverseInput,
} from '../bedrock-core';
import { billableOutputTokens, priceFor, perCallInr, type Pricing } from '../llm-cost-core';
import PRICING_JSON from '../../data/llm-pricing.json' with { type: 'json' };

const src = (p: string) => readFileSync(p, 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const PRICING = PRICING_JSON as unknown as Pricing;

const TRACE = src('lib/trace.ts');
const BEDROCK = src('lib/bedrock.ts');
const GCP_AUTH = src('lib/gcp-auth.ts');
const OVERRIDE = src('lib/lab-override.ts');
const LLM = src('lib/llm.ts');
const COST = src('lib/llm-cost.ts');

const HAIKU = 'global.anthropic.claude-haiku-4-5-20251001-v1:0';
const SONNET = 'global.anthropic.claude-sonnet-4-6';
const OPUS = 'global.anthropic.claude-opus-4-6-v1';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · The Google ID token (C1)
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the ID-token assertion carries target_audience and NOT scope', () => {
  const c = idTokenClaims('sa@p.iam.gserviceaccount.com', 'https://oauth2.googleapis.com/token', '588427270277', 1_700_000_000_000);
  assert.deepEqual(c, {
    iss: 'sa@p.iam.gserviceaccount.com',
    aud: 'https://oauth2.googleapis.com/token',
    target_audience: '588427270277',
    iat: 1_700_000_000,
    exp: 1_700_003_600,
  });
  // `scope` is what makes the SAME exchange return an ACCESS token. Both keys on one assertion is
  // the one mistake that would silently produce the wrong credential type.
  assert.ok(!('scope' in c));
  assert.equal(c.exp - c.iat, 3600, 'one hour, same as the access-token flow');
});

test('getGcpIdToken mirrors getVertexAccessToken, reads id_token, and caches PER AUDIENCE', () => {
  const fn = GCP_AUTH.slice(GCP_AUTH.indexOf('export async function getGcpIdToken'));
  assert.ok(fn.includes('target_audience: aud'), 'the claim that selects an ID token');
  assert.ok(!/\bscope:/.test(fn), 'no scope claim on this assertion');
  assert.ok(fn.includes('id_token?: string'), 'the response field is id_token');
  assert.ok(!/access_token/.test(fn), 'and never access_token');
  assert.ok(fn.includes("createSign('RSA-SHA256')"), 'same pure-Node RS256 signing, no new dependency');
  assert.ok(fn.includes('idTokenCache.get(aud)') && fn.includes('idTokenCache.set(aud'), 'keyed by audience');
  assert.ok(fn.includes('hit.expiresAt - 5 * 60_000 > now'), 'refreshes 5 minutes before expiry');
  // ADDITIVE: the existing minting path is untouched.
  assert.ok(GCP_AUTH.includes("scope: 'https://www.googleapis.com/auth/cloud-platform',"), 'getVertexAccessToken keeps its scope claim');
});

test('no log line in the auth chain can print a token, key or credential', () => {
  // The proof is by construction: every console.* argument in the two files is enumerated here.
  for (const [name, text] of [['lib/bedrock.ts', BEDROCK], ['lib/gcp-auth.ts', GCP_AUTH]] as const) {
    const logs = text.match(/console\.[a-z]+\([^\n]*/g) ?? [];
    for (const line of logs) {
      for (const forbidden of ['idToken', 'WebIdentityToken', 'webIdentityToken', 'accessKeyId', 'AccessKeyId',
        'secretAccessKey', 'SecretAccessKey', 'sessionToken', 'SessionToken', 'private_key', 'GCP_SA_KEY',
        'cachedCreds', 'credentials', 'assertion']) {
        assert.ok(!line.includes(forbidden), `${name}: console line must not reference ${forbidden} — ${line.slice(0, 120)}`);
      }
    }
  }
  // The one identity line is deliberate and names identities only.
  assert.ok(BEDROCK.includes('console.info(`[bedrock] assumed ${roleArn} in ${region} as ${vertexSaEmail() ?? \'unknown-sa\'}'));
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · The credential cache + refresh decision (C2.2) — verification 8, as arithmetic
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the refresh decision: fresh reuses, inside-the-skew re-mints, expired re-mints', () => {
  const now = 1_700_000_000_000;
  const inMin = (m: number) => new Date(now + m * 60_000);
  assert.equal(credentialsUsable({ expiration: inMin(60) }, now), true, 'a fresh 60-minute credential is usable');
  assert.equal(credentialsUsable({ expiration: inMin(6) }, now), true, 'six minutes left is outside the 5-minute skew');
  assert.equal(credentialsUsable({ expiration: inMin(4) }, now), false, 'four minutes left is INSIDE the skew — re-mint');
  assert.equal(credentialsUsable({ expiration: inMin(0) }, now), false, 'exactly at expiry');
  assert.equal(credentialsUsable({ expiration: inMin(-1) }, now), false, 'expired');
  assert.equal(CREDENTIAL_REFRESH_SKEW_MS, 5 * 60_000, 'the same 5 minutes gcp-auth uses');
});

test('VERIFICATION 8, without a warm instance: two calls 61 minutes apart cannot share credentials', () => {
  const t0 = 1_700_000_000_000;
  const minted = { expiration: new Date(t0 + 60 * 60_000) };   // STS: DurationSeconds 3600
  assert.equal(credentialsUsable(minted, t0), true, 'call 1 mints and uses');
  assert.equal(credentialsUsable(minted, t0 + 61 * 60_000), false,
    'call 2, 61 minutes later, MUST re-mint — if this ever returns true the warm instance sends an expired credential');
  // …and the boundary is the skew, not the expiry: the last usable moment is t+55m.
  assert.equal(credentialsUsable(minted, t0 + 55 * 60_000 - 1), true);
  assert.equal(credentialsUsable(minted, t0 + 55 * 60_000), false);
});

test('an undatable credential is UNUSABLE — never reused on the benefit of the doubt', () => {
  const now = Date.now();
  assert.equal(credentialsUsable(null, now), false);
  assert.equal(credentialsUsable(undefined, now), false);
  assert.equal(credentialsUsable({}, now), false);
  assert.equal(credentialsUsable({ expiration: null }, now), false);
  assert.equal(credentialsUsable({ expiration: 'not-a-date' }, now), false);
  assert.equal(credentialsUsable({ expiration: new Date('nonsense') }, now), false);
});

test('the STS call is the reference’s call: role, session name, 60 minutes, unsigned client', () => {
  assert.ok(BEDROCK.includes('AssumeRoleWithWebIdentityCommand'));
  assert.ok(BEDROCK.includes("export const BEDROCK_ROLE_SESSION_NAME = 'bedrock-session';"));
  assert.ok(BEDROCK.includes('export const BEDROCK_SESSION_SECONDS = 3600;'));
  assert.ok(BEDROCK.includes('DurationSeconds: BEDROCK_SESSION_SECONDS'), 'not a restated literal');
  assert.ok(BEDROCK.includes('WebIdentityToken: webIdentityToken'));
  assert.ok(BEDROCK.includes('new STSClient({ region })'), 'no credentials — AssumeRoleWithWebIdentity is unsigned');
  // The SDK's own retries stay off: our budget is the shared policy's, and 3 × 3 = 9 wire calls.
  assert.ok(BEDROCK.includes('maxAttempts: 1'));
  // The credential provider is a FUNCTION, which is what lets the SDK re-resolve on a warm instance.
  assert.ok(BEDROCK.includes('credentials: () => bedrockCredentials()'));
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · Configuration + the model catalogue
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('bedrockConfigured needs all four vars — and never gates on AWS_REGION', () => {
  assert.deepEqual([...BEDROCK_ENV_VARS], ['GCP_SA_KEY', 'BEDROCK_REGION', 'BEDROCK_ROLE_ARN', 'BEDROCK_OIDC_AUDIENCE']);
  const full = { GCP_SA_KEY: '{}', BEDROCK_REGION: 'ap-south-1', BEDROCK_ROLE_ARN: 'arn:…', BEDROCK_OIDC_AUDIENCE: '5884' };
  assert.equal(bedrockConfiguredFrom(full), true);
  assert.equal(bedrockConfiguredFrom({}), false);
  for (const k of BEDROCK_ENV_VARS) {
    assert.equal(bedrockConfiguredFrom({ ...full, [k]: undefined }), false, `missing ${k}`);
    assert.equal(bedrockConfiguredFrom({ ...full, [k]: '' }), false, `empty ${k}`);
  }
  // Vercel sets AWS_REGION itself, so it can neither complete nor break the probe.
  assert.equal(bedrockConfiguredFrom({ ...full, AWS_REGION: 'iad1' }), true);
  assert.equal(bedrockConfiguredFrom({ AWS_REGION: 'iad1' }), false);
  assert.ok(!/AWS_REGION/.test(code(src('lib/bedrock-core.ts')).replace(/BEDROCK_ENV_VARS[\s\S]*?\]/, '')), 'never read as configuration');
});

test('exactly three model ids, and an unlisted one is REFUSED rather than sent', () => {
  assert.deepEqual(Object.keys(BEDROCK_MODELS), [HAIKU, SONNET, OPUS]);
  assert.equal(bedrockModelLabel(HAIKU), 'Haiku 4.5');
  assert.equal(bedrockModelLabel(SONNET), 'Sonnet 4.6');
  assert.equal(bedrockModelLabel(OPUS), 'Opus 4.6');
  assert.equal(bedrockModelLabel('global.anthropic.claude-sonnet-5'), null, 'pending on this account, not live');
  assert.equal(isKnownBedrockModel(''), false);
  assert.equal(isKnownBedrockModel(null), false);
  for (const m of Object.keys(BEDROCK_MODELS)) assert.doesNotThrow(() => assertKnownBedrockModel(m));
  // An unpriced model would be metered at the Gemini fallback rate — an unattributable COST row.
  assert.throws(() => assertKnownBedrockModel('anthropic.claude-3-5-sonnet'), /unknown model/);
  assert.throws(() => assertKnownBedrockModel('anthropic.claude-3-5-sonnet'), /Never falls back/);
  // Every id is a GLOBAL inference profile — which is the rate data/llm-pricing.json carries.
  for (const m of Object.keys(BEDROCK_MODELS)) assert.ok(m.startsWith('global.'), `${m} is a global profile`);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4 · The Converse mapping — outbound
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('OpenAI chat params → Converse: system split out, roles mapped, inferenceConfig built', () => {
  const input = toConverseInput({
    model: 'qwen2.5:14b',                       // the local fallback model — must NOT travel
    messages: [
      { role: 'system', content: 'You are an auditor.' },
      { role: 'user', content: 'Grade this note.' },
    ],
    temperature: 0.2,
    max_tokens: 2200,
    stream: false,
    options: { num_ctx: 8192 },                 // Ollama-only
    keep_alive: '15m',                          // Ollama-only
  }, HAIKU);

  assert.deepEqual(input, {
    modelId: HAIKU,
    system: [{ text: 'You are an auditor.' }],
    messages: [{ role: 'user', content: [{ text: 'Grade this note.' }] }],
    inferenceConfig: { maxTokens: 2200, temperature: 0.2 },
  });
  // The Ollama-only params and the local model name are dropped, exactly as the other two
  // providers' branches drop them — Bedrock rejects unknown fields.
  const flat = JSON.stringify(input);
  assert.ok(!flat.includes('keep_alive') && !flat.includes('num_ctx') && !flat.includes('qwen'));
});

test('consecutive same-role turns MERGE — Converse rejects them and dropping one would edit the prompt', () => {
  const input = toConverseInput({
    messages: [
      { role: 'system', content: 'A' },
      { role: 'system', content: 'B' },
      { role: 'user', content: 'one' },
      { role: 'user', content: 'two' },
      { role: 'assistant', content: 'ack' },
      { role: 'user', content: 'three' },
    ],
  }, SONNET);
  assert.deepEqual(input.system, [{ text: 'A' }, { text: 'B' }], 'system blocks stay separate and ordered');
  assert.deepEqual(input.messages, [
    { role: 'user', content: [{ text: 'one' }, { text: 'two' }] },
    { role: 'assistant', content: [{ text: 'ack' }] },
    { role: 'user', content: [{ text: 'three' }] },
  ]);
  // Nothing is lost: all SIX input turns still appear, exactly once each, in order — two as system
  // blocks and four as message content blocks. Merging changes the container, never the count.
  assert.equal(JSON.stringify(input).match(/"text"/g)?.length, 6);
});

test('mapping degrades safely on shapes the repo does not send today', () => {
  assert.equal(messageText('plain'), 'plain');
  assert.equal(messageText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb');
  assert.equal(messageText(null), '');
  assert.equal(messageText(undefined), '');
  // No messages ⇒ an empty list Bedrock will refuse LOUDLY, not a fabricated turn.
  assert.deepEqual(toConverseInput({}, HAIKU), { modelId: HAIKU, messages: [] });
  // A junk temperature/max_tokens is OMITTED rather than sent as NaN (which the API rejects with
  // an opaque validation error) and never invented as a default.
  assert.equal(toConverseInput({ temperature: Number('x'), max_tokens: 0 }, HAIKU).inferenceConfig, undefined);
  assert.deepEqual(toConverseInput({ temperature: 0 }, HAIKU).inferenceConfig, { temperature: 0 }, 'zero is a value, not absence');
  // 'developer' is OpenAI's newer name for a system turn; it must not become a user turn.
  assert.deepEqual(toConverseInput({ messages: [{ role: 'developer', content: 'sys' }] }, HAIKU).system, [{ text: 'sys' }]);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5 · The Converse mapping — inbound (and the two mappings that are load-bearing)
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('Converse response → the OpenAI shape every consumer in this repo already reads', () => {
  const out = fromConverseOutput({
    output: { message: { role: 'assistant', content: [{ text: '{"findings":' }, { text: '[]}' }] } },
    stopReason: 'end_turn',
    usage: { inputTokens: 4489, outputTokens: 5150, totalTokens: 9639 },
  }, SONNET);
  assert.equal(out.choices[0].message.content, '{"findings":[]}', 'multi-block content is concatenated, not joined with a separator');
  assert.equal(out.choices[0].finish_reason, 'stop');
  assert.equal(out.model, SONNET);
  assert.equal(out.provider, 'bedrock');
  assert.deepEqual(out.usage, { prompt_tokens: 4489, completion_tokens: 5150, total_tokens: 9639 });
  // The cost tracker's rule applied to this shape must recover output exactly — no double count.
  assert.equal(billableOutputTokens(out.usage), 5150);
});

test('⚠️ stopReason → finish_reason is load-bearing: end_turn MUST become stop', () => {
  // classifyProviderResponse treats a finish_reason outside {stop,tool_calls,function_call} as a
  // DEFECT, and the shared retry loop then throws. Unmapped, every successful Bedrock call would
  // look like a failure, be retried to exhaustion, and end as a ProviderResponseError.
  assert.equal(mapStopReason('end_turn'), 'stop');
  assert.equal(mapStopReason('stop_sequence'), 'stop');
  assert.equal(mapStopReason('max_tokens'), 'length');
  assert.equal(mapStopReason('tool_use'), 'tool_calls');
  assert.equal(mapStopReason('content_filtered'), 'content_filter');
  assert.equal(mapStopReason('guardrail_intervened'), 'content_filter');
  assert.equal(mapStopReason(undefined), 'stop', 'absent ⇒ content is the signal');
  assert.equal(mapStopReason('something_new'), 'something_new', 'an unknown reason is surfaced, not laundered into stop');
});

test('usage degrades safely: a missing total is derived, a missing usage is zero (never null cost)', () => {
  const noTotal = fromConverseOutput({ usage: { inputTokens: 10, outputTokens: 3 }, stopReason: 'end_turn' }, HAIKU);
  assert.deepEqual(noTotal.usage, { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 });
  assert.equal(billableOutputTokens(noTotal.usage), 3, 'total − prompt reduces to output exactly');
  const none = fromConverseOutput({}, HAIKU);
  assert.deepEqual(none.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  assert.equal(none.choices[0].message.content, '', 'and empty content, which classifyProviderResponse calls a defect');
});

test('the stream shim satisfies a `for await` caller and carries the usage chunk', async () => {
  const c = fromConverseOutput({
    output: { message: { content: [{ text: 'hello' }] } }, stopReason: 'end_turn',
    usage: { inputTokens: 5, outputTokens: 2 },
  }, HAIKU);
  const chunks: Array<Record<string, unknown>> = [];
  for await (const ch of singleChunkStream(c)) chunks.push(ch as Record<string, unknown>);
  assert.equal(chunks.length, 2);
  const first = chunks[0] as { choices: Array<{ delta: { content: string } }> };
  assert.equal(first.choices[0].delta.content, 'hello', 'the whole answer in one delta — /api/ask accumulates it unchanged');
  const last = chunks[1] as { choices: unknown[]; usage: unknown };
  assert.deepEqual(last.choices, [], 'the usage chunk has empty choices, like Vertex include_usage');
  assert.deepEqual(last.usage, { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 6 · F11 dispatch — the property this build must not get wrong
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('an explicit bedrock target OUTRANKS both cloud tiers and has no ladder behind it', () => {
  const c = code(TRACE);
  assert.ok(c.includes('const bedrockModel = opts?.bedrock;'));
  // The bridge/ladder resolution is short-circuited: a bedrock target never resolves an OpenRouter
  // slug, and never sets useGemini, so no second tier can exist to fall to.
  assert.ok(c.includes('const orSlug = bedrockModel ? undefined : (opts?.openrouter || openrouterGeminiSlug(opts?.gemini));'));
  assert.ok(c.includes('const useGemini = !bedrockModel && !useOpenRouter'));
  // The branch itself: no nextHop, no runOllamaFallback, no noLocalFallback switch — it throws.
  const branch = c.slice(c.indexOf('if (bedrockModel) {'), c.indexOf('} else if (useOpenRouter || useGemini) {'));
  assert.ok(branch.includes('throw be;'), 'a failure is terminal for the call');
  assert.ok(!/runOllamaFallback|nextHop|noLocalFallback/.test(branch), 'no fallback machinery inside the bedrock branch');
  assert.ok(branch.includes("await logEvent(traceId, 'provider_error', label, bedrockFailurePayload(label, bedrockModel, be)"),
    'the failure is recorded before it is thrown');
});

test('⚠️ the bedrock target reaches BOTH governedChat arms — the traceless one cannot drop it', () => {
  const body = TRACE.slice(TRACE.indexOf('export async function governedChat'));
  assert.ok(body.includes('return tracedChat(traceId, label, params, opts);'), 'traced arm unchanged');
  // THE LESSON THIS ENCODES: chatWithFallback has no bedrock parameter, so a dropped target would
  // not error — it would run the LOCAL MINI and produce a row attributed to Bedrock.
  assert.ok(body.includes('if (opts?.bedrock) return bedrockOnlyChat(label, params, opts.bedrock, opts);'));
  assert.ok(body.indexOf('if (opts?.bedrock)') < body.indexOf('return chatWithFallback('), 'and it is checked BEFORE the fallback path');
  const arm = TRACE.slice(TRACE.indexOf('async function bedrockOnlyChat'), TRACE.indexOf('export async function governedChat'));
  assert.ok(arm.includes('throw e;'), 'the traceless arm never falls back either');
  assert.ok(arm.includes("startTrace('provider_error'"), 'and still records the failure, like emitProviderErrorTrace');
});

test('the budget reaches the transport, and its default is READ FROM THE TABLE', () => {
  assert.ok(TRACE.includes('model: bedrockModel, timeoutMs: opts?.timeoutMs, maxTries: opts?.maxTries, label,'), 'traced arm');
  assert.ok(TRACE.includes('bedrockGenerate(params, { model, timeoutMs: opts.timeoutMs, maxTries: opts.maxTries, label })'), 'traceless arm');
  const g = BEDROCK.slice(BEDROCK.indexOf('export async function bedrockGenerate'));
  assert.ok(g.includes('defaultTimeoutMs: util?.perAttemptMs'), 'no literal ceiling in this file');
  assert.ok(g.includes('defaultMaxTries: util?.maxTries'));
  assert.ok(BEDROCK.includes('const util = PROVIDER_BUDGETS.bedrock.utility;'), 'one fact, one place');
  assert.ok(!/110_000|380_000|200_000/.test(code(BEDROCK)), 'no restated budget literals');
  // And the shared policy is REUSED, not re-implemented: same deadline, same backoff, same
  // 200-that-is-not-a-completion judgement the other two transports get.
  assert.ok(g.includes('createWithRetry('));
  assert.ok(g.includes("provider: 'bedrock'"));
  assert.ok(g.includes('signal: ro.signal'), 'the per-attempt deadline actually aborts the AWS call');
});

test('the provider_error record names BOTH identities in the chain', () => {
  const p = BEDROCK.slice(BEDROCK.indexOf('export function bedrockErrorPayload'));
  assert.ok(p.includes('saIdentity: vertexSaEmail()'), 'which SA signed the ID token');
  assert.ok(p.includes('roleArn: bedrockRoleArn() || null'), 'which role STS was asked to assume');
  assert.ok(p.includes('region: bedrockRegion() || null'));
  assert.ok(p.includes("fellBackTo: 'none'"), 'there is nothing to fall back to');
  // role_arn is ADDITIVE on the shared payload: absent ⇒ the gemini/openrouter records are
  // byte-identical to before this build.
  assert.ok(src('lib/provider-error-core.ts').includes('...(i.roleArn ? { role_arn: i.roleArn } : {}),'));
  // The snapshot-before-decrement discipline survives being carried out of the catch.
  assert.ok(BEDROCK.includes('const inFlightAtError = providerCallsInFlight();'));
  assert.ok(BEDROCK.indexOf('const inFlightAtError = providerCallsInFlight();') < BEDROCK.indexOf("endProviderCall('bedrock');\n    const payload"));
});

test('the override gate and the routing map carry bedrock end to end', () => {
  assert.ok(OVERRIDE.includes("if (provider === 'bedrock') return bedrockConfigured();"));
  assert.ok(!/BEDROCK_API_KEY\s*&&/.test(OVERRIDE), 'the dead API-key gate is gone, not merely commented');
  assert.ok(OVERRIDE.includes("if (ovr.provider === 'bedrock') return { gemini: undefined, bedrock: ovr.model };"),
    'gemini MUST be cleared or the governed layer would still see a Gemini model');
  assert.ok(LLM.includes("export { bedrockConfigured, BEDROCK_MODELS, bedrockModelLabel, isKnownBedrockModel } from './bedrock';"));
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 7 · Cost — rows AND the filter that decides whether they are ever consulted
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('each model prices at its published global-endpoint rate, and never at a Gemini rate', () => {
  const expected: Array<[string, number, number, string]> = [
    [HAIKU, 1.0, 5.0, 'Claude Haiku 4.5 (Bedrock)'],
    [SONNET, 3.0, 15.0, 'Claude Sonnet 4.6 (Bedrock)'],
    [OPUS, 5.0, 25.0, 'Claude Opus 4.6 (Bedrock)'],
  ];
  for (const [id, inUsd, outUsd, label] of expected) {
    const p = priceFor(id, PRICING);
    assert.equal(p.label, label, `${id} resolves to its own row, not the fallback`);
    assert.equal(p.inUsdPerM, inUsd);
    assert.equal(p.outUsdPerM, outUsd);
    assert.equal(p.hiThresholdTokens, undefined, 'Claude 4.6 carries the full 1M window at one rate');
  }
  // The ordering trap the file's own note warns about: no Bedrock id may collide with an earlier
  // match string, and no existing model may start matching a Claude row.
  assert.equal(priceFor('gemini-2.5-pro', PRICING).label, 'Gemini 2.5 Pro');
  assert.equal(priceFor('gemini-2.5-flash', PRICING).label, 'Gemini 2.5 Flash');
  assert.equal(priceFor('qwen/qwen3.5-flash-02-23', PRICING).label, 'Qwen3.5 Flash (OpenRouter)');
  // A worked number, so a rate typo shows up as rupees: 10k in + 2k out on Haiku at ₹94.7/$.
  const inr = perCallInr(HAIKU, 10_000, 2_000, { ...PRICING, fxUsdInr: 94.7 });
  assert.ok(Math.abs(inr - ((10_000 * 1.0 + 2_000 * 5.0) / 1e6) * 94.7) < 1e-9);
  assert.ok(Math.abs(inr - 1.894) < 0.001, `₹${inr.toFixed(3)} for a 10k/2k Haiku call`);
});

test('⚠️ the cost tracker actually SELECTS Bedrock rows — rates alone would have shown ₹0', () => {
  assert.ok(COST.includes("ILIKE '%claude%'"), 'without this arm the priced-model filter excludes every Bedrock call');
  assert.ok(COST.includes("ILIKE '%gemini%'") && COST.includes("ILIKE '%qwen%'"), 'and the existing two are untouched');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 8 · Byte-identity: nothing changes for a caller that passes no bedrock target
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('with no bedrock target the dispatch is the pre-existing one, line for line', () => {
  const c = code(TRACE);
  // The ladder, its terminal disposition and the Ollama fallback are untouched.
  assert.ok(c.includes('const ladder = cloudLadder({'));
  assert.ok(c.includes('if (opts?.noLocalFallback) throw lastErr;'));
  assert.ok(c.includes("if (lastTier === 'openrouter' && isProviderResponseError(lastErr)) throw lastErr;"));
  assert.ok(c.includes('result = await runOllamaFallback(lastTier, servedModel, lastErr, () => llm.chat.completions.create(params, reqOpts));'));
  assert.ok(c.includes('result = await llm.chat.completions.create(params, reqOpts);'), 'the plain local path');
  // servedModel/provider fall through to exactly their previous expressions when bedrockModel is
  // undefined — the ternaries are prefixed, never rewritten.
  assert.ok(c.includes("provider: bedrockModel ? 'bedrock' : useOpenRouter ? 'openrouter' : useGemini ? 'gemini' : 'ollama',"));
  // lib/lab-provider-core.ts is NOT touched by this slice (kickoff constraint 2).
  assert.ok(!/bedrockConfigured|bedrockConverse|BEDROCK_ROLE/.test(src('lib/lab-provider-core.ts')));
});

test('labRoutingOpts is still {} with no override — the spread stays byte-identical', () => {
  assert.ok(OVERRIDE.includes('if (!ovr) return {};'));
  assert.ok(OVERRIDE.includes("if (ovr.provider === 'vertex') return { gemini: ovr.model };"));
  assert.ok(OVERRIDE.includes("if (ovr.provider === 'openrouter') return { gemini: undefined, openrouter: ovr.model };"));
  assert.ok(OVERRIDE.includes("return { gemini: undefined };   // ollama — force the local mini"));
});

test('mini_analyze refuses a provider its seam cannot serve, instead of stamping the row anyway', () => {
  const mcp = src('lib/mcp-tools.ts');
  assert.ok(mcp.includes("if (M.provider !== 'ollama' && M.provider !== 'openrouter') {"),
    'bedrock: and vertex: are both refused — the evalModel seam is OpenRouter-only');
  assert.ok(mcp.includes("const evalModel = M.provider === 'openrouter' ? M.model : undefined;"), 'the seam itself is unchanged');
  // The refusal must happen BEFORE the row is written, or it is not a refusal.
  const fn = mcp.slice(mcp.indexOf('async function miniAnalyze'));
  assert.ok(fn.indexOf("M.provider !== 'ollama'") < fn.indexOf('await saveLabAnalysis('));
});
