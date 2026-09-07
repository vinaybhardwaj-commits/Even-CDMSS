/**
 * LAB-MCP-V2 §17.11 round D3 — `failure_minimize` (item 6, decisions 131 and 142), decision 145's
 * two forced retrieval options, and decision 143's retirement seen from the v2 surface.
 *
 * ⚠️ THE BISECTION IS DRIVEN OVER A REAL QUEUE. `failure_minimize` submits a dataset, an experiment
 * and a run per step and turns the tick itself, so what is exercised here is the whole loop —
 * `putObject`, `submitRun`, `claim`, the gateway's reservation and settle, and the group match on
 * the way back out. The ENGINE is a stub, injected through `tick`'s own adapter seam, because the
 * question this tool answers is about which CASES fail and not about what any engine computes.
 *
 * ⚠️ AND ONE CASE IS BAD, ON PURPOSE. `c3` is the only case whose analyze call throws, so the
 * minimal set is knowable in advance and the bisection's path is a fact rather than a shape: four
 * cases, then the two halves, then the winning half's first element.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, migrationFile } from './helpers';
import { embedded, type Db } from '../db';
import { LabError, armBodySchema, datasetBodySchema, experimentBodySchema } from '../contracts';
import { applyMigrations, ensureBudget, getBudget, itemsOf, putObject, submitRun } from '../store';
import { tick } from '../worker';
import { callTool } from '../service';
import { failureCluster } from '../tools/cluster';
import { failureMinimize, MAX_MINIMIZE_CASES, MINIMIZE_CAVEAT } from '../tools/minimize';
import { exitLabExecution, withLabExecution } from '../../lab-execution-context';
import { makeRouteAdapter, assessStream, eventTypes } from '../adapters/types';
import { makeOpdAdapter } from '../adapters/opd';
import { Gateway } from '../gateway';
import { fixtureTransport } from '../transport';
import { FROZEN, ARM } from './helpers';
import type { Adapter } from '../adapters/types';
import type { RetrieveOptions, RetrieveResult } from '../../retrieve';

const BAD = 'c3';
const CASES = ['c1', 'c2', 'c3', 'c4'];

const ARM_BODY = armBodySchema.parse({
  engine: 'opd_note_audit',
  engine_version: 'test/1.0',
  stages: { analysis: { provider: 'ollama', model: 'local-model', max_cost_microusd: 50_000 } },
});

/**
 * The stub engine. One gateway call at `analysis` per item — so `lab_v2.calls` carries a stage for
 * the group key to match on — and then a throw for the bad case, whose message is identical every
 * time so every occurrence lands in ONE `failure_cluster` group.
 */
function stubAdapter(bad: Set<string>, calls: string[]): Adapter {
  return {
    engine: 'opd_note_audit',
    stages: ['analysis'],
    engineVersion: () => 'test/1.0',
    frozenInputs: ['note'],
    perAttemptTimeoutMs: 10_000,
    async run(ctx) {
      calls.push(ctx.caseKey);
      await ctx.gateway.call('analysis', { model: 'local-model', messages: [{ role: 'user', content: ctx.caseKey }] });
      // A plain Error, which `worker.ts` files under category 'provider' — the shape a real engine
      // failure has, and the one `failure_cluster` groups on.
      if (bad.has(ctx.caseKey)) throw new Error('the analyze leg returned nothing parseable');
      return {
        result: { ok: true }, summary: { engine: 'opd_note_audit', ok: true },
        execution_status: 'succeeded', assessment_status: 'assessed',
      };
    },
  };
}

/** A source run in the shape `failure_minimize` reads: a dataset, an experiment, and failed items. */
async function seedFailedRun(db: Db, bad: Set<string>) {
  const budget = await ensureBudget(db, 'research', 'default', 20_000_000);
  const { object: arm } = await putObject(db, 'research', 'arm', ARM_BODY, 'deidentified', 'arm-1');
  const datasetBody = datasetBodySchema.parse({
    engine: 'opd_note_audit',
    cases: CASES.map((k) => ({ case_key: k, member_key: `mk-${k}`, frozen: { note: k } })),
    snapshot_policy: 'note_at_creation',
    exclusions: [],
    classification: 'deidentified',
    source_versions: { origin: 'test' },
    replay_exactness: 'mutable_source',
  });
  const { object: dataset } = await putObject(db, 'research', 'dataset', datasetBody, 'deidentified', 'ds-1');
  const { object: experiment } = await putObject(db, 'research', 'experiment', experimentBodySchema.parse({
    hypothesis: 'the source run', dataset_id: dataset.id, dataset_hash: dataset.hash,
    baseline_arm_id: arm.id, arm_ids: [arm.id], repeats: 1, endpoints: [],
    budget_name: 'default', purpose: 'research',
  }), 'deidentified', 'ex-1');
  const { run } = await submitRun(db, 'research', 'experiment_run', experiment.id, budget.id, 'src-1', 'h', 86_400_000,
    CASES.map((k) => ({
      case_key: k, arm_hash: arm.hash, repetition: 1,
      payload: { engine: 'opd_note_audit', frozen: { note: k }, arm: ARM_BODY, budget_id: budget.id, arm_id: arm.id },
    })));
  const calls: string[] = [];
  const adapters = { opd_note_audit: stubAdapter(bad, calls) };
  for (let p = 0; p < 10; p += 1) {
    const r = await tick({ db, transport: fixtureTransport(), adapters, maxItems: 4 });
    if (r.claimed === 0) break;
  }
  return { run, budget, arm, dataset, experiment, adapters };
}

