/**
 * lib/lab-v2/contracts.ts — every schema, code and hash rule the v2 platform shares
 * (LAB-MCP-V2-PRD-v1.0 §2, §3, §4.2, §8, §9).
 *
 * One name for one thing (PRD §2). If a value appears in a column, a tool schema and a
 * report, it is defined ONCE here and imported everywhere else. The enums below are the
 * single source for the migration's CHECK-equivalent vocabulary, the registry's scope
 * and effect fields, and the three result statuses.
 *
 * Zod is pinned to 3.25.76 (§14.2). Zod 3 implements Standard Schema's `validate` but
 * NOT `jsonSchema`, and the MCP SDK 2.0.0 needs both — lib/mcp-v2/schema-bridge.ts
 * closes that gap. Nothing in this file knows about the SDK.
 */
import { createHash } from 'crypto';
import { z } from 'zod';

export { LabError, type LabErrorCode } from '../lab-execution-context';

// ── Identity (§3) ────────────────────────────────────────────────────────────────────
export const SCOPES = ['research_read', 'research_write', 'production_read', 'production_write', 'review', 'release'] as const;
export type Scope = (typeof SCOPES)[number];

export const EFFECTS = ['read', 'research_write', 'production_write', 'review', 'release'] as const;
export type Effect = (typeof EFFECTS)[number];

export const PRINCIPALS = ['research', 'operator', 'reviewer', 'release'] as const;
export type Principal = (typeof PRINCIPALS)[number];

