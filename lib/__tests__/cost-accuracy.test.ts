// lib/__tests__/cost-accuracy.test.ts — the anti-regression lock that keeps ₹/doc honest.
//
// WHY THIS EXISTS. The Flash-tiering study (ccd9409) proved the ₹/doc carried since S6 (₹11.30)
// was 3× understated against a true ₹34.20. Two independent causes, both re-provable here without
// a database:
//   1. Gemini 2.5 bills REASONING tokens at the output rate, but `completion_tokens` excludes them
//      while `total_tokens` includes them. Counting `completion` alone drops ~47% of billable
//      output, and output is ~93% of the ₹.
//   2. The multimodal PDF read passed NO trace envelope, so call_model/tokens_in/tokens_out were
//      NULL on every read and a column-based reader priced the whole thing at ₹0.
//
// SL0 (17-Jul-2026) measured both paths on ONE real audited doc (IP-200, WdOho28ICRkziEw683Rs):
//      shipped $ dashboard (payload reader) → ₹31.97   ✅ already accurate — deliberately untouched
//      envelope columns (pre-fix)           → ₹10.54   ❌ understated 67%
// So the fix is instrumentation-only and one-sided: the columns were brought UP to the dashboard's
// already-correct rule. These tests pin the two paths to each other so they can never drift again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { billableOutputTokens, costInr, type Pricing } from '../llm-cost-core';
import { buildEnvelope } from '../trace';
import PRICING_JSON from '../../data/llm-pricing.json' with { type: 'json' };

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const PRICING = PRICING_JSON as unknown as Pricing;

// The real analyze-call usage shape, measured on a live Gemini 2.5 Pro call (study §5).
// NOTE: prompt + completion + reasoning == total (4489 + 2716 + 2434 == 9639), so the billable
// output is total − prompt == 5150 == completion + reasoning. (The kickoff quotes 7150 for this
// shape; that is an arithmetic slip in the brief — 5150 is what its own numbers give, and the
// assertion below is written to the arithmetic, not to the typo.)
const REAL_ANALYZE_USAGE = { prompt_tokens: 4489, completion_tokens: 2716, total_tokens: 9639 };
const REASONING_TOKENS = 2434;
const BILLABLE_OUT = 5150;

test('(a) priced output is total − prompt (reasoning-inclusive), never completion alone', () => {
  assert.equal(billableOutputTokens(REAL_ANALYZE_USAGE), BILLABLE_OUT);
  assert.equal(BILLABLE_OUT, REAL_ANALYZE_USAGE.completion_tokens + REASONING_TOKENS,
    'billable output == visible completion + billed thinking tokens');
  assert.notEqual(billableOutputTokens(REAL_ANALYZE_USAGE), REAL_ANALYZE_USAGE.completion_tokens);

  // and it is not academic: this is the ₹ gap that made S6 report ₹11.30 for a ₹34 pipeline
  const correct = costInr('gemini-2.5-pro', 4489, BILLABLE_OUT, false, PRICING);
  const reasoningBlind = costInr('gemini-2.5-pro', 4489, REAL_ANALYZE_USAGE.completion_tokens, false, PRICING);
  assert.ok(correct > reasoningBlind * 1.7, `reasoning-blind pricing understates badly (₹${reasoningBlind.toFixed(2)} vs ₹${correct.toFixed(2)})`);
});

test('(a) the rule degrades safely: no total ⇒ completion; never negative; missing usage ⇒ 0', () => {
  // a non-thinking model / provider that omits total_tokens must reduce to completion exactly
  assert.equal(billableOutputTokens({ prompt_tokens: 100, completion_tokens: 42 }), 42);
  // a malformed total must never produce a negative or under-count below completion
  assert.equal(billableOutputTokens({ prompt_tokens: 900, completion_tokens: 42, total_tokens: 100 }), 42);
  assert.equal(billableOutputTokens({ prompt_tokens: 900, total_tokens: 100 }), 0);
  assert.equal(billableOutputTokens(null), 0);
  assert.equal(billableOutputTokens(undefined), 0);
  assert.equal(billableOutputTokens({}), 0);
});

test('(b) a multimodal event’s envelope carries the model and reasoning-inclusive tokens_out', () => {
  // the real PDF-read usage from the SL0 doc: total 5856 = prompt 2563 + completion 1409 + 1884 thinking
  const mmUsage = { prompt_tokens: 2563, completion_tokens: 1409, total_tokens: 5856 };
  const env = buildEnvelope(undefined, {
    model: 'gemini-2.5-pro', provider: 'vertex-multimodal',
    tokensIn: mmUsage.prompt_tokens, tokensOut: billableOutputTokens(mmUsage),
  });
  assert.equal(env.call_model, 'gemini-2.5-pro', 'the PDF read is no longer NULL-modelled');
  assert.equal(env.tokens_in, 2563);
  assert.equal(env.tokens_out, 3293, 'tokens_out = total − prompt (1409 visible + 1884 thinking)');
  assert.notEqual(env.tokens_out, mmUsage.completion_tokens);
  assert.equal(env.call_provider, 'vertex-multimodal');
  // generic transport ⇒ the caller owns the prompt fingerprint; these stay null here
  assert.equal(env.prompt_id, null);
  assert.equal(env.prompt_hash, null);
});

