/**
 * LAB-MCP-V2 §17.3 — the five route engines behind the fence (decisions 34, 35, 35a, 37).
 *
 * WHAT IS AND IS NOT TESTED HERE, AND WHY. Decision 37 has the adapter call the real `POST` of a
 * real clinical route. Running one of those end to end in a unit test would need a database, a
 * corpus and a model, so it is the orchestrator's production verification, not this suite's job.
 * What IS testable — and is what actually broke in earlier rounds — is the seam:
 *
 *   · the synthetic request the engine receives, header for header;
 *   · that every governed label the handlers carry is a listed, priced stage;
 *   · that decision 34's gate refuses an identifying body BEFORE anything is stored;
 *   · that a stage reserves and settles exactly one call, and all three statuses land;
 *   · that the five route files are still untouched, which decision 37 exists to guarantee.
 *
 * The engine's own behaviour is exercised through a stub `post` that drives the chat edge, so the
 * plumbing is proved without pretending a clinical pipeline ran.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { freshDb } from './helpers';
import { callTool } from '../service';
import { ENGINE_STAGES, SUPPORTED_ENGINES, stagesFor, type EngineId } from '../contracts';
import {
  assessStream, buildSyntheticRequest, eventTypes, makeRouteAdapter, readRouteResponse, ALL_ADAPTERS,
} from '../adapters/types';
import { freezeRequestCase, identifyingKeys, requestFieldsFor, requiresIdentifyingInput } from '../sources/requests';
import { Gateway } from '../gateway';
import { fixtureTransport } from '../transport';
import { ensureBudget, getBudget, itemsOf, putObject, submitRun } from '../store';
import { tick } from '../worker';
import type { Db } from '../db';

const A3: EngineId[] = ['ask', 'ddx', 'appropriateness', 'pathway', 'doc_audit'];
const ROUTES: Record<string, string> = {
  ask: 'app/api/ask/route.ts',
  ddx: 'app/api/ddx/route.ts',
  appropriateness: 'app/api/appropriateness/route.ts',
  pathway: 'app/api/pathway/skeleton/route.ts',
  doc_audit: 'app/api/doc-audit/analyze/route.ts',
};

const deps = (db: Db, principal: 'research' | 'operator' | 'reviewer' | 'release' = 'research') =>
  ({ db, principal, protocolVersion: 'test', sdkVersion: 'test' }) as never;

/** A clean, non-identifying body per engine — what a real dataset would freeze. */
const CLEAN_BODY: Record<string, Record<string, unknown>> = {
  ask: { question: 'What is the evidence for antibiotics in acute bronchitis?' },
  ddx: { cc: 'cough for three days', age: 34, sex: 'M' },
  appropriateness: { scenario: 'Adult with acute viral URTI', proposedActions: ['amoxicillin 500mg TDS'] },
  pathway: { scenario: 'Adult with suspected acute appendicitis' },
  doc_audit: { extracted: { docType: 'discharge', courseSummary: 'Uneventful recovery.', patient: { age: 40, sex: 'F' } } },
};

