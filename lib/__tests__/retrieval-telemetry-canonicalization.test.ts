/**
 * lib/__tests__/retrieval-telemetry-canonicalization.test.ts — `canonicalJson`, the ONE function
 * used for both the identical-content no-op check and persistence (D12). Proof 56.
 *
 * GOVERNED BY addendum v23 (authorized by the orchestrator on V's explicit delegation, 18 August
 * 2026, under Saul review 34), §4 (the proof text, verbatim from kickoff v11 §6, the numbering
 * authority) and §6 (this file, named by `retrieval-telemetry-core.test.ts`'s header since 11 August
 * and never created until now). Addendum v15 §3 sets the conventions.
 *
 *   56  Recursive canonicalization, nested-key permutation, JSONB round trip, array reorder not
 *       equal, undefined array element rejected.
 *
 * D12: "Keys sorted recursively at every depth. Array order preserved. `undefined` omitted in
 * objects and rejected in arrays. Non-finite numbers rejected. Comparison against the normalized
 * JSON used for persistence, after a JSONB round trip."
 *
 * WHAT THIS FILE DOES NOT CLAIM. There is no database here, so the "JSONB round trip" is what
 * Postgres jsonb is DOCUMENTED to do to a stored document and this file reproduces it in memory:
 * keys come back in jsonb's own storage order (shorter keys first, then bytewise), duplicate keys
 * collapse to the last value, and whitespace is gone. It does not claim the store's SQL performs
 * the comparison — the update-precedence order (no-op check first) is `retrieval-telemetry-store`'s
 * and is pinned elsewhere. Every fixture value is a literal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson } from '../retrieval-telemetry-core';

type Obj = Record<string, unknown>;
/** A type GUARD, not a cast. */
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * What a jsonb column hands back for a stored document (in memory): the JSON text is parsed, and
 * every object is rebuilt with its keys in jsonb's storage order — by key LENGTH first, then by
 * byte order — recursively, so nested objects come back reordered too. Arrays keep their order,
 * as jsonb arrays do. This is deliberately NOT sorted-by-name: a canonicalizer that only survives
 * a name-sorted input has not been round-tripped.
 */
function jsonbRoundTrip(text: string): unknown {
  const reorder = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(reorder);
    if (isObj(v)) {
      const keys = Object.keys(v).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
      const out: Obj = {};
      for (const k of keys) out[k] = reorder(v[k]);
      return out;
    }
    return v;
  };
  return reorder(JSON.parse(text));
}

test('56.1 — RECURSIVE canonicalization: keys are sorted at EVERY depth, inside objects and inside objects nested in arrays, and array order is preserved', () => {
  const value = {
    zeta: { delta: 1, alpha: [{ y: 2, x: 1 }, { b: null, a: 'q' }] },
    alpha: 0,
    mid: { c: { z: true, a: false }, b: [3, 1, 2] },
  };
  assert.equal(
    canonicalJson(value),
    '{"alpha":0,"mid":{"b":[3,1,2],"c":{"a":false,"z":true}},"zeta":{"alpha":[{"x":1,"y":2},{"a":"q","b":null}],"delta":1}}',
    'depth 1, depth 2, and depth 3 inside an array are all sorted; [3,1,2] stays [3,1,2]',
  );
  // Scalars and null pass through unchanged.
  assert.equal(canonicalJson(null), 'null');
  assert.equal(canonicalJson('s'), '"s"');
  assert.equal(canonicalJson(7), '7');
  assert.equal(canonicalJson(true), 'true');
});

test('56.2 — NESTED-KEY PERMUTATION: two documents whose keys are inserted in different orders at several depths canonicalize to the SAME string', () => {
  const a = { outer: { m: { q: 1, p: 2 }, k: [{ s: 1, r: 2 }] }, first: 'x' };
  const b = { first: 'x', outer: { k: [{ r: 2, s: 1 }], m: { p: 2, q: 1 } } };
  assert.notEqual(JSON.stringify(a), JSON.stringify(b), 'the naive serialization DOES differ — this test is not vacuous');
  assert.equal(canonicalJson(a), canonicalJson(b), 'the canonical forms are identical');
  // …and a one-value difference at depth 3 is still a difference.
  const c = { first: 'x', outer: { k: [{ r: 2, s: 9 }], m: { p: 2, q: 1 } } };
  assert.notEqual(canonicalJson(a), canonicalJson(c));
});

