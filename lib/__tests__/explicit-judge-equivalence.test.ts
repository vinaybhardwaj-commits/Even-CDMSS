/**
 * lib/__tests__/explicit-judge-equivalence.test.ts — the request-recorder contract, and J1.
 *
 * GOVERNED BY addendum v15 (signed by V, 16 August 2026), sections 3, 4.2 and 5, under Saul review
 * 27 (which released pass 2) and review 28 (which set the corrections). Kickoff v11 §9 is the
 * numbering authority for J1. Addendum v18 (signed by V, 16 August 2026, under Saul review 29)
 * governs the pass 2 proof repairs in this file: the tuple comparator and its 5.9b guard (§3.2),
 * the socket identity on the observation (§3.7a, §4.2), `Reflect.ownKeys` at all four exhaustive
 * key sites (§3.7b), and 5.4's deterministic acceptance signal (§3.7c). Addendum v19 (signed by V,
 * 16 August 2026, under Saul review 30) governs the recorder repair round: the once-sampled
 * recording decision and its two mid-flight tests 5.2b/5.2c (§3.1), the descriptor-faithful
 * snapshot (§3.2), and the bounded fail-loud acceptance waits in 5.4 and 5.6 (§3.3).
 *
 * WHAT THIS FILE PROVES.
 *   · Each of addendum v15 §5.2 to §5.11 — TEN guarded terms — has at least one executable test
 *     that fails when the behaviour is broken. A contract term with no test is a claim, not a guard.
 *   · J1: the explicit-judge arm and the environment-default-judge arm of `rerank` produce
 *     byte-identical serialized results, byte-identical canonical telemetry payloads, and
 *     byte-identical outbound judge requests, under deterministic collaborators, in three cases —
 *     success, a real batch parse failure, and a generic outer judge failure.
 *
 * WHAT THIS FILE DOES NOT CLAIM (v15 §3.1, the J1 ceiling). J1's wire claim is exactly this and no
 * more: byte-identical HTTP method, path, and entity-body bytes received by the loopback server. It
 * claims nothing about TCP framing, TLS, or headers. The recorder stores none of those, so nothing
 * here can compare them.
 *
 * COLLABORATORS. The real loopback judge in `judge-server-stub.ts` (`startJudgeServer`), the real
 * `rerank` from `lib/rerank.ts`, the real `createTelemetryCapture` and `buildRetrievalPayload` from
 * `lib/retrieval-capture.ts`. No database. No socket to any host but 127.0.0.1, enforced by the
 * connection guard from the same stub.
 *
 * ORDER OF EVALUATION IS LOAD-BEARING (v15 §10.4). `lib/llm.ts` builds its OpenAI client from
 * `OLLAMA_BASE_URL` at module evaluation, and `startJudgeServer` is what sets that variable. So
 * `rerank` and `retrieval-capture` are imported DYNAMICALLY, after the server is listening. A static
 * import at the top of this file would point the judge at whatever the variable held before.
 *
 * TEARDOWN. `startJudgeServer` mutates ten environment variables and restores none of them; this
 * file snapshots all ten before calling it and restores them in `after()`. The connection guard is
 * uninstalled in `after()`. The server is closed in `after()`.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  startJudgeServer, installConnectionGuard, uninstallConnectionGuard, connectionGuardInstalled,
  groupByMarkerSet, sameWireObservations, RECORDER_BODY_LIMIT_BYTES,
  type JudgeServer, type JudgeObservation,
} from './judge-server-stub';
import type { TelemetryCapture } from '../retrieval-capture';
import type { RerankDeps } from '../rerank';

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

// ── Fixture. Two candidates minimum (kickoff §4.5); here five, so one JUDGE_BATCH slice is full and
// a second exists — two batches, which is what makes marker-set grouping (§5.9) mean something.
// Each passage opens with a unique marker that sits inside MAX_SNIPPET_CHARS and survives the
// whitespace collapse in `rerankJudge`.
const CANDIDATES = [
  { id: 1, text: 'MRKA1 a clinical passage used only by this proof, numbered one.' },
  { id: 2, text: 'MRKB2 a clinical passage used only by this proof, numbered two.' },
  { id: 3, text: 'MRKC3 a clinical passage used only by this proof, numbered three.' },
  { id: 4, text: 'MRKD4 a clinical passage used only by this proof, numbered four.' },
  { id: 5, text: 'MRKE5 a clinical passage used only by this proof, numbered five.' },
  { id: 6, text: 'MRKF6 a clinical passage used only by this proof, numbered six.' },
];
const MARKERS = CANDIDATES.map((c) => c.text.split(' ')[0]);
// Scores chosen to REORDER, so a run that returned input order would be visibly wrong.
const SCORES: Record<string, number> = { MRKA1: 2, MRKB2: 9, MRKC3: 4, MRKD4: 10, MRKE5: 1, MRKF6: 7 };
const QUERY = 'a clinical question used only by this proof';

type Booted = {
  judge: JudgeServer;
  rerank: typeof import('../rerank').rerank;
  createTelemetryCapture: typeof import('../retrieval-capture').createTelemetryCapture;
  buildRetrievalPayload: typeof import('../retrieval-capture').buildRetrievalPayload;
  llm: { chat: { completions: { create: (...a: unknown[]) => Promise<unknown> } } };
};
let booted: Booted | null = null;

/** Server first, then the guard, then the dynamic imports. The `try` guards the window between
 *  "server listening" and "handle assigned": an import that throws there would otherwise leak a
 *  listener the `after()` hook cannot see. The original error is rethrown unchanged. */
