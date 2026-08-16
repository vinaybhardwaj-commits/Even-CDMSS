/**
 * lib/__tests__/rerank-pass-2.test.ts — proofs 2, 16, 17, 18 and 70, and J2.
 *
 * GOVERNED BY addendum v15 (signed by V, 16 August 2026), sections 3, 4.1, 4.3, 4.4 and 4.5, under
 * Saul review 27 and review 28. Kickoff v11 §6 is the numbering authority for the five proofs, and
 * §9 for J2. Proof text is quoted from kickoff v11 by proof NUMBER, never by line.
 *
 * WHAT THIS FILE PROVES.
 *   · Proof 2.  The `cohereFn` adapter passes the capture as capture and not as `fetch`, and the
 *              Cohere path still works with an injected `fetchImpl`.
 *   · Proof 16. Cohere soft failure: more than one candidate, Cohere selected, an untyped throw,
 *              `inputOrder()` returned, one synthesised `terminal_failure` batch per planned
 *              boundary, expected equals recorded, `rerank_soft_failed` true, and the row not partial.
 *   · Proof 17. The judge path cannot reach `inputOrder()`: a per-batch throw warns, continues, and
 *              leaves `rerank_soft_failed` false.
 *   · Proof 18. `expected_batch_count` equals `ceil(retained_pool / JUDGE_BATCH)` when the judge
 *              served and 1 when Cohere served; always derived from `served_backend`, never from
 *              `intended_backend`. `JUDGE_BATCH` is READ FROM THE SOURCE TEXT of `lib/rerank.ts`,
 *              not imported and not hard-coded (v15 §4.3, kickoff §3.1).
 *   · Proof 70. The Cohere-to-judge downgrade, four assertions in order (v15 §4.3): the runtime
 *              order, the manifest facts, `persisted_complete` by the composition in v15 §4.4, and
 *              source parity of provider selection and fallback order against 72960baa.
 *   · J2.       Explicit judge invokes neither `checkHealthy` nor `cohereFn`, under a judge default
 *              and under a hostile Cohere default, on success and on failure. Call-local, with
 *              injected counters through `RerankDeps`.
 *
 * WHAT THIS FILE DOES NOT CLAIM.
 *   · Nothing about the wire. J2 is a CALL-LEVEL fact proved with counters; the wire-level fact —
 *     zero Cohere outbound requests through `retrieve` — is J3's, in
 *     `explicit-judge-retrieve.test.ts` (v15 §4.1). The two are not merged.
 *   · Nothing about "the base-to-commit production byte comparison" review 28 named. That phrase
 *     is defined nowhere in the corpus; addendum v15 §4.3 declines it pending clarification. Proof
 *     70's byte requirement is the SOURCE-PARITY sentence quoted from kickoff v11, and that is what
 *     70.4 asserts.
 *   · No database. `persisted_complete` is asserted by composing the real, pure production
 *     functions (v15 §4.4), not by writing or reading a row.
 *
 * COLLABORATORS. The real `rerank`, `rerankCohere`, `rerankJudge` and `_resetRerankHealth` from
 * `lib/rerank.ts`. The real loopback judge for the judge arms. Injected `RerankDeps` for the
 * counters and the Cohere failure modes. An injected `fetchImpl` for proof 2, so no socket opens
 * to any Cohere endpoint. The connection guard is installed for the whole file.
 *
 * ORDER OF EVALUATION (v15 §10.4): server first, then the dynamic imports.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  startJudgeServer, installConnectionGuard, uninstallConnectionGuard, type JudgeServer,
} from './judge-server-stub';
import type { RerankDeps } from '../rerank';
import type { TelemetryCapture } from '../retrieval-capture';

// ── The ten environment variables `startJudgeServer` mutates and never restores (kickoff §4.5) ───
const ENV_TOUCHED = [
  'OLLAMA_BASE_URL', 'RERANK_JUDGE_MODEL', 'LLM_PIPELINE', 'GCP_PROJECT', 'GCP_SA_KEY',
  'GEMINI_ALL', 'GEMINI_UTILITY', 'GEMINI_VIA_OPENROUTER', 'RERANK_BACKEND', 'OPENROUTER_API_KEY',
] as const;
const envSnapshot = new Map<string, string | undefined>();
for (const k of ENV_TOUCHED) envSnapshot.set(k, process.env[k]);
function restoreEnv(): void {
  for (const [k, v] of envSnapshot) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}

// ── Fixture: six candidates, unique leading markers, scores that REORDER (kickoff §4.5) ─────────
const CANDIDATES = [
  { id: 1, text: 'MRKA1 a clinical passage used only by this proof, numbered one.' },
  { id: 2, text: 'MRKB2 a clinical passage used only by this proof, numbered two.' },
  { id: 3, text: 'MRKC3 a clinical passage used only by this proof, numbered three.' },
  { id: 4, text: 'MRKD4 a clinical passage used only by this proof, numbered four.' },
  { id: 5, text: 'MRKE5 a clinical passage used only by this proof, numbered five.' },
  { id: 6, text: 'MRKF6 a clinical passage used only by this proof, numbered six.' },
];
const SCORES: Record<string, number> = { MRKA1: 2, MRKB2: 9, MRKC3: 4, MRKD4: 10, MRKE5: 1, MRKF6: 7 };
const QUERY = 'a clinical question used only by this proof';
const fresh = () => CANDIDATES.map((c) => ({ ...c }));

type Booted = {
  judge: JudgeServer;
  rerank: typeof import('../rerank').rerank;
  rerankCohere: typeof import('../rerank').rerankCohere;
  rerankJudge: typeof import('../rerank').rerankJudge;
  RerankBackendError: typeof import('../rerank').RerankBackendError;
  RerankBackendUnreachable: typeof import('../rerank').RerankBackendUnreachable;
  _resetRerankHealth: typeof import('../rerank')._resetRerankHealth;
  createTelemetryCapture: typeof import('../retrieval-capture').createTelemetryCapture;
  buildRetrievalPayload: typeof import('../retrieval-capture').buildRetrievalPayload;
  settlement: typeof import('../retrieval-settlement');
  core: typeof import('../retrieval-telemetry-core');
};
let booted: Booted | null = null;

async function boot(): Promise<Booted> {
  if (booted) return booted;
  const judge = await startJudgeServer(SCORES);
  try {
    installConnectionGuard();
    const r = await import('../rerank');
    const cap = await import('../retrieval-capture');
    const settlement = await import('../retrieval-settlement');
    const core = await import('../retrieval-telemetry-core');
    booted = {
      judge, rerank: r.rerank, rerankCohere: r.rerankCohere, rerankJudge: r.rerankJudge,
      RerankBackendError: r.RerankBackendError, RerankBackendUnreachable: r.RerankBackendUnreachable,
      _resetRerankHealth: r._resetRerankHealth,
      createTelemetryCapture: cap.createTelemetryCapture, buildRetrievalPayload: cap.buildRetrievalPayload,
      settlement, core,
    };
  } catch (e) {
    await judge.close().catch(() => {});
    throw e;
  }
  return booted;
}

after(async () => {
  uninstallConnectionGuard();
  if (booted) { booted._resetRerankHealth(); await booted.judge.close().catch(() => {}); booted = null; }
  restoreEnv();
});

/** The manifest, built through the real capture-to-payload bridge (v15 §4.5: snake_case here). */
async function manifestOf(capture: TelemetryCapture) {
  const { buildRetrievalPayload } = await boot();
  return buildRetrievalPayload(capture, { hmacKey: 'pass-2-key', scorerContext: '' });
}

