/**
 * lib/lab-v2/registry.ts — the fifteen round-1 tools and their metadata
 * (LAB-MCP-V2-PRD-v1.0 §8, §8.1).
 *
 * ONE REGISTRY, NOT A FLAT LIST. V1's failure mode was `LAB_TOOLS`: an array of name +
 * description + inputSchema with no permission, no side-effect class and no cost class,
 * so every caller saw every tool and authorisation was whatever each handler remembered
 * to check. Here each tool declares its scopes, its effect and its cost, the endpoint
 * filters `tools/list` by them, and `tools/call` re-checks on every invocation.
 *
 * MCP annotations are GENERATED from `effect` (§3.2.4), never hand-written per tool. They
 * describe a tool to a client; they authorise nothing. Deriving them mechanically is what
 * makes "every tool's effect matches its annotations" a property the test can assert
 * rather than a list someone has to keep in sync.
 */
import type { ZodTypeAny } from 'zod';
import {
  SCOPES, toolSchemas, type Classification, type CostClass, type Effect, type Scope, type ToolName,
} from './contracts';
// Round A2 (§17.2). The nine observation schemas live beside their handlers because the round's
// file contract does not list contracts.ts among the files it may edit.
import { OBSERVATION_SCHEMAS, type ObservationToolName } from './tools/observation';

export interface ToolAnnotations { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean }

export interface ToolSpec {
  /** A round-1 name from contracts.ts, or a round-A2 name from tools/observation.ts. */
  name: ToolName | ObservationToolName;
  description: string;
  inputSchema: ZodTypeAny;
  outputSchema: ZodTypeAny;
  scopes: readonly Scope[];
  effect: Effect;
  classification: Classification;
  cost_class: CostClass;
  slice: string;
}

/** Visible to every principal: intersecting the full scope set always succeeds. */
const ANY: readonly Scope[] = SCOPES;

/**
 * §3.2.4 — annotations derived from effect, mechanically.
 * `idempotentHint` is true across round 1 because every writing tool is keyed by an
 * idempotency key or is a set-to-a-value operation (pause, cancel, retry): repeating one
 * converges rather than compounding. `destructiveHint` is false throughout because no
 * round-1 tool deletes or overwrites anything — cancel and retry move state forward and
 * leave the attempt history intact.
 */
export function annotationsFor(effect: Effect): ToolAnnotations {
  return {
    readOnlyHint: effect === 'read',
    destructiveHint: false,
    idempotentHint: true,
  };
}

const t = (
  name: ToolName, description: string, scopes: readonly Scope[], effect: Effect, cost_class: CostClass = 'free',
): ToolSpec => ({
  name,
  description,
  inputSchema: toolSchemas[name].input as unknown as ZodTypeAny,
  outputSchema: toolSchemas[name].output as unknown as ZodTypeAny,
  scopes,
  effect,
  // Slice A stores and returns only de-identified objects (§3.3). The research key can
  // never mint an identifying one, and round 1 has no tool that would return one.
  classification: 'deidentified',
  cost_class,
  slice: 'A-1',
});

/** Round A2's entries (§17.2). Same shape, schemas from the observation module. */
const o = (
  name: ObservationToolName, description: string, scopes: readonly Scope[],
): ToolSpec => ({
  name,
  description,
  inputSchema: OBSERVATION_SCHEMAS[name].input as unknown as ZodTypeAny,
  outputSchema: OBSERVATION_SCHEMAS[name].output as unknown as ZodTypeAny,
  scopes,
  effect: 'read',
  classification: 'deidentified',
  cost_class: 'free',
  slice: 'A-2',
});

