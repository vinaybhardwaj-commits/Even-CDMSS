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

/**
 * §3.1 — the key a caller holds IS its authority. No self-declared header, ever.
 *
 * ⚠️ §17.8 DECISION 108 — `operator` GAINS `research_write`, AND WITHOUT IT SLICE D HAD NO
 * REACHABLE PATH AT ALL. Decision 105 gives `operator` the `data_scope` attribute, so it is the
 * only principal that may send an identifier; but a run needs `dataset_create`, then
 * `experiment_create`, then `experiment_run`, and all three are `research_write`. `research` has
 * the scope and can never hold the attribute (decision 105); `operator` had the attribute and not
 * the scope. Measured live on `c7f353af`: `operator` saw 33 tools and none of the three. So no
 * principal could run an identifying experiment, which is the whole of Slice D.
 *
 * ⚠️ THE ATTRIBUTE STILL GATES THE IDENTIFIER, AND THE SCOPE STILL GATES THE TOOL. This grants
 * `operator` the research-write TOOLS; it grants nothing about identifying input, which remains
 * `production_read` plus the env list. And it grants `research` nothing: the two are separate rows
 * and `research` is unchanged, so the key that may never see a person still cannot.
 */
export const SCOPES_BY_PRINCIPAL: Record<Principal, readonly Scope[]> = {
  research: ['research_read', 'research_write', 'production_read'],
  operator: ['production_read', 'production_write', 'research_read', 'research_write'],
  reviewer: ['review', 'research_read', 'production_read'],
  release: ['release', 'production_read'],
};

/**
 * §17.8 DECISION 105 — `data_scope`, the one attribute that lets a principal send an identifier.
 *
 * ⚠️ IT IS NOT A SCOPE AND NOT A KEY, DELIBERATELY. A fifth scope would have had to be granted
 * by a fifth env key, and a fifth key is a fifth thing to rotate and to leak. `data_scope` is an
 * ATTRIBUTE of an existing principal, set by naming that principal in one env list, and it grants
 * nothing on its own: a tool marked `identifying_input` needs `production_read` AND the attribute,
 * so the scope table still decides what a key can do and the list only decides what it may SEE.
 *
 * ⚠️ AND `research` MAY NEVER HOLD IT. The research key exists to be handed to people who analyse
 * de-identified data; the whole platform's guarantee is that it cannot reach a person. The loader
 * refuses the name at load rather than filtering it silently, because a deployment that asked for
 * something impossible should be told, not quietly corrected.
 */
export const DATA_SCOPES = ['deidentified', 'identifying'] as const;
export type DataScope = (typeof DATA_SCOPES)[number];

/** The env list decision 105 names. Comma-separated principal names, empty by default. */
export const IDENTIFYING_PRINCIPALS_ENV = 'LAB_V2_IDENTIFYING_PRINCIPALS';

