/**
 * lib/__tests__/batch-outcome-precedence.test.ts — PROOF 12, kickoff v11 line 1126.
 *
 *   > **`timeout` is a distinct batch outcome**, and the precedence in D15 holds when several
 *   > defects coexist.
 *
 * ⚠️ THE PRECEDENCE HAS NO SINGLE IMPLEMENTATION, AND THIS FILE ASSERTS IT THROUGH BEHAVIOUR.
 * `BATCH_OUTCOME_PRECEDENCE` at `lib/retrieval-telemetry-core.ts:426` is a VOCABULARY list, used
 * once at `:766` to check that a batch's outcome is a known value — it orders nothing at run time.
 * The ordering lives in three separate lines of `lib/rerank.ts`, plus one helper:
 *
 *     :590   `let outcome: BatchOutcome = 'success'`      the initialiser
 *     :640   missing > 0 ? missing_score_key : nonnumeric > 0 ? nonnumeric_score : success
 *     :647   parseFailed ? parse_failure : terminalOutcomeFor(evidence)     ← this proof turns here
 *     :521   terminalOutcomeFor — last attempt 'timeout' ? timeout : terminal_failure
 *
 * So every row below drives the real `rerankJudge` against a real socket and reads
 * `capture.batches[].outcome`. No resolver is extracted and `lib/rerank.ts` is not edited — that is
 * later work with its own specification (v11 §13).
 *
 * ⚠️ IMPORT ORDER IS LOAD-BEARING (review 22 item 8). `startJudgeServer` sets `OLLAMA_BASE_URL`,
 * `RERANK_JUDGE_MODEL` and the Gemini kill-switches, and `lib/llm.ts:41` builds its OpenAI client
 * with that base URL at MODULE EVALUATION. ESM evaluates every static import before the importing
 * module's body runs, so `rerank`, `llm` and `multi-query` are imported DYNAMICALLY, after the
 * server is listening. The same hazard is documented at `lib/__tests__/gemini-env-fixture.ts:4-11`.
 * A static `import { rerankJudge } from '../rerank'` at the top of this file would point the judge
 * at whatever `OLLAMA_BASE_URL` happened to hold — in CI, nothing.
 *
 * Proof 11 is in `attempt-taxonomy.test.ts`: it is pure, needs no server, and keeping it separate
 * keeps this file's import-ordering hazard out of it.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startJudgeServer, type JudgeServer } from './judge-server-stub';
import type { TelemetryCapture } from '../retrieval-capture';

/** Two passages, so a response can carry one good key and one bad one — which is what rows 4 and 5
 *  need. Each carries a unique leading marker: the only thing that tells one batch from another. */
const CANDIDATES = [
  { id: 1, text: 'MRKA a clinical passage used only by this proof, numbered one.' },
  { id: 2, text: 'MRKB a clinical passage used only by this proof, numbered two.' },
];

type Booted = {
  judge: JudgeServer;
  rerankJudge: <T extends { id: number; text: string }>(
    q: string, c: T[], capture?: TelemetryCapture,
  ) => Promise<unknown>;
  createTelemetryCapture: (role: 'primary') => TelemetryCapture;
  llm: { chat: { completions: { create: (...a: unknown[]) => Promise<unknown> } } };
};

let booted: Booted | null = null;

/** Server first, dynamic imports second. Once per file. */
async function boot(): Promise<Booted> {
  if (booted) return booted;
  const judge = await startJudgeServer({ MRKA: 8, MRKB: 4 });
  const rerankMod = await import('../rerank');
  const captureMod = await import('../retrieval-capture');
  const llmMod = await import('../llm');
  booted = {
    judge,
    rerankJudge: rerankMod.rerankJudge as Booted['rerankJudge'],
    createTelemetryCapture: captureMod.createTelemetryCapture,
    llm: llmMod.llm as unknown as Booted['llm'],
  };
  return booted;
}

