/**
 * lib/lab-v2/service.ts — the fifteen tool handlers (LAB-MCP-V2-PRD-v1.0 §8.1).
 *
 * ONE DISPATCH PATH FOR EVERY TOOL, and it does the same four things in the same order
 * every time: re-check the scope, validate the input, run the handler, validate the
 * output. Nothing is left to a handler's memory.
 *
 * ⚠️ THE SCOPE CHECK IS HERE, NOT ONLY IN `tools/list`. Visibility is a usability feature;
 * authorisation is this line. A principal that guesses the name of a tool it cannot see
 * gets SCOPE_DENIED — explicitly NOT "unknown tool" (§3.2.2), because a truthful denial
 * is a smaller leak than a lie a caller can distinguish by timing anyway.
 *
 * ⚠️ INPUT VALIDATION IS EXPLICIT HERE rather than delegated to the SDK. The MCP SDK is
 * given a JSON Schema through the bridge in lib/mcp-v2/schema-bridge.ts and may or may
 * not enforce it depending on how a client calls; §8's "inputs are validated at dispatch"
 * has to be true regardless, so the Zod schema is applied here where it cannot be skipped.
 */
import type { Db } from './db';
import {
  LabError, RUN_DEADLINE_MS, SCOPES_BY_PRINCIPAL, SUPPORTED_ENGINES, ENGINE_SLICE, PROVIDERS,
  armBodySchema, datasetBodySchema, experimentBodySchema, hash, toolSchemas,
  type Principal, type Scope, type ToolName,
} from './contracts';
import { PRICING_VERSION, isSupportedModel, modelsFor } from './pricing';
import { BY_NAME, visibleTools } from './registry';
import {
  appliedMigrations, countItemsByState, deriveRunState, ensureBudget, getBudget, getObject,
  getRun, getWorker, itemsOf, putObject, recordEvent, requestCancel, retryRun, setWorkerPaused, submitRun,
} from './store';
import { opdAdapter } from './adapters/opd';
import { freezeOpdCase, validateFrozenCase } from './sources/opd';
import { openrouterConfigured, geminiConfigured } from '../llm';
import { bedrockConfigured } from '../bedrock';

export interface ServiceDeps {
  db: Db;
  principal: Principal;
  protocolVersion: string;
  sdkVersion: string;
}

const DEFAULT_BUDGET_CAP_MICROUSD = 5_000_000;   // $5 per named budget until an operator raises it.

function scopesOf(principal: Principal): readonly Scope[] { return SCOPES_BY_PRINCIPAL[principal]; }

/** §13 — a tool call carrying a `principal` or `reviewer` field has it IGNORED. */
function stripIdentityFields(args: Record<string, unknown>): Record<string, unknown> {
  const { principal: _p, reviewer: _r, owner: _o, ...rest } = args;
  return rest;
}