/** The principal this platform will never grant `identifying` to, whatever the env says. */
export const NEVER_IDENTIFYING: readonly Principal[] = ['research'];

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
  // §17.5 decision 47 — the seventh, and the first whose pipeline had to be extracted before it
  // could run inside the fence at all. lib/ipd-episode/compute.ts.
  'ipd_episode',
  /**
   * §17.8 round D1, decisions 103-105 — the first two engines that CANNOT RUN without an
   * identifying input, and the reason decision 105 exists. Under decision 34 an engine like this
   * was simply unsupported; under 105 it is supported, its tools are marked `identifying_input`,
   * and the identifier is used in the request and never written to `lab_v2` (decision 99).
   *
   * ⚠️ `ipd_discharge` IS DELIBERATELY ABSENT and stays "not wired yet; arrives in slice D2". Its
   * extraction is a `compute.ts`-sized one with 22 source-text guard sites and an unfenced
   * multimodal read (decision 102, fixed this round); decision 103 splits it out for that reason.
   */
  'readmission', 'preop',
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
  /**
   * §17.5 — the IPD episode pipeline's three governed stages, in the order they occur:
   * lib/ipd-episode/checkpoint.ts:325 (once per checkpoint, up to the decision 43 ceiling), then
   * lib/ipd-episode/judge.ts:125 and :156.
   *
   * ⚠️ `commentary` IS NOT A STAGE OF THIS ENGINE. Pass B left the pipeline under IPD decision 35
   * and runs on demand from app/api/ipd-episode/commentary; an arm that priced it would be
   * reserving budget against a call this engine cannot make (the decision 11 lesson, again).
   * ⚠️ `checkpoint` IS ONE STAGE, NOT ONE PER CHECKPOINT. An episode makes between one and six
   * checkpoint calls depending on its anchors, so a per-checkpoint stage would make the arm's
   * cost ceiling depend on the episode — which is the opposite of what a ceiling is for.
   */
  ipd_episode: [
    { name: 'checkpoint', conditional: false },
    { name: 'divergence', conditional: false },
    { name: 'fidelity', conditional: false },
  ],
  /**
   * §17.8 — `lib/readmission/run.ts:144` (`vertexPass`), the four labels `runReconSequence`
   * passes at `:452`, `:466`, `:486` and `:494`.
   *
   * ⚠️ ALL FOUR ARE CONDITIONAL, AND THAT IS THE HONEST MARKING RATHER THAN A CAUTIOUS ONE.
   * Exactly one of three paths fires per finding: out-of-network takes `readmit_oon` alone
   * (decision 13, index side only); lane `other` takes `readmit_condition` and is promoted to the
   * full pair only on a `same` verdict (decision 9); every other lane takes `readmit_recon_a` then
   * `readmit_recon_b` (the two-pass money verdict). So no single label fires on every finding,
   * and §35a still requires every one of them to be PRICED — an arm that priced only the recon
   * pair would refuse the first out-of-network case it met.
   *
   * ⚠️ `readmit_narrative` IS NOT A STAGE OF THIS ENGINE IN D1. Decision 104 puts the narrative
   * leg (`run.ts:545`) out of scope, and the adapter never reaches it. Pricing a call the engine
   * cannot make is the decision 11 lesson.
   */
  readmission: [
    { name: 'readmit_oon', conditional: true },
    { name: 'readmit_condition', conditional: true },
    { name: 'readmit_recon_a', conditional: true },
    { name: 'readmit_recon_b', conditional: true },
  ],
  /**
   * §17.8 — `lib/preop/suggest.ts:78` and `lib/preop/narrative.ts:44`.
   *
   * ⚠️ BOTH ARE CONDITIONAL BECAUSE BOTH SIT BEHIND FLAGS, and in the lab those flags come from
   * the ARM, not from the environment (decision 104). With neither enabled a preop tick makes no
   * model call at all and still produces a tier for every episode — the deterministic score is
   * the engine, and the two legs are additions to it.
   */
  preop: [
    { name: 'preop_suggest', conditional: true },
    { name: 'preop_narrative', conditional: true },
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

/**
 * §17.7 adds two: `staged_set` (a corpus batch pinned by label and id list) and `release` (the
 * immutable, hashed artifact a review binds to). Both are OBJECTS rather than rows in the release
 * ledger, and deliberately: `lab_v2.objects` is immutable and content-addressed, so an artifact
 * cannot be edited after it was approved — which is the whole of decision 81.
 */
export const OBJECT_KINDS = ['dataset', 'arm', 'experiment', 'artifact', 'report', 'operation_plan', 'staged_set', 'release'] as const;
export type ObjectKind = (typeof OBJECT_KINDS)[number];

export const PROVIDERS = ['bedrock', 'openrouter', 'ollama', 'vertex'] as const;
export type Provider = (typeof PROVIDERS)[number];

/** §11 / decision 77 — two releasable targets. `config:opd` was withdrawn. */
export const RELEASE_TARGETS = ['corpus', 'rules'] as const;
export type ReleaseTarget = (typeof RELEASE_TARGETS)[number];

export const REVIEW_DECISIONS = ['approved', 'rejected'] as const;
export const RECEIPT_KINDS = ['apply', 'rollback'] as const;

/** §11 / decision 81 — an approval is good for seven days and not one hour longer. */
export const APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * ⚠️ ON EVERY ROLLBACK RECEIPT, VERBATIM. §11: a rollback is a new activation of the predecessor.
 * It is not an undo of everything that happened while the release was in force, and a receipt that
 * did not say so would let a reader assume the audits written against the new corpus had been
 * reconsidered. They have not been.
 */
export const ROLLBACK_CAVEAT =
  'This rollback returns the named chunks to quarantine and records a new activation with the '
  + 'predecessor as the artifact in force. It does NOT delete audits written while the release was '
  + 'live, does not rewrite any finding, and does not revoke any human action taken on them. '
  + 'Anything produced under the rolled-back artifact stands and carries its own engine version.';

/**
 * §11's caveat for the `rules` target (§17.7 C2, decision 90). The corpus wording is about chunks
 * returning to quarantine and would be simply wrong on a rulebook row.
 *
 * ⚠️ IT SAYS "RETIRED, NOT DELETED" FIRST, because that is the part a reader will otherwise assume
 * the other way round, and the part that makes every historical `rule_ref` still resolve.
 */
export const RULES_ROLLBACK_CAVEAT =
  'This rollback RETIRES the promoted recommendation — it sets status, which is the one thing the '
  + "engine's `WHERE status = 'active'` selection reads — and it never deletes the row. The "
  + 'statement, its citation and its ratifier stay on the record, so every audit already stamped '
  + 'with that rule_ref still resolves to the rule it was stamped with. It does NOT delete audits '
  + 'written while the rule was live, does not rewrite any finding, does not re-run any note, and '
  + 'does not revoke any human action taken on one. Anything produced under the rolled-back '
  + 'artifact stands and carries its own engine version.';

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
/**
 * §9, plus DECISION 65's fourth value.
 *
 * `verified` / `invalid` / `unknown` are verdicts about a call that WAS made: the receipt named the
 * requested target, named a different one, or did not arrive. A frozen or replayed item makes no
 * call at all, and calling that `unknown` was the wrong word — nothing is unknown about it. The
 * models that produced the answer are on the record; they simply produced it earlier.
 *
 * ⚠️ `replayed` MAY ONLY BE CLAIMED WHERE NO CALL HAPPENED. The gateway's verdict wins whenever it
 * saw one, so this value cannot launder a real attribution failure into a reassuring word — which
 * is the only way a fourth status could do damage.
 */
export const ATTRIBUTION_STATUSES = ['verified', 'invalid', 'unknown', 'replayed'] as const;
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

/**
 * §17.5 decisions 48 and 50 — the frozen inputs for ONE ipd_episode case.
 *
 * ⚠️ WHAT IS NOT IN HERE IS THE POINT. No encounter id (`episode_ref` is sha256 of the audit row
 * id), no member id (only its salted hash, and that rides on the CASE, not in here), and no
 * `verbatimSections` — `stripped` records that it was removed and the freeze refuses the case if
 * any patient-name key survived it.
 */
export const ipdFrozenSchema = z.object({
  audit_id: z.string().min(1),
  engine_version: z.string().min(1),
  episode_ref: z.string().min(1),
  envelope: z.object({
    encounterId: z.string(),
    memberId: z.null(),
    facilityName: z.string().nullable(),
    speciality: z.string().nullable(),
    admittedAt: z.string(),
    dischargedAt: z.string().nullable(),
    losDays: z.number().nullable(),
    dischargeType: z.string().nullable(),
    treatingDepartmentName: z.string().nullable(),
    admissionType: z.string().nullable(),
    admitSource: z.string().nullable(),
    remarks: z.string().nullable(),
    responsibleClinicianId: z.string().nullable(),
  }),
  real_course: z.array(z.record(z.unknown())),
  sources_present: z.array(z.string()),
  extraction: z.object({ extraction_version: z.string().nullable(), extracted_case: z.unknown() }),
  checkpoints: z.record(z.record(z.unknown())),
  /** Decision 48 — request hash → the stored reply. Empty means FRESH mode, not a broken case. */
  steps: z.record(z.object({
    stage: z.string(),
    request_hash: z.string(),
    completion: z.unknown(),
    text: z.string(),
    served: z.object({ provider: z.string(), model: z.string().nullable() }).nullable(),
  })),
  admission_context: z.string().nullable(),
  models: z.object({ checkpoint: z.string().nullable(), judge: z.string().nullable() }),
  stripped: z.array(z.string()),
  stored: z.record(z.unknown()),
});
export type IpdFrozenParsed = z.infer<typeof ipdFrozenSchema>;

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
      /** §17.8 decision 105 — THIS principal's scope, and the whole list, so a caller can see why. */
      data_scope: z.enum(DATA_SCOPES),
      identifying_principals: z.array(z.enum(PRINCIPALS)),
      tools: z.array(z.object({
        name: z.string(), effect: z.enum(EFFECTS), cost_class: z.enum(COST_CLASSES),
        classification: z.enum(CLASSIFICATIONS), slice: z.string(),
        /** §17.8 decision 105 — true when this tool may be sent an identifier. */
        identifying_input: z.boolean(),
      })),
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
      /**
       * §17.8 decision 105 — true when the engine cannot run without an identifying field, so a
       * caller knows before it sends one which key it will need. It no longer decides `supported`.
       */
      identifying_input: z.boolean(),
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
      /**
       * §17.5 decision 48 — the ipd_episode selector. `audit_ids` is an explicit list of
       * `ipd_episode_audits.id`; `engine_version` takes every CURRENT row at that version, oldest
       * first. Never an encounter id: decision 50 keeps the live db13 key out of the research
       * store, and a caller who has one can find its audit row through `audit_search`.
       */
      episodes: z.union([
        z.object({ audit_ids: z.array(z.string().uuid()).min(1).max(200) }),
        z.object({ engine_version: z.string().min(1), limit: z.number().int().min(1).max(200).default(200) }),
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