export const CLASSIFICATIONS = ['deidentified', 'identifying'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export const COST_CLASSES = ['free', 'metered'] as const;
export type CostClass = (typeof COST_CLASSES)[number];

/** §3.1 — the key a caller holds IS its authority. No self-declared header, ever. */
export const SCOPES_BY_PRINCIPAL: Record<Principal, readonly Scope[]> = {
  research: ['research_read', 'research_write', 'production_read'],
  operator: ['production_read', 'production_write', 'research_read'],
  reviewer: ['review', 'research_read', 'production_read'],
  release: ['release', 'production_read'],
};

/** §3.1 — one env var per principal. LAB_API_KEY (v1) is deliberately absent. */
export const KEY_ENV_BY_PRINCIPAL: Record<Principal, string> = {
  research: 'LAB_API_KEY_RESEARCH',
  operator: 'LAB_API_KEY_OPERATOR',
  reviewer: 'LAB_API_KEY_REVIEWER',
  release: 'LAB_API_KEY_RELEASE',
};

// ── Engines and objects (§2, §4) ─────────────────────────────────────────────────────
export const ENGINE_IDS = ['opd_note_audit', 'ask', 'ddx', 'appropriateness', 'pathway', 'doc_audit', 'ipd_episode', 'ipd_discharge', 'readmission', 'preop'] as const;
export type EngineId = (typeof ENGINE_IDS)[number];

/**
 * Engines wired end to end. Round 1 shipped `opd_note_audit`; round A3 adds the five that
 * §17.3 names, each behind the same fence and each surviving decision 34 (no request field
 * that names or resolves to a person — the evidence is in the round A3 report).
 */
export const SUPPORTED_ENGINES: readonly EngineId[] = [
  'opd_note_audit', 'ask', 'ddx', 'appropriateness', 'pathway', 'doc_audit',
];

/**
 * DECISION 35 / 35a — stages are the DISTINCT GOVERNED LABELS of the handler's whole call tree,
 * in the order they occur, one stage per label. Read out of the source on 05 Sep 2026, not
 * guessed; several live in a core module the route delegates to rather than in the route file,
 * which is why the call tree and not the file is the unit.
 *
 * `conditional` marks a label that does not fire on every request — `investigations_parse` only
 * when the body supplies investigations, `clinical_state_normalise` only behind its flag. Per
 * decision 35a a conditional stage is still LISTED and still MUST BE PRICED; when it does not
 * fire there is no call and no charge. Pricing a stage that may not run costs nothing, and
 * refusing to price it would make the arm's cost ceiling a guess.
 */
export interface EngineStage { name: string; conditional: boolean }

export const ENGINE_STAGES: Partial<Record<EngineId, readonly EngineStage[]>> = {
  // lib/opd-note-audit.ts:1137 — the single governed leg.
  opd_note_audit: [{ name: 'analysis', conditional: false }],
  // app/api/ask/route.ts: investigations.ts:187, then 254, 296, 354, 386.
  ask: [
    { name: 'investigations_parse', conditional: true },
    { name: 'draft', conditional: false },
    { name: 'critique', conditional: false },
    { name: 'revision', conditional: false },
    { name: 'answer', conditional: false },
  ],
  // app/api/ddx/route.ts: investigations.ts:187, route:197, then 402, 424, 478.
  ddx: [
    { name: 'investigations_parse', conditional: true },
    { name: 'clinical_state_normalise', conditional: true },
    { name: 'ddx_draft', conditional: false },
    { name: 'ddx_critique', conditional: false },
    { name: 'ddx_revision', conditional: false },
  ],
  // lib/lvc-value.ts:124 and :131, then app/api/appropriateness/route.ts:111.
  appropriateness: [
    { name: 'lvc_value', conditional: false },
    { name: 'lvc_value_critique', conditional: false },
    { name: 'clinical_state_normalise', conditional: true },
  ],
  // lib/pathway.ts:68, then app/api/pathway/skeleton/route.ts:71.
  pathway: [
    { name: 'pathway_skeleton', conditional: false },
    { name: 'clinical_state_normalise', conditional: true },
  ],
  // lib/doc-audit.ts:199, :309/310, :423, :433, :443.
  doc_audit: [
    { name: 'doc_audit_analyze', conditional: false },
    { name: 'doc_audit_cite_gate', conditional: false },
    { name: 'doc_audit_prognosis', conditional: false },
    { name: 'doc_audit_prognosis_critique', conditional: false },
    { name: 'doc_audit_prognosis_revise', conditional: false },
  ],
};

export function stagesFor(engine: EngineId): readonly EngineStage[] {
  return ENGINE_STAGES[engine] ?? [];
}

/** The slice that adds each engine, reported by engine_describe for unsupported ones. */
export const ENGINE_SLICE: Record<EngineId, string> = {
  opd_note_audit: 'A', ask: 'A round 2', ddx: 'A round 2', appropriateness: 'A round 2',
  pathway: 'A round 2', doc_audit: 'A round 2', ipd_episode: 'B', ipd_discharge: 'D',
  readmission: 'D', preop: 'D',
};

/**
 * §4.2 — opd_note_audit's stages (decision 11). ONE stage: the engine has exactly one
 * governed model call site, `opd_audit_analyze` at lib/opd-note-audit.ts:1137. A
 * `verification` stage was declared in the original §4.2 and no call would ever have been
 * billed to it, so an arm could reserve budget against a stage that never runs. An arm
 * naming a stage absent from this list is refused with STAGE_UNKNOWN.
 * `max_cost_microusd` is required on each stage that IS listed.
 */
export const OPD_STAGES = ['analysis'] as const;

export const OBJECT_KINDS = ['dataset', 'arm', 'experiment', 'artifact', 'report', 'operation_plan'] as const;
export type ObjectKind = (typeof OBJECT_KINDS)[number];

export const PROVIDERS = ['bedrock', 'openrouter', 'ollama', 'vertex'] as const;
export type Provider = (typeof PROVIDERS)[number];

export const REPLAY_EXACTNESS = ['frozen', 'mutable_source'] as const;

// ── Lifecycle (§5.1, §9) ─────────────────────────────────────────────────────────────
export const ITEM_STATES = ['queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled', 'expired'] as const;
export type ItemState = (typeof ITEM_STATES)[number];
export const RUN_STATES = ITEM_STATES;
export type RunState = ItemState;

export const ATTEMPT_OUTCOMES = ['succeeded', 'failed', 'abandoned', 'cancelled', 'lease_lost'] as const;
export const CALL_STATES = ['reserved', 'settled', 'unknown', 'refused'] as const;

/** §9 — three independent fields, all three set on every finished item. */
export const EXECUTION_STATUSES = ['succeeded', 'failed', 'partial', 'cancelled', 'expired'] as const;
export const ASSESSMENT_STATUSES = ['assessed', 'unassessable', 'not_reached'] as const;
export const ATTRIBUTION_STATUSES = ['verified', 'invalid', 'unknown'] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];
export type AssessmentStatus = (typeof ASSESSMENT_STATUSES)[number];
export type AttributionStatus = (typeof ATTRIBUTION_STATUSES)[number];

/** §5.3 / §5.6 — the scheduling constants. Fixed in Slice A; not tool inputs. */
export const LEASE_MS = 120_000;
export const HEARTBEAT_MS = 30_000;
export const MAX_ATTEMPTS = 3;
export const REQUEUE_DELAY_MS = 60_000;
export const RUN_DEADLINE_MS = 24 * 60 * 60 * 1000;
export const TICK_MAX_ITEMS = 4;
export const TICK_MAX_ELAPSED_MS = 500_000;
export const WORKER_ID = 'vercel-tick';