async function boot(): Promise<Booted> {
  if (booted) return booted;
  const judge = await startJudgeServer(SCORES);
  try {
    installConnectionGuard();
    const rerankMod = await import('../rerank');
    const captureMod = await import('../retrieval-capture');
    const llmMod = await import('../llm');
    booted = {
      judge, rerank: rerankMod.rerank,
      createTelemetryCapture: captureMod.createTelemetryCapture,
      buildRetrievalPayload: captureMod.buildRetrievalPayload,
      llm: llmMod.llm as unknown as Booted['llm'],
    };
  } catch (e) {
    await judge.close().catch(() => {});
    throw e;
  }
  return booted;
}

after(async () => {
  uninstallConnectionGuard();
  if (booted) { await booted.judge.close().catch(() => {}); booted = null; }
  restoreEnv();
});

/** Raw POST to the loopback server, bypassing the SDK, for the recorder-contract cases.
 *  `agent` is optional: the socket-reuse case (5.5b, v18 §3.7a) passes a keep-alive agent so two
 *  requests share ONE socket; every other case uses the default per-request connection. */
function post(port: number, path: string, body: Buffer | string, method = 'POST', agent?: http.Agent): Promise<{ status: number; body: string }> {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method, agent, headers: { 'content-type': 'application/json', 'content-length': buf.length } },
      (res) => { const c: Buffer[] = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(c).toString('utf8') })); },
    );
    req.on('error', reject);
    req.end(buf);
  });
}

/** Run one recorder case with recording on and a clean store, restoring both in `finally`. */
async function recorded<T>(fn: (judge: JudgeServer) => Promise<T>): Promise<T> {
  const { judge } = await boot();
  await judge.settled();
  judge.setRecording(true);
  judge.resetObservations();
  try { return await fn(judge); } finally {
    // ⚠️ WAIT FOR THE SERVER, NOT THE CLIENT. The client's response `end` fires BEFORE the server's
    // `finish`, and the in-flight counter decrements on the server's. A reset here without waiting
    // throws "in flight" — and a throw inside `finally` poisons every later case in the file. That
    // is exactly what §5.6 is for: it refused, correctly, and the fix is to wait, not to relax it.
    await judge.settled();
    judge.setRecording(false);
    judge.resetObservations();
  }
}

/** POST, then wait until the server has finished its response, so the in-flight count is 0. */
async function postSettled(judge: JudgeServer, path: string, body: Buffer | string, method = 'POST', agent?: http.Agent) {
  const r = await post(judge.port, path, body, method, agent);
  await judge.settled();
  return r;
}

/**
 * BOUNDED, FAIL-LOUD acceptance wait (v19 §3.3). `seq` is assigned at acceptance and acceptance is
 * where the in-flight counter increments, so polling the counter waits for exactly the accepting
 * event. Three properties, because the previous poll had none of them and could hang the file:
 *   1. BOUNDED — on expiry it fails BY NAME (the rejection carries `what` and surfaces as the named
 *      test's failure), never polling forever.
 *   2. REQUEST-ERROR REJECTION — a socket error on the held request rejects the wait instead of
 *      stalling it. The listener stays attached afterwards, so a late error cannot crash the
 *      process as an unhandled 'error' event either.
 *   3. The CALLER puts the held request's release in an OUTER `finally`, so the release runs
 *      whether or not this wait resolved. That is the caller's half of the contract; 5.4 and 5.6
 *      both hold it.
 */
function waitForInFlight(judge: JudgeServer, target: number, held: http.ClientRequest, what: string, timeoutMs = 5000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const startedAt = Date.now();
    let done = false;
    const fail = (e: Error) => { if (!done) { done = true; reject(e); } };
    held.on('error', (e) => fail(new Error(`acceptance wait for ${what}: request error: ${e.message}`)));
    const tick = () => {
      if (done) return;
      if (judge.inFlight() === target) { done = true; resolve(); return; }
      if (Date.now() - startedAt > timeoutMs) {
        fail(new Error(`acceptance wait timed out after ${timeoutMs} ms waiting for ${what}`));
        return;
      }
      setImmediate(tick);
    };
    tick();
  });
}

/**
 * BOUNDED wait for the server's 100 Continue (v19 §3.1's mid-flight tests). A request accepted
 * while recording is OFF moves no counter, so its acceptance is observed through
 * `Expect: 100-continue`: the server auto-writes `100 Continue` at request-head parse, in the same
 * synchronous block that runs the request handler and samples the recording decision — so the
 * client's 'continue' event proves the decision has been sampled. Same three properties as
 * `waitForInFlight`: bounded, request-error rejecting, and the caller releases in an outer
 * `finally`.
 */