// ═════════════════════════════════════════════════════════════════════════════════════
// failure_minimize
// ═════════════════════════════════════════════════════════════════════════════════════

test('§17.11 item 6: the bisection converges on the one case that reproduces the group', async () => {
  const db = await freshDb();
  const bad = new Set([BAD]);
  const { run, adapters } = await seedFailedRun(db, bad);

  // The group key comes from failure_cluster's own report, not from a literal here.
  const cluster = await failureCluster(db, { window_hours: 24 }) as {
    groups: { key: { engine: string; stage: string; category: string; message_head: string }; items: number }[];
  };
  const group = cluster.groups.find((g) => g.key.category === 'provider')!;
  assert.ok(group, 'the seeded run produced a provider group');
  assert.equal(group.key.stage, 'analysis', 'the stage of the last model call');
  assert.equal(group.items, 1);

  const out = await failureMinimize({ db, principal: 'research', transport: fixtureTransport(), adapters }, {
    group_key: group.key, run_id: run.id, budget_cap_microusd: 5_000_000, idempotency_key: 'min-1',
  });

  console.log('D3 BISECTION', JSON.stringify({
    started_with: out.started_with,
    steps: out.steps.map((s) => ({ step: s.step, cases: s.case_keys, reproduced: s.reproduced, matching: s.matching_items })),
    minimal: out.minimal_case_keys,
    stopped: out.stopped,
  }));

  assert.equal(out.source_run_id, run.id);
  assert.equal(out.candidates, 1);
  assert.deepEqual(out.started_with, [BAD]);
  assert.deepEqual(out.minimal_case_keys, [BAD]);
  assert.equal(out.stopped, 'minimal');
  assert.equal(out.caveat, MINIMIZE_CAVEAT);
  assert.equal(out.steps.length, 1, 'one candidate needs one step and no halving');
  assert.equal(out.steps[0].reproduced, true);
  assert.equal(out.steps[0].matching_items, 1);
  assert.ok(out.reproducing_run_ids.length === 1);
  await db.close();
});

test('§17.11 item 6: four candidates halve to one, and every step is reported', async () => {
  const db = await freshDb();
  // Every case fails, but only ONE keeps failing when re-run — the transport is what decides, and
  // it is swapped between the source run and the minimisation. That is the shape a real
  // minimisation has: the source run recorded four failures and only one of them is reproducible.
  const { run } = await seedFailedRun(db, new Set(CASES));
  const cluster = await failureCluster(db, { window_hours: 24 }) as {
    groups: { key: { engine: string; stage: string; category: string; message_head: string }; items: number }[];
  };
  const group = cluster.groups.find((g) => g.key.category === 'provider')!;
  assert.equal(group.items, 4);

  const replayCalls: string[] = [];
  const out = await failureMinimize({
    db, principal: 'research', transport: fixtureTransport(),
    adapters: { opd_note_audit: stubAdapter(new Set([BAD]), replayCalls) },
  }, {
    group_key: group.key, run_id: run.id, budget_cap_microusd: 5_000_000, idempotency_key: 'min-2',
  });

  console.log('D3 BISECTION', JSON.stringify({
    started_with: out.started_with,
    steps: out.steps.map((s) => ({ step: s.step, cases: s.case_keys, reproduced: s.reproduced, matching: s.matching_items })),
    minimal: out.minimal_case_keys, stopped: out.stopped, spend: out.spend_microusd,
  }));

  assert.deepEqual(out.started_with, CASES);
  assert.deepEqual(out.minimal_case_keys, [BAD]);
  assert.equal(out.stopped, 'minimal');
  // ⚠️ THE PATH, NOT JUST THE ANSWER. Four, then the two halves, then the winning half's first.
  assert.deepEqual(out.steps.map((s) => s.case_keys), [
    ['c1', 'c2', 'c3', 'c4'],
    ['c1', 'c2'],
    ['c3', 'c4'],
    ['c3'],
  ]);
  assert.deepEqual(out.steps.map((s) => s.reproduced), [true, false, true, true]);
  assert.equal(out.reproducing_run_ids.length, 3);
  // Every step ran its own cases and nothing else — 4 + 2 + 2 + 1.
  assert.equal(replayCalls.length, 9);
  // The estimate is the arm's own ceiling times the cases in the step, never a guess at a price.
  assert.deepEqual(out.steps.map((s) => s.estimated_microusd), [200_000, 100_000, 100_000, 50_000]);
  await db.close();
});