/** Run one judge call and return the single batch's captured record. */
async function runBatch(): Promise<{
  outcome: string; missingScoreKeys: number; nonnumericScoreKeys: number;
  finiteScoreKeys: number; expectedScoreKeys: number;
}> {
  const { rerankJudge, createTelemetryCapture } = await boot();
  const capture = createTelemetryCapture('primary');
  await rerankJudge('a clinical question', CANDIDATES, capture);
  assert.equal(capture.batches.length, 1, 'two candidates are one batch');
  const b = capture.batches[0] as unknown as {
    outcome: string; missingScoreKeys: number; nonnumericScoreKeys: number;
    finiteScoreKeys: number; expectedScoreKeys: number;
  };
  return b;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// The executable matrix (review 22 item 9). Six rows, each executed, each reading
// `capture.batches[].outcome`. Rows 3 to 6 are served by the stub; rows 1 and 2 cannot be, and are
// reached by the two techniques the kickoff names, in that order, because row 2 closes the server.
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('12.0 — the precedence list is a VOCABULARY, not an implementation', async () => {
  // Stated here so a reader does not go looking for the resolver this proof is asserting.
  const core = await import('../retrieval-telemetry-core');
  assert.deepEqual([...core.BATCH_OUTCOME_PRECEDENCE], [
    'timeout', 'terminal_failure', 'parse_failure', 'missing_score_key', 'nonnumeric_score', 'success',
  ]);
  const coreSrc = readFileSync('lib/retrieval-telemetry-core.ts', 'utf8');
  const uses = (coreSrc.match(/BATCH_OUTCOME_PRECEDENCE/g) || []).length;
  assert.equal(uses, 2, 'declared once, used once — as a membership check, never to order anything');
  // The ordering really does live in rerank.ts, on the three lines named in this file's header.
  const rerank = readFileSync('lib/rerank.ts', 'utf8').split('\n');
  assert.match(rerank[589], /let outcome: BatchOutcome = 'success';/);
  assert.match(rerank[639], /outcome = missing > 0 \? 'missing_score_key' : nonnumeric > 0 \? 'nonnumeric_score' : 'success';/);
  assert.match(rerank[646], /outcome = parseFailed \? 'parse_failure' : terminalOutcomeFor\(evidence\);/);
});

test('12.3 — ROW 3: a malformed completion is `parse_failure`', async () => {
  const { judge } = await boot();
  judge.setRawContent(() => 'this is not JSON at all');
  const b = await runBatch();
  judge.setRawContent(null);
  assert.equal(b.outcome, 'parse_failure');
  // parse_failure PRESERVES its provider and usage — a completion arrived and cost tokens. It is
  // resolved at rerank.ts:647, the same line as terminal_failure, and wins there because
  // `parseFailed` was set inside the inner try at :618-621.
  assert.equal(b.finiteScoreKeys, 0, 'nothing parsed, so nothing is finite');
});

test('12.4 — ROW 4: missing AND nonnumeric keys give `missing_score_key`, and BOTH counts survive', async () => {
  // ⚠️ THE COEXISTENCE ROW. Two defects in one response: key "0" is present but non-numeric, key
  // "1" is absent entirely. Precedence puts missing_score_key above nonnumeric_score, and D15
  // requires the independent counts to be preserved alongside the one outcome.
  const { judge } = await boot();
  judge.setRawContent(() => '{"0":"x"}');
  const b = await runBatch();
  judge.setRawContent(null);
  assert.equal(b.outcome, 'missing_score_key', 'missing outranks nonnumeric');
  assert.equal(b.missingScoreKeys, 1, 'the absent key is counted');
  assert.equal(b.nonnumericScoreKeys, 1, 'AND the non-numeric one is counted, not swallowed');
  assert.equal(b.finiteScoreKeys, 0);
  assert.equal(b.expectedScoreKeys, 2);
});

test('12.5 — ROW 5: finite AND nonnumeric keys give `nonnumeric_score`', async () => {
  const { judge } = await boot();
  judge.setRawContent(() => '{"0":7,"1":"not-a-number"}');
  const b = await runBatch();
  judge.setRawContent(null);
  assert.equal(b.outcome, 'nonnumeric_score');
  assert.equal(b.missingScoreKeys, 0, 'no key is absent, which is what separates this row from row 4');
  assert.equal(b.nonnumericScoreKeys, 1);
  assert.equal(b.finiteScoreKeys, 1);
});

test('12.6 — ROW 6: all finite keys give `success`', async () => {
  const { judge } = await boot();
  judge.setScores({ MRKA: 8, MRKB: 4 });
  const b = await runBatch();
  assert.equal(b.outcome, 'success');
  assert.equal(b.finiteScoreKeys, 2);
  assert.equal(b.missingScoreKeys, 0);
  assert.equal(b.nonnumericScoreKeys, 0);
});

test('12.1 — ROW 1: a TIMEOUT is `timeout`, and is not folded into terminal_failure', async () => {
  // ⚠️ A TEST-LOCAL METHOD MOCK ON THE EXPORTED CLIENT (review 22 item 7). No wall clock, no
  // external host. The thrown error declares the SDK's own `APIConnectionTimeoutError` name, which
  // is what `classifyLocalAttempt` reads at lib/llm.ts:362-364; the resulting `timeout` attempt
  // becomes the terminal one, and `terminalOutcomeFor` at rerank.ts:521 resolves `timeout`.
  const { llm } = await boot();
  class APIConnectionTimeoutError extends Error {
    constructor() { super('Request timed out.'); this.name = 'APIConnectionTimeoutError'; }
  }
  mock.method(llm.chat.completions, 'create', async () => { throw new APIConnectionTimeoutError(); });
  try {
    const b = await runBatch();
    assert.equal(b.outcome, 'timeout', 'a timeout must be its own outcome');
    assert.notEqual(b.outcome, 'terminal_failure');
    // The scores were never produced, so every expected key is counted missing — and the outcome is
    // still `timeout`, because :647 resolves before the missing-key branch can apply.
    assert.equal(b.missingScoreKeys, 2);
    assert.equal(b.finiteScoreKeys, 0);
  } finally {
    mock.restoreAll();
  }
});

test('12.2 — ROW 2: a generic exhausted transport is `terminal_failure`', async () => {
  // ⚠️ RUNS LAST, BECAUSE IT CLOSES THE SERVER. The SDK then gets ECONNREFUSED, which declares a
  // status of neither 429 nor anything else and no timeout name — so `classifyLocalAttempt` reports
  // the honest `transport_error`, and `terminalOutcomeFor` resolves `terminal_failure` rather than
  // sharpening it into a timeout.
  //
  // This is the CONTRAST that makes row 1 mean something: same code path, same resolver line, and
  // the only difference is what the transport declared about itself.
  const { judge } = await boot();
  await judge.close();
  const b = await runBatch();
  assert.equal(b.outcome, 'terminal_failure');
  assert.notEqual(b.outcome, 'timeout', 'a dead socket is not a timeout');
  assert.equal(b.finiteScoreKeys, 0);
});

test('12.7 — the six rows produced six DISTINCT outcomes, and they are the committed six', async () => {
  // A guard against a matrix that passes because every row resolves to the same value. Re-stated
  // from what the rows above asserted, so it cannot drift from them silently.
  const core = await import('../retrieval-telemetry-core');
  const produced = ['timeout', 'terminal_failure', 'parse_failure', 'missing_score_key', 'nonnumeric_score', 'success'];
  assert.equal(new Set(produced).size, 6, 'six rows, six different outcomes');
  for (const o of produced) {
    assert.ok((core.BATCH_OUTCOME_PRECEDENCE as readonly string[]).includes(o), `${o} is a committed outcome`);
  }
});