test('(b) the multimodal transport passes an envelope with the reasoning-inclusive rule', () => {
  const src = read('lib/gemini-multimodal.ts');
  assert.ok(/buildEnvelope\(undefined, \{/.test(src), 'the self-logged llm_response carries an envelope');
  assert.ok(/tokensOut: billableOutputTokens\(usage\)/.test(src), 'tokens_out uses the shared reasoning-inclusive rule');
  assert.ok(/tokensIn: usage\.prompt_tokens/.test(src), 'tokens_in is the prompt count (PDF tokens included)');
  // payload.usage must stay EXACTLY as the (already-correct) dashboard expects
  for (const k of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
    assert.ok(new RegExp(`${k}:`).test(src), `payload.usage keeps '${k}' for the dashboard reader`);
  }
  // thinking tokens are captured as a SIBLING of usage — never inside it (that would alter the
  // dashboard's input shape for no benefit)
  assert.ok(/thoughts_tokens: u\.thoughtsTokenCount/.test(src), 'thoughtsTokenCount is captured when Vertex returns it');
  assert.ok(!/usage: \{[^}]*thoughts/s.test(src), 'thoughts are NOT injected into payload.usage');
});

test('(c) the multimodal read is logged exactly once — no double count', () => {
  const mm = read('lib/gemini-multimodal.ts');
  // exactly one llm_response logger in the transport…
  const responseLogs = mm.match(/logEvent\([^,]+,\s*'llm_response'/g) ?? [];
  assert.equal(responseLogs.length, 1, 'the transport self-logs its llm_response exactly once');

  // …and the doc-audit caller must NOT log a second llm_response for the same call. It logs an
  // llm_request only (a different kind, which the dashboard's LLM_KINDS deliberately excludes).
  const da = read('lib/doc-audit.ts');
  const readCall = da.slice(da.indexOf('const run = async (traceId?: string)'), da.indexOf('parseExtraction'));
  assert.ok(/logEvent\(traceId, 'llm_request', 'doc_read'/.test(readCall), 'the caller logs the request…');
  assert.ok(!/logEvent\([^)]*'llm_response'/.test(readCall), '…and never a second llm_response for the read');

  // the $ dashboard prices only response-kind events, so request events can never be summed too
  const cost = read('lib/llm-cost.ts');
  assert.ok(/LLM_KINDS = `e\.kind IN \('llm_response', 'llm_stream_usage'\)`/.test(cost),
    'the dashboard counts response kinds only');
});

test('(3) the IPD extract call passes traceId — without it the read self-logs nothing at all', () => {
  const da = read('lib/doc-audit.ts');
  const call = da.match(/generateFromDocument\(core\.EXTRACT_SYSTEM[\s\S]*?\);/);
  assert.ok(call, 'the extract read call located');
  assert.ok(/traceId/.test(call![0]), 'the extract read is traced (else it is invisible on EVERY ₹ surface)');
});

test('the column path and the payload path state the SAME rule (they must never drift)', () => {
  // The dashboard's SQL was already correct and is deliberately NOT changed. This pins it: if
  // someone simplifies OUT_TOK to completion_tokens, or drops the greatest(), this fails.
  const cost = read('lib/llm-cost.ts');
  const outTok = cost.slice(cost.indexOf('const OUT_TOK'), cost.indexOf('const IS_MM'));
  assert.ok(/greatest\(/.test(outTok), 'OUT_TOK still takes the greatest of the two readings');
  assert.ok(/completion_tokens/.test(outTok) && /total_tokens/.test(outTok) && /prompt_tokens/.test(outTok),
    'OUT_TOK is greatest(completion, total − prompt) — the same rule as billableOutputTokens');

  // and the writers of the COLUMNS use the shared TS helper, not a raw completion count
  const trace = read('lib/trace.ts');
  assert.ok(/tokensOut: r\.usage \? billableOutputTokens\(r\.usage\) : null/.test(trace),
    'tracedChat writes reasoning-inclusive tokens_out');
  assert.ok(/tokensOut: billableOutputTokens\(u\)/.test(trace),
    'the streaming usage path writes reasoning-inclusive tokens_out');
  assert.ok(!/tokensOut: (r\.)?u(sage)?\??\.?(\.)?completion_tokens/.test(trace),
    'no envelope writer records completion_tokens as the output count');
});