test('§17.11 decision 131: the cap refuses a step BEFORE it runs, and says what it would have cost', async () => {
  const db = await freshDb();
  const { run, adapters } = await seedFailedRun(db, new Set(CASES));
  const cluster = await failureCluster(db, { window_hours: 24 }) as {
    groups: { key: { engine: string | null; stage: string | null; category: string | null; message_head: string | null } }[];
  };
  const key = cluster.groups.find((g) => g.key.category === 'provider')!.key;

  const out = await failureMinimize({ db, principal: 'research', transport: fixtureTransport(), adapters }, {
    group_key: key, run_id: run.id, budget_cap_microusd: 1_000, idempotency_key: 'min-3',
  });
  assert.equal(out.stopped, 'budget_cap');
  assert.equal(out.steps.length, 1);
  assert.equal(out.steps[0].run_id, null, 'no run was submitted');
  assert.equal(out.steps[0].spent_microusd, 0);
  assert.match(String(out.steps[0].note), /refused before the step/);
  assert.match(String(out.steps[0].note), /worst case 200000 would exceed the cap of 1000/);
  // Nothing was created: a refused step is a refusal, not a half-run.
  const runs = await db.query<{ c: string }>(`SELECT count(*)::text AS c FROM lab_v2.runs WHERE operation = 'failure_minimize'`);
  assert.equal(runs[0].c, '0');
  await db.close();
});

test('§17.11 decision 131: at most eight cases reach a first step', async () => {
  assert.equal(MAX_MINIMIZE_CASES, 8);
});

test('§17.11 item 6: a group with no items in that run, and a run with no experiment, are named refusals', async () => {
  const db = await freshDb();
  const { run } = await seedFailedRun(db, new Set([BAD]));
  await assert.rejects(
    () => failureMinimize({ db, principal: 'research' }, {
      group_key: { engine: 'opd_note_audit', stage: 'nonesuch', category: 'provider', message_head: 'x' },
      run_id: run.id, budget_cap_microusd: 1_000_000, idempotency_key: 'min-4',
    }),
    (e: LabError) => e.code === 'NOT_FOUND' && /same failure_cluster report/.test(e.message));

  // A run whose owner is someone else.
  await assert.rejects(
    () => failureMinimize({ db, principal: 'operator' }, {
      group_key: { engine: 'opd_note_audit', stage: 'analysis', category: 'provider', message_head: 'x' },
      run_id: run.id, budget_cap_microusd: 1_000_000, idempotency_key: 'min-5',
    }),
    (e: LabError) => e.code === 'OWNER_ONLY');
  await db.close();
});

test('§17.11 decision 109: failure_minimize is reachable through callTool', async () => {
  const db = await freshDb();
  const { run } = await seedFailedRun(db, new Set([BAD]));
  const cluster = await callTool({ db, principal: 'research', protocolVersion: 'p', sdkVersion: 's' } as never,
    'failure_cluster', { window_hours: 24, limit: 50 }) as {
      groups: { key: { engine: string; stage: string; category: string; message_head: string } }[];
    };
  const key = cluster.groups.find((g) => g.key.category === 'provider')!.key;
  // Through dispatch: the schema, the scope, the handler and the output validation.
  const out = await callTool({ db, principal: 'research', protocolVersion: 'p', sdkVersion: 's' } as never,
    'failure_minimize', { group_key: key, run_id: run.id, budget_cap_microusd: 1_000, idempotency_key: 'min-6' }) as {
      stopped: string; minimal_case_keys: string[]; caveat: string;
    };
  // A cap of 1_000 refuses the first step, which is the cheapest reachable proof that dispatch,
  // schema validation and the handler all agree — and it spends nothing to get it.
  assert.equal(out.stopped, 'budget_cap');
  assert.ok(out.caveat.length > 50);
  // The reviewer key may not call it at all.
  await assert.rejects(
    () => callTool({ db, principal: 'reviewer', protocolVersion: 'p', sdkVersion: 's' } as never,
      'failure_minimize', { group_key: key, run_id: run.id, budget_cap_microusd: 1_000, idempotency_key: 'min-7' }),
    (e: LabError) => e.code === 'SCOPE_DENIED');
  await db.close();
});