function waitForContinue(held: http.ClientRequest, what: string, timeoutMs = 5000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; reject(new Error(`100-continue wait timed out after ${timeoutMs} ms waiting for ${what}`)); }
    }, timeoutMs);
    held.on('continue', () => { if (!done) { done = true; clearTimeout(timer); resolve(); } });
    held.on('error', (e) => {
      if (!done) { done = true; clearTimeout(timer); reject(new Error(`100-continue wait for ${what}: request error: ${e.message}`)); }
    });
  });
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// The connection guard (v15 §10.3 item 5): one test proves it refuses a non-loopback host.
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('guard.1 — the connection guard refuses a non-loopback host, synchronously, naming the host', async () => {
  await boot();
  assert.ok(connectionGuardInstalled(), 'the guard is installed for the whole file');
  // ⚠️ SYNCHRONOUS THROW (v15 §10.2 fact 2): it escapes `http.get` rather than arriving as an
  // `error` event, so this is try/catch and not a listener.
  let caught: Error | null = null;
  try {
    const r = http.get('http://10.255.255.1:9/refused', () => {});
    r.on('error', () => {});
  } catch (e) { caught = e as Error; }
  assert.ok(caught, 'the guard threw');
  assert.match(caught!.message, /10\.255\.255\.1/, 'the error names the refused host');
  assert.match(caught!.message, /only 127\.0\.0\.1 is permitted/);
  // …and loopback is permitted, through the same seam, so the refusal above is not "everything".
  const { judge } = await boot();
  const ok = await postSettled(judge, '/v1/probe', '{}');
  assert.equal(ok.status, 200);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// The ten guarded terms, addendum v15 §5.2 to §5.11. One executable test each, at least.
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('5.2 — recording is OFF by default: no observation is stored and the counter does not advance', async () => {
  const { judge } = await boot();
  judge.setRecording(false);
  judge.resetObservations();
  await postSettled(judge, '/v1/off', '{"messages":[]}');
  assert.deepEqual(judge.snapshot(), [], 'nothing recorded while off');
  // The counter did not advance either: the first observation after enabling is seq 0.
  judge.setRecording(true);
  try {
    await postSettled(judge, '/v1/on', '{"messages":[]}');
    const snap = judge.snapshot();
    assert.equal(snap.length, 1);
    assert.equal(snap[0].seq, 0, 'the counter did not advance while recording was off');
  } finally { await judge.settled(); judge.setRecording(false); judge.resetObservations(); }
});

test('5.2b — MID-FLIGHT TOGGLE off→on: a request accepted while recording was off produces NO observation, and the in-flight count returns to zero', async () => {
  // v19 §3.1. The recording decision is sampled ONCE, at acceptance, as `recordThisRequest`. Before
  // that fix, the push guard at the `end` handler re-read the flag: a request accepted while
  // recording was OFF, with recording toggled ON mid-flight, produced an observation with
  // `seq: -1` — an observation for a request the recorder never accepted.
  const { judge } = await boot();
  await judge.settled();
  judge.setRecording(false);
  judge.resetObservations();
  try {
    // The in-flight counter does not move for an unrecorded request, so acceptance is observed
    // through Expect: 100-continue — see `waitForContinue`.
    const reqA = http.request({
      host: '127.0.0.1', port: judge.port, path: '/v1/mid-off-on', method: 'POST',
      headers: { 'content-length': 4, Expect: '100-continue' },
    });
    const aDone = new Promise<void>((resolve, reject) => {
      reqA.on('response', (res) => { res.resume(); res.on('end', resolve); });
      reqA.on('error', reject);
    });
    void aDone.catch(() => {});   // handled later at `await aDone`
    try {
      await waitForContinue(reqA, "request '/v1/mid-off-on' acceptance");
      judge.setRecording(true);            // ← toggled ON while the request is in flight
    } finally {
      reqA.end('ABCD');   // outer finally — the body, released whether or not the wait resolved
    }
    await aDone;
    await judge.settled();
    // The in-flight count returned to zero — the leak here is the failure mode that hides behind a
    // passing observation check (v19 §2).
    assert.equal(judge.inFlight(), 0, 'no in-flight leak from the mid-flight toggle');
    // The accepted-while-off request produced NO observation…
    assert.deepEqual(judge.snapshot(), [], 'no observation for a request accepted while recording was off');
    // …and the sequence counter never advanced for it: the next recorded request is seq 0, real,
    // never -1.
    const r = await postSettled(judge, '/v1/mid-off-on-next', '{}');
    assert.equal(r.status, 200);
    const snap = judge.snapshot();
    assert.equal(snap.length, 1);
    assert.equal(snap[0].seq, 0, 'the counter never advanced for the unrecorded request');
  } finally { await judge.settled(); judge.setRecording(false); judge.resetObservations(); }
});

test('5.2c — MID-FLIGHT TOGGLE on→off: a request accepted while recording was on produces a COMPLETE observation with a real seq, and the in-flight count returns to zero', async () => {
  // v19 §3.1, the other direction. Before the sampled decision, the push guard re-read the flag at
  // the `end` handler: a request ACCEPTED with recording on — seq assigned, in-flight incremented —
  // whose recording was toggled off mid-flight LOST its observation, and only the close handler's
  // own acceptance-time registration kept the counter from leaking.
  const { judge } = await boot();
  await judge.settled();
  judge.setRecording(true);
  judge.resetObservations();
  try {
    const reqA = http.request({ host: '127.0.0.1', port: judge.port, path: '/v1/mid-on-off', method: 'POST', headers: { 'content-length': 10 } });
    const aDone = new Promise<void>((resolve, reject) => {
      reqA.on('response', (res) => { res.resume(); res.on('end', resolve); });
      reqA.on('error', reject);
    });
    void aDone.catch(() => {});   // handled later at `await aDone`
    reqA.write('12345');
    try {
      await waitForInFlight(judge, 1, reqA, "request '/v1/mid-on-off' acceptance");
      judge.setRecording(false);           // ← toggled OFF while the request is in flight
    } finally {
      reqA.end('67890');   // outer finally — released whether or not the wait resolved
    }
    await aDone;
    // `settled()` returning at all proves the decrement ran off the SAMPLED decision, and the
    // direct assertion pins it: the in-flight count is back to zero, no leak.
    await judge.settled();
    assert.equal(judge.inFlight(), 0, 'no in-flight leak from the mid-flight toggle');
    const snap = judge.snapshot();
    assert.equal(snap.length, 1, 'the accepted-while-on request WAS recorded — the observation is not lost');
    assert.equal(snap[0].path, '/v1/mid-on-off');
    assert.notEqual(snap[0].seq, -1, 'a real seq, never -1');
    assert.ok(snap[0].seq >= 0);
    assert.equal(snap[0].body.length, 10, 'the COMPLETE body was recorded');
    assert.equal(snap[0].overflowed, false);
  } finally { await judge.settled(); judge.setRecording(false); judge.resetObservations(); }
});

test('5.3 — one observation holds seq, socketId, method, path, and the exact body bytes; nothing else', async () => {
  await recorded(async (judge) => {
    const body = Buffer.from('{"messages":[{"role":"user","content":"MRKA1 exact bytes"}]}');
    await postSettled(judge, '/v1/chat/completions?x=1', body, 'POST');
    const [o] = judge.snapshot();
    // ⚠️ `Reflect.ownKeys`, NOT `Object.keys` (v18 §3.7b, review 29 finding 7). `Object.keys` sees
    // only enumerable string keys, so a non-enumerable or symbol-keyed field passed this exhaustive
    // check unchallenged — and this field-set comparison is what would notice an extra key at all.
    // Every key is wrapped in String(k): a symbol throws on implicit string coercion, and a
    // deepEqual over a key list containing symbols needs the same treatment.
    // `socketId` is the sixth field, permitted by addendum v18 §4.2 (amending v15 §5.3).
    assert.deepEqual(Reflect.ownKeys(o).map((k) => String(k)).sort(),
      ['body', 'method', 'overflowed', 'path', 'seq', 'socketId'],
      'exactly six fields — no headers, no authorization values, no timestamps, nothing derived');
    assert.equal(o.method, 'POST');
    assert.equal(o.path, '/v1/chat/completions?x=1', 'req.url as received, unmodified');
    assert.ok(Buffer.isBuffer(o.body));
    assert.ok(o.body.equals(body), 'the exact entity-body bytes');
    assert.equal(o.overflowed, false);
    assert.equal(typeof o.socketId, 'number');
    // The observation carries no header-shaped key under any name — symbol keys included.
    for (const k of Reflect.ownKeys(o)) assert.equal(/header|auth|content-type|time/i.test(String(k)), false, `no ${String(k)}`);
  });
});

test('5.4 — sequence numbers are assigned at ACCEPTANCE, monotonic from 0, and never reused', async () => {
  await recorded(async (judge) => {
    // Request A arrives first and finishes LAST; B arrives second and finishes first. A must be 0.
    const reqA = http.request({ host: '127.0.0.1', port: judge.port, path: '/v1/a', method: 'POST', headers: { 'content-length': 4 } });
    const aDone = new Promise<void>((resolve, reject) => {
      reqA.on('response', (res) => { res.resume(); res.on('end', resolve); });
      reqA.on('error', reject);
    });
    // If the acceptance wait rejects, the try below throws before `aDone` is awaited; this marks
    // the rejection handled so it cannot surface as an unhandled rejection, while `await aDone`
    // later still observes it.
    void aDone.catch(() => {});
    reqA.write('{"');           // half the body — the server has ACCEPTED it and assigned its seq
    // ⚠️ DETERMINISTIC ACCEPTANCE SIGNAL (v18 §3.7c), now BOUNDED and FAIL-LOUD (v19 §3.3). The
    // first version of this wait slept 30 ms — an unacknowledged timing assumption. The v18 repair
    // replaced the sleep with an unbounded counter poll, which removed the race but could hang the
    // file: no timeout, no request-error rejection, and a release that did not cover a failure
    // before the wait resolved. `waitForInFlight` is bounded and rejects on request error, and the
    // release (`reqA.end`) sits in the OUTER finally below, so it runs whether or not the wait
    // resolved.
    //
    // ⚠️ PLAIN `post` for B, NOT `postSettled`. A is deliberately held open, so `settled()` cannot
    // resolve until A is released; awaiting it here would deadlock the test against its own fixture.
    try {
      await waitForInFlight(judge, 1, reqA, "request A ('/v1/a') acceptance");
      await post(judge.port, '/v1/b', '{"b":1}');   // B arrives second, completes first
    } finally {
      reqA.end('a"}');   // the release — outer finally, whether or not the acceptance wait resolved
    }
    await aDone;
    await judge.settled();
    const snap = judge.snapshot();
    const byPath = Object.fromEntries(snap.map((o) => [o.path, o.seq]));
    assert.equal(byPath['/v1/a'], 0, 'A arrived first, so A is 0 — even though it finished last');
    assert.equal(byPath['/v1/b'], 1);
    // Monotonic and never reused: a third request is 2, and after reset the counter is 0 again.
    await postSettled(judge, '/v1/c', '{}');
    assert.equal(judge.snapshot().find((o) => o.path === '/v1/c')!.seq, 2);
    judge.resetObservations();
    await postSettled(judge, '/v1/d', '{}');
    assert.equal(judge.snapshot()[0].seq, 0, 'resetObservations returns the counter to 0');
  });
});

test('5.5a — the boundary: 1048576 bytes is ACCEPTED and recorded in full', async () => {
  await recorded(async (judge) => {
    // ⚠️ A LITERAL, NOT THE CONSTANT (addendum v17 §3.1, mutation row 1). This was
    // `Buffer.alloc(RECORDER_BODY_LIMIT_BYTES, …)`, and the mutation table showed why that is not a
    // boundary test: a test whose INPUT is computed from the value under test moves with that value
    // and cannot detect a change to it. When the constant was mutated to 1048577, this test kept
    // sending "the constant" and still passed the boundary it was meant to pin. The number below is
    // the boundary v15 §5.5 states, written down so a later reader does not "tidy" it back into an
    // expression. The constant's own value is pinned SEPARATELY, three lines down.
    const exact = Buffer.alloc(1048576, 0x20);
    const r = await postSettled(judge, '/v1/exact', exact);
    assert.equal(r.status, 200, 'exactly the limit is accepted');
    const [o] = judge.snapshot();
    assert.equal(o.overflowed, false);
    assert.equal(o.body.length, 1048576, 'recorded in full');
    // The source pin, kept as a separate check. It is useful; it is NOT the boundary test.
    assert.equal(RECORDER_BODY_LIMIT_BYTES, 1048576, 'the limit is 1048576 exactly');
  });
});

test('5.5b — the boundary: 1048577 bytes is REJECTED with 413, an empty JSON body, an overflowed observation, and the SAME undestroyed socket carries the next request', async () => {
  await recorded(async (judge) => {
    // ⚠️ A LITERAL, NOT `RECORDER_BODY_LIMIT_BYTES + 1` (addendum v17 §3.1, mutation row 1). The
    // derived form was the defect the mutation table found: with the constant mutated to 1048577,
    // this test sent 1048578, which the mutated limit still rejected, and the test that exists to
    // pin the rejection boundary at 1048577 passed. Written as the number so it cannot move.
    //
    // ⚠️ ONE SOCKET FOR BOTH REQUESTS (v18 §3.7a, review 29 finding 7). "The socket was not
    // destroyed" needs the SAME socket to carry the follow-up request — an earlier version of this
    // test simply issued another request, which proved only that the server still listens, because
    // a default `http.request` opens a fresh connection every time. A keep-alive agent with
    // maxSockets 1 pins both requests to one socket, and the observation's `socketId` (v18 §4.2)
    // is what makes the reuse ASSERTABLE: different `seq`, same `socketId`, is reuse proven.
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const over = Buffer.alloc(1048577, 0x20);
      const r = await postSettled(judge, '/v1/over', over, 'POST', agent);
      assert.equal(r.status, 413, 'one byte over is rejected');
      assert.equal(r.body, '{}', 'an empty JSON object as the body, response ended normally');
      // The socket was not destroyed: the SAME socket carries another request and gets 200.
      const again = await postSettled(judge, '/v1/after', '{}', 'POST', agent);
      assert.equal(again.status, 200);
      const snap = judge.snapshot();
      const o = snap.find((x) => x.path === '/v1/over');
      const follow = snap.find((x) => x.path === '/v1/after');
      assert.ok(o, 'the overflow observation exists');
      assert.ok(follow, 'the follow-up observation exists');
      assert.equal(o.overflowed, true);
      assert.equal(o.body.length, 0, 'zero-length body — the raw bytes were discarded, never buffered');
      assert.equal(o.method, 'POST');
      assert.equal(o.path, '/v1/over');
      assert.equal(typeof o.seq, 'number');
      assert.notEqual(o.seq, follow.seq, 'two requests, two sequence numbers');
      assert.equal(o.socketId, follow.socketId,
        'the SAME undestroyed socket carried both requests — reuse proven, not inferred');
    } finally { agent.destroy(); }
  });
});

test('5.6 — while a request is in flight, BOTH snapshot and resetObservations throw, naming the count', async () => {
  await recorded(async (judge) => {
    const reqH = http.request({ host: '127.0.0.1', port: judge.port, path: '/v1/held', method: 'POST', headers: { 'content-length': 10 } });
    const held = new Promise<void>((resolve, reject) => {
      reqH.on('response', (res) => { res.resume(); res.on('end', resolve); });
      reqH.on('error', reject);
    });
    void held.catch(() => {});   // handled later at `await held`; never an unhandled rejection
    reqH.write('12345');
    // ⚠️ RELEASE IN A `finally` (addendum v17 §3.2, mutation rows 6 and 7). The release used to sit
    // AFTER these two assertions. When the in-flight refusal was mutated away, `assert.throws`
    // failed — and the held request was then never released, so `recorded()`'s own `finally`
    // waited on `settled()` forever and the whole file timed out at 60 s. The mutation WAS detected,
    // but as a nameless timeout rather than as `not ok 5.6`. A failed assertion must still let the
    // request complete, so the failure is reported by name.
    //
    // ⚠️ THE 30 ms SLEEP IS GONE (v19 §3.3). It was left in under v18, which authorized only 5.4's
    // repair; v19 authorizes this one. The bounded, fail-loud acceptance wait replaces it, and the
    // release now sits in the OUTER finally, covering a failure of the wait itself. A test that
    // hangs instead of failing has an invisible failure mode — the same defect the mutation table
    // found here two rounds ago.
    try {
      await waitForInFlight(judge, 1, reqH, "the held request ('/v1/held') acceptance");
      assert.throws(() => judge.snapshot(), /1 request\(s\) in flight/, 'snapshot refuses and names the count');
      assert.throws(() => judge.resetObservations(), /1 request\(s\) in flight/, 'reset refuses and names the count');
    } finally {
      reqH.end('67890');   // outer finally — released whether or not the acceptance wait resolved
    }
    await held;
    await judge.settled();
    // After the response ends the counter is back to zero and both succeed.
    assert.equal(judge.snapshot().length, 1);
    judge.resetObservations();
    assert.deepEqual(judge.snapshot(), []);
  });
});

test('5.6b — the in-flight counter decrements on a 413 response too', async () => {
  await recorded(async (judge) => {
    await postSettled(judge, '/v1/over', Buffer.alloc(1048577));   // literal, per v17 §3.1
    // If the 413 path did not decrement, this would throw.
    assert.doesNotThrow(() => judge.snapshot());
  });
});

test('5.7 — snapshot is DEFENSIVE: mutating the array, an object, or a Buffer leaves recorder state unchanged', async () => {
  await recorded(async (judge) => {
    const body = Buffer.from('{"k":"MRKA1 original"}');
    await postSettled(judge, '/v1/one', body);
    const first = judge.snapshot();
    // Mutate everything returned.
    first[0].body.fill(0x58);                 // write into the Buffer
    (first[0] as { path: string }).path = '/tampered';
    first.push({ seq: 99, socketId: 99, method: 'GET', path: '/x', body: Buffer.alloc(0), overflowed: false });
    // A second snapshot returns the ORIGINAL values.
    const second = judge.snapshot();
    assert.equal(second.length, 1, 'the pushed element did not reach the store');
    assert.equal(second[0].path, '/v1/one', 'the object write did not reach the store');
    assert.ok(second[0].body.equals(body), 'the Buffer write did not reach the store');
    assert.notEqual(second[0].body, first[0].body, 'different Buffer objects');
    assert.notEqual(second[0], first[0], 'different observation objects');
    assert.notEqual(second, first, 'different arrays');
  });
});

test('5.8 — two identical requests produce two observations; the recorder never deduplicates', async () => {
  await recorded(async (judge) => {
    const body = '{"messages":[{"role":"user","content":"MRKA1 identical"}]}';
    await postSettled(judge, '/v1/same', body);
    await postSettled(judge, '/v1/same', body);
    const snap = judge.snapshot();
    assert.equal(snap.length, 2, 'two, not one');
    assert.ok(snap[0].body.equals(snap[1].body));
    assert.equal(snap[0].path, snap[1].path);
    assert.notEqual(snap[0].seq, snap[1].seq, 'distinct sequence numbers');
    // And the comparison helper preserves multiplicity: the marker group has TWO bodies.
    const g = groupByMarkerSet(snap, ['MRKA1']);
    assert.equal(g.get('MRKA1')!.length, 2);
  });
});

test('5.9 — comparison groups by marker SET, not arrival order', async () => {
  // Two runs whose sockets completed in opposite orders carry the same multiset of marker-keyed
  // bodies and must compare equal. Two runs whose bodies differ under one marker set must not.
  const mk = (seq: number, marker: string, extra = ''): JudgeObservation => ({
    seq, socketId: seq, method: 'POST', path: '/v1/chat/completions',
    body: Buffer.from(`{"messages":[{"role":"user","content":"PASSAGES: [0] ${marker} passage${extra}"}]}`),
    overflowed: false,
  });
  const runA = [mk(0, 'MRKA1'), mk(1, 'MRKB2')];
  const runB = [mk(0, 'MRKB2'), mk(1, 'MRKA1')];   // opposite arrival order
  assert.equal(sameWireObservations(runA, runB, ['MRKA1', 'MRKB2']), null,
    'same multiset of marker-keyed bodies, whatever order the sockets completed in');
  const runC = [mk(0, 'MRKA1'), mk(1, 'MRKB2', ' CHANGED')];
  const why = sameWireObservations(runA, runC, ['MRKA1', 'MRKB2']);
  assert.ok(why && /MRKB2/.test(why), `a differing body is caught and NAMED by marker set: ${why}`);
  // The grouping itself: keyed by sorted marker subset, order-independent.
  const g = groupByMarkerSet(runB, ['MRKB2', 'MRKA1']);
  assert.deepEqual([...g.keys()].sort(), ['MRKA1', 'MRKB2']);
});

test('5.9b — the comparator keeps method, path and body as ONE tuple: a swap between marker groups is a difference', () => {
  // Review 29 finding 2 / v18 §3.2. The old comparator grouped BODIES by marker set and compared
  // method and path separately, as a global sorted multiset — so two observations could swap their
  // method or path between marker groups and still compare equal, and test 5.9 mutates only a body,
  // so nothing caught it. The group value is now one Buffer, method + path + NUL + body, and this
  // test is the guard: without it the repair would be unguarded and the defect merely moved.
  const mk = (seq: number, marker: string, path: string, method = 'POST'): JudgeObservation => ({
    seq, socketId: seq, method, path,
    body: Buffer.from(`{"messages":[{"role":"user","content":"PASSAGES: [0] ${marker} passage"}]}`),
    overflowed: false,
  });
  // Same bodies, same GLOBAL path multiset — but the paths have swapped marker groups.
  const runA = [mk(0, 'MRKA1', '/v1/chat/completions'), mk(1, 'MRKB2', '/v1/elsewhere')];
  const runB = [mk(0, 'MRKA1', '/v1/elsewhere'), mk(1, 'MRKB2', '/v1/chat/completions')];
  const whyPath = sameWireObservations(runA, runB, ['MRKA1', 'MRKB2']);
  assert.ok(whyPath !== null, 'a path swapped between marker groups is reported as a difference');
  // A method swap between marker groups likewise — the global method multiset is unchanged.
  const runC = [mk(0, 'MRKA1', '/v1/x', 'POST'), mk(1, 'MRKB2', '/v1/x', 'PUT')];
  const runD = [mk(0, 'MRKA1', '/v1/x', 'PUT'), mk(1, 'MRKB2', '/v1/x', 'POST')];
  assert.ok(sameWireObservations(runC, runD, ['MRKA1', 'MRKB2']) !== null,
    'a method swapped between marker groups is reported as a difference');
  // Positive control: identical tuples still compare equal, whatever the arrival order.
  const runE = [mk(0, 'MRKB2', '/v1/elsewhere'), mk(1, 'MRKA1', '/v1/chat/completions')];
  assert.equal(sameWireObservations(runA, runE, ['MRKA1', 'MRKB2']), null,
    'same tuples in a different arrival order compare equal');
});

test('5.10 — resetObservations clears observations and the counter and NOTHING in responder configuration', async () => {
  const { judge } = await boot();
  judge.setRecording(true);
  try {
    // Configure every responder knob to a non-default value.
    judge.setScores({ MRKA1: 3 });
    judge.setRawContent(() => '{"0":7}');
    judge.setIncludeUsage(true);
    judge.setExpansion('a distinctive expansion paragraph');
    judge.setEmbeddingOverride(() => [0.5, 0.5]);
    judge.setChatDiscrimination(false);
    await postSettled(judge, '/v1/x', '{}');
    assert.equal(judge.snapshot().length, 1);
    judge.resetObservations();
    assert.deepEqual(judge.snapshot(), [], 'observations cleared');
    // Now PROVE each responder setting survived, by observing the responder's behaviour.
    // Raw content survives: a judge chat returns exactly the raw string.
    const chat = await postSettled(judge, '/v1/chat/completions',
      JSON.stringify({ messages: [{ role: 'system', content: 'You are a clinical relevance judge' }, { role: 'user', content: 'PASSAGES:\n[0] MRKA1 p' }] }));
    const parsed = JSON.parse(chat.body) as { choices: Array<{ message: { content: string } }>; usage?: unknown };
    assert.equal(parsed.choices[0].message.content, '{"0":7}', 'raw content survived the reset');
    assert.ok(parsed.usage, 'usage inclusion survived the reset');
    // Chat discrimination OFF survives: an expansion-shaped system prompt is answered by the JUDGE
    // responder (raw content), not the expansion text.
    const exp = await postSettled(judge, '/v1/chat/completions',
      JSON.stringify({ messages: [{ role: 'system', content: 'You are a medical query rewriter' }, { role: 'user', content: 'q' }] }));
    assert.equal((JSON.parse(exp.body) as typeof parsed).choices[0].message.content, '{"0":7}',
      'chat discrimination stayed OFF across the reset');
    // Embedding override survives.
    const emb = await postSettled(judge, '/v1/embeddings', JSON.stringify({ input: 'x', model: 'm' }));
    const vec = JSON.parse(emb.body) as { data: Array<{ embedding: string }> };
    const decoded = Buffer.from(vec.data[0].embedding, 'base64');
    assert.equal(decoded.length, 8, 'the two-element override vector survived (2 × float32)');
    // Expansion text: prove it by turning discrimination back ON and asking.
    judge.setChatDiscrimination(true);
    const exp2 = await postSettled(judge, '/v1/chat/completions',
      JSON.stringify({ messages: [{ role: 'system', content: 'You are a medical query rewriter' }, { role: 'user', content: 'q' }] }));
    assert.equal((JSON.parse(exp2.body) as typeof parsed).choices[0].message.content, 'a distinctive expansion paragraph',
      'expansion text survived the reset');
    // Scores survive: with raw content cleared, the judge scores MRKA1 as 3.
    judge.setRawContent(null);
    const sc = await postSettled(judge, '/v1/chat/completions',
      JSON.stringify({ messages: [{ role: 'system', content: 'You are a clinical relevance judge' }, { role: 'user', content: 'PASSAGES:\n[0] MRKA1 p' }] }));
    assert.equal((JSON.parse(sc.body) as typeof parsed).choices[0].message.content, '{"0":3}', 'scores survived the reset');
  } finally {
    // Restore the responder to the file's defaults for later cases.
    judge.setScores(SCORES); judge.setRawContent(null); judge.setIncludeUsage(false);
    judge.setEmbeddingOverride(null); judge.setChatDiscrimination(true);
    await judge.settled();
    judge.setRecording(false); judge.resetObservations();
  }
});

test('5.11 — the parsed `requests` API is unchanged: same fields, same push sites, same arrival order, and JudgeRequest gains no field', async () => {
  const { judge } = await boot();
  judge.setRecording(true);
  const before = judge.requests.length;
  try {
    // One of each kind, in a known order: judge chat, expansion chat, embedding.
    await postSettled(judge, '/v1/chat/completions',
      JSON.stringify({ model: 'm', temperature: 0, max_tokens: 5, messages: [{ role: 'system', content: 'You are a clinical relevance judge' }, { role: 'user', content: 'PASSAGES:\n[0] MRKA1 p' }] }));
    await postSettled(judge, '/v1/chat/completions',
      JSON.stringify({ model: 'm', temperature: 0, max_tokens: 5, messages: [{ role: 'system', content: 'You are a medical query rewriter' }, { role: 'user', content: 'q' }] }));
    await postSettled(judge, '/v1/embeddings', JSON.stringify({ model: 'e', input: 'the input' }));
    const added = judge.requests.slice(before);
    assert.deepEqual(added.map((r) => r.kind), ['judge', 'expansion', 'embedding'], 'arrival order across all three kinds');
    // The field set of JudgeRequest, exactly, on each kind. A recorder field here would fail this.
    // ⚠️ `Reflect.ownKeys` at every site, with String(k) before any regex or deepEqual (v18 §3.7b):
    // `Object.keys` sees only enumerable string keys, so a non-enumerable or symbol-keyed recorder
    // field would have passed both this exhaustive field-set check and the regex loop below.
    const FIELDS = ['kind', 'url', 'model', 'system', 'user', 'temperature', 'maxTokens', 'markers'];
    const ownKeys = (r: object) => Reflect.ownKeys(r).map((k) => String(k)).sort();
    assert.deepEqual(ownKeys(added[0]), [...FIELDS].sort(), 'judge request carries the parsed fields and nothing else');
    assert.deepEqual(ownKeys(added[1]), [...FIELDS].sort(), 'expansion request likewise');
    assert.deepEqual(ownKeys(added[2]), [...FIELDS, 'input'].sort(), 'embedding adds only its own optional `input`');
    for (const r of added) {
      for (const k of Reflect.ownKeys(r)) assert.equal(/seq|body|overflow|observ/i.test(String(k)), false, `no recorder field ${String(k)} on JudgeRequest`);
    }
    // And the two stores are independent: three parsed requests, three observations, no cross-write.
    assert.equal(judge.snapshot().length, 3);
  } finally { await judge.settled(); judge.setRecording(false); judge.resetObservations(); }
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// J1 — explicit judge versus environment-default judge, three cases.
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Run `rerank` once on one arm, with recording on, and return everything J1 compares.
 *
 * The EXPLICIT arm passes `backend: 'judge'`. The ENV-DEFAULT arm passes `backend: undefined` and
 * simulates the environment default through `deps.envBackend`, which exists for exactly this
 * (`RerankDeps.envBackend` in `lib/rerank.ts`). Both arms use the real `rerankJudge` — no `judgeFn`
 * is injected — so both really dial the loopback server.
 */
async function runArm(arm: 'explicit' | 'env', extraDeps: RerankDeps = {}) {
  const { judge, rerank, createTelemetryCapture, buildRetrievalPayload } = await boot();
  judge.setRecording(true);
  judge.resetObservations();
  try {
    const capture = createTelemetryCapture('primary');
    const backend = arm === 'explicit' ? ('judge' as const) : undefined;
    const deps: RerankDeps = arm === 'explicit' ? extraDeps : { ...extraDeps, envBackend: 'judge' };
    const result = await rerank(QUERY, CANDIDATES.map((c) => ({ ...c })), backend, deps, capture);
    const payload = buildRetrievalPayload(capture, { hmacKey: 'j1-key', scorerContext: '' });
    await judge.settled();
    return {
      wire: judge.snapshot(),
      serialized: JSON.stringify(result),
      payload: JSON.stringify(payload),
      capture,
    };
  } finally { await judge.settled(); judge.setRecording(false); judge.resetObservations(); }
}

function assertJ1Equal(a: Awaited<ReturnType<typeof runArm>>, b: Awaited<ReturnType<typeof runArm>>, label: string) {
  // ⚠️ NON-VACUITY FIRST (v15 §4.2). Both arms must have produced NONEMPTY wire observations, or
  // "byte-identical" would be comparing two empty sets.
  assert.ok(a.wire.length > 0, `${label}: the explicit arm sent at least one request`);
  assert.ok(b.wire.length > 0, `${label}: the env-default arm sent at least one request`);
  // The wire claim, and ONLY the wire claim (v15 §3.1): method, path, entity-body bytes.
  const why = sameWireObservations(a.wire, b.wire, MARKERS);
  assert.equal(why, null, `${label}: outbound judge requests differ — ${why}`);
  // Serialized results, byte-identical.
  assert.equal(a.serialized, b.serialized, `${label}: serialized results differ`);
  // Canonical telemetry payloads, byte-identical. No field difference is permitted.
  assert.equal(a.payload, b.payload, `${label}: canonical telemetry payloads differ`);
}

test('J1.1 — SUCCESS: explicit judge and env-default judge are byte-identical on the wire, in results, and in payload', async () => {
  const { judge } = await boot();
  judge.setRawContent(null); judge.setScores(SCORES);
  const a = await runArm('explicit');
  const b = await runArm('env');
  assertJ1Equal(a, b, 'success');
  // Non-vacuity: the judge actually reordered, both batches ran, every batch succeeded.
  assert.equal(a.capture.batches.length, 2, 'six candidates at JUDGE_BATCH 5 is two batches');
  assert.ok(a.capture.batches.every((bt) => bt.outcome === 'success'));
  const order = (JSON.parse(a.serialized) as Array<{ id: number }>).map((c) => c.id);
  assert.deepEqual(order, [4, 2, 6, 3, 1, 5], 'reordered by the judge scores, not input order');
  // The two arms differ in exactly what J1 says they may: how the backend was chosen.
  assert.equal(a.capture.intendedBackend, 'judge');
  assert.equal(b.capture.intendedBackend, 'judge');
  assert.equal(a.capture.rerankBackendDowngraded, false);
  assert.equal(b.capture.rerankBackendDowngraded, false);
});

test('J1.2 — REAL BATCH PARSE FAILURE: both arms receive the same malformed completion and record it identically', async () => {
  const { judge } = await boot();
  // The loopback judge returns non-JSON for EVERY batch. This is a real `JSON.parse` throw inside
  // `rerankJudge`'s per-batch try, resolved as `parse_failure` on the catch branch — not a mock.
  judge.setRawContent(() => 'this is not JSON at all');
  try {
    const a = await runArm('explicit');
    const b = await runArm('env');
    assertJ1Equal(a, b, 'parse failure');
    assert.ok(a.capture.batches.every((bt) => bt.outcome === 'parse_failure'), 'the failure is a real parse_failure on every batch');
    assert.equal(a.capture.rerankSoftFailed, false, 'a per-batch failure never reaches inputOrder — soft failed stays false');
    // parse_failure keeps the served provider: a completion arrived, so the batch is served, not not_served.
    assert.ok(a.capture.batches.every((bt) => bt.evidence !== null));
  } finally { judge.setRawContent(null); }
});

test('J1.3 — GENERIC OUTER JUDGE FAILURE, produced by CALL-THEN-THROW: nonempty and byte-identical wire observations on both arms', async () => {
  // ⚠️ THE FIXTURE CALLS THE REAL LOOPBACK JUDGE AND ONLY THEN THROWS (v15 §4.2). An injected judgeFn
  // that threw before any request left would leave both arms with zero observations and the
  // comparison would be vacuous. This one runs the real `rerankJudge` — real requests, real batches,
  // real capture stamping — and throws a plain (non-typed) Error AFTER it returns, so the outer
  // catch in `rerank` sees a generic failure and both arms take the same soft-fall path.
  const { rerank: _r } = await boot();
  const rerankMod = await import('../rerank');
  const callThenThrow: RerankDeps['judgeFn'] = async (q, c, cap) => {
    await rerankMod.rerankJudge(q, c, cap);         // the real call, on the wire
    throw new Error('generic outer judge failure, after the call');   // NOT a RerankBackendError
  };
  const a = await runArm('explicit', { judgeFn: callThenThrow });
  const b = await runArm('env', { judgeFn: callThenThrow });
  assertJ1Equal(a, b, 'generic outer failure');
  // The failure was generic, so both arms soft-fell to input order and synthesised the planned
  // boundaries — identically. The wire observations prove the real call happened FIRST.
  assert.equal(a.wire.length, 2, 'two real batch requests left before the throw');
  assert.equal(a.capture.rerankSoftFailed, true);
  assert.equal(b.capture.rerankSoftFailed, true);
  const order = (JSON.parse(a.serialized) as Array<{ id: number; rerank_backend: string }>);
  assert.deepEqual(order.map((c) => c.id), [1, 2, 3, 4, 5, 6], 'input order after a generic soft-fall');
  assert.ok(order.every((c) => c.rerank_backend === 'none'));
  void _r;
});