test('56.3 — JSONB ROUND TRIP: canonical(parse(stored)) equals canonical(original) even when the store hands the keys back in jsonb order at every depth', () => {
  const original = {
    manifest_schema_version: 3,
    expansion: { status: 'skipped', served_route_class: null, attempts: [] },
    batches: [{ batch_index: 0, attempts: [{ provider: 'vertex', outcome: 'success', attempt: 1, status: 200 }], outcome: 'success' }],
    retrieval_config: { topK: 8, rerank_temperature: 0, rerank_seed_status: 'unseeded' },
    fused_candidate_ids: [11, 12, 13],
  };
  const stored = canonicalJson(original);
  const back = jsonbRoundTrip(stored);
  assert.notEqual(JSON.stringify(back), stored, 'the round trip really did reorder — jsonb order is not sorted order');
  assert.equal(canonicalJson(back), stored, 'and canonicalizing what came back reproduces the persisted bytes');
  // The identical-content no-op check is decided by this equality: a manifest re-submitted after
  // a round trip compares EQUAL, so it burns no revision (D12).
  assert.equal(canonicalJson(back) === canonicalJson(original), true);
  // A single changed value after the round trip is NOT equal.
  const changed = jsonbRoundTrip(stored);
  assert.ok(isObj(changed) && isObj(changed.retrieval_config), 'the round-tripped document is an object with a config object');
  changed.retrieval_config.topK = 9;
  assert.notEqual(canonicalJson(changed), stored);
});

test('56.4 — ARRAY REORDER IS NOT EQUAL: array order is content, at the top level and nested', () => {
  assert.notEqual(canonicalJson([1, 2, 3]), canonicalJson([3, 2, 1]));
  assert.notEqual(canonicalJson({ ids: [11, 12] }), canonicalJson({ ids: [12, 11] }));
  assert.notEqual(canonicalJson({ b: [{ a: 1 }, { a: 2 }] }), canonicalJson({ b: [{ a: 2 }, { a: 1 }] }));
  // Ordered ids are the case that matters: a reordered `ordered_final_candidate_ids` is a different
  // ranking, and the no-op check must NOT swallow it.
  const one = { ordered_final_candidate_ids: [12, 11, 13], fused_candidate_ids: [11, 12, 13] };
  const two = { ordered_final_candidate_ids: [11, 12, 13], fused_candidate_ids: [11, 12, 13] };
  assert.notEqual(canonicalJson(one), canonicalJson(two));
  // While the SAME arrays under permuted keys are equal — order inside arrays, not order of keys.
  assert.equal(canonicalJson(one), canonicalJson({ fused_candidate_ids: [11, 12, 13], ordered_final_candidate_ids: [12, 11, 13] }));
});

test('56.5 — an UNDEFINED ARRAY ELEMENT is REJECTED (thrown, not dropped and not nulled), while undefined in an object is omitted', () => {
  assert.throws(() => canonicalJson([1, undefined, 3]), /undefined array element/, 'top-level array');
  assert.throws(() => canonicalJson({ batches: [{ a: 1 }, undefined] }), /undefined array element/, 'nested array');
  assert.throws(() => canonicalJson({ deep: { deeper: [undefined] } }), /undefined array element/, 'deep in objects');
  // Why rejection: dropping changes the LENGTH and nulling changes the VALUE — either way two
  // manifests that differ would compare equal. Neither of these is what happens:
  assert.notEqual(canonicalJson([1, 3]), canonicalJson([1, null, 3]), 'the two "repairs" are themselves different documents');
  // In an object, undefined is omitted, as JSON.stringify would — an absent field and a declared
  // null remain different claims after canonicalization.
  assert.equal(canonicalJson({ b: 1, a: undefined }), '{"b":1}');
  assert.notEqual(canonicalJson({ b: 1, a: undefined }), canonicalJson({ b: 1, a: null }), 'omitted ≠ null');
});

test('56.6 — NON-FINITE numbers are rejected at any depth, and finite ones pass', () => {
  assert.throws(() => canonicalJson(Number.NaN), /non-finite/);
  assert.throws(() => canonicalJson({ a: [{ b: Number.POSITIVE_INFINITY }] }), /non-finite/);
  assert.throws(() => canonicalJson([Number.NEGATIVE_INFINITY]), /non-finite/);
  assert.equal(canonicalJson({ a: 0, b: -1.5, c: 1e21 }), '{"a":0,"b":-1.5,"c":1e+21}');
});