// ═════════════════════════════════════════════════════════════════════════════════════
// Decision 145 — the two forced retrieval options
// ═════════════════════════════════════════════════════════════════════════════════════

type Seen = { query: string; opts: RetrieveOptions };
const EMPTY: RetrieveResult = { hits: [], expandedQuery: 'q', meta: { vector_pool: 0, bm25_pool: 0, fused: 0, reranked: false } } as never;

test('§17.11 decision 145: the shared route edge forces skipExpand and useReranker off', async () => {
  const db = await freshDb();
  const seen: Seen[] = [];
  const budget = await ensureBudget(db, 'research', 'default', 10_000_000);
  const { run } = await submitRun(db, 'research', 'experiment_run', null, budget.id, 'r145-1', 'h', 86_400_000, [
    { case_key: 'x', arm_hash: 'h', repetition: 1, payload: { engine: 'stub', frozen: { engine: 'ask', body: { question: 'q' } }, arm: { stages: {} }, budget_id: budget.id } },
  ]);
  /**
   * The route's own body, calling the retrieve edge the way an engine does: through the lab
   * execution context, with ITS OWN options — `useReranker: true` and expansion left on, which is
   * exactly what decision 133 measured escaping the fence.
   */
  const post = async () => {
    const ctx = (await import('../../lab-execution-context')).labExecution();
    await ctx!.retrieve!('a query', { topK: 8, useReranker: true, bm25: true } as never);
    return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
  };
  const adapter = makeRouteAdapter({
    engine: 'ask', path: '/api/ask', file: 'app/api/ask/route.ts', post: post as never,
    summarise: (read) => ({ event_types: eventTypes(read) }), assess: assessStream,
  }, {
    retrieve: async (query: string, opts: RetrieveOptions) => { seen.push({ query, opts }); return EMPTY; },
  });
  await tick({ db, transport: fixtureTransport(), adapters: { stub: adapter } });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].opts.skipExpand, true, 'expandQuery cannot fire');
  assert.equal(seen[0].opts.useReranker, false, 'the rerank judge cannot fire');
  // The caller's other options survive: only the two named by decision 145 are overridden.
  assert.equal((seen[0].opts as { topK?: number }).topK, 8);
  assert.equal((seen[0].opts as { bm25?: boolean }).bm25, true);

  const [item] = await itemsOf(db, run.id);
  const events = await db.query<{ kind: string; body: Record<string, unknown> }>(
    `SELECT kind, body FROM lab_v2.events WHERE aggregate = $1`, [item.id]);
  const read = events.find((e) => e.kind === 'retrieval_read');
  assert.ok(read, 'the read is logged');
  assert.equal(read!.body.forced_no_model, true, 'and the event says the options were forced');
  await db.close();
});

test('§17.11 decision 145: the OPD edge forces them too, and the frozen branch is untouched', async () => {
  const db = await freshDb();
  const budget = await ensureBudget(db, 'research', 'default', 10_000_000);
  const { run } = await submitRun(db, 'research', 'experiment_run', null, budget.id, 'r145-2', 'h', 86_400_000, [
    { case_key: 'test-note-0001', arm_hash: 'h', repetition: 1, payload: {} },
  ]);
  const [item] = await itemsOf(db, run.id);
  const gateway = new Gateway({
    db, itemId: item.id, leaseToken: 0, budgetId: budget.id,
    transport: fixtureTransport({ reply: JSON.stringify({ findings: [], pdqi9: {} }) }),
    stages: { analysis: { provider: 'ollama', model: 'local-model', max_cost_microusd: 100_000 } },
  });

  const seen: Seen[] = [];
  const events: { kind: string; body: Record<string, unknown> }[] = [];
  await makeOpdAdapter({
    retrieve: (async (query: string, opts: RetrieveOptions) => { seen.push({ query, opts }); return EMPTY; }) as never,
  }).run({
    runId: run.id, itemId: item.id, caseKey: 'test-note-0001',
    // ⚠️ NO `sources` ON THE FROZEN CASE, so the edge takes its LIVE branch — the frozen branch
    // returns the dataset's own chunks and never reaches the corpus, so there is nothing to force.
    frozen: FROZEN, arm: ARM, repetition: 1, gateway,
    event: (kind, body) => { events.push({ kind, body }); },
    checkpoint: async (_n, _h, produce) => produce(),
  });
  assert.ok(seen.length >= 1, 'the OPD engine retrieved');
  for (const s of seen) {
    assert.equal(s.opts.skipExpand, true);
    assert.equal(s.opts.useReranker, false);
  }
  const reads = events.filter((e) => e.kind === 'retrieval_read');
  assert.ok(reads.length >= 1);
  for (const r of reads) {
    assert.equal(r.body.frozen, false);
    assert.equal(r.body.forced_no_model, true);
  }
  await db.close();
});