// ── decision 37: the routes are untouched ────────────────────────────────────────────
test('decision 37: all five route files still hold their handler bodies', () => {
  for (const [engine, path] of Object.entries(ROUTES)) {
    const src = readFileSync(path, 'utf8');
    assert.ok(/export async function POST\(/.test(src), `${engine}: the handler is still in the route file`);
    assert.ok(!/export \{ executeRequest as POST \}/.test(src), `${engine}: no extraction happened`);
    assert.ok(src.length > 2000, `${engine}: the body did not move out`);
  }
});

test('decision 37: lib/clinical-services does not exist', () => {
  let present = true;
  try { readFileSync('lib/clinical-services/ask.ts', 'utf8'); } catch { present = false; }
  assert.equal(present, false, 'decision 33 was withdrawn; nothing was extracted');
});

test('decision 37: the adapter calls POST in process, never a network self-fetch', () => {
  const src = readFileSync('lib/lab-v2/adapters/types.ts', 'utf8');
  assert.ok(src.includes('spec.post(buildSyntheticRequest('), 'a direct function call');
  // A self-fetch would leave the AsyncLocalStorage store and the fence would silently not apply.
  assert.ok(!/fetch\(\s*['"`]https?:/.test(src), 'no self-fetch to a real URL');
  for (const path of Object.values(ROUTES)) {
    assert.ok(readFileSync(path, 'utf8').length > 0);
  }
});

// ── the synthetic request ────────────────────────────────────────────────────────────
test('§17.3: the synthetic NextRequest carries exactly the URL, method, headers and body the routes read', async () => {
  const req = buildSyntheticRequest('/api/ask', { question: 'q', labModel: 'should-be-stripped' });
  assert.equal(req.method, 'POST');
  assert.equal(new URL(req.url).pathname, '/api/ask');
  assert.equal(new URL(req.url).origin, 'https://lab-v2.internal');
  assert.equal(req.headers.get('content-type'), 'application/json');
  assert.equal(req.headers.get('user-agent'), 'cdmss-lab-v2/adapter');
  const body = await req.json() as Record<string, unknown>;
  assert.equal(body.question, 'q');
  // labModel would send resolveLabOverride into isAdminUnlocked() → cookies(), which throws
  // outside a request scope; and model choice belongs to the arm, not to a frozen string.
  assert.equal('labModel' in body, false, 'labModel is stripped');
});

test('§17.3: no header the five routes read is missing from the synthetic request', () => {
  // The only header reads in this call tree are `user-agent` (ask, ddx, for a trace event) and,
  // inside resolveLabOverride, three lab headers that are never reached because labModel is
  // stripped. There is no auth header and no cookie on this path.
  for (const [engine, path] of Object.entries(ROUTES)) {
    const src = readFileSync(path, 'utf8');
    const reads = [...src.matchAll(/req\.headers\.get\(([^)]*)\)/g)].map((m) => m[1].trim());
    for (const r of reads) {
      assert.ok(/user-agent/i.test(r), `${engine}: unexpected header read ${r} — the synthetic request must supply it`);
    }
    assert.ok(!/req\.cookies|cookies\(\)/.test(src), `${engine}: reads no cookie`);
  }
  const override = readFileSync('lib/lab-override.ts', 'utf8');
  assert.ok(override.includes('Short-circuit before touching cookies/env'), 'and resolveLabOverride short-circuits without labModel');
});

// ── decisions 35 and 35a: stages ─────────────────────────────────────────────────────
test('decision 35: each engine lists exactly the governed labels measured in its call tree', () => {
  assert.deepEqual(stagesFor('ask').map((s) => s.name), ['investigations_parse', 'draft', 'critique', 'revision', 'answer']);
  assert.deepEqual(stagesFor('ddx').map((s) => s.name), ['investigations_parse', 'clinical_state_normalise', 'ddx_draft', 'ddx_critique', 'ddx_revision']);
  assert.deepEqual(stagesFor('appropriateness').map((s) => s.name), ['lvc_value', 'lvc_value_critique', 'clinical_state_normalise']);
  assert.deepEqual(stagesFor('pathway').map((s) => s.name), ['pathway_skeleton', 'clinical_state_normalise']);
  assert.deepEqual(stagesFor('doc_audit').map((s) => s.name), [
    'doc_audit_analyze', 'doc_audit_cite_gate', 'doc_audit_prognosis', 'doc_audit_prognosis_critique', 'doc_audit_prognosis_revise',
  ]);
  // The counts the ruling fixed.
  assert.deepEqual(A3.map((e) => stagesFor(e).length), [5, 5, 3, 2, 5]);
});

test('decision 35: every listed label really appears in that engine\'s call tree', () => {
  const trees: Record<string, string[]> = {
    ask: ['app/api/ask/route.ts', 'lib/investigations.ts'],
    ddx: ['app/api/ddx/route.ts', 'lib/investigations.ts'],
    appropriateness: ['app/api/appropriateness/route.ts', 'lib/lvc-value.ts'],
    pathway: ['app/api/pathway/skeleton/route.ts', 'lib/pathway.ts'],
    doc_audit: ['app/api/doc-audit/analyze/route.ts', 'lib/doc-audit.ts'],
  };
  for (const engine of A3) {
    const src = trees[engine].map((f) => readFileSync(f, 'utf8')).join('\n');
    for (const st of stagesFor(engine)) {
      assert.ok(src.includes(`'${st.name}'`), `${engine}: label '${st.name}' must exist in its call tree`);
    }
  }
});

test('decision 35a: the conditional stages are the two that do not fire on every request', () => {
  const conditional = A3.flatMap((e) => stagesFor(e).filter((s) => s.conditional).map((s) => `${e}.${s.name}`));
  assert.deepEqual(conditional.sort(), [
    'appropriateness.clinical_state_normalise',
    'ask.investigations_parse',
    'ddx.clinical_state_normalise',
    'ddx.investigations_parse',
    'pathway.clinical_state_normalise',
  ]);
  // A conditional stage is still a stage: it is listed, and experiment_create still demands a price.
  for (const e of A3) for (const s of stagesFor(e)) assert.equal(typeof s.conditional, 'boolean');
});

// ── decision 34: classification ──────────────────────────────────────────────────────
test('decision 34: all five engines survive — no request field they read is identifying', () => {
  for (const engine of A3) {
    const fields = requestFieldsFor(engine);
    assert.ok(fields.length > 0, `${engine}: the field list is the evidence, and must not be empty`);
    for (const f of fields) assert.equal(f.identifying, false, `${engine}.${f.name} is marked identifying`);
    assert.equal(requiresIdentifyingInput(engine), false, `${engine} must be supported`);
  }
});

test('decision 34: the gate is a denylist over the WHOLE body, not just the fields a handler reads', () => {
  // A handler that ignores `member_id` would still have it stored in a research object forever.
  assert.deepEqual(identifyingKeys({ question: 'q', member_id: 'M-1' }), ['member_id']);
  assert.deepEqual(identifyingKeys({ extracted: { patient: { uhid: 'X' } } }), ['uhid']);
  assert.deepEqual(identifyingKeys({ a: [{ patient_name: 'X' }] }), ['patient_name']);
  assert.deepEqual(identifyingKeys({ scenario: 's', encounter_id: 'E1' }), ['encounter_id']);
  assert.deepEqual(identifyingKeys({ cc: 'cough', age: 34, sex: 'M' }), []);
});

test('decision 34: dataset_create refuses an identifying body with CLASSIFICATION_REQUIRED', async () => {
  const db = await freshDb();
  for (const engine of A3) {
    await assert.rejects(
      () => callTool(deps(db), 'dataset_create', {
        engine, body: { ...CLEAN_BODY[engine], member_id: 'M-0001' }, idempotency_key: `bad-${engine}`,
      }),
      (e: { code?: string }) => e.code === 'CLASSIFICATION_REQUIRED',
      `${engine} must refuse an identifying body`,
    );
  }
  await db.close();
});

test('decision 34: a clean body is frozen as a de-identified dataset', async () => {
  const db = await freshDb();
  for (const engine of A3) {
    const out = await callTool(deps(db), 'dataset_create', {
      engine, body: CLEAN_BODY[engine], idempotency_key: `ok-${engine}`,
    }) as { dataset_id: string; classification: string; replay_exactness: string };
    assert.equal(out.classification, 'deidentified');
    assert.equal(out.replay_exactness, 'mutable_source');
    assert.ok(out.dataset_id);
  }
  await db.close();
});

test('decision 34: the case key is the body\'s own hash, so the same body is the same case', () => {
  const a = freezeRequestCase('ask', { question: 'q' });
  const b = freezeRequestCase('ask', { question: 'q' });
  const c = freezeRequestCase('ask', { question: 'other' });
  assert.equal(a.case_key, b.case_key);
  assert.notEqual(a.case_key, c.case_key);
  assert.ok(a.case_key.startsWith('req:'));
  assert.equal(a.member_key, null);
});

// ── engine_describe ──────────────────────────────────────────────────────────────────
test('§17.3: engine_describe reports all six supported, with conditional marks and field lists', async () => {
  const db = await freshDb();
  for (const engine of ['opd_note_audit', ...A3] as EngineId[]) {
    const out = await callTool(deps(db), 'engine_describe', { engine }) as {
      supported: boolean; reason: string | null; stages: { name: string; conditional: boolean }[];
      request_fields: { identifying: boolean }[];
    };
    assert.equal(out.supported, true, `${engine} must be supported`);
    assert.equal(out.reason, null);
    assert.deepEqual(out.stages.map((s) => s.name), stagesFor(engine).map((s) => s.name));
    for (const f of out.request_fields) assert.equal(f.identifying, false);
  }
  await db.close();
});

test('§17.3: an engine with no adapter is still supported:false with a reason', async () => {
  const db = await freshDb();
  const out = await callTool(deps(db), 'engine_describe', { engine: 'readmission' }) as { supported: boolean; reason: string | null; stages: unknown[] };
  assert.equal(out.supported, false);
  assert.match(out.reason ?? '', /slice D/);
  assert.deepEqual(out.stages, []);
  await db.close();
});

test('§17.3: SUPPORTED_ENGINES and the adapter registry agree', () => {
  const registered = Object.keys(ALL_ADAPTERS()).sort();
  assert.deepEqual(registered, [...SUPPORTED_ENGINES].sort());
  assert.equal(registered.length, 6);
  for (const e of SUPPORTED_ENGINES) assert.ok(ENGINE_STAGES[e], `${e} must declare stages`);
});

// ── stage pricing ────────────────────────────────────────────────────────────────────
test('§17.3: an arm must price every stage, conditional ones included', async () => {
  const db = await freshDb();
  const dataset = await putObject(db, 'research', 'dataset', {
    engine: 'pathway', cases: [{ case_key: 'req:x', member_key: null, frozen: { engine: 'pathway', body: CLEAN_BODY.pathway } }],
    snapshot_policy: 'single_case_at_creation', exclusions: [], classification: 'deidentified',
    source_versions: {}, replay_exactness: 'mutable_source',
  }, 'deidentified', 'ds-pathway');
  const armWith = (stages: Record<string, unknown>, key: string) => ({
    hypothesis: 'h', dataset_id: dataset.object.id, dataset_hash: dataset.object.hash,
    baseline_arm: { engine: 'pathway', stages }, arms: [], repeats: 1,
    endpoints: [], budget_name: 'default', purpose: 'research', idempotency_key: key,
  });
  const priced = (name: string) => ({ [name]: { provider: 'ollama', model: 'local-model', max_cost_microusd: 100 } });

  // A stage the engine does not list.
  await assert.rejects(
    () => callTool(deps(db), 'experiment_create', armWith({ ...priced('pathway_skeleton'), ...priced('made_up') }, 'k1')),
    (e: { code?: string }) => e.code === 'STAGE_UNKNOWN',
  );
  // Both listed stages priced, including the conditional one — accepted.
  const ok = await callTool(deps(db), 'experiment_create',
    armWith({ ...priced('pathway_skeleton'), ...priced('clinical_state_normalise') }, 'k2')) as { experiment_id: string };
  assert.ok(ok.experiment_id);
  await db.close();
});

// ── the seam: stages reserve and settle, statuses land, the fence holds ──────────────
/** A stub route that drives the chat edge for each named stage, then returns NDJSON. */
function stubPost(stages: string[], opts: { error?: boolean } = {}) {
  return async (): Promise<Response> => {
    const { governedChat } = await import('../../trace');
    const events: string[] = [];
    for (const s of stages) {
      await governedChat(undefined, s, { messages: [{ role: 'user', content: 'x' }] });
      events.push(JSON.stringify({ type: 'stage', name: s }));
    }
    if (opts.error) events.push(JSON.stringify({ type: 'error', message: 'engine declared it cannot answer' }));
    events.push(JSON.stringify({ type: 'done', ms: 1 }));
    return new Response(events.join('\n'), { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
  };
}

async function runStub(db: Db, stages: string[], opts: { error?: boolean } = {}) {
  const budget = await ensureBudget(db, 'research', 'default', 10_000_000);
  const armStages = Object.fromEntries(stages.map((s) => [s, { provider: 'ollama', model: 'local-model', max_cost_microusd: 5_000 }]));
  const { run } = await submitRun(db, 'research', 'experiment_run', null, budget.id, `stub-${stages.join('-')}-${opts.error ? 'e' : 'o'}`, 'h', 86_400_000, [
    { case_key: 'req:x', arm_hash: 'h', repetition: 1, payload: { engine: 'stub', frozen: { engine: 'ask', body: { question: 'q' } }, arm: { stages: armStages }, budget_id: budget.id } },
  ]);
  const adapter = makeRouteAdapter({
    engine: 'ask', path: '/api/ask', post: stubPost(stages, opts) as never,
    summarise: (read) => ({ event_types: eventTypes(read) }),
    assess: assessStream,
  });
  const report = await tick({ db, transport: fixtureTransport(), adapters: { stub: adapter } });
  return { run, budget, report };
}

test('§17.3: every stage reserves and settles exactly one call, and all three statuses land', async () => {
  const db = await freshDb();
  const stages = ['draft', 'critique', 'revision', 'answer'];
  const { run, budget, report } = await runStub(db, stages);
  assert.equal(report.claimed, 1);

  const [item] = await itemsOf(db, run.id);
  assert.equal(item.state, 'succeeded');
  assert.equal(item.execution_status, 'succeeded');
  assert.equal(item.assessment_status, 'assessed');
  assert.equal(item.attribution_status, 'verified');

  const calls = await db.query<{ stage: string; state: string; actual_microusd: string | null }>(
    `SELECT stage, state, actual_microusd FROM lab_v2.calls WHERE item_id = $1 ORDER BY created_at`, [item.id]);
  assert.deepEqual(calls.map((c) => c.stage), stages, 'one call per stage, in order');
  for (const c of calls) assert.equal(c.state, 'settled');
  const after = await getBudget(db, budget.id);
  assert.equal(Number(after!.reserved_microusd), 0, 'every reservation was settled');
  await db.close();
});

test('§17.3: a stage the arm did not price fails the item by NAME, never silently', async () => {
  const db = await freshDb();
  // The arm prices `draft` only; the stub also calls `critique`.
  const { run } = await runStub(db, ['draft', 'critique'].slice(0, 1).concat([]));
  assert.ok(run.id);
  const db2 = await freshDb();
  const budget = await ensureBudget(db2, 'research', 'default', 10_000_000);
  const { run: run2 } = await submitRun(db2, 'research', 'experiment_run', null, budget.id, 'unpriced', 'h', 86_400_000, [
    { case_key: 'req:x', arm_hash: 'h', repetition: 1, payload: { engine: 'stub', frozen: { engine: 'ask', body: { question: 'q' } }, arm: { stages: { draft: { provider: 'ollama', model: 'local-model', max_cost_microusd: 5_000 } } }, budget_id: budget.id } },
  ]);
  const adapter = makeRouteAdapter({
    engine: 'ask', path: '/api/ask', post: stubPost(['draft', 'critique']) as never,
    summarise: () => ({}), assess: assessStream,
  });
  await tick({ db: db2, transport: fixtureTransport(), adapters: { stub: adapter } });
  const [item] = await itemsOf(db2, run2.id);
  assert.equal(item.state, 'failed');
  // The adapter CATCHES the gateway refusal and returns a failed outcome, so the message lands in
  // the stored result rather than in item.error — which is the right place for an engine-level
  // failure. What matters is that the unpriced stage is named somewhere a reader will find it.
  // The INLINE summary must name it: an operator reading run_result should not have to fetch an
  // artifact to learn which stage the arm forgot to price.
  const stored = JSON.stringify(item.result);
  assert.match(stored, /critique/, 'the unpriced stage is named in the inline summary');
  assert.match(stored, /MODEL_UNSUPPORTED/, 'and the refusal is typed');
  await db.close(); await db2.close();
});

test('§9: an engine that declares it cannot answer is unassessable, not failed', async () => {
  const db = await freshDb();
  const { run } = await runStub(db, ['draft'], { error: true });
  const [item] = await itemsOf(db, run.id);
  assert.equal(item.execution_status, 'succeeded', 'the engine ran to its end');
  assert.equal(item.assessment_status, 'unassessable', 'and said it had no clinical answer');
  await db.close();
});

// ── response reading ─────────────────────────────────────────────────────────────────
test('§17.3: NDJSON and plain JSON responses are both read correctly', async () => {
  const nd = await readRouteResponse(new Response(
    '{"type":"stage","name":"draft"}\n{"type":"done","ms":5}',
    { status: 200, headers: { 'content-type': 'application/x-ndjson' } }));
  assert.equal(nd.events.length, 2);
  assert.deepEqual(eventTypes(nd), ['stage', 'done']);
  assert.equal(assessStream(nd), 'assessed');

  const errored = await readRouteResponse(new Response(
    '{"type":"error","message":"no excerpts"}\n{"type":"done","ms":5}',
    { status: 200, headers: { 'content-type': 'application/x-ndjson' } }));
  assert.equal(assessStream(errored), 'unassessable');

  // pathway is the one that does not stream.
  const plain = await readRouteResponse(new Response(
    JSON.stringify({ ok: true, skeleton: { steps: [1, 2] } }),
    { status: 200, headers: { 'content-type': 'application/json' } }));
  assert.equal(plain.events.length, 0);
  assert.equal((plain.json as { ok: boolean }).ok, true);
});

// ── the fence ────────────────────────────────────────────────────────────────────────
test('§7: each new adapter runs its engine inside the lab execution context', async () => {
  const { labExecution } = await import('../../lab-execution-context');
  const db = await freshDb();
  let sawContext = false;
  const budget = await ensureBudget(db, 'research', 'default', 1_000_000);
  const { run } = await submitRun(db, 'research', 'experiment_run', null, budget.id, 'fence', 'h', 86_400_000, [
    { case_key: 'req:x', arm_hash: 'h', repetition: 1, payload: { engine: 'stub', frozen: { engine: 'ask', body: { question: 'q' } }, arm: { stages: {} }, budget_id: budget.id } },
  ]);
  const adapter = makeRouteAdapter({
    engine: 'ask', path: '/api/ask',
    post: (async () => {
      sawContext = !!labExecution();
      // Production sql must be unreachable from here.
      const { sql } = await import('../../db');
      const runSql = sql as unknown as (q: string, p: unknown[]) => Promise<unknown>;
      await assert.rejects(async () => runSql('SELECT 1', []), (e: { code?: string }) => e.code === 'LAB_IO_FORBIDDEN');
      return new Response('{"type":"done","ms":1}', { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
    }) as never,
    summarise: () => ({}), assess: assessStream,
  });
  await tick({ db, transport: fixtureTransport(), adapters: { stub: adapter } });
  assert.equal(sawContext, true, 'the engine ran inside withLabExecution');
  const [item] = await itemsOf(db, run.id);
  assert.equal(item.state, 'succeeded');
  await db.close();
});

test('§7: the isolation gate still lists only lib/lab-v2/** as importers of withLabExecution', () => {
  // The five new adapters import the shared helper, which is the only file entering the context.
  const types = readFileSync('lib/lab-v2/adapters/types.ts', 'utf8');
  assert.ok(types.includes('withLabExecution'), 'the shared adapter enters the context');
  for (const engine of A3) {
    const src = readFileSync(`lib/lab-v2/adapters/${engine === 'doc_audit' ? 'doc-audit' : engine}.ts`, 'utf8');
    // An IMPORT, not a mention: each adapter's header explains that the engine runs inside
    // withLabExecution, so a bare substring check would fail on its own documentation — the same
    // trap the real gate in isolation.test.ts avoids by matching the import statement.
    assert.ok(!/import[^;]*\bwithLabExecution\b[^;]*from/.test(src),
      `${engine}: enters the context only through the shared helper`);
  }
});