export const REGISTRY: readonly ToolSpec[] = [
  // ── capability discovery ──────────────────────────────────────────────────────────
  t('system_capabilities', 'List the tools this principal can see, the negotiated MCP protocol version, the SDK version, whether LAB_V2_ENABLED is set, and the pricing table version.', ANY, 'read'),
  t('engine_describe', 'Describe one engine: whether it is supported in this round, its stages, its engine version on main, its frozen inputs, and the replay exactness available for it.', ANY, 'read'),
  t('model_capabilities', 'Per provider: whether it is configured, when it was last health-tested, and which models are priced and supported. There is no fallback ladder in v2.', ANY, 'read'),
  // ── operational health ────────────────────────────────────────────────────────────
  t('system_health', 'v2 store reachability, migrations applied, worker pause state, queue depth by state, oldest queued age, reaps in the last 24h and calls by state in the last 24h.', ['production_read'], 'read'),
  t('worker_status', 'The worker row, its active item and its last heartbeat.', ['production_read'], 'read'),
  t('worker_control', 'Pause or resume the tick worker. Pausing stops new claims; items already running finish.', ['production_write'], 'production_write'),
  // ── datasets ──────────────────────────────────────────────────────────────────────
  t('dataset_create', 'Freeze one OPD note and its inputs (note text and structured fields, specialty, complexity, LVC rule snapshot) into an immutable, hashed, de-identified dataset object.', ['research_write'], 'research_write'),
  t('dataset_preview', 'Dataset metadata and case keys. Never the frozen clinical text.', ['research_read'], 'read'),
  t('dataset_validate', 'Re-read each case from its live source and report whether the frozen inputs still match.', ['research_read'], 'read'),
  // ── experiments ───────────────────────────────────────────────────────────────────
  t('experiment_create', 'Store the arm objects and the experiment object. Refuses an unsupported (provider, model), a stage with no max_cost_microusd, and a dataset_hash that does not match.', ['research_write'], 'research_write'),
  t('experiment_run', 'Submit an experiment. Persists the run and its items, then returns a run id before any model work begins.', ['research_write'], 'research_write', 'metered'),
  // ── job lifecycle ─────────────────────────────────────────────────────────────────
  t('run_status', 'Run state, item counts by state and by each of the three result statuses, and the run budget in microusd.', ['research_read'], 'read'),
  t('run_result', 'Paginated items with bounded result summaries. The full result of each item is addressable as an artifact resource.', ['research_read'], 'read'),
  t('run_cancel', 'Request cancellation. Queued items cancel at once; a running item is signalled at its next heartbeat. Owner only.', ['research_write'], 'research_write'),
  t('run_retry', 'Re-queue the failed and expired items of a run as new attempts on the same item ids. Never re-runs a succeeded item. Owner only.', ['research_write'], 'research_write', 'metered'),

  // ── round A2: observation (§17.2). All nine are read-only and free. ────────────────
  o('source_freshness', 'For each source the platform reads — the db13 OPD note table, opd_note_audits, ipd_episode_audits, mksap_chunks and the v2 call ledger — the newest row time and the row count in the last 24 hours. Each source fails independently.', ['production_read']),
  o('audit_search', 'Search opd_note_audits by a filter schema, never SQL: engine version, doctor uid, band, note date range, LVC category, verdict and a minimum finding count. Returns scores and finding subjects. Never note text.', ['research_read']),
  o('audit_aggregate', 'Aggregate the same filter by engine_version, doctor_uid, band, lvc_category or note_month, over count, average note-quality index, average completeness, summed findings or summed low-value findings. Metrics are computed per audit.', ['research_read']),
  o('case_snapshot', 'For one OPD note uid: its current audit row, the v2 datasets that froze that uid, and the runs that consumed them.', ['research_read']),
  o('audit_explain', 'For one OPD uid and one finding index: the finding with its rule reference, LVC category, signal type and source, and every citation id resolved against the corpus. Unresolvable ids are listed, never dropped.', ['research_read']),
  o('retrieval_inspect', 'Run the production retrieval CANDIDATE stage for a query — embedding and lexical, never the reranker and never query expansion, so the tool makes no chat model call. Returns the candidates with scores and the pool sizes.', ['research_read']),
  o('citation_check', 'Structural citation check: for each citation id, whether the chunk exists, whether it is active, and whether it appears in the sources of the named run or audit. No model.', ['research_read']),
  o('corpus_search', 'Lexical search over the corpus by text, optionally narrowed by book, source or active state. Returns bounded previews and the quarantine prefix where one applies.', ['research_read']),
  o('report_export', 'Write one evidence-pack artifact for a run: the experiment, dataset metadata without frozen text, the arms, every item with its three statuses, the call ledger, the replay exactness, and a fixed caveat about single-run sampling.', ['research_read']),
];

export const BY_NAME: Record<string, ToolSpec> = Object.fromEntries(REGISTRY.map((s) => [s.name, s]));

/** §3.2.1 — a tool is visible when its scopes intersect the principal's. */
export function visibleTools(principalScopes: readonly Scope[]): ToolSpec[] {
  return REGISTRY.filter((spec) => spec.scopes.some((s) => principalScopes.includes(s)));
}

export function isVisible(spec: ToolSpec, principalScopes: readonly Scope[]): boolean {
  return spec.scopes.some((s) => principalScopes.includes(s));
}