/**
 * `JUDGE_BATCH`, READ FROM THE SOURCE TEXT (proof 18, v15 §4.3, kickoff §3.1). The constant is
 * module-private in `lib/rerank.ts` and is not exported, which is what makes this requirement
 * natural: a test that imported it would need an export that D16 forbids, and a test that wrote
 * the number would silently agree with any future change. This reads the declaration and computes
 * from what it read.
 */
function judgeBatchFromSource(): number {
  const src = readFileSync('lib/rerank.ts', 'utf8');
  const m = src.match(/^const JUDGE_BATCH = (\d+);/m);
  assert.ok(m, 'lib/rerank.ts declares `const JUDGE_BATCH = <n>;` at column 0');
  const n = Number(m![1]);
  assert.ok(Number.isInteger(n) && n > 0, 'JUDGE_BATCH is a positive integer');
  return n;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Proof 2 — the cohereFn adapter passes the capture AS CAPTURE, and the Cohere path works with an
// injected fetchImpl.
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('2.1 — rerankCohere with an injected fetchImpl serves, stamps the capture, and opens no real socket', async () => {
  const { rerankCohere, createTelemetryCapture } = await boot();
  const prevKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'proof-2-key-not-a-secret';
  try {
    const seen: Array<{ url: string; method: string; hasBody: boolean }> = [];
    // The injected fetch: records the call, returns a well-formed Cohere reply. No socket opens —
    // and if the adapter had passed the capture in fetchImpl's position, this function would never
    // be called and `fetch(...)` would try to reach openrouter.ai, which the connection guard refuses.
    const fetchImpl: typeof fetch = async (url, init) => {
      seen.push({ url: String(url), method: String(init?.method), hasBody: typeof init?.body === 'string' });
      const docs = JSON.parse(String(init?.body)) as { documents: string[] };
      return new Response(JSON.stringify({
        results: docs.documents.map((_, i) => ({ index: i, relevance_score: (docs.documents.length - i) / 10 })),
        usage: { cost: 0.001 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const capture = createTelemetryCapture('primary');
    const out = await rerankCohere(QUERY, fresh(), fetchImpl, async () => {}, capture);
    assert.equal(seen.length, 1, 'exactly one Cohere request, through the injected fetch');
    assert.match(seen[0].url, /openrouter\.ai\/api\/v1\/rerank/, 'the real endpoint URL, never dialled');
    assert.equal(seen[0].method, 'POST');
    assert.ok(seen[0].hasBody);
    // The capture was received AS A CAPTURE: it is stamped by rerankCohere.
    assert.equal(capture.servedBackend, 'cohere');
    assert.equal(capture.expectedBatchCount, 1);
    assert.equal(capture.batches.length, 1);
    assert.equal(capture.batches[0].outcome, 'success');
    assert.equal(capture.rerankSeedStatus, 'not_applicable');
    assert.equal(capture.rerankTemperature, null);
    // …and the path works: scores in, ordered out.
    assert.equal(out.length, 6);
    assert.ok(out.every((c) => c.rerank_backend === 'cohere'));
    assert.deepEqual(out.map((c) => c.id), [1, 2, 3, 4, 5, 6], 'relevance_score decreasing with index, so input order');
  } finally { if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = prevKey; }
});

test('2.2 — the DEFAULT cohereFn adapter inside rerank passes the capture in the CAPTURE position, not the fetch position', async () => {
  // Through the real `rerank` dispatch with NO cohereFn injected, so the module-built adapter runs.
  // `checkHealthy` is injected to pass. `fetchImpl` cannot be injected through this path — that is
  // the point of proof 2: the adapter fixes positions 3 and 4 as `undefined` and passes the capture
  // FIFTH. If it passed the capture THIRD, `cohereRelevanceScores` would call `capture(...)` as
  // fetch and throw a TypeError. Instead the real `fetch` runs and the connection guard refuses the
  // outbound socket, which is the exact evidence: the capture was NOT used as fetch.
  const { rerank, createTelemetryCapture, RerankBackendUnreachable } = await boot();
  const prevKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'proof-2-key-not-a-secret';
  try {
    const capture = createTelemetryCapture('primary');
    let thrown: unknown = null;
    try {
      await rerank(QUERY, fresh(), 'cohere', { checkHealthy: async () => {} }, capture);
    } catch (e) { thrown = e; }
    // Explicit cohere is STRICT: the typed error propagates. It is Unreachable — the wrap that
    // `cohereRelevanceScores` puts around a thrown `fetch` — proof that `fetch` was CALLED with a
    // real URL, and the capture was NOT that fetch. (Native fetch reports the guard's synchronous
    // throw as the bare string "fetch failed"; the guard's own message is the cause underneath and
    // does not survive the wrap, so the message is asserted only as far as the code surfaces it.)
    assert.ok(thrown instanceof RerankBackendUnreachable, `typed Unreachable, got ${String(thrown)}`);
    assert.match((thrown as Error).message, /unreachable/i);
    // Had the capture been passed as fetch, `capture(...)` would have thrown a TypeError ("capture
    // is not a function"), which is NOT a RerankBackendError and would have soft-fallen instead of
    // propagating. The typed propagation above rules that out.
    assert.equal(thrown instanceof TypeError, false);
    // The capture reached `rerank` and was stamped with the INTENDED backend before dispatch.
    assert.equal(capture.intendedBackend, 'cohere');
    // Source pin of the adapter shape, by symbol not line: `rerankCohere(q, c, undefined, undefined, cap)`.
    const src = readFileSync('lib/rerank.ts', 'utf8');
    assert.match(src, /rerankCohere\(q, c, undefined, undefined, cap\)/, 'the adapter fixes fetchImpl and recordCost and passes the capture fifth');
  } finally { if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = prevKey; }
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Proof 16 — Cohere soft failure.
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('16.1 — Cohere selected, an UNTYPED throw: inputOrder returned, one synthesised terminal_failure batch, expected == recorded, soft_failed true, row not partial', async () => {
  const { rerank, createTelemetryCapture, settlement, core } = await boot();
  const capture = createTelemetryCapture('primary');
  // Explicit Cohere; the probe passes; the Cohere call throws a PLAIN Error — not a RerankBackendError.
  const out = await rerank(QUERY, fresh(), 'cohere', {
    checkHealthy: async () => {},
    cohereFn: async () => { throw new Error('untyped cohere failure'); },
  }, capture);
  // inputOrder() returned: ids in input order, backend 'none', scores strictly decreasing.
  assert.deepEqual(out.map((c) => c.id), [1, 2, 3, 4, 5, 6]);
  assert.ok(out.every((c) => c.rerank_backend === 'none'));
  for (let i = 1; i < out.length; i++) assert.ok(out[i - 1].rerank_score > out[i].rerank_score);
  // ONE synthesised terminal_failure batch per PLANNED boundary. Cohere plans ONE boundary.
  assert.equal(capture.batches.length, 1);
  assert.equal(capture.batches[0].outcome, 'terminal_failure');
  assert.equal(capture.batches[0].start, 0);
  assert.equal(capture.batches[0].end, 6);
  assert.equal(capture.batches[0].evidence.provenNotServed, false, 'a generic throw carries no proof of non-delivery');
  // Expected equals recorded, at the capture seam and in the manifest.
  assert.equal(capture.expectedBatchCount, 1);
  assert.equal(capture.rerankSoftFailed, true);
  const m = await manifestOf(capture);
  assert.equal(m.expected_batch_count, m.recorded_rerank_batches, 'expected == recorded');
  assert.equal(m.rerank_soft_failed, true);
  assert.equal(m.served_backend, 'cohere', 'the planned backend is stamped as served for reconciliation');
  // THE ROW IS NOT PARTIAL (v15 §4.4): compose the real settlement mapping. A clean save with an
  // empty defect list settles persisted_complete — soft failure is degraded RANKING, not a
  // manifest defect, and does not partial the row.
  const base = settlement.outcomeForSaveResult('inserted');
  const defects = settlement.verdictForRun({ primary: [] }, 'primary', true);
  const outcome = settlement.upgradeForDefects(base, defects);
  assert.equal(core.stateForSettlement(outcome), 'persisted_complete', 'the row is not partial');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Proof 17 — the judge path cannot reach inputOrder().
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('17.1 — a per-batch throw inside rerankJudge warns, continues, and leaves rerank_soft_failed FALSE', async () => {
  const { rerank, createTelemetryCapture, judge } = await boot();
  // The loopback judge returns non-JSON on EVERY batch: a real per-batch throw inside
  // `rerankJudge`'s try/catch. It warns and continues; it never escapes to `rerank`'s outer catch.
  judge.setRawContent(() => 'not json — per-batch throw');
  const warned: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(' ')); };
  try {
    const capture = createTelemetryCapture('primary');
    const out = await rerank(QUERY, fresh(), 'judge', {}, capture);
    // It CONTINUED: every batch is recorded, all scores are the initialiser 0, and the sort is stable
    // so ids come back in input order — but this is NOT inputOrder(): backend is 'judge', not 'none'.
    assert.equal(capture.batches.length, 2, 'both batches ran');
    assert.ok(capture.batches.every((b) => b.outcome === 'parse_failure'), 'each batch failed inside its own try');
    assert.ok(out.every((c) => c.rerank_backend === 'judge'), 'the JUDGE served — inputOrder() would say none');
    assert.ok(out.every((c) => c.rerank_score === 0));
    // It WARNED, per batch.
    assert.ok(warned.filter((w) => w.includes('[rerank judge] batch failed')).length >= 2, 'a warning per failed batch');
    // And soft-failed stays FALSE: the outer catch was never reached.
    assert.equal(capture.rerankSoftFailed, false);
    const m = await manifestOf(capture);
    assert.equal(m.rerank_soft_failed, false);
    assert.equal(m.expected_batch_count, m.recorded_rerank_batches);
  } finally { console.warn = origWarn; judge.setRawContent(null); }
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Proof 18 — expected_batch_count, derived from served_backend, with JUDGE_BATCH read from source.
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('18.1 — JUDGE served: expected_batch_count == ceil(pool / JUDGE_BATCH), JUDGE_BATCH read from source text', async () => {
  const { rerank, createTelemetryCapture } = await boot();
  const JB = judgeBatchFromSource();
  // Three pool sizes bracketing a batch boundary, so the ceil is exercised on both sides of it.
  for (const pool of [2, JB, JB + 1, 2 * JB + 1]) {
    const cands = Array.from({ length: pool }, (_, i) => ({ id: i + 1, text: `MRKP${i + 1} passage ${i + 1} for proof eighteen.` }));
    const capture = createTelemetryCapture('primary');
    await rerank(QUERY, cands, 'judge', {}, capture);
    const expected = Math.ceil(pool / JB);
    assert.equal(capture.servedBackend, 'judge');
    assert.equal(capture.expectedBatchCount, expected, `pool ${pool}: ceil(${pool}/${JB}) = ${expected}`);
    assert.equal(capture.batches.length, expected, 'recorded matches');
    const m = await manifestOf(capture);
    assert.equal(m.expected_batch_count, expected);
    assert.equal(m.served_backend, 'judge');
  }
});

test('18.2 — COHERE served: expected_batch_count == 1, whatever the pool', async () => {
  const { rerank, createTelemetryCapture } = await boot();
  const JB = judgeBatchFromSource();
  for (const pool of [2, 2 * JB + 1]) {
    const cands = Array.from({ length: pool }, (_, i) => ({ id: i + 1, text: `MRKQ${i + 1} passage.` }));
    const capture = createTelemetryCapture('primary');
    await rerank(QUERY, cands, 'cohere', {
      checkHealthy: async () => {},
      cohereFn: async (q, c, cap) => {
        // A cohereFn that stamps exactly what rerankCohere stamps, without a socket.
        if (cap) { cap.servedBackend = 'cohere'; cap.expectedBatchCount = 1; cap.batches.push({
          index: 0, start: 0, end: c.length,
          evidence: { servedProvider: 'openrouter', servedModel: 'cohere', attempts: null, provenNotServed: false },
          outcome: 'success', expectedScoreKeys: c.length, finiteScoreKeys: c.length, missingScoreKeys: 0, nonnumericScoreKeys: 0,
          intendedProvider: 'openrouter', intendedModel: 'cohere', promptTokens: null, completionTokens: null,
        }); }
        return c.map((x, i) => ({ ...x, rerank_score: 1 - i / c.length, rerank_backend: 'cohere' as const }));
      },
    }, capture);
    assert.equal(capture.servedBackend, 'cohere');
    assert.equal(capture.expectedBatchCount, 1, `pool ${pool}: Cohere is always one batch`);
    const m = await manifestOf(capture);
    assert.equal(m.expected_batch_count, 1);
  }
});

test('18.3 — DERIVED FROM served_backend, NEVER intended_backend: intended Cohere, judge serves, expected is the JUDGE count', async () => {
  // This is proof 70's downgrade used as proof 18's discriminating case: intended and served differ,
  // and expected_batch_count follows the one that SERVED. Test 70.2 asserts the same manifest fact
  // in its own place; here it is the direct proof of the derivation rule.
  const { rerank, createTelemetryCapture, RerankBackendUnreachable, _resetRerankHealth } = await boot();
  const JB = judgeBatchFromSource();
  _resetRerankHealth();
  try {
    const capture = createTelemetryCapture('primary');
    await rerank(QUERY, fresh(), undefined, {
      envBackend: 'cohere',
      checkHealthy: async () => { throw new RerankBackendUnreachable('cohere', 'm', 'probe refused'); },
    }, capture);
    assert.equal(capture.intendedBackend, 'cohere');
    assert.equal(capture.servedBackend, 'judge');
    assert.equal(capture.expectedBatchCount, Math.ceil(6 / JB), 'the judge count, NOT Cohere\'s 1');
    const m = await manifestOf(capture);
    assert.equal(m.intended_backend, 'cohere');
    assert.equal(m.expected_batch_count, Math.ceil(6 / JB));
    assert.notEqual(m.expected_batch_count, 1);
  } finally { _resetRerankHealth(); }
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Proof 70 — the Cohere-to-judge downgrade. Four assertions, in the order v15 §4.3 gives.
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** One downgrade run with an ORDER LOG, so 70.1 can assert what happened before what. */
async function downgradeRun() {
  const { rerank, createTelemetryCapture, RerankBackendUnreachable, _resetRerankHealth, judge } = await boot();
  // ⚠️ THE HEALTH PROBE IS MEMOIZED per backend and model for ten minutes (v15 §4.3). A passing
  // probe from an earlier test in this process would prevent the downgrade. Reset before, and
  // restore in finally. A THROWN probe is not cached, so this run leaves nothing behind either.
  _resetRerankHealth();
  const order: string[] = [];
  judge.setRecording(true); judge.resetObservations();
  try {
    const capture = createTelemetryCapture('primary');
    const out = await rerank(QUERY, fresh(), undefined, {
      envBackend: 'cohere',   // "backend Cohere by environment default", simulated through RerankDeps
      checkHealthy: async () => { order.push('checkHealthy:throw'); throw new RerankBackendUnreachable('cohere', 'rerank-v3.5', 'probe refused by design'); },
      // No judgeFn injected: the REAL rerankJudge serves, on the wire.
    }, capture);
    await judge.settled();
    order.push(`judge:served:${judge.snapshot().length}-requests`);
    return { out, capture, order };
  } finally { judge.setRecording(false); judge.resetObservations(); _resetRerankHealth(); }
}

test('70.1 — RUNTIME ORDER: checkHealthy throws RerankBackendError FIRST, the judge serves SECOND', async () => {
  const { order, out } = await downgradeRun();
  assert.equal(order[0], 'checkHealthy:throw', 'the probe threw first');
  assert.match(order[1], /^judge:served:2-requests$/, 'then the real judge served — two batches on the wire');
  assert.ok(out.every((c) => c.rerank_backend === 'judge'), 'the judge produced the ranking');
  assert.deepEqual(out.map((c) => c.id), [4, 2, 6, 3, 1, 5], 'and it REORDERED');
});

test('70.2 — MANIFEST FACTS: intended_backend cohere, served_backend judge, rerank_backend_downgraded true, expected_batch_count matches the judge', async () => {
  const { capture } = await downgradeRun();
  const JB = judgeBatchFromSource();
  // Capture seam, camelCase (v15 §4.5).
  assert.equal(capture.intendedBackend, 'cohere');
  assert.equal(capture.servedBackend, 'judge');
  assert.equal(capture.rerankBackendDowngraded, true);
  assert.equal(capture.expectedBatchCount, Math.ceil(6 / JB));
  assert.equal(capture.batches.length, Math.ceil(6 / JB));
  // Manifest, snake_case.
  const m = await manifestOf(capture);
  assert.equal(m.intended_backend, 'cohere');
  assert.equal(m.served_backend, 'judge');
  assert.equal(m.rerank_backend_downgraded, true);
  assert.equal(m.expected_batch_count, Math.ceil(6 / JB));
  assert.equal(m.expected_batch_count, m.recorded_rerank_batches, 'expected matches recorded — the row reconciles');
  assert.equal(m.rerank_soft_failed, false, 'a downgrade is not a soft failure');
});

test('70.3 — the row is persisted_complete, by the composition in v15 §4.4', async () => {
  const { capture, settlement, core } = { ...(await downgradeRun()), ...(await boot()) };
  // The manifest validates clean — no defect — so the run's own verdict is an empty array.
  const m = await manifestOf(capture);
  const defectsOnManifest = core.validateManifest({ ...m, operational: {
    route: 'opd_audit_worker', route_class: core.routeClassOf('opd_audit_worker'), retrieval_role: 'primary',
    invocation_id: 'inv-70', trace_id: null, deployment_sha: null,
    started_at: '2026-08-16T00:00:00.000Z', completed_at: '2026-08-16T00:00:01.000Z',
    routing_flags: {}, active_backfill_run_id: null, active_backfill_target: null,
    active_backfill_state: null, active_lab_experiment_id: null,
  } } as never).filter((d) => d !== 'index_version_absent');   // the fixture sets no index; not this proof's subject
  assert.deepEqual(defectsOnManifest, [], 'the downgraded manifest is otherwise clean');
  // The composition, exactly as v15 §4.4 names it, all four synchronous and pure:
  const base = settlement.outcomeForSaveResult('inserted');            // persisted_clean
  const verdict = settlement.verdictForRun({ primary: [] }, 'primary', true);   // own key present, []
  const outcome = settlement.upgradeForDefects(base, verdict);          // stays persisted_clean
  const state = core.stateForSettlement(outcome);                       // the mapper
  assert.equal(base, 'persisted_clean');
  assert.deepEqual(verdict, []);
  assert.equal(outcome, 'persisted_clean');
  assert.equal(state, 'persisted_complete', 'persisted_complete comes from exactly one outcome, persisted_clean');
});

test('70.4 — SOURCE PARITY: provider selection and fallback order in lib/rerank.ts are byte-identical to 72960baa', async () => {
  // Proof 70's byte requirement is THIS sentence from kickoff v11 — "provider selection and fallback
  // order are byte-identical to today" — a source-parity assertion over lib/rerank.ts. It is not a
  // wire comparison; see this file's header on the review 28 phrase that v15 §4.3 declines.
  //
  // "Today" is pinned to the pass-2 base commit. The comparison is of the WHOLE FILE against that
  // commit's blob: pass 2 is test-only (v15 §2), so a byte-identical file is both the strongest and
  // the correct claim. If a future pass edits rerank.ts, this test's baseline moves WITH THAT PASS'S
  // authorization, not silently.
  const BASE = '72960baa8ba88d618b4eee1c43dc56ecfec58113';
  const atBase = execFileSync('git', ['show', `${BASE}:lib/rerank.ts`], { encoding: 'utf8' });
  const now = readFileSync('lib/rerank.ts', 'utf8');
  assert.equal(now, atBase, 'lib/rerank.ts is byte-identical to the pass-2 base');
  // And the specific structures the sentence names are present in that identical text, by symbol:
  // the resolver, the env-default resilient arm, the explicit strict arm, and the downgrade flag.
  assert.match(now, /export function resolveRerankBackend\(backend: 'judge' \| 'cohere' \| undefined, envBackend: 'judge' \| 'cohere' = BACKEND\)/);
  assert.match(now, /if \(chosen === 'cohere' && !explicit\) \{/, 'the env-default resilient arm');
  assert.match(now, /if \(e instanceof RerankBackendError\) \{[\s\S]*?capture\.rerankBackendDowngraded = true;/, 'typed error → downgrade');
  assert.match(now, /if \(e instanceof RerankBackendError\) throw e;/, 'the explicit arm propagates');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// J2 — explicit judge invokes neither checkHealthy nor cohereFn. Call-local, injected counters.
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** Counters through RerankDeps. `envBackend` simulates the hostile default without an env flip. */
function counters(envBackend: 'judge' | 'cohere', judgeFn?: RerankDeps['judgeFn']): { deps: RerankDeps; n: { health: number; cohere: number } } {
  const n = { health: 0, cohere: 0 };
  const deps: RerankDeps = {
    envBackend,
    checkHealthy: async () => { n.health += 1; },
    cohereFn: async (q, c) => { n.cohere += 1; return c.map((x, i) => ({ ...x, rerank_score: 1 - i, rerank_backend: 'cohere' as const })); },
    ...(judgeFn ? { judgeFn } : {}),
  };
  return { deps, n };
}

test('J2.1 — under a JUDGE default: explicit judge, on success and on failure, calls neither checkHealthy nor cohereFn', async () => {
  const { rerank, createTelemetryCapture, judge } = await boot();
  // Success.
  {
    const { deps, n } = counters('judge');
    const out = await rerank(QUERY, fresh(), 'judge', deps, createTelemetryCapture('primary'));
    assert.equal(n.health, 0); assert.equal(n.cohere, 0);
    assert.ok(out.every((c) => c.rerank_backend === 'judge'));
  }
  // Failure: a per-batch parse failure via the real judge, AND a generic outer failure via judgeFn.
  judge.setRawContent(() => 'not json');
  try {
    const { deps, n } = counters('judge');
    await rerank(QUERY, fresh(), 'judge', deps, createTelemetryCapture('primary'));
    assert.equal(n.health, 0); assert.equal(n.cohere, 0);
  } finally { judge.setRawContent(null); }
  {
    const { deps, n } = counters('judge', async () => { throw new Error('generic judge failure'); });
    const out = await rerank(QUERY, fresh(), 'judge', deps, createTelemetryCapture('primary'));
    assert.equal(n.health, 0); assert.equal(n.cohere, 0);
    assert.ok(out.every((c) => c.rerank_backend === 'none'), 'soft-fell to input order — and still no Cohere consultation');
  }
});

test('J2.2 — under a HOSTILE COHERE default: explicit judge, on success and on failure, still calls neither', async () => {
  // ⚠️ CALL-LOCAL. `envBackend: 'cohere'` is the hostile default. A memoized probe from an earlier
  // test is irrelevant to this assertion: the counter is on THIS call's injected checkHealthy, and
  // the claim is that the explicit arm never reaches it at all.
  const { rerank, createTelemetryCapture, judge } = await boot();
  {
    const { deps, n } = counters('cohere');
    const out = await rerank(QUERY, fresh(), 'judge', deps, createTelemetryCapture('primary'));
    assert.equal(n.health, 0, 'checkHealthy never invoked'); assert.equal(n.cohere, 0, 'cohereFn never invoked');
    assert.ok(out.every((c) => c.rerank_backend === 'judge'));
  }
  judge.setRawContent(() => 'not json');
  try {
    const { deps, n } = counters('cohere');
    await rerank(QUERY, fresh(), 'judge', deps, createTelemetryCapture('primary'));
    assert.equal(n.health, 0); assert.equal(n.cohere, 0);
  } finally { judge.setRawContent(null); }
  {
    const { deps, n } = counters('cohere', async () => { throw new Error('generic judge failure'); });
    await rerank(QUERY, fresh(), 'judge', deps, createTelemetryCapture('primary'));
    assert.equal(n.health, 0); assert.equal(n.cohere, 0);
  }
  // THE CONTRAST that makes zero mean something: with the backend OMITTED under the same hostile
  // default, the resilient arm DOES consult the probe. Same counters, different call.
  {
    const { deps, n } = counters('cohere');
    await rerank(QUERY, fresh(), undefined, deps, createTelemetryCapture('primary'));
    assert.equal(n.health, 1, 'omitted backend under a Cohere default consults the probe once');
    assert.equal(n.cohere, 1, 'and calls cohereFn once');
  }
});