// ── Canonical JSON + hash (§4.1) ─────────────────────────────────────────────────────
/**
 * Stable serialisation: object keys sorted at every depth, arrays left in order (their
 * order is meaningful — a dataset's case list and an experiment's arm list both are).
 * Two bodies that differ only by key order MUST hash the same, because `objects` carries
 * UNIQUE (kind, hash) and "the same body is the same object".
 */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const inner = (v as Record<string, unknown>)[k];
      if (inner !== undefined) out[k] = walk(inner);
    }
    return out;
  };
  return JSON.stringify(walk(value));
}

/** sha256 of the canonical JSON, hex. The object identity used everywhere. */
export function hash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

// ── Object bodies (§4.2) ─────────────────────────────────────────────────────────────
/** The frozen inputs for one opd_note_audit case (§4.2). Retrieval is NOT among them. */
export const opdFrozenSchema = z.object({
  note: z.record(z.unknown()),
  specialty: z.string().nullable(),
  complexity: z.object({ band: z.string().nullable(), inputs: z.record(z.unknown()).nullable() }),
  // §4.2 requires "rule ids and hashes"; keywords/category ride along because the
  // adapter has to FEED these back to auditOpdNote for the replay to be the same run.
  lvc_rules: z.array(z.object({
    id: z.string(), hash: z.string(),
    keywords: z.array(z.string()), category: z.string().nullable(),
  })),
  // Decision 10 — the fourth and fifth production reads the engine makes inside the fence.
  // Before this they hit LAB_IO_FORBIDDEN and fell back to their own safe defaults, so a
  // lab run silently scored UN-SUPPRESSED at quieting gen 0 while production did neither.
  // Kept as pass-through shapes: the adapter hands them straight back to auditOpdNote, and
  // the lab must not re-type a clinical structure it does not own.
  suppressions: z.array(z.record(z.unknown())),
  quieting_config: z.object({ rules: z.array(z.record(z.unknown())), gen: z.number().int() }),
  // Decision 41 — present only on a cohort dataset, which is what makes it `frozen` rather than
  // `mutable_source`. The adapter's retrieve edge serves this list instead of reading the corpus.
  sources: z.array(z.object({
    id: z.union([z.string(), z.number()]),
    book: z.string().nullable(),
    chapter: z.string().nullable(),
    source: z.string().nullable(),
    preview: z.string().nullable(),
    score: z.number().nullable(),
  })).optional(),
});
export type OpdFrozen = z.infer<typeof opdFrozenSchema>;

export const datasetCaseSchema = z.object({
  case_key: z.string().min(1),
  member_key: z.string().nullable(),
  frozen: z.record(z.unknown()),
});

export const datasetBodySchema = z.object({
  engine: z.enum(ENGINE_IDS),
  cases: z.array(datasetCaseSchema).min(1),
  snapshot_policy: z.string(),
  exclusions: z.array(z.string()),
  classification: z.enum(CLASSIFICATIONS),
  source_versions: z.record(z.unknown()),
  /** Slice A is ALWAYS 'mutable_source': retrieval is not frozen until Slice B (§4.2). */
  replay_exactness: z.enum(REPLAY_EXACTNESS),
});
export type DatasetBody = z.infer<typeof datasetBodySchema>;

export const stageSpecSchema = z.object({
  provider: z.enum(PROVIDERS),
  model: z.string().min(1),
  options: z.record(z.unknown()).optional(),
  /** REQUIRED. A stage without it is refused with BUDGET_UNBOUNDED (§4.2). */
  max_cost_microusd: z.number().int().nonnegative(),
});

export const armBodySchema = z.object({
  engine: z.enum(ENGINE_IDS),
  engine_version: z.string(),
  stages: z.record(stageSpecSchema),
  prompt_hashes: z.record(z.string()).default({}),
  rubric_hash: z.string().nullable().default(null),
  retrieval: z.object({
    corpus_revision: z.string().nullable().default(null),
    k: z.number().int().positive().nullable().default(null),
    reranker: z.string().nullable().default(null),
  }).default({ corpus_revision: null, k: null, reranker: null }),
});
export type ArmBody = z.infer<typeof armBodySchema>;

export const experimentBodySchema = z.object({
  hypothesis: z.string().min(1),
  dataset_id: z.string().uuid(),
  dataset_hash: z.string(),
  baseline_arm_id: z.string().uuid(),
  arm_ids: z.array(z.string().uuid()).min(1),
  repeats: z.number().int().min(1).max(5),
  endpoints: z.array(z.string()),
  budget_name: z.string(),
  purpose: z.string(),
});
export type ExperimentBody = z.infer<typeof experimentBodySchema>;