export async function callTool(deps: ServiceDeps, name: string, rawArgs: unknown): Promise<unknown> {
  const spec = BY_NAME[name];
  const scopes = scopesOf(deps.principal);
  // Unknown and unauthorised are BOTH denials here. An unknown name is a genuine
  // -32602 at the protocol layer (the SDK never routes it to us), so anything reaching
  // this branch is a hidden tool being probed by name.
  if (!spec || !spec.scopes.some((s) => scopes.includes(s))) {
    throw new LabError('SCOPE_DENIED', `principal '${deps.principal}' may not call '${name}'`);
  }
  const args = stripIdentityFields((rawArgs ?? {}) as Record<string, unknown>);
  const parsed = toolSchemas[spec.name as ToolName].input.safeParse(args);
  if (!parsed.success) {
    throw new LabError('INVALID_INPUT', `invalid input for '${name}': ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
  }

  const out = await HANDLERS[spec.name](deps, parsed.data as never);

  // Outputs are validated before return (§8): a handler that drifts from its declared
  // contract fails here rather than shipping a shape a client will silently mis-read.
  const validated = toolSchemas[spec.name as ToolName].output.safeParse(out);
  if (!validated.success) {
    throw new LabError('STORE_UNAVAILABLE', `internal: '${name}' produced an output that does not match its schema: ${validated.error.issues[0]?.message ?? ''}`);
  }
  // §3.2.3 — actor, tool and outcome. NEVER the request body of a tool carrying clinical text.
  await recordEvent(deps.db, deps.principal, name, 'tool_call', { tool: name, request_hash: hash(args), outcome: 'ok' })
    .catch(() => { /* the audit trail must never be the thing that fails the call */ });
  return validated.data;
}

type Handler = (deps: ServiceDeps, args: Record<string, unknown>) => Promise<unknown>;

const HANDLERS: Record<ToolName, Handler> = {
  // ── capability discovery ──────────────────────────────────────────────────────────
  async system_capabilities(deps) {
    const scopes = scopesOf(deps.principal);
    return {
      principal: deps.principal,
      scopes: [...scopes],
      tools: visibleTools(scopes).map((s) => ({
        name: s.name, effect: s.effect, cost_class: s.cost_class, classification: s.classification, slice: s.slice,
      })),
      protocol_version: deps.protocolVersion,
      sdk_version: deps.sdkVersion,
      lab_v2_enabled: process.env.LAB_V2_ENABLED === '1',
      pricing_version: PRICING_VERSION,
    };
  },

  async engine_describe(_deps, args) {
    const engine = String(args.engine) as (typeof SUPPORTED_ENGINES)[number];
    const supported = SUPPORTED_ENGINES.includes(engine);
    return {
      engine,
      supported,
      slice: ENGINE_SLICE[engine],
      stages: supported ? [...opdAdapter.stages] : [],
      engine_version: supported ? opdAdapter.engineVersion() : null,
      frozen_inputs: supported ? [...opdAdapter.frozenInputs] : [],
      // Slice A never freezes retrieval, so 'frozen' is not offered for any engine yet (§4.2).
      replay_exactness_available: supported ? (['mutable_source'] as const).slice() : [],
    };
  },

  async model_capabilities() {
    const configured: Record<string, boolean> = {
      bedrock: bedrockConfigured(),
      openrouter: openrouterConfigured(),
      vertex: geminiConfigured(),
      ollama: !!process.env.OLLAMA_BASE_URL,
    };
    return {
      pricing_version: PRICING_VERSION,
      providers: PROVIDERS.map((p) => ({
        provider: p,
        configured: configured[p] ?? false,
        // Round 1 reports configuration only. An actual probe is a live model call and
        // would make a capability read cost money; §6.1 asks for the last SUCCESSFUL
        // probe, and until a probe exists the honest answer is null, not a guess.
        health_tested_at: null,
        models: modelsFor(p),
      })),
    };
  },

  // ── operational health ────────────────────────────────────────────────────────────
  async system_health(deps) {
    const { db } = deps;
    const migrations = await appliedMigrations(db);
    const worker = await getWorker(db);
    const depth = await db.query<{ state: string; c: string }>(`SELECT state, count(*)::text AS c FROM lab_v2.items GROUP BY state`);
    const oldest = await db.query<{ age: string | null }>(
      `SELECT EXTRACT(EPOCH FROM (now() - min(next_at)))::text AS age FROM lab_v2.items WHERE state = 'queued'`);
    const reaped = await db.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM lab_v2.events WHERE kind = 'item_reaped' AND created_at > now() - interval '24 hours'`);
    const calls = await db.query<{ state: string; c: string }>(
      `SELECT state, count(*)::text AS c FROM lab_v2.calls WHERE created_at > now() - interval '24 hours' GROUP BY state`);
    return {
      store_reachable: true,
      migrations_applied: migrations,
      worker_paused: worker.paused,
      queue_depth_by_state: Object.fromEntries(depth.map((r) => [r.state, Number(r.c)])),
      oldest_queued_age_seconds: oldest[0]?.age == null ? null : Number(oldest[0].age),
      reaped_last_24h: Number(reaped[0]?.c ?? 0),
      calls_by_state_last_24h: Object.fromEntries(calls.map((r) => [r.state, Number(r.c)])),
    };
  },

  async worker_status(deps) {
    const w = await getWorker(deps.db);
    return { id: w.id, paused: w.paused, revision: w.revision, heartbeat_at: w.heartbeat_at, active_item: w.active_item };
  },

  async worker_control(deps, args) {
    const w = await setWorkerPaused(deps.db, args.action === 'pause');
    return { id: w.id, paused: w.paused, revision: w.revision };
  },

  // ── datasets ──────────────────────────────────────────────────────────────────────
  async dataset_create(deps, args) {
    const engine = String(args.engine);
    if (!SUPPORTED_ENGINES.includes(engine as never)) {
      throw new LabError('ENGINE_UNSUPPORTED', `engine '${engine}' has no round-1 adapter; it arrives in slice ${ENGINE_SLICE[engine as never] ?? '?'}`);
    }
    // Read from production OUTSIDE any lab context. freezeOpdCase throws CASE_NOT_FOUND
    // or SOURCE_UNAVAILABLE and never a partially frozen case.
    const frozen = await freezeOpdCase(String(args.case_key));
    const body = datasetBodySchema.parse({
      engine,
      cases: [{ case_key: frozen.case_key, member_key: frozen.member_key, frozen: frozen.frozen }],
      snapshot_policy: 'single_case_at_creation',
      exclusions: [],
      classification: 'deidentified',
      source_versions: frozen.source_versions,
      // ALWAYS 'mutable_source' in Slice A: retrieval is not frozen, so a replay can
      // legitimately differ. Every report says so (§4.2).
      replay_exactness: 'mutable_source',
    });
    const { object, deduplicated } = await putObject(deps.db, deps.principal, 'dataset', body, 'deidentified', String(args.idempotency_key));
    return { dataset_id: object.id, hash: object.hash, replay_exactness: body.replay_exactness, classification: 'deidentified', deduplicated };
  },

  async dataset_preview(deps, args) {
    const obj = await getObject(deps.db, String(args.dataset_id));
    if (!obj || obj.kind !== 'dataset') throw new LabError('NOT_FOUND', `no dataset ${args.dataset_id}`);
    const body = datasetBodySchema.parse(obj.body);
    return {
      dataset_id: obj.id, engine: body.engine, hash: obj.hash, classification: obj.classification,
      replay_exactness: body.replay_exactness, snapshot_policy: body.snapshot_policy,
      exclusions: body.exclusions, source_versions: body.source_versions,
      // Case keys only — NEVER the frozen clinical text (§8.1).
      case_keys: body.cases.map((c) => c.case_key),
      created_at: new Date(obj.created_at).toISOString(),
    };
  },

  async dataset_validate(deps, args) {
    const obj = await getObject(deps.db, String(args.dataset_id));
    if (!obj || obj.kind !== 'dataset') throw new LabError('NOT_FOUND', `no dataset ${args.dataset_id}`);
    const body = datasetBodySchema.parse(obj.body);
    const checked: { case_key: string; field: string; matches: boolean }[] = [];
    for (const c of body.cases) {
      const fields = await validateFrozenCase(c.case_key, c.frozen as never);
      for (const f of fields) checked.push({ case_key: c.case_key, ...f });
    }
    return {
      dataset_id: obj.id,
      matches: checked.every((c) => c.matches),
      checked,
      note: 'replay_exactness is mutable_source: retrieval is not frozen in Slice A, so a matching report does not promise an identical replay.',
    };
  },

  // ── experiments ───────────────────────────────────────────────────────────────────
  async experiment_create(deps, args) {
    const dataset = await getObject(deps.db, String(args.dataset_id));
    if (!dataset || dataset.kind !== 'dataset') throw new LabError('NOT_FOUND', `no dataset ${args.dataset_id}`);
    if (dataset.hash !== String(args.dataset_hash)) {
      throw new LabError('DATASET_HASH_MISMATCH', `dataset ${dataset.id} hashes to ${dataset.hash}, not ${args.dataset_hash}`);
    }
    const datasetBody = datasetBodySchema.parse(dataset.body);

    const rawArms = [args.baseline_arm as Record<string, unknown>, ...((args.arms as Record<string, unknown>[]) ?? [])];
    const armIds: string[] = [];
    for (const raw of rawArms) {
      const arm = armBodySchema.parse({ engine_version: opdAdapter.engineVersion(), ...raw });
      if (arm.engine !== datasetBody.engine) {
        throw new LabError('INVALID_INPUT', `arm engine '${arm.engine}' does not match dataset engine '${datasetBody.engine}'`);
      }
      const stageNames = Object.keys(arm.stages);
      if (!stageNames.length) throw new LabError('BUDGET_UNBOUNDED', 'an arm must price at least one stage');
      // Decision 11 — a stage the engine does not list can never be billed, so an arm that
      // names one has reserved budget against work that will never run and declared a
      // variable the experiment cannot actually vary. Refuse it here, before anything is
      // queued, rather than let the run complete and quietly mean less than it claims.
      const known = new Set<string>(opdAdapter.stages);
      for (const stage of stageNames) {
        if (!known.has(stage)) {
          throw new LabError('STAGE_UNKNOWN', `engine '${arm.engine}' has no stage '${stage}'; it lists ${[...known].join(', ')}`);
        }
      }
      for (const [stage, spec] of Object.entries(arm.stages)) {
        // §4.2 — an unpriced stage is refused BEFORE anything is queued, not discovered
        // when the first call tries to reserve against a cap that was never set.
        if (typeof spec.max_cost_microusd !== 'number') {
          throw new LabError('BUDGET_UNBOUNDED', `stage '${stage}' has no max_cost_microusd`);
        }
        if (!isSupportedModel(spec.provider, spec.model)) {
          throw new LabError('MODEL_UNSUPPORTED', `stage '${stage}': (${spec.provider}, ${spec.model}) is not supported or not priced`);
        }
      }
      const { object } = await putObject(deps.db, deps.principal, 'arm', arm, 'deidentified', null);
      armIds.push(object.id);
    }

    const budget = await ensureBudget(deps.db, deps.principal, String(args.budget_name ?? 'default'),
      Number(args.budget_cap_microusd ?? DEFAULT_BUDGET_CAP_MICROUSD));

    const body = experimentBodySchema.parse({
      hypothesis: args.hypothesis,
      dataset_id: dataset.id,
      dataset_hash: dataset.hash,
      baseline_arm_id: armIds[0],
      arm_ids: armIds,
      repeats: Number(args.repeats ?? 1),
      endpoints: args.endpoints ?? [],
      budget_name: String(args.budget_name ?? 'default'),
      purpose: String(args.purpose ?? 'research'),
    });
    const { object, deduplicated } = await putObject(deps.db, deps.principal, 'experiment', body, 'deidentified', String(args.idempotency_key));
    return { experiment_id: object.id, hash: object.hash, baseline_arm_id: armIds[0], arm_ids: armIds, budget_id: budget.id, deduplicated };
  },

  async experiment_run(deps, args) {
    const experiment = await getObject(deps.db, String(args.experiment_id));
    if (!experiment || experiment.kind !== 'experiment') throw new LabError('NOT_FOUND', `no experiment ${args.experiment_id}`);
    if (experiment.owner !== deps.principal) throw new LabError('OWNER_ONLY', 'an experiment may only be run by the principal that created it');
    const body = experimentBodySchema.parse(experiment.body);
    const dataset = await getObject(deps.db, body.dataset_id);
    if (!dataset) throw new LabError('NOT_FOUND', `experiment ${experiment.id} references a dataset that is gone`);
    const datasetBody = datasetBodySchema.parse(dataset.body);
    const budget = await ensureBudget(deps.db, deps.principal, body.budget_name, DEFAULT_BUDGET_CAP_MICROUSD);

    // One item per (case, arm, repetition). Each carries EVERYTHING the worker needs, so
    // the worker never re-reads an object and can therefore never observe a different one.
    const items = [];
    for (const arm_id of body.arm_ids) {
      const armObj = await getObject(deps.db, arm_id);
      if (!armObj) throw new LabError('NOT_FOUND', `experiment ${experiment.id} references arm ${arm_id}, which is gone`);
      for (const c of datasetBody.cases) {
        for (let r = 1; r <= body.repeats; r += 1) {
          items.push({
            case_key: c.case_key,
            arm_hash: armObj.hash,
            repetition: r,
            payload: { engine: datasetBody.engine, frozen: c.frozen, arm: armObj.body, budget_id: budget.id, arm_id },
          });
        }
      }
    }
    const { run, itemCount, deduplicated } = await submitRun(
      deps.db, deps.principal, 'experiment_run', experiment.id, budget.id,
      String(args.idempotency_key), hash({ experiment: experiment.id, items: items.length }),
      RUN_DEADLINE_MS, items,
    );
    return { run_id: run.id, item_count: itemCount, deduplicated };
  },

  // ── job lifecycle ─────────────────────────────────────────────────────────────────
  async run_status(deps, args) {
    const run = await getRun(deps.db, String(args.run_id));
    if (!run) throw new LabError('NOT_FOUND', `no run ${args.run_id}`);
    const state = await deriveRunState(deps.db, run.id);
    const counts = await countItemsByState(deps.db, run.id);
    const items = await itemsOf(deps.db, run.id);
    const tally = (field: 'execution_status' | 'assessment_status' | 'attribution_status') => {
      const out: Record<string, number> = {};
      for (const i of items) { const k = i[field] ?? 'not_set'; out[k] = (out[k] ?? 0) + 1; }
      return out;
    };
    const budget = await getBudget(deps.db, run.budget_id);
    return {
      run_id: run.id, state,
      created_at: new Date(run.created_at).toISOString(),
      deadline_at: new Date(run.deadline_at).toISOString(),
      items_by_state: counts,
      execution_status: tally('execution_status'),
      assessment_status: tally('assessment_status'),
      attribution_status: tally('attribution_status'),
      reserved_microusd: Number(budget?.reserved_microusd ?? 0),
      spent_microusd: Number(budget?.spent_microusd ?? 0),
      unknown_microusd: Number(budget?.unknown_microusd ?? 0),
    };
  },

  async run_result(deps, args) {
    const run = await getRun(deps.db, String(args.run_id));
    if (!run) throw new LabError('NOT_FOUND', `no run ${args.run_id}`);
    const limit = Number(args.limit ?? 20);
    const offset = Number(args.offset ?? 0);
    const all = await countItemsByState(deps.db, run.id);
    const total = Object.values(all).reduce((a, b) => a + b, 0);
    const items = await itemsOf(deps.db, run.id, limit, offset);
    return {
      run_id: run.id,
      total,
      items: items.map((i) => {
        const stored = (i.result ?? null) as { summary?: Record<string, unknown>; artifact_id?: string } | null;
        return {
          item_id: i.id, case_key: i.case_key, arm_hash: i.arm_hash, repetition: i.repetition,
          state: i.state,
          execution_status: i.execution_status as never,
          assessment_status: i.assessment_status as never,
          attribution_status: i.attribution_status as never,
          attempts: i.attempts,
          summary: stored?.summary ?? null,
          error: i.error,
          // Large bodies are returned as a resource, not inline (§8).
          artifact: stored?.artifact_id ? `lab://artifacts/${stored.artifact_id}` : null,
        };
      }),
    };
  },

  async run_cancel(deps, args) {
    const run = await getRun(deps.db, String(args.run_id));
    if (!run) throw new LabError('NOT_FOUND', `no run ${args.run_id}`);
    if (run.owner !== deps.principal) throw new LabError('OWNER_ONLY', 'a run may only be cancelled by its owner');
    const cancelled = await requestCancel(deps.db, run.id);
    const state = await deriveRunState(deps.db, run.id);
    return { run_id: run.id, state, cancelled_items: cancelled };
  },

  async run_retry(deps, args) {
    const run = await getRun(deps.db, String(args.run_id));
    if (!run) throw new LabError('NOT_FOUND', `no run ${args.run_id}`);
    if (run.owner !== deps.principal) throw new LabError('OWNER_ONLY', 'a run may only be retried by its owner');
    const requeued = await retryRun(deps.db, run.id);
    return { run_id: run.id, requeued };
  },
};