test('§17.11 decision 145: the source text of both edges carries the two options', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const ROOT = process.cwd();
  for (const file of ['lib/lab-v2/adapters/types.ts', 'lib/lab-v2/adapters/opd.ts', 'lib/lab-v2/adapters/ipd-discharge.ts']) {
    const src = readFileSync(join(ROOT, file), 'utf8');
    assert.match(src, /skipExpand: true, useReranker: false/, `${file} does not force the two options`);
    assert.match(src, /forced_no_model: true/, `${file} does not record that it forced them`);
  }
  // ⚠️ AND THE THIRD PATH IS STILL OPEN AND STILL NAMED. Decision 133 accepts the embedding read;
  // this asserts nobody quietly claimed otherwise.
  const types = readFileSync(join(ROOT, 'lib/lab-v2/adapters/types.ts'), 'utf8');
  assert.match(types, /embedding/i, 'the accepted egress path is named where the options are forced');
});

// ═════════════════════════════════════════════════════════════════════════════════════
// Decision 143 — the retirement, from the v2 side
// ═════════════════════════════════════════════════════════════════════════════════════

test('§17.11 decision 143: system_capabilities carries the deprecation for every principal', async () => {
  const db = await freshDb();
  for (const principal of ['research', 'operator', 'reviewer', 'release'] as const) {
    const out = await callTool({ db, principal, protocolVersion: 'p', sdkVersion: 's' } as never,
      'system_capabilities', {}) as { deprecations: { tool: string; surface: string; replaced_by: string[]; since: string }[] };
    assert.deepEqual(out.deprecations, [{
      tool: 'lab_query', surface: 'v1', replaced_by: ['audit_search', 'corpus_search'], since: 'e5f53c55',
    }], `${principal} cannot see what was retired`);
  }
  // Both replacements exist on this surface and are visible to the research key.
  const research = await callTool({ db, principal: 'research', protocolVersion: 'p', sdkVersion: 's' } as never,
    'system_capabilities', {}) as { tools: { name: string }[] };
  const names = research.tools.map((t) => t.name);
  for (const t of ['audit_search', 'corpus_search']) assert.ok(names.includes(t), `${t} is the replacement and must exist`);
  await db.close();
});

test('§17.11: the three D3 tools are on the surface with their declared metadata', async () => {
  const db = await freshDb();
  const out = await callTool({ db, principal: 'operator', protocolVersion: 'p', sdkVersion: 's' } as never,
    'system_capabilities', {}) as { tools: { name: string; effect: string; cost_class: string; identifying_input: boolean; slice: string }[] };
  const byName = Object.fromEntries(out.tools.map((t) => [t.name, t]));
  assert.equal(byName.case_ask.effect, 'read');
  assert.equal(byName.case_ask.cost_class, 'free');
  assert.equal(byName.case_ask.identifying_input, true);
  assert.equal(byName.case_ask.slice, 'D-3');
  assert.equal(byName.case_timeline.identifying_input, true);
  assert.equal(byName.failure_minimize.effect, 'research_write');
  assert.equal(byName.failure_minimize.cost_class, 'metered');
  assert.equal(byName.failure_minimize.identifying_input, false, 'a group key and a run id name no person');
  await db.close();
});

test('§17.11: an unfenced import has not crept in — the case readers stay under lib/lab-v2', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const src = readFileSync(join(process.cwd(), 'lib/lab-v2/sources/case-readers.ts'), 'utf8');
  // Both reads go through the two doors this platform already has, and no third one is opened.
  assert.match(src, /import \{ boundedRead \} from '\.\/read'/);
  assert.match(src, /import \{ metabaseQuery \} from '\.\.\/\.\.\/metabase'/);
  assert.ok(!/from '\.\.\/\.\.\/db'/.test(src), 'the case readers never reach lib/db directly');
  // And nothing here writes.
  for (const word of ['INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER']) {
    assert.ok(!new RegExp(`\\b${word}\\b`).test(src.replace(/\/\*[\s\S]*?\*\//g, '')), `case-readers.ts contains ${word}`);
  }
});