// ── Tool inputs and outputs (§8.1) ───────────────────────────────────────────────────
const empty = z.object({});

export const toolSchemas = {
  system_capabilities: {
    input: empty,
    output: z.object({
      principal: z.enum(PRINCIPALS),
      scopes: z.array(z.enum(SCOPES)),
      tools: z.array(z.object({ name: z.string(), effect: z.enum(EFFECTS), cost_class: z.enum(COST_CLASSES), classification: z.enum(CLASSIFICATIONS), slice: z.string() })),
      protocol_version: z.string(),
      sdk_version: z.string(),
      lab_v2_enabled: z.boolean(),
      pricing_version: z.string(),
    }),
  },
  engine_describe: {
    input: z.object({ engine: z.enum(ENGINE_IDS) }),
    output: z.object({
      engine: z.enum(ENGINE_IDS),
      supported: z.boolean(),
      /** §34 — set only when supported is false. */
      reason: z.string().nullable(),
      slice: z.string(),
      /** §35a — every stage is listed and must be priced; `conditional` says it may not fire. */
      stages: z.array(z.object({ name: z.string(), conditional: z.boolean() })),
      engine_version: z.string().nullable(),
      frozen_inputs: z.array(z.string()),
      /** §34 — the request fields the handler reads, and whether each is identifying. */
      request_fields: z.array(z.object({ name: z.string(), identifying: z.boolean(), note: z.string().optional() })),
      replay_exactness_available: z.array(z.enum(REPLAY_EXACTNESS)),
    }),
  },
  model_capabilities: {
    input: empty,
    output: z.object({
      pricing_version: z.string(),
      providers: z.array(z.object({
        provider: z.enum(PROVIDERS),
        configured: z.boolean(),
        health_tested_at: z.string().nullable(),
        models: z.array(z.string()),
      })),
    }),
  },
  system_health: {
    input: empty,
    output: z.object({
      store_reachable: z.boolean(),
      migrations_applied: z.array(z.string()),
      worker_paused: z.boolean(),
      queue_depth_by_state: z.record(z.number()),
      oldest_queued_age_seconds: z.number().nullable(),
      reaped_last_24h: z.number(),
      calls_by_state_last_24h: z.record(z.number()),
      /**
       * Decision 43 — the measurement that decides worker hosting after a week. Items' wait from
       * creation to their FIRST attempt, so a requeued item is not counted as if it waited twice.
       */
      queue_wait_ms: z.object({
        last_24h: z.object({ p50: z.number().nullable(), p95: z.number().nullable(), n: z.number().int() }),
        last_7d: z.object({ p50: z.number().nullable(), p95: z.number().nullable(), n: z.number().int() }),
      }),
    }),
  },
  worker_status: {
    input: empty,
    output: z.object({
      id: z.string(),
      paused: z.boolean(),
      revision: z.number(),
      heartbeat_at: z.string().nullable(),
      active_item: z.string().nullable(),
    }),
  },
  worker_control: {
    input: z.object({ action: z.enum(['pause', 'resume']) }),
    output: z.object({ id: z.string(), paused: z.boolean(), revision: z.number() }),
  },
  dataset_create: {
    input: z.object({
      engine: z.enum(ENGINE_IDS),
      /** opd_note_audit: the OPD note uid whose inputs are frozen from db13 and Neon. */
      case_key: z.string().min(1).optional(),
      /** The five round-A3 engines: the request body itself IS the case (§17.3, decision 34). */
      body: z.record(z.unknown()).optional(),
      /**
       * Slice B cohort mode (§17.4 item 1). Either an explicit case list or an `audit_search`
       * filter. Max 200 cases — a cohort is a study, not a sweep, and 200 frozen cases is already
       * 200 retrieval reads and 200 db13 resolutions at creation time.
       */
      cohort: z.union([
        z.object({ case_keys: z.array(z.string().min(1)).min(1).max(200) }),
        z.object({ filter: z.record(z.unknown()) }),
      ]).optional(),
      exclusions: z.array(z.string()).default([]),
      idempotency_key: z.string().min(1),
    }),
    output: z.object({
      dataset_id: z.string().uuid(),
      hash: z.string(),
      replay_exactness: z.enum(REPLAY_EXACTNESS),
      classification: z.enum(CLASSIFICATIONS),
      deduplicated: z.boolean(),
      /** Cohort mode reports what it asked for, what it froze, and what it dropped and why. */
      counts: z.object({
        requested: z.number().int(),
        frozen: z.number().int(),
        excluded: z.number().int(),
      }),
      excluded: z.array(z.object({ case_key: z.string(), reason: z.string() })),
    }),
  },
  dataset_preview: {
    input: z.object({ dataset_id: z.string().uuid() }),
    output: z.object({
      dataset_id: z.string().uuid(),
      engine: z.enum(ENGINE_IDS),
      hash: z.string(),
      classification: z.enum(CLASSIFICATIONS),
      replay_exactness: z.enum(REPLAY_EXACTNESS),
      snapshot_policy: z.string(),
      exclusions: z.array(z.string()),
      source_versions: z.record(z.unknown()),
      case_keys: z.array(z.string()),
      created_at: z.string(),
    }),
  },
  dataset_validate: {
    input: z.object({ dataset_id: z.string().uuid() }),
    output: z.object({
      dataset_id: z.string().uuid(),
      matches: z.boolean(),
      checked: z.array(z.object({ case_key: z.string(), field: z.string(), matches: z.boolean() })),
      note: z.string(),
    }),
  },
  experiment_create: {
    input: z.object({
      hypothesis: z.string().min(1),
      dataset_id: z.string().uuid(),
      dataset_hash: z.string().min(1),
      baseline_arm: armBodySchema.partial({ engine_version: true, prompt_hashes: true, rubric_hash: true, retrieval: true }),
      arms: z.array(armBodySchema.partial({ engine_version: true, prompt_hashes: true, rubric_hash: true, retrieval: true })).default([]),
      repeats: z.number().int().min(1).max(5).default(1),
      endpoints: z.array(z.string()).default([]),
      budget_name: z.string().default('default'),
      budget_cap_microusd: z.number().int().positive().optional(),
      purpose: z.string().default('research'),
      idempotency_key: z.string().min(1),
    }),
    output: z.object({
      experiment_id: z.string().uuid(),
      hash: z.string(),
      baseline_arm_id: z.string().uuid(),
      arm_ids: z.array(z.string().uuid()),
      budget_id: z.string().uuid(),
      deduplicated: z.boolean(),
    }),
  },
  experiment_run: {
    input: z.object({ experiment_id: z.string().uuid(), idempotency_key: z.string().min(1) }),
    output: z.object({ run_id: z.string().uuid(), item_count: z.number().int(), deduplicated: z.boolean() }),
  },
  run_status: {
    input: z.object({ run_id: z.string().uuid() }),
    output: z.object({
      run_id: z.string().uuid(),
      state: z.enum(RUN_STATES),
      created_at: z.string(),
      deadline_at: z.string(),
      items_by_state: z.record(z.number()),
      execution_status: z.record(z.number()),
      assessment_status: z.record(z.number()),
      attribution_status: z.record(z.number()),
      reserved_microusd: z.number(),
      spent_microusd: z.number(),
      unknown_microusd: z.number(),
    }),
  },
  run_result: {
    input: z.object({
      run_id: z.string().uuid(),
      limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().min(0).default(0),
    }),
    output: z.object({
      run_id: z.string().uuid(),
      total: z.number().int(),
      items: z.array(z.object({
        item_id: z.string().uuid(),
        case_key: z.string(),
        arm_hash: z.string(),
        repetition: z.number().int(),
        state: z.enum(ITEM_STATES),
        execution_status: z.enum(EXECUTION_STATUSES).nullable(),
        assessment_status: z.enum(ASSESSMENT_STATUSES).nullable(),
        attribution_status: z.enum(ATTRIBUTION_STATUSES).nullable(),
        attempts: z.number().int(),
        summary: z.record(z.unknown()).nullable(),
        error: z.record(z.unknown()).nullable(),
        artifact: z.string().nullable(),
      })),
    }),
  },
  run_cancel: {
    input: z.object({ run_id: z.string().uuid() }),
    output: z.object({ run_id: z.string().uuid(), state: z.enum(RUN_STATES), cancelled_items: z.number().int() }),
  },
  budget_reconcile: {
    input: z.object({
      call_id: z.string().uuid(),
      actual_microusd: z.number().int().min(0),
      /** DECISION 42 — non-empty, always. Money does not move on a shrug. */
      reason: z.string().min(1).max(500),
    }),
    output: z.object({
      call_id: z.string().uuid(),
      budget_id: z.string().uuid(),
      from_unknown_microusd: z.number().int(),
      to_spent_microusd: z.number().int(),
      reason: z.string(),
    }),
  },
  run_retry: {
    input: z.object({ run_id: z.string().uuid() }),
    output: z.object({ run_id: z.string().uuid(), requeued: z.number().int() }),
  },
} as const;

export type ToolName = keyof typeof toolSchemas;
