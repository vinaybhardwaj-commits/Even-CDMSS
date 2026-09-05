/**
 * lib/lab-v2/adapters/types.ts — the engine-adapter seam (LAB-MCP-V2-PRD-v1.0 §14.1).
 *
 * An adapter is the ONLY thing that knows how to turn a frozen case plus an arm into a
 * result. Everything around it — leasing, budgeting, attribution, status derivation — is
 * engine-agnostic and lives in the worker and the gateway. That split is what lets round
 * 2 add five more engines without touching the scheduler.
 *
 * An adapter deliberately CANNOT reach production IO: it runs inside `withLabExecution`,
 * so `sql` and `metabaseQuery` throw beneath it and retrieval delegates to the edge the
 * worker supplied. It gets its inputs from the frozen dataset, and nowhere else.
 */
import type { AssessmentStatus, EngineId, ExecutionStatus } from '../contracts';
import type { Gateway } from '../gateway';

export interface AdapterContext {
  runId: string;
  itemId: string;
  caseKey: string;
  /** The dataset's frozen inputs for this case. The adapter's only source of truth. */
  frozen: Record<string, unknown>;
  /** The arm body: engine version, per-stage model spec, retrieval settings. */
  arm: Record<string, unknown>;
  repetition: number;
  /** Budgeted, attributed model access. The adapter never calls a provider itself. */
  gateway: Gateway;
  /** Aborts when the run is cancelled or the lease is lost (§5.4). */
  signal?: AbortSignal;
  /** Structured observation on this item — `retrieval_read`, stage timings, and so on. */
  event: (kind: string, body: Record<string, unknown>) => void;
  /** Memoised stage output for Slice B replay (§4.1 `steps`). */
  checkpoint: <T>(name: string, dependencyHash: string, produce: () => Promise<T>) => Promise<T>;
}

export interface AdapterOutcome {
  /** The full engine output, stored as the item's result and offered as an artifact. */
  result: unknown;
  /** A small, bounded projection safe to return inline from `run_result`. */
  summary: Record<string, unknown>;
  execution_status: ExecutionStatus;
  /** §9 — whether the CLINICAL question got an answer, independent of execution. */
  assessment_status: AssessmentStatus;
}

export interface Adapter {
  engine: EngineId;
  /** Stage names this engine bills against; an arm must price every one (§4.2). */
  stages: readonly string[];
  /** The engine version on `main`, reported by `engine_describe`. */
  engineVersion(): string;
  /** The frozen inputs this engine needs, reported by `engine_describe`. */
  frozenInputs: readonly string[];
  /**
   * Decision 22 — the per-attempt transport ceiling for this engine's model calls, in ms.
   * The gateway applies it to every stage call unless the arm's stage overrides it with
   * `options.timeout_ms`. Without it a stage call inherits the SDK client default, which is
   * unrelated to the engine's own budget and to the tick's 500 s elapsed bound.
   */
  perAttemptTimeoutMs: number;
  run(ctx: AdapterContext): Promise<AdapterOutcome>;
}
