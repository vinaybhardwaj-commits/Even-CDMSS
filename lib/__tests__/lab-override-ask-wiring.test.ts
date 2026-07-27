// F11 wiring — app/api/ask ONLY (A12, decision 15). THE BYTE-IDENTITY TEST.
//
// WHAT THIS PROVES, precisely. It cannot boot a Next route, so it does not diff two HTTP responses.
// It proves the three mechanical facts that TOGETHER make byte-identity hold, each of which is the
// thing that would actually break:
//   (a) with no labModel, the override resolver short-circuits to null before touching env, cookies
//       or the network — so nothing in the request path changes;
//   (b) labRoutingOpts(null) is {}, and `{ gemini: G, ...{} }` DEEP-EQUALS `{ gemini: G }` — the
//       spread cannot introduce a key, change one, or reorder;
//   (c) every routing site in ask carries `...LAB`, asserted over the route's source, so a future
//       edit cannot silently leave one site un-threaded (which would make behaviour differ BETWEEN
//       passes of the same request rather than between requests — the nastiest version of this bug).
// The live four-state exercise on production remains the orchestrator's step, and only that can
// close it end-to-end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { labRoutingOpts, probeReachable } from '../lab-override';
import { decideOverride, LAB_ORIGIN_HEADER, OVERRIDE_ENV_FLAG } from '../lab-override-core';

const ASK_SRC = readFileSync(new URL('../../app/api/ask/route.ts', import.meta.url), 'utf8');
const MCP_SRC = readFileSync(new URL('../mcp-tools.ts', import.meta.url), 'utf8');

test('BYTE-IDENTITY (a): with no labModel the gate short-circuits to "no override"', () => {
  // the pure decision, which the wrapper delegates to, returns before evaluating ANY other condition
  for (const m of [undefined, null, '', '   ']) {
    const d = decideOverride({ requestedModel: m, isAdmin: true, isClinicianSession: false });
    assert.equal(d.override, false);
    assert.equal((d as { refusal: string }).refusal, 'no_model_requested');
  }
});

test('BYTE-IDENTITY (b): labRoutingOpts(null) is {} and the spread changes nothing', () => {
  const LAB = labRoutingOpts(null);
  assert.deepEqual(LAB, {});
  const G = 'gemini-2.5-pro';
  // the exact expression the five call sites use, against what they used before the wiring
  assert.deepEqual({ gemini: G, ...LAB }, { gemini: G });
  assert.deepEqual(Object.keys({ gemini: G, ...LAB }), ['gemini']);
  // and it holds for the undefined-G case (the local mini path), which is the common one
  assert.deepEqual({ gemini: undefined, ...LAB }, { gemini: undefined });
});

test('BYTE-IDENTITY (c): EVERY routing site in ask threads ...LAB — none left behind', () => {
  const threaded = (ASK_SRC.match(/\{ gemini: G, \.\.\.LAB \}/g) ?? []).length;
  assert.equal(threaded, 5, 'all five governedChat/parseInvestigations routing sites must carry ...LAB');
  // no site may pass a bare { gemini: G } in CODE (the string appears once more, inside a comment)
  const codeLines = ASK_SRC.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'));
  assert.equal(codeLines.filter((l) => /\{ gemini: G \}/.test(l)).length, 0);
});

test('the wiring is ADDITIVE: labModel is the only new body field, providerOverride unchanged', () => {
  assert.match(ASK_SRC, /providerOverride\?: 'gemini' \| 'ollama'; labModel\?: string/);
  // the pre-existing providerOverride semantics are untouched
  assert.match(ASK_SRC, /body\.providerOverride === 'ollama' \? undefined/);
  assert.match(ASK_SRC, /body\.providerOverride === 'gemini' \? \(geminiConfigured\(\) \? GEMINI_MODEL : undefined\)/);
  assert.match(ASK_SRC, /: geminiModelFor\('ask'\)/);
});

test('ask records the RESOLVED model on the trace, never the requested string', () => {
  assert.match(ASK_SRC, /draft: labOverride\.model, critique: labOverride\.model, revise: labOverride\.model/);
  assert.match(ASK_SRC, /provider: labOverride\.provider/);
  // …and the untouched default branch is still there for the no-override path
  assert.match(ASK_SRC, /draft: G \?\? TEXT_MODEL, critique: G \?\? CRITIQUE_MODEL/);
});

test('ONLY ask is wired — the other four routes are untouched this build', () => {
  for (const p of ['ddx', 'appropriateness', 'doc-audit/analyze', 'pathway/skeleton']) {
    const src = readFileSync(new URL(`../../app/api/${p}/route.ts`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /resolveLabOverride/, `${p} must NOT be wired in this build`);
    assert.doesNotMatch(src, /labModel/, `${p} must NOT accept labModel yet`);
  }
});

test('selfPostNdjson can now carry the lab-origin header (gate condition 2)', () => {
  // Before this build its headers were hardcoded to content-type, so condition 2 was unsatisfiable
  // and no override could ever fire on any route.
  assert.match(MCP_SRC, /extraHeaders\?: Record<string, string>/);
  assert.match(MCP_SRC, /'content-type': 'application\/json', \.\.\.\(extraHeaders \?\? \{\}\)/);
  assert.equal(LAB_ORIGIN_HEADER, 'x-cdmss-lab-origin');
});

test('routing map: vertex→gemini, openrouter clears gemini, ollama forces the mini', () => {
  const v = labRoutingOpts({ override: true, provider: 'vertex', model: 'gemini-2.5-pro', paid: true, caller: 'lab-mcp' });
  assert.deepEqual(v, { gemini: 'gemini-2.5-pro' });
  const o = labRoutingOpts({ override: true, provider: 'openrouter', model: 'google/gemini-2.5-flash', paid: true, caller: 'lab-mcp' });
  assert.equal(o.openrouter, 'google/gemini-2.5-flash');
  assert.equal(o.gemini, undefined, 'gemini MUST be cleared or the governed layer would still prefer it');
  const l = labRoutingOpts({ override: true, provider: 'ollama', model: 'qwen2.5:14b', paid: false, caller: 'lab-mcp' });
  assert.deepEqual(l, { gemini: undefined });
});

test('condition 6 probe is deterministic and refuses an unknown provider', () => {
  assert.equal(probeReachable('nonsense'), false);
  // ollama is the local default path and is reachable whenever a mini model is configured
  assert.equal(typeof probeReachable('ollama'), 'boolean');
  assert.equal(typeof probeReachable('vertex'), 'boolean');
  assert.equal(typeof probeReachable('openrouter'), 'boolean');
  assert.equal(OVERRIDE_ENV_FLAG, 'LAB_PROVIDER_OVERRIDE_ENABLED');
});
