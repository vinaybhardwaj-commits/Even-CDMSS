/**
 * lib/retrieval-telemetry-core.ts — the PURE core of Stage 0a rerank telemetry.
 * CDMSS-RERANK-TELEMETRY-PRD-v2.1-11-AUG-2026 §4.2, §4.3, §4.6, and the on-path kickoff's D2, D5,
 * D9, D12, D15, D16, D17.
 *
 * OBSERVATION ONLY. Nothing here decides a ranking, chooses a provider, sizes a batch or reaches a
 * scorer input. No fs, no net, no clock, no process.env — `node:crypto` is computation, and the
 * HMAC key is passed IN so this module can be unit-tested without a secret and can never leak one.
 *
 * ⚠️ NO CLINICAL TEXT EVER REACHES A FIELD DEFINED HERE. Every identifier-shaped value is a keyed
 * HMAC and every measurement is a count, an enum or a timing. §6.4 asserts it on the two
 * field-bearing declarations; the types are written so the honest version is also the easy one —
 * there is no free-text field to fill.
 *
 * ⚠️ AND THE IN-MEMORY CAPTURE TYPE IS NOT DECLARED HERE, deliberately (D5). It holds RAW passage
 * bytes on their way to becoming keyed HMACs, so it lives in lib/retrieval-capture.ts — the
 * sentence above is only true if it stays out. A source assertion pins that this file does not
 * contain its NAME, which is why the name is not written anywhere in this file, not even in a
 * comment: the cheapest possible check is one that cannot be argued with.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
/**
 * ⚠️ THIS FILE'S FIRST OUTBOUND IMPORT (v11 §4 item 4, §5). It had none until now — only
 * `node:crypto` above — and `lib/transport-attribution-core.ts` imports nothing at all, so no cycle
 * is possible in either direction. The architecture map gains one edge because of this line, and
 * `lib/architecture/map.generated.ts` is regenerated in the same commit.
 *
 * The alternative was a second copy of the six values here, which is the defect this pass removes
 * from `RERANK_SEED_STATUSES` a few lines below. One authority, imported.
 */
import { TRANSPORT_ATTEMPT_OUTCOMES } from './transport-attribution-core';

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 1. VERSIONS — independent of the application deployment (§4.3)
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The row contract (the columns the migration route creates). Bumped when a COLUMN changes.
 * Separate from the manifest version on purpose: the JSONB payload evolves far faster than the
 * scalar columns, and a canary window must be able to say "one schema version" about each.
 *
 * 1 → 2: the on-path build. Fourteen persistence states (from eight), the retrieval role, the two
 * candidate counts, the served backend and its downgrade flag, the index version, the backfill
 * activity triple, and the two sibling tables.
 */
export const TELEMETRY_SCHEMA_VERSION = 2;

/**
 * The JSONB manifest contract. Bumped when a manifest FIELD changes.
 *
 * ⚠️ 2 → 3 (pass 0a). Addendum v7 §10 added `rerank_temperature` and `rerank_seed_status` to
 * `retrieval_config`, and the version did not move — so a manifest WITH the fields and one WITHOUT
 * them both claimed version 2, which is exactly what the version exists to prevent. PRD §7 gates the
 * canary on recognised manifest versions, and a version that does not discriminate cannot gate.
 *
 * ⚠️ THERE ARE NO VERSION-2 ROWS ANYWHERE. The three telemetry tables have never been created in
 * production, and the only database that has ever held them is the measurement branch, whose rows
 * are synthetic and carry `route = 'script'`. So this bump orphans no stored data, and the validator
 * below deliberately recognises ONE version rather than a list — see `manifest_version_unrecognized`.
 */
export const MANIFEST_SCHEMA_VERSION = 3;

/**
 * The HMAC key generation. §4.3 requires a versioned key identifier: a rotated key produces
 * different digests for identical input, and without this a window would silently compare
 * pre-rotation and post-rotation HMACs as if they disagreed.
 */
export const HMAC_KEY_VERSION = 'k1';

/** The one `telemetry_error` value §4.3 and D8 give a defined meaning to. */
export const TELEMETRY_ERROR_HMAC_KEY_ABSENT = 'hmac_key_absent';

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 2. PERSISTENCE STATES (§4.2, D9) — one vocabulary, generated into the CHECK constraint
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * ⚠️ THIS LIST IS THE SOURCE OF TRUTH. The migration route GENERATES its CHECK from it (D2 forbids
 * hand-typing the values), and the `.sql` mirror is held to the route by a parity test. §4.2 asks
 * for a database constraint OR an equivalently centralized runtime definition; this ships both,
 * because the failure they guard differs at each end — the constraint stops a bad write, the union
 * type stops a bad read.
 *
 * ⚠️ `not_eligible` IS REMOVED (D9). It was in the committed vocabulary and had no owner in the
 * settlement matrix: every case that would have used it is really one of `retrieval_not_run`,
 * `no_persistence_intended` or `persistence_skipped`, which say WHY. A state nobody writes is a
 * state that makes a census look complete while answering nothing.
 */
export const RETRIEVAL_PERSISTENCE_STATES = [
  // ── NON-TERMINAL (2) ──────────────────────────────────────────────────────────────────────────
  /** Written BEFORE any provider work (§4.5 step 1). A killed invocation stays visible as this. */
  'started',
  /** Retrieval settled and its terminal manifest is written; the audit's fate is not yet known. */
  'retrieval_complete',

  // ── TERMINAL (12) ─────────────────────────────────────────────────────────────────────────────
  /** The audit persisted, and validation of this run's manifest was clean. */
  'persisted_complete',
  /** The audit persisted; the manifest is incomplete — recorded, never silently upgraded. */
  'persisted_partial',
  /**
   * The audit was written by ANOTHER execution: this one lost its ON CONFLICT race. Its telemetry
   * survives unlinked (§4.5 step 5) — the losing computation really happened and really cost money.
   */
  'completed_unpersisted',
  /** A governance refusal (DEC-2) stopped the write. Not a failure; a decision. */
  'persistence_refused',
  /**
   * The audit write itself FAILED.
   *
   * ⚠️ CORRECTED (D9). The committed comment on this state read "the audit write failed or lost its
   * ON CONFLICT race". The second half is now false and is removed: D9's outcome table sends
   * `losing_conflict` to `completed_unpersisted`, precisely so a race — which is normal, expected
   * concurrency — stops being reported as a failure. The state itself did not change.
   */
  'audit_persistence_failed',
  /** The audit threw before any save was attempted. `saveOpdAudit` was never called. */
  'audit_generation_failed',
  /** Telemetry's own write failed. Fail-visibly (constraint 8): the gap is stated, not hidden. */
  'telemetry_persistence_failed',
  /** Reconciled from a stale `started` after max invocation duration + grace (§4.5 step 6). */
  'aborted',
  /** Reconciled from a stale `retrieval_complete`: the audit's fate is genuinely unknown. */
  'persistence_unknown',
  /** Declared, then the retrieval never ran (the note was unresolvable, the caller returned early). */
  'retrieval_not_run',
  /** This caller never intended to write an audit at all — a lab read, a recall, a dry run. */
  'no_persistence_intended',
  /** `saveOpdAudit` returned `skipped`: there was no uid to key the row on. */
  'persistence_skipped',
] as const;

export type RetrievalPersistenceState = typeof RETRIEVAL_PERSISTENCE_STATES[number];

/** The two states a run can still move out of. */
export const NON_TERMINAL_PERSISTENCE_STATES = ['started', 'retrieval_complete'] as const;

/** Terminal for canary purposes: a window closes only when every run reaches one of these. */
export const TERMINAL_PERSISTENCE_STATES: readonly RetrievalPersistenceState[] =
  RETRIEVAL_PERSISTENCE_STATES.filter(
    (s): s is RetrievalPersistenceState => !(NON_TERMINAL_PERSISTENCE_STATES as readonly string[]).includes(s),
  );

export function isTerminalState(s: string): boolean {
  return (TERMINAL_PERSISTENCE_STATES as readonly string[]).includes(s);
}

/**
 * States in which `retrieval_outcome` MUST be recorded — the run got far enough to have one.
 * Generated into the outcome CHECK alongside the set below (D2 forbids hand-typing either).
 */
export const OUTCOME_REQUIRED_STATES: readonly RetrievalPersistenceState[] = [
  'retrieval_complete', 'persisted_complete', 'persisted_partial', 'completed_unpersisted',
  'persistence_refused', 'audit_persistence_failed', 'persistence_skipped',
  'no_persistence_intended', 'persistence_unknown',
] as const;

/**
 * States in which an outcome may be present or absent, because the run may have been settled from
 * either side of its terminal write.
 *
 * ⚠️ `audit_generation_failed` IS HERE, NOT IN THE REQUIRED SET (D9/D12). D11 puts the primary
 * terminal write at step 12 and `auditOpdNote` can throw at step 7, 8 or 9 — so a row settled this
 * way may still be `started`, having never recorded an outcome. Requiring one would leave the only
 * honest settlement unreachable and hand the row to the reconciler as an `aborted` guess.
 */
export const OUTCOME_EITHER_STATES: readonly RetrievalPersistenceState[] = [
  'aborted', 'retrieval_not_run', 'telemetry_persistence_failed', 'audit_generation_failed',
] as const;

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 3. ROLES (§4.1) AND THE ROUTE TAXONOMY (§5 step 1)
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The closed set of retrieval roles, declared BEFORE retrieval runs (§4.1). One audit can produce
 * two rows — `primary` and `normative_channel` — which is why §7's linked-run rule is role-based:
 * a correctly instrumented audit that ran the normative channel has two linked rows, not one.
 */
export const RETRIEVAL_ROLES = [
  'primary',            // defaultRetrieve in lib/opd-note-audit.ts — the audit's own evidence
  'normative_channel',  // normativeChannelRetrieve — the guideline leg, expansion always skipped
  'lvc_recall',         // defaultRecall's semantic leg in lib/lvc.ts
  'lab_direct',         // labRetrieve's direct branch in lib/mcp-tools.ts
  'lab_multi_query',    // labRetrieve's multi-query branch
] as const;
export type RetrievalRole = typeof RETRIEVAL_ROLES[number];

/**
 * Every entrypoint that can execute an OPD retrieval. The class is what §8's overlap analysis
 * groups by; the route is the specific caller, kept so "which backfill" stays answerable.
 *
 * `unknown_route` exists because §4.4's rule against guessing applies here too: a retrieval reached
 * from a caller this list does not name is recorded as unknown, never assigned to the nearest match.
 * §7/A3 excludes exactly one case by name — `lvc_recall` rows from the appropriateness surface,
 * which has no taxonomy member — and that exclusion is why the value must stay honest.
 */
export const RETRIEVAL_ROUTES = [
  'opd_audit_worker',          // /api/opd-audit/worker — the nightly cron
  'opd_audit_run',             // /api/opd-audit/run — manual single-note
  'opd_audit_mini_backfill',   // /api/admin/opd-audit-mini-backfill
  'opd_dosing_backfill',       // /api/admin/opd-dosing-backfill
  'opd_rescore_direction',     // /api/admin/opd-rescore-direction
  'lab_batch',                 // lib/lab-batch.ts — hosted lab
  'mcp_tools',                 // lib/mcp-tools.ts — lab/measurement seam
  'lvc_judge_aa',              // /api/admin/lvc-judge-aa — A/A replicates
  'script',                    // scripts/*.mjs — local, never in a canary window
  'unknown_route',
] as const;
export type RetrievalRoute = typeof RETRIEVAL_ROUTES[number];

/**
 * The invocation table's route vocabulary: every retrieval route, plus the reconciler, which owns
 * invocations but performs no retrieval. Kept as a SEPARATE type so `RetrievalRoute` cannot
 * accidentally admit `reconciler` on a retrieval row (D17).
 */
export const INVOCATION_ROUTES = [...RETRIEVAL_ROUTES, 'reconciler'] as const;
export type InvocationRoute = typeof INVOCATION_ROUTES[number];

export type RouteClass = 'worker' | 'backfill' | 'lab' | 'manual' | 'unknown' | 'reconciler';

const ROUTE_CLASS: Readonly<Record<InvocationRoute, RouteClass>> = {
  opd_audit_worker: 'worker',
  opd_audit_run: 'manual',
  opd_audit_mini_backfill: 'backfill',
  opd_dosing_backfill: 'backfill',
  opd_rescore_direction: 'backfill',
  lab_batch: 'lab',
  mcp_tools: 'lab',
  lvc_judge_aa: 'lab',
  script: 'manual',
  unknown_route: 'unknown',
  reconciler: 'reconciler',
};

export function routeClassOf(route: string): RouteClass {
  return ROUTE_CLASS[route as InvocationRoute] ?? 'unknown';
}

/**
 * The invocation-level facts a boundary establishes once and threads down (§4.1, D11).
 *
 * ⚠️ THREADED EXPLICITLY, NEVER MODULE STATE. §4.1 forbids mutable process-global state in a
 * serverless process that serves concurrent requests, and that applies to the context, the capture
 * and every id — not only to invocation ids. One module-level "current invocation" would attribute
 * two overlapping requests to whichever wrote last.
 */
export interface TelemetryRequestContext {
  invocationId: string;
  route: InvocationRoute;
  routeClass: RouteClass;
  deploymentSha: string | null;
  /** From `x-vercel-id`. The key is OMITTED when the header is absent — never an empty string. */
  vercelRequestId: string | null;
  startedAt: string;
  routingFlags: Record<string, string>;
  /** Hosted-lab linkage, when this invocation belongs to an experiment. */
  labExperimentId?: string | null;
}

/**
 * Build the context ONE boundary establishes, from that boundary's own request (D11).
 *
 * ⚠️ ONE PLACE, BECAUSE THERE ARE TEN BOUNDARIES. Eight routes and two scripts each create exactly
 * one of these; ten hand-written literals would drift on the deployment SHA env var, on the route
 * class, or on what an absent `x-vercel-id` means, and the drift would look like data.
 *
 * ⚠️ AN ABSENT `x-vercel-id` OMITS THE KEY, never an empty string. An empty string is a value and
 * would be read as one; absence is absence. `routing_flags` stays `Record<string, string>`, so the
 * only honest way to say "not present" is not to have the key.
 */
export function telemetryContextFor(
  route: InvocationRoute,
  headers?: { get(name: string): string | null } | null,
  extra?: { routingFlags?: Record<string, string>; labExperimentId?: string | null },
): TelemetryRequestContext {
  const vercelRequestId = headers?.get('x-vercel-id') || null;
  const routingFlags: Record<string, string> = { ...(extra?.routingFlags ?? {}) };
  return {
    invocationId: randomUUID(),
    route,
    routeClass: routeClassOf(route),
    deploymentSha: process.env.VERCEL_GIT_COMMIT_SHA || null,
    vercelRequestId,
    startedAt: new Date().toISOString(),
    routingFlags,
    labExperimentId: extra?.labExperimentId ?? null,
  };
}

/** Invocation accounting (D2). `reconciler` runs are invocations too, and must not be counted as
 *  retrieval work — §2 forbids reporting a tick as a workload. */
export const INVOCATION_KINDS = ['retrieval', 'reconciler'] as const;
export type InvocationKind = typeof INVOCATION_KINDS[number];

/** An invocation that never reached its own closing write stays `closure_unknown`, honestly. */
export const INVOCATION_CLOSURE_STATES = ['closed', 'closure_unknown'] as const;
export type InvocationClosureState = typeof INVOCATION_CLOSURE_STATES[number];

/**
 * The reranker seed-status vocabulary, as the MANIFEST contract defines it (addendum v7 §10).
 *
 * ⚠️ THIS IS NOW THE ONLY DECLARATION (v11 §7, review 22 item 5). It was duplicated in
 * `lib/retrieval-capture.ts`, identically, because pass 0a's file contract did not include capture
 * and the constant could not be moved then. This pass's contract includes both files, so capture's
 * copy is deleted and capture re-exports THIS OBJECT. `lib/rerank.ts:21` imports the type from
 * capture and needs no change, because the type moved with the const.
 *
 * ⚠️ IDENTITY IS TESTED WITH `strictEqual`, NOT DEEP EQUALITY. A deep-equal assertion passes against
 * a re-declared copy with the same members, which is exactly the drift this collapse removes; only a
 * reference comparison can tell one array from two.
 *
 *   not_applicable  no rerank decode ran, or the backend takes no seed (Cohere is a deterministic
 *                   cross-encoder with neither seed nor temperature)
 *   unseeded        the call set no seed at all — TODAY'S JUDGE, on every path
 *   applied_local   a seed was set and the call served locally, so it reached the model
 *   stripped_cloud  a seed was set in the Ollama options bag and the call served on a cloud tier,
 *                   which strips that bag — so the seed did NOT reach the model
 */
export const RERANK_SEED_STATUSES = ['not_applicable', 'unseeded', 'applied_local', 'stripped_cloud'] as const;
export type RerankSeedStatus = typeof RERANK_SEED_STATUSES[number];

/** The phases a telemetry write can fail in (D2's failure table CHECK). */
export const TELEMETRY_FAILURE_PHASES = [
  'invocation_start', 'work_declaration', 'retrieval_terminal', 'retrieval_terminal_rejected',
  'persistence_link', 'closure',
] as const;
export type TelemetryFailurePhase = typeof TELEMETRY_FAILURE_PHASES[number];

/** The phases that name a specific run, and therefore require a run id and role (D2). */
export const RUN_SCOPED_FAILURE_PHASES: readonly TelemetryFailurePhase[] =
  ['work_declaration', 'retrieval_terminal', 'retrieval_terminal_rejected', 'persistence_link'] as const;

/**
 * ⚠️ `retrieval_terminal_rejected` IS A SIBLING OF `retrieval_terminal`, NOT A REPLACEMENT, AND THE
 * RECONCILER DELIBERATELY DOES NOT MAP IT (addendum v7 §8).
 *
 * A rejected terminal write is a compare-and-set that matched no row: the revision moved, or the row
 * left `started`. That is NOT the same event as a terminal write that threw, and conflating them
 * would lose the distinction the phase exists to record.
 *
 * `reconcilerStateFor` below tests membership of `'retrieval_terminal'` EXACTLY, so a row carrying
 * only this new phase reconciles as `aborted` — the no-evidence answer. That is intentional and is
 * the prior settled decision (decisions §8, 13 Aug): record the event so it becomes countable, and
 * decide the state mapping when C0 shows how often each case occurs. Mapping it now would be a
 * guess dressed as a rule. If C0 shows this path is common, that is the moment to revisit it.
 */

/**
 * Whether a provider backfill was ACTUALLY WORKING when this retrieval ran.
 *
 * ⚠️ LOAD-BEARING, not decoration. §2 forbids twice — once as an evidence boundary and once as a
 * §7 gate — reporting a cron tick as a workload. 360 backfill route invocations were observed;
 * how many of them did work is unknown, and without this flag every overlap analysis would repeat
 * that error with a bigger number.
 */
export const BACKFILL_ACTIVITY = ['active', 'idle'] as const;
export type BackfillActivity = typeof BACKFILL_ACTIVITY[number];

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 4. KEYED HMAC (§4.3) — plain hashes of patient-derived text are not acceptable
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * HMAC-SHA-256 over UTF-8, prefixed with its key version so a rotation is visible in the value
 * itself rather than inferred from a timestamp. Returns `<keyVersion>:<hex>`.
 *
 * ⚠️ WHY NOT sha256. A retrieval question and a passage are patient-derived. An unkeyed digest of a
 * short clinical string is reversible by dictionary attack — the digest IS the source, for anyone
 * willing to enumerate. The key is the whole protection, so it is required, non-empty, and never
 * defaulted: a missing key throws rather than silently degrading to something weaker.
 *
 * ⚠️ THE GUARD TRIMS (D8). It used to test `secret.length === 0` while the build-time guard tested
 * a trimmed value, so a key of three spaces was ABSENT to the deploy check and USABLE here — the
 * two would have disagreed about whether production was configured. A whitespace key is not a key.
 */
export function telemetryHmac(secret: string, value: string, keyVersion = HMAC_KEY_VERSION): string {
  if (typeof secret !== 'string' || secret.trim().length === 0) {
    throw new Error('telemetry HMAC secret is required — an unkeyed digest of clinical text is not acceptable (§4.3)');
  }
  const digest = createHmac('sha256', secret).update(Buffer.from(value ?? '', 'utf8')).digest('hex');
  return `${keyVersion}:${digest}`;
}

/** Constant-time compare of two `<keyVersion>:<hex>` values. False when the key versions differ. */
export function hmacEquals(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 5. MANIFEST (§4.3, D5, D15, D16)
// ════════════════════════════════════════════════════════════════════════════════════════════════

export type ExpansionStatus = 'expanded' | 'skipped' | 'failed_open';

/**
 * Variant-generation status. SIX real values plus `not_collected`.
 *
 * ⚠️ `parse_failure` AND `failed_open` ARE DIFFERENT (A11). Today both land in one catch, so the
 * real generator needs an inner `try` around the parse to tell them apart — a parse failure means a
 * completion ARRIVED, cost tokens and did not parse, which §4.6 prices and §4.4 says keeps its
 * provider, model and usage. A failed-open means the call itself never produced one.
 *
 * ⚠️ `not_collected` IS FOR THE INJECTED SEAM ONLY (A11). `MultiQueryDeps.variantsFn` returns a
 * bare string array, from which `parsed_empty` and `failed_open` are indistinguishable. Guessing
 * either would put a fabricated fact in a provenance record. An admitted gap is not a defect.
 */
export type VariantStatus =
  | 'generated' | 'parsed_empty' | 'all_invalid' | 'not_an_array'
  | 'parse_failure' | 'failed_open' | 'not_collected';

/** The outcome of retrieving for ONE variant arm. Index 0 is the original expanded arm. */
export type VariantOutcome = 'success' | 'zero_hits' | 'retrieval_failure';

/** §4.3: a successful retrieval with hits, a successful retrieval with none, and a failure. */
export type RetrievalOutcome = 'success' | 'zero_hits' | 'retrieval_failure';

/**
 * The terminal outcome of one rerank batch. §6.2 requires these to be DISTINCT: a parse failure and
 * a missing score key are different defects with different fixes, and collapsing them is how a
 * scoring gap becomes invisible.
 *
 * ⚠️ `timeout` IS A MEMBER (D15), not a synonym for `terminal_failure`. A batch that timed out and
 * a batch that was refused are the same shape in the scores array and want opposite remediation —
 * one is a capacity question, the other is not.
 */
export type BatchOutcome =
  | 'success'
  | 'timeout'
  | 'terminal_failure'
  | 'parse_failure'
  | 'missing_score_key'
  | 'nonnumeric_score';

/**
 * Precedence when several defects coexist, highest first (D15). Independent COUNTS are preserved
 * alongside, so a response with both a missing key and a non-numeric one records both facts and
 * one outcome.
 */
export const BATCH_OUTCOME_PRECEDENCE: readonly BatchOutcome[] = [
  'timeout', 'terminal_failure', 'parse_failure', 'missing_score_key', 'nonnumeric_score', 'success',
] as const;

/**
 * Where a stage or batch was actually served.
 *
 * ⚠️ `unattributed` AND `not_served` ARE DIFFERENT FACTS AND §4.4 FORBIDS MERGING THEM.
 * `unattributed` — a completion may have arrived and attribution is unavailable. It is recorded
 * telemetry, it fails the served-attribution objective, and §7 requires it resolved before C0.
 * `not_served` — telemetry can PROVE no completion arrived, and the proof is the failure
 * attribution D14 attaches to the thrown error. Without that proof the honest answer is
 * `unattributed`, not the more convenient one.
 */
export type ServedRouteClass = 'vertex' | 'openrouter' | 'local' | 'unattributed' | 'not_served';

/** One attempt as it reaches the manifest. `provider` is required by §4.6 — cost is countable by
 *  provider, model, attempt and usage, and a ladder's attempts can span three providers. */
export interface ManifestAttempt {
  provider: string;
  attempt: number;
  /** One of the six committed `TransportAttemptOutcome` values (§4.3). */
  outcome: string;
  status: number | null;
}

export interface ManifestBatch {
  /** STABLE index derived from candidate boundaries, never promise completion order (constraint 7). */
  batch_index: number;
  candidate_start: number;
  candidate_end: number;
  intended_provider: string;
  intended_model: string;
  /**
   * What actually served it. The type permits null DEFENSIVELY; the validator rejects it (A6).
   * A batch record exists only where a request was PLANNED, so a null here is a defect and not a
   * declaration — the explicit null belongs at stage level, where a stage can make no request.
   */
  served_route_class: ServedRouteClass | null;
  served_model: string | null;
  /** Ordered attempt outcomes, from the transport's own evidence — never reconstructed. */
  attempts: ManifestAttempt[] | null;
  outcome: BatchOutcome;
  expected_score_keys: number;
  /** Keys that arrived AND parsed as a finite number. A legitimate 0 counts here (§6.2). */
  finite_score_keys: number;
  /** Independent defect counts, preserved alongside the single `outcome` above (D15). */
  missing_score_keys: number;
  nonnumeric_score_keys: number;
  /** Null, not zero, when the provider returned no usage (§4.6). */
  prompt_tokens: number | null;
  completion_tokens: number | null;
}

/** The multi-query section (D6). Required on role `lab_multi_query`, absent elsewhere. */
export interface MultiQuerySection {
  variant_generation: {
    status: VariantStatus;
    /** Null permitted only when the stage made no request (D16's explicit stage-level null). */
    served_route_class: ServedRouteClass | null;
    served_model: string | null;
    attempts: ManifestAttempt[] | null;
    prompt_tokens: number | null;
    completion_tokens: number | null;
    generated_variant_count: number;
  };
  /** `variants.length` equals `generated_variant_count + 1` — index 0 is the ORIGINAL arm. */
  variants: Array<{ index: number; outcome: VariantOutcome; candidate_count: number }>;
}

/**
 * THE TEXT-FREE PAYLOAD. Every field here is a count, an enum, an id or a keyed HMAC.
 *
 * ⚠️ §6.4 SLICES THIS DECLARATION BY NAME and fails if a field that could hold clinical text is
 * added to it. Renaming it without re-pointing that test makes the assertion pass vacuously, which
 * is why the rewritten pin asserts its slice is non-empty before testing it.
 */
export interface RetrievalPayload {
  manifest_schema_version: number;
  /** Null ONLY with `telemetry_error = 'hmac_key_absent'`, which cannot happen in production. */
  hmac_key_version: string | null;
  telemetry_error: string | null;

  retrieval_outcome: RetrievalOutcome;
  /** A class name. Never a message, never a value. Required when the outcome is a failure. */
  retrieval_error_class: string | null;

  expansion: {
    status: ExpansionStatus;
    input_hmac: string | null;
    served_route_class: ServedRouteClass | null;
    served_model: string | null;
    attempts: ManifestAttempt[] | null;
  };

  multi_query?: MultiQuerySection;

  /**
   * TWO CANDIDATE COUNTS, NOT ONE (§4.3). `fused` is the pool after the cap; `hydrated` is what the
   * re-read actually returned, and it is the number the rerank guard tests. They can differ, and
   * the difference is a dropped row — invisible if only one is recorded.
   */
  fused_candidate_ids: number[];
  hydrated_candidate_ids: number[];
  fused_candidate_count: number;
  hydrated_candidate_count: number;
  /** One per HYDRATED row, not per fused id. Null only with `hmac_key_absent`. */
  pre_rerank_passage_hmacs: string[] | null;

  intended_backend: string;
  intended_model: string;
  /**
   * WHAT ACTUALLY RAN (A10). `lib/rerank.ts` falls through from Cohere to the judge when Cohere is
   * the environment default and its health check fails. Intended Cohere implies one expected batch;
   * the judge then serves N. Under §7's never-waived reconciliation every such row would be
   * `persisted_partial` BY CONSTRUCTION, so the expected count is derived from what served.
   * Null only when no rerank request was made at all.
   */
  served_backend: string | null;
  rerank_backend_downgraded: boolean;
  /** Derived from `served_backend`, never from `intended_backend` (A10). */
  expected_batch_count: number;
  recorded_rerank_batches: number;
  /** Cohere entered and soft-failed to input order. Describes degraded RANKING, not missing
   *  evidence — it never waives the batch reconciliation (§7). */
  rerank_soft_failed: boolean;

  ordered_final_candidate_ids: number[];
  /** Keyed HMAC of the EXACT rendered scorer context — the byte-identity anchor for §6.1.
   *  Required on role `primary`; null on the other four, and that null is not a defect (A2). */
  scorer_context_hmac: string | null;

  /**
   * ⚠️ `null` IS ADMITTED, AND IS A CLAIM (widened by addendum v7 §10). The house rule elsewhere in
   * this module is that an omitted field and a declared null are different statements: absence reads
   * as "this stage did not happen", null reads as "it happened and there is no value". The reranker
   * decode settings need exactly that distinction — `rerank_temperature: null` means no rerank
   * decode ran, which is a fact, where an absent key would mean the field was never implemented.
   */
  retrieval_config: Record<string, string | number | boolean | null>;
  corpus_version: string | null;
  /** The embedding column and the embed model it implies — together, which candidates exist. */
  index_version: string | null;

  batches: ManifestBatch[];
}

/**
 * THE OPERATIONAL STAMP. Route, identity, timing and the environment facts a window needs.
 * §6.4 slices this declaration by name too.
 */
export interface OperationalTelemetry {
  route: RetrievalRoute;
  route_class: RouteClass;
  retrieval_role: RetrievalRole;
  invocation_id: string;
  /** Null on the two retrieving `trace: false` callers, for the whole of their life (D10/D11). */
  trace_id: string | null;
  deployment_sha: string | null;
  started_at: string;
  completed_at: string | null;
  routing_flags: Record<string, string>;
  active_backfill_run_id: string | null;
  /**
   * THE ACTIVE BACKFILL RUN'S `model`. Null when there is no active run (addendum v7 §7).
   *
   * ⚠️ THE NAME PROMISES MORE THAN THE DATA HOLDS, AND THAT IS RECORDED RATHER THAN RENAMED.
   * `BackfillRun` has no `target` field at all — verified, and v7 §7 says to stop if one appears.
   * What this carries is the grader model identifier the run is written against. No code reads the
   * value back, so nothing depends on the misreading today; the definition is written here so that
   * no future reader infers a day range, a cursor or a note set from the word "target".
   *
   * ⚠️ NOT RENAMED, DELIBERATELY. Renaming a persisted column is a migration, and neither v7 nor
   * this pass authorizes one for that purpose.
   *
   * Null is a MEASUREMENT here, paired with `active_backfill_state`: PRD §7 needs active
   * provider-backfill intervals for overlap analysis and states that an idle cron tick is not an
   * interval. Null target with state `idle` is exactly "no active run", which is that distinction.
   */
  active_backfill_target: string | null;
  active_backfill_state: BackfillActivity | null;
  active_lab_experiment_id: string | null;
}

/**
 * The stamped manifest. A one-line INTERSECTION with no field list of its own — which is exactly
 * why §6.4 asserts its shape rather than scanning its source: there is nothing to scan, and a
 * third ban loop over this name would pass vacuously forever.
 */
export type StampedRetrievalManifest = RetrievalPayload & { operational: OperationalTelemetry };

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 6. VALIDATION (D17) — takes `unknown`, validates at run time, returns CODES only
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** Own-property presence, so an absent field and an explicit null are different answers. */
function has(o: unknown, k: string): boolean {
  return !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
}
function get(o: unknown, k: string): unknown {
  return has(o, k) ? (o as Record<string, unknown>)[k] : undefined;
}
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNonEmptyStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isIdArray = (v: unknown): v is number[] => Array.isArray(v) && v.every(isFiniteNum);

/**
 * Structural validation of a STAMPED manifest. Returns violation CODES only — never a value, never
 * a fragment, because a validator that echoes what it rejected is a validator that can leak.
 *
 * Takes `unknown` (D17): the row this reads may have been written by an older deployment or by a
 * caller that skipped the type entirely, and a validator whose parameter is already the type it is
 * meant to prove is a validator that proves nothing.
 */
export function validateManifest(input: unknown): string[] {
  const v: string[] = [];
  if (!input || typeof input !== 'object') return ['manifest_absent'];
  const m = input as Record<string, unknown>;

  if (m.manifest_schema_version !== MANIFEST_SCHEMA_VERSION) v.push('manifest_version_unrecognized');

  // ── The HMAC-absent licence. Four fields may be null when, and ONLY when, it is declared (D8) ──
  const keyAbsent = m.telemetry_error === TELEMETRY_ERROR_HMAC_KEY_ABSENT;
  if (!isNonEmptyStr(m.hmac_key_version) && !keyAbsent) v.push('hmac_key_version_absent');

  // ── Operational ──────────────────────────────────────────────────────────────────────────────
  const op = m.operational;
  if (!op || typeof op !== 'object') {
    v.push('operational_absent');
  } else {
    const o = op as Record<string, unknown>;
    if (!(RETRIEVAL_ROUTES as readonly unknown[]).includes(o.route)) v.push('route_absent_or_invalid');
    if (!isNonEmptyStr(o.route_class)) v.push('route_class_absent');
    if (!(RETRIEVAL_ROLES as readonly unknown[]).includes(o.retrieval_role)) v.push('retrieval_role_absent_or_invalid');
    if (!isNonEmptyStr(o.invocation_id)) v.push('invocation_id_absent');
    if (!isNonEmptyStr(o.started_at)) v.push('started_at_absent');
    if (!isNonEmptyStr(o.completed_at)) v.push('completed_at_absent');
    if (!has(o, 'trace_id')) v.push('trace_id_field_absent');
    if (!has(o, 'deployment_sha')) v.push('deployment_sha_field_absent');
    if (!o.routing_flags || typeof o.routing_flags !== 'object' || Array.isArray(o.routing_flags)) {
      v.push('routing_flags_absent');
    }
    if (!has(o, 'active_backfill_run_id')) v.push('active_backfill_run_id_field_absent');
    if (!has(o, 'active_backfill_target')) v.push('active_backfill_target_field_absent');
    if (!has(o, 'active_backfill_state')) v.push('active_backfill_state_field_absent');
    else if (o.active_backfill_state !== null && !(BACKFILL_ACTIVITY as readonly unknown[]).includes(o.active_backfill_state)) {
      v.push('active_backfill_state_invalid');
    }
    if (!has(o, 'active_lab_experiment_id')) v.push('active_lab_experiment_id_field_absent');
  }
  const role = (op as Record<string, unknown> | undefined)?.retrieval_role;

  // ── Retrieval outcome ────────────────────────────────────────────────────────────────────────
  const outcome = m.retrieval_outcome;
  if (outcome !== 'success' && outcome !== 'zero_hits' && outcome !== 'retrieval_failure') {
    v.push('retrieval_outcome_absent_or_invalid');
  }
  if (!has(m, 'retrieval_error_class')) v.push('retrieval_error_class_field_absent');
  else if (outcome === 'retrieval_failure' && !isNonEmptyStr(m.retrieval_error_class)) {
    v.push('retrieval_error_class_absent_on_failure');
  }

  // ── Expansion ────────────────────────────────────────────────────────────────────────────────
  const ex = m.expansion as Record<string, unknown> | undefined;
  if (!ex || typeof ex !== 'object') {
    v.push('expansion_absent');
  } else {
    const skipped = ex.status === 'skipped';
    if (ex.status !== 'expanded' && ex.status !== 'skipped' && ex.status !== 'failed_open') {
      v.push('expansion_status_absent_or_invalid');
    }
    if (!has(ex, 'input_hmac')) v.push('expansion_input_hmac_field_absent');
    else if (ex.input_hmac === null && !keyAbsent && !skipped) v.push('expansion_input_hmac_absent');
    // A SKIPPED stage made no request, so its served class is the explicit stage-level null (A6).
    // Anything else must declare — absence of the field is not a declaration (§7).
    if (!has(ex, 'served_route_class')) v.push('expansion_served_route_class_field_absent');
    else if (ex.served_route_class === null && !skipped) v.push('expansion_served_route_class_absent');
    else if (ex.served_route_class !== null && !isServedRouteClass(ex.served_route_class)) {
      v.push('expansion_served_route_class_invalid');
    }
    if (!has(ex, 'served_model')) v.push('expansion_served_model_field_absent');
    if (!has(ex, 'attempts')) v.push('expansion_attempts_field_absent');
    // LOCATION 1 of 3 (v11 §4). The presence check above asks only whether the FIELD is there.
    pushAttemptOutcomeDefects(ex.attempts, 'attempt_outcome_absent_or_invalid', v);
  }

  // ── Candidates ───────────────────────────────────────────────────────────────────────────────
  if (!isIdArray(m.fused_candidate_ids)) v.push('fused_candidate_ids_absent');
  if (!isIdArray(m.hydrated_candidate_ids)) v.push('hydrated_candidate_ids_absent');
  if (!isFiniteNum(m.fused_candidate_count) || (m.fused_candidate_count as number) < 0) v.push('fused_candidate_count_absent');
  if (!isFiniteNum(m.hydrated_candidate_count) || (m.hydrated_candidate_count as number) < 0) v.push('hydrated_candidate_count_absent');
  if (!has(m, 'pre_rerank_passage_hmacs')) v.push('pre_rerank_passage_hmacs_field_absent');
  else if (m.pre_rerank_passage_hmacs === null) {
    if (!keyAbsent) v.push('pre_rerank_passage_hmacs_absent');
  } else if (!Array.isArray(m.pre_rerank_passage_hmacs)) {
    v.push('pre_rerank_passage_hmacs_absent');
  } else if (Array.isArray(m.hydrated_candidate_ids)
    && (m.pre_rerank_passage_hmacs as unknown[]).length !== (m.hydrated_candidate_ids as unknown[]).length) {
    // One per HYDRATED row. Pinned against the hydrated count, not the fused one — a dropped row is
    // exactly the case this cardinality is here to make visible.
    v.push('passage_hmac_cardinality_mismatch');
  }

  // ── Backend, batches and the reconciliation §7 never waives ───────────────────────────────────
  if (!isNonEmptyStr(m.intended_backend)) v.push('intended_backend_absent');
  if (!isNonEmptyStr(m.intended_model)) v.push('intended_model_absent');
  if (typeof m.rerank_backend_downgraded !== 'boolean') v.push('rerank_backend_downgraded_absent');
  if (typeof m.rerank_soft_failed !== 'boolean') v.push('rerank_soft_failed_absent');
  if (!isFiniteNum(m.expected_batch_count)) v.push('expected_batch_count_absent');
  if (!isFiniteNum(m.recorded_rerank_batches)) v.push('recorded_rerank_batches_absent');
  if (!has(m, 'served_backend')) v.push('served_backend_field_absent');

  if (!Array.isArray(m.batches)) {
    v.push('batches_absent');
  } else {
    const batches = m.batches as Record<string, unknown>[];
    // `served_backend` may be null ONLY when no request was made. A batch record IS a planned
    // request, so one batch and a null served backend is a contradiction.
    if (batches.length > 0 && m.served_backend === null) v.push('served_backend_absent_with_batches');
    if (isFiniteNum(m.recorded_rerank_batches) && batches.length !== m.recorded_rerank_batches) {
      v.push('recorded_batch_count_mismatch');
    }
    if (isFiniteNum(m.expected_batch_count) && batches.length !== m.expected_batch_count) {
      v.push('batch_count_mismatch');
    }
    const seen = new Set<number>();
    for (const b of batches) {
      if (!isFiniteNum(b.batch_index)) { v.push('batch_index_absent'); continue; }
      if (seen.has(b.batch_index as number)) v.push('duplicate_batch_index');
      seen.add(b.batch_index as number);
      if (!isFiniteNum(b.candidate_start) || !isFiniteNum(b.candidate_end)) v.push('batch_boundaries_absent');
      else if ((b.candidate_end as number) <= (b.candidate_start as number)) v.push('bad_candidate_boundaries');
      if (!isNonEmptyStr(b.intended_provider)) v.push('batch_intended_provider_absent');
      if (!isNonEmptyStr(b.intended_model)) v.push('batch_intended_model_absent');
      // §7: a declared served class on EVERY batch record. Absence of the field is not a
      // declaration, and neither is null — the type permits it defensively, the gate does not (A6).
      if (!has(b, 'served_route_class') || b.served_route_class === null) v.push('batch_served_route_class_absent');
      else if (!isServedRouteClass(b.served_route_class)) v.push('batch_served_route_class_invalid');
      if (b.served_route_class === 'unattributed' && b.served_model !== null) v.push('unattributed_with_model');
      if (b.served_route_class === 'not_served' && b.served_model !== null) v.push('not_served_with_model');
      if (!has(b, 'served_model')) v.push('batch_served_model_field_absent');
      if (!has(b, 'attempts')) v.push('batch_attempts_field_absent');
      // LOCATION 2 of 3 (v11 §4).
      pushAttemptOutcomeDefects(b.attempts, 'attempt_outcome_absent_or_invalid', v);
      if (!(BATCH_OUTCOME_PRECEDENCE as readonly unknown[]).includes(b.outcome)) v.push('batch_outcome_absent_or_invalid');
      if (!isFiniteNum(b.expected_score_keys) || (b.expected_score_keys as number) < 0) v.push('expected_score_keys_absent');
      if (!isFiniteNum(b.finite_score_keys) || (b.finite_score_keys as number) < 0) v.push('finite_score_keys_absent');
      else if (isFiniteNum(b.expected_score_keys) && (b.finite_score_keys as number) > (b.expected_score_keys as number)) {
        v.push('score_keys_exceed_expected');
      }
    }
    // Batches must be orderable by their boundaries independently of completion order (constraint 7).
    const byIndex = [...batches].filter((b) => isFiniteNum(b.batch_index))
      .sort((a, b) => (a.batch_index as number) - (b.batch_index as number));
    for (let i = 1; i < byIndex.length; i++) {
      if ((byIndex[i].candidate_start as number) < (byIndex[i - 1].candidate_end as number)) v.push('overlapping_batches');
    }
  }

  // ── Ordering, config and the role-sensitive scorer-context HMAC ───────────────────────────────
  if (!isIdArray(m.ordered_final_candidate_ids)) v.push('ordered_final_candidate_ids_absent');
  if (!m.retrieval_config || typeof m.retrieval_config !== 'object' || Array.isArray(m.retrieval_config)) {
    v.push('retrieval_config_absent');
  } else {
    // ── The v7 §10 decode fields, REQUIRED as of manifest version 3 ────────────────────────────
    //
    // ⚠️ `has`, NOT A TRUTHINESS TEST, and for the reason the rest of this validator uses it: an
    // ABSENT field and an EXPLICIT NULL are different claims. `rerank_temperature: null` means no
    // rerank decode ran, which is a fact worth recording; an absent key means the manifest predates
    // the field or the writer forgot it, which is a defect.
    const cfg = m.retrieval_config;
    if (!has(cfg, 'rerank_temperature')) {
      v.push('rerank_temperature_field_absent');
    } else {
      const t = get(cfg, 'rerank_temperature');
      if (t !== null && (typeof t !== 'number' || !Number.isFinite(t))) v.push('rerank_temperature_invalid');
    }
    if (!has(cfg, 'rerank_seed_status')) {
      v.push('rerank_seed_status_field_absent');
    } else if (!(RERANK_SEED_STATUSES as readonly unknown[]).includes(get(cfg, 'rerank_seed_status'))) {
      // Never null: a seed status is always knowable, and `not_applicable` is the value for
      // "no rerank decode ran". A null here would be an absence dressed as a measurement.
      v.push('rerank_seed_status_invalid');
    }
  }
  if (!has(m, 'corpus_version')) v.push('corpus_version_field_absent');
  if (!isNonEmptyStr(m.index_version)) v.push('index_version_absent');

  if (!has(m, 'scorer_context_hmac')) v.push('scorer_context_hmac_field_absent');
  else if (role === 'primary' && m.scorer_context_hmac === null && !keyAbsent) v.push('scorer_context_hmac_absent');

  // ── Multi-query, required on exactly one role ─────────────────────────────────────────────────
  if (role === 'lab_multi_query') {
    const mq = m.multi_query as Record<string, unknown> | undefined;
    if (!mq || typeof mq !== 'object') v.push('multi_query_absent');
    else {
      const vg = mq.variant_generation as Record<string, unknown> | undefined;
      if (!vg || typeof vg !== 'object') v.push('variant_generation_absent');
      else {
        if (!isVariantStatus(vg.status)) v.push('variant_generation_status_absent_or_invalid');
        if (!has(vg, 'served_route_class')) v.push('variant_generation_served_route_class_field_absent');
        if (!isFiniteNum(vg.generated_variant_count)) v.push('generated_variant_count_absent');
        // LOCATION 3 of 3 (v11 §4, review 22 item 2). This block did not read `vg.attempts` at all
        // before this line, so a variant-generation attempt could carry any outcome unchallenged.
        pushAttemptOutcomeDefects(vg.attempts, 'attempt_outcome_absent_or_invalid', v);
      }
      if (!Array.isArray(mq.variants)) v.push('variants_absent');
      else if (vg && isFiniteNum((vg as Record<string, unknown>).generated_variant_count)
        && (mq.variants as unknown[]).length !== ((vg as Record<string, unknown>).generated_variant_count as number) + 1) {
        // index 0 is the ORIGINAL expanded arm, so the array is always one longer than the count
        v.push('variant_arity_mismatch');
      }
    }
  } else if (has(m, 'multi_query')) {
    v.push('multi_query_on_non_multi_query_role');
  }

  return v;
}

function isServedRouteClass(v: unknown): boolean {
  return v === 'vertex' || v === 'openrouter' || v === 'local' || v === 'unattributed' || v === 'not_served';
}

/**
 * THE ATTEMPT-OUTCOME BRANCH (v11 §4, review 22 items 2 and 4). One implementation, called from all
 * THREE manifest locations — expansion attempts, rerank batch attempts, and multi-query
 * variant-generation attempts — with the same stable defect name at each.
 *
 * ⚠️ NOTHING VALIDATED AN ATTEMPT OUTCOME BEFORE THIS. The two checks that look like validation,
 * `expansion_attempts_field_absent` and `batch_attempts_field_absent`, only ask whether the FIELD is
 * present; the variant-generation block did not reach `attempts` at all. The single line in this
 * file that read `a.outcome` was the 429 counter in `batchCounters`. So a manifest could carry any
 * string — or nothing — where one of the six committed outcomes belongs, and the census that counts
 * 429s would silently miss it.
 *
 * ⚠️ `attempts: null` IS LEGAL HERE AND MUST NOT BE FLAGGED. A skipped expansion stage emits null
 * (`lib/retrieval-capture.ts:309`) and `manifestAttempts` returns null when there is no evidence
 * (`:122-123`). Addendum v11 §6.1 defers the `null` to `[]` correction to PASS 3, so a branch that
 * treated null as defective would flag every skipped stage today and would be making pass 3's
 * decision early. Validate the members of an array when there is one; say nothing when there is not.
 *
 * ⚠️ A NON-ARRAY, NON-NULL value IS defective. `undefined`, a string or an object is neither "no
 * attempts" nor a list of them, and the field-presence checks beside each call site do not catch a
 * present-but-wrong-shaped value.
 */
function pushAttemptOutcomeDefects(attempts: unknown, defect: string, v: string[]): void {
  if (attempts === null || attempts === undefined) return;          // legal today — see above
  if (!Array.isArray(attempts)) { v.push(defect); return; }
  for (const a of attempts) {
    const outcome = (a as { outcome?: unknown } | null)?.outcome;
    if (!(TRANSPORT_ATTEMPT_OUTCOMES as readonly unknown[]).includes(outcome)) { v.push(defect); return; }
  }
}
function isVariantStatus(v: unknown): boolean {
  return ['generated', 'parsed_empty', 'all_invalid', 'not_an_array', 'parse_failure', 'failed_open', 'not_collected']
    .includes(v as string);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 7. COUNTERS (§4.3, D15) — the two orphan columns finally get a writer
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The counters the row carries, derived from the manifest so the two can never disagree.
 *
 * ⚠️ THE CLASS ATTRIBUTION WAS A BUG (D15). It was a chain ending in a bare `else` that incremented
 * `unattributed`. Once `not_served` exists — and once a skipped stage can carry a null class — both
 * would have landed in that `else` and been reported as unattributed: three different facts merged
 * into one column, which is exactly what §2 forbids. Every branch now tests EQUALITY, and a null or
 * absent class increments nothing.
 *
 * That a null increments nothing here, while `validateManifest` REJECTS a null on a batch, is not a
 * contradiction: the type is defensive and the validator is the contract (A6). This counter must
 * not be read as permission for a batch to omit its class.
 */
export function batchCounters(m: Pick<RetrievalPayload, 'batches'>): {
  vertex: number; openrouter: number; local: number; not_served: number;
  failed: number; unattributed: number; retries_429: number;
} {
  const c = { vertex: 0, openrouter: 0, local: 0, not_served: 0, failed: 0, unattributed: 0, retries_429: 0 };
  for (const b of m?.batches ?? []) {
    if (b.served_route_class === 'vertex') c.vertex += 1;
    else if (b.served_route_class === 'openrouter') c.openrouter += 1;
    else if (b.served_route_class === 'local') c.local += 1;
    else if (b.served_route_class === 'not_served') c.not_served += 1;
    else if (b.served_route_class === 'unattributed') c.unattributed += 1;
    // a null or absent class increments NOTHING — see the note above
    if (b.outcome !== 'success') c.failed += 1;
    c.retries_429 += (b.attempts ?? []).filter((a) => a.outcome === 'http_429').length;
  }
  return c;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 8. COST (§4.6) — unknown usage stays unknown
// ════════════════════════════════════════════════════════════════════════════════════════════════

export interface RerankUsageBucket {
  provider: string;
  model: string;
  batches: number;
  attempts: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  /** Batches whose provider returned no usage. §4.6: never turn missing token data into zero cost. */
  batches_with_unknown_usage: number;
  /** §4.6: local, not-served and skipped stages are UNPRICED. `unattributed` and `parse_failure`
   *  are priced from their preserved usage — a malformed completion still consumed tokens. */
  priceable: boolean;
}

/** Which served classes cost money. `not_served` bought nothing; `local` is not billed. */
export function isPriceableClass(served: string | null | undefined): boolean {
  return served === 'vertex' || served === 'openrouter' || served === 'unattributed';
}

/**
 * Aggregate rerank usage by served provider/model. The rule that matters: a bucket whose every
 * batch lacked usage reports `null` tokens, NOT 0 — a zero would price as ₹0 and read as "this
 * cost nothing", which is precisely the false statement the cost tracker has been making about
 * every rerank call ever dispatched (they are traceless, so it never saw one).
 *
 * Pricing is deliberately NOT applied here. The existing pricing source and its effective-date
 * discipline live in lib/llm-cost-core.ts; duplicating rates would create a second source of truth
 * for money. This produces the countable inputs that module prices.
 */
export function aggregateRerankUsage(manifests: Array<Pick<RetrievalPayload, 'batches'>>): RerankUsageBucket[] {
  const buckets = new Map<string, RerankUsageBucket>();
  for (const m of manifests ?? []) {
    for (const b of m?.batches ?? []) {
      const provider = b.served_route_class ?? 'unattributed';
      const model = b.served_model ?? provider;
      const key = `${provider} ${model}`;
      let e = buckets.get(key);
      if (!e) {
        e = {
          provider, model, batches: 0, attempts: 0, prompt_tokens: null, completion_tokens: null,
          batches_with_unknown_usage: 0, priceable: isPriceableClass(provider),
        };
        buckets.set(key, e);
      }
      e.batches += 1;
      e.attempts += (b.attempts ?? []).length;
      const known = typeof b.prompt_tokens === 'number' || typeof b.completion_tokens === 'number';
      if (!known) { e.batches_with_unknown_usage += 1; continue; }
      if (typeof b.prompt_tokens === 'number') e.prompt_tokens = (e.prompt_tokens ?? 0) + b.prompt_tokens;
      if (typeof b.completion_tokens === 'number') e.completion_tokens = (e.completion_tokens ?? 0) + b.completion_tokens;
    }
  }
  return [...buckets.values()].sort((a, b) => (a.provider + a.model).localeCompare(b.provider + b.model));
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 9. SETTLEMENT AND TRANSITIONS (D9, D12)
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * What the OWNER of a save observed. Mapped to a state by `stateForSettlement` below, so the
 * mapping exists once rather than at each of the seven save expressions.
 */
export const SETTLEMENT_OUTCOMES = [
  'persisted_clean', 'persisted_dirty', 'losing_conflict', 'persistence_skipped',
  'persistence_refused', 'audit_persistence_failed', 'audit_generation_failed',
  'no_persistence_intended', 'retrieval_not_run',
] as const;
export type SettlementOutcome = typeof SETTLEMENT_OUTCOMES[number];

/**
 * D9's outcome-to-state table, complete and total.
 *
 * ⚠️ `aborted`, `persistence_unknown` and `telemetry_persistence_failed` are ABSENT by design: THIS
 * TABLE never names them. They are produced only through `reconcilerStateFor` below, which is the
 * reconciler's own mapping — and `stateForUnwrittenRun` in `lib/retrieval-settlement.ts` also calls
 * it, for a run still at revision 0 whose outcome D12's transition guard cannot apply. So the honest
 * statement is about the PRODUCER, not about the caller: no settlement mapping produces these three,
 * and a settlement that reaches one has gone through the reconciler's function to do it (D9 as
 * amended by addendum v1 item 2, 13 Aug 2026).
 */
const SETTLEMENT_STATE: Readonly<Record<SettlementOutcome, RetrievalPersistenceState>> = {
  persisted_clean: 'persisted_complete',
  persisted_dirty: 'persisted_partial',
  losing_conflict: 'completed_unpersisted',
  persistence_skipped: 'persistence_skipped',
  persistence_refused: 'persistence_refused',
  audit_persistence_failed: 'audit_persistence_failed',
  audit_generation_failed: 'audit_generation_failed',
  no_persistence_intended: 'no_persistence_intended',
  retrieval_not_run: 'retrieval_not_run',
};

export function stateForSettlement(outcome: SettlementOutcome): RetrievalPersistenceState {
  return SETTLEMENT_STATE[outcome];
}

/**
 * The ONLY allowed transitions (D12). Terminal states never transition.
 *
 * ⚠️ `retrieval_complete -> aborted` IS DELIBERATELY ABSENT. A run that wrote its terminal manifest
 * did not abort; what is unknown is the audit's fate, and that is `persistence_unknown`. Collapsing
 * the two would report a completed retrieval as one that never finished.
 *
 * ⚠️ `started -> audit_generation_failed` IS DELIBERATELY PRESENT. D11 puts the primary terminal
 * write at step 12 and `auditOpdNote` can throw at steps 7, 8 or 9 — so a row that never reached
 * its terminal write is still `started` when the audit fails. Forbidding this would leave the only
 * honest settlement unreachable and hand the row to the reconciler as an `aborted` guess.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<string, readonly RetrievalPersistenceState[]>> = {
  started: [
    'retrieval_complete', 'aborted', 'retrieval_not_run', 'telemetry_persistence_failed',
    'audit_generation_failed',
  ],
  retrieval_complete: [
    'persisted_complete', 'persisted_partial', 'completed_unpersisted', 'persistence_refused',
    'audit_persistence_failed', 'audit_generation_failed', 'persistence_skipped',
    'no_persistence_intended', 'telemetry_persistence_failed', 'persistence_unknown',
  ],
};

export function isAllowedTransition(from: string, to: string): boolean {
  return (ALLOWED_TRANSITIONS[from] as readonly string[] | undefined)?.includes(to) ?? false;
}

/**
 * D13's reconciler mapping. A row's assigned state depends on BOTH where it stalled and whether
 * run-level failure evidence exists — the difference between "telemetry failed and we know it" and
 * "we simply never heard again", which are different remediations.
 */
export function reconcilerStateFor(
  rowState: 'started' | 'retrieval_complete',
  failurePhases: readonly string[],
): RetrievalPersistenceState {
  if (rowState === 'started') {
    return failurePhases.includes('retrieval_terminal') ? 'telemetry_persistence_failed' : 'aborted';
  }
  return failurePhases.includes('persistence_link') ? 'telemetry_persistence_failed' : 'persistence_unknown';
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 10. CANONICALIZATION (D12) — one function, used for both equality and persistence
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Deterministic JSON: keys sorted recursively at EVERY depth, array order preserved, `undefined`
 * omitted in objects and REJECTED in arrays, non-finite numbers rejected.
 *
 * `undefined` in an array is rejected rather than dropped or nulled because dropping changes the
 * length and nulling changes the value — either way two manifests that differ would compare equal,
 * which is the one thing the identical-content no-op check must never do.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number');
    return value;
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((el) => {
      if (el === undefined) throw new Error('canonicalJson: undefined array element');
      return canonicalize(el);
    });
  }
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    const el = (value as Record<string, unknown>)[k];
    if (el === undefined) continue;               // omitted in objects, as JSON.stringify would
    out[k] = canonicalize(el);
  }
  return out;
}

/**
 * The columns compared by the identical-content no-op check (D12), classified so the projection is
 * a stated decision rather than an accident of what someone remembered to list.
 *
 * The manifest's operational TIMESTAMPS are excluded: a retry reuses the originally stamped
 * manifest, so comparing `completed_at` would make every retry look like new content and burn a
 * revision for a write that changed nothing.
 */
export const COLUMN_CLASSIFICATION = {
  /** Written once at declaration; a change here is a bug, not an update. */
  immutable_insert: [
    'retrieval_run_id', 'retrieval_role', 'route', 'invocation_id', 'app_source',
    'telemetry_schema_version', 'started_at',
  ],
  /** Written by the terminal write and by settlement; these are what equality compares. */
  mutable_terminal: [
    'audit_id', 'trace_id', 'uid', 'engine_version', 'deployment_sha', 'persistence_state',
    'retrieval_outcome', 'retrieval_error_class', 'completed_at', 'expansion_status',
    'expansion_route_class', 'expansion_served_model', 'expansion_attempts', 'rerank_route_class',
    'expected_rerank_batches', 'recorded_rerank_batches', 'served_backend',
    'rerank_backend_downgraded', 'rerank_soft_failed', 'fused_candidate_count',
    'hydrated_candidate_count', 'index_version', 'context_hmac', 'retrieval_manifest',
    'telemetry_error', 'experiment_run_id', 'pair_id', 'replicate',
    'active_backfill_run_id', 'active_backfill_target', 'active_backfill_state',
  ],
  /** Bookkeeping about the row itself — never part of its content. */
  revision_metadata: ['row_revision', 'persistence_settled_at'],
  /** Derived from `retrieval_manifest` by `batchCounters`; compared through it, not beside it. */
  derived: [
    'rerank_vertex_batches', 'rerank_openrouter_batches', 'rerank_local_batches',
    'rerank_failed_batches', 'rerank_unattributed_batches', 'rerank_not_served_batches',
    'rerank_429_attempts',
  ],
} as const;

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 11. THE SCHEMA CONTRACT (D1, D2) — the statements the migration route applies
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * ⚠️ WHY THE DDL LIVES IN THE CORE AND NOT IN THE ROUTE.
 *
 * D2 forbids hand-typing any value list into a CHECK: an earlier version of the kickoff hand-typed
 * a count and got it wrong, and the version after it hand-typed thirteen state names two paragraphs
 * after forbidding exactly that. The CHECKs are therefore GENERATED from the constants above — and
 * a generated statement cannot be verified by reading the route's source, because the values are
 * not in it. Putting the builder here makes the emitted SQL importable, so the parity test compares
 * REAL OUTPUT against the `.sql` mirror rather than comparing two pieces of prose.
 *
 * This is not the same thing PRD §4.2 forbids. §4.2 says do not generate the `.sql` FILE from the
 * constant — that file stays hand-typed documentation, held to this output by the parity test.
 * What is generated is the statement the ROUTE executes.
 */
const q = (xs: readonly string[]) => xs.map((s) => `'${s}'`).join(', ');

export interface DdlStatement {
  /** Names this step in the route's `steps` response, so an operator can read what ran. */
  key: string;
  sql: string;
}

/**
 * Every statement the migration route runs, in order. All idempotent.
 *
 * ⚠️ THE CREATE TABLE CARRIES NO INLINE STATE CHECK, deliberately. Migration 0035 declared one
 * inline with the eight old values. Keeping that shape would put the state vocabulary in two places
 * in one migration — the inline copy and the named constraint D2 requires be DROPped and re-ADDed —
 * and a reader would have to check the two agree. There is one home for it: the named constraint
 * below. On a fresh table the DROP is a no-op and the ADD installs it; on an existing table the
 * pair replaces whatever was there. Both paths end identically.
 */
export function retrievalTelemetryDdl(): DdlStatement[] {
  return [
    // ── 1. The retrieval-execution table ────────────────────────────────────────────────────────
    {
      key: 'retrieval_table',
      sql: `CREATE TABLE IF NOT EXISTS opd_audit_retrieval_telemetry (
  retrieval_run_id UUID PRIMARY KEY,
  audit_id UUID NULL REFERENCES opd_note_audits(id) ON DELETE SET NULL,
  trace_id TEXT NULL,
  uid TEXT NULL,
  engine_version TEXT NULL,
  route TEXT NOT NULL,
  invocation_id TEXT NULL,
  app_source TEXT NOT NULL DEFAULT 'standalone',
  deployment_sha TEXT NULL,
  telemetry_schema_version INTEGER NOT NULL,
  experiment_run_id TEXT NULL,
  pair_id TEXT NULL,
  replicate TEXT NULL,
  persistence_state TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NULL,
  expansion_status TEXT NULL,
  expansion_route_class TEXT NULL,
  rerank_route_class TEXT NULL,
  expected_rerank_batches INTEGER NULL,
  recorded_rerank_batches INTEGER NULL,
  rerank_vertex_batches INTEGER NOT NULL DEFAULT 0,
  rerank_openrouter_batches INTEGER NOT NULL DEFAULT 0,
  rerank_local_batches INTEGER NOT NULL DEFAULT 0,
  rerank_failed_batches INTEGER NOT NULL DEFAULT 0,
  rerank_unattributed_batches INTEGER NOT NULL DEFAULT 0,
  rerank_429_attempts INTEGER NOT NULL DEFAULT 0,
  context_hmac TEXT NULL,
  retrieval_manifest JSONB NULL,
  telemetry_error TEXT NULL
)`,
    },
    // ── 2. The on-path additions (D2) ───────────────────────────────────────────────────────────
    {
      key: 'retrieval_columns',
      sql: `ALTER TABLE opd_audit_retrieval_telemetry
  ADD COLUMN IF NOT EXISTS retrieval_role TEXT,
  ADD COLUMN IF NOT EXISTS retrieval_outcome TEXT,
  ADD COLUMN IF NOT EXISTS retrieval_error_class TEXT,
  ADD COLUMN IF NOT EXISTS persistence_settled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS row_revision INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS expansion_served_model TEXT,
  ADD COLUMN IF NOT EXISTS expansion_attempts JSONB,
  ADD COLUMN IF NOT EXISTS rerank_not_served_batches INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rerank_soft_failed BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS served_backend TEXT,
  ADD COLUMN IF NOT EXISTS rerank_backend_downgraded BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS fused_candidate_count INTEGER,
  ADD COLUMN IF NOT EXISTS hydrated_candidate_count INTEGER,
  ADD COLUMN IF NOT EXISTS index_version TEXT,
  ADD COLUMN IF NOT EXISTS active_backfill_run_id TEXT,
  ADD COLUMN IF NOT EXISTS active_backfill_target TEXT,
  ADD COLUMN IF NOT EXISTS active_backfill_state TEXT,
  ALTER COLUMN app_source SET DEFAULT 'standalone'`,
    },
    // ── 3. The three CHECKs, in ONE statement (v9 §6.1) ─────────────────────────────────────────
    //
    // ⚠️ ONE ALTER, NOT SIX. These were five drop/add pairs across two tables, run by a plain loop
    // with no transaction (`migrate-retrieval-telemetry/route.ts:72-75`,
    // `telemetry-overhead/route.ts:298`). THIS TABLE IS THE DANGEROUS ONE: its CREATE TABLE above
    // carries no inline CHECK at all, deliberately, so this pair was the ONLY source of all three
    // constraints — and a failure between a DROP and its ADD left the table UNCONSTRAINED, with
    // nothing later putting the constraint back.
    //
    // ⚠️ WHY DROPPING AND ADDING THE SAME NAME IN ONE STATEMENT WORKS. PostgreSQL sorts the
    // subcommands of one ALTER TABLE into ordered passes, and drops run before adds. It works
    // because of PASS ORDERING, not because the actions run left to right — do not reason about
    // this statement by reading it top to bottom. The whole statement takes one lock and validates
    // every new CHECK against existing rows inside it, which is the atomicity this is for. It also
    // means one bad row now fails the ENTIRE replacement rather than leaving the table half
    // constrained; that is the intended trade, not a regression.
    //
    // Every value list is still generated from the constants above. Idempotent in both directions:
    // DROP … IF EXISTS tolerates absence on a fresh table, and each ADD names a constraint the same
    // statement has already freed.
    //
    // The role CHECK is UNCONDITIONAL. A NULL role passes a CHECK by SQL's own rules, which is
    // exactly why the NOT NULL below has to be a separate, conditional step.
    //
    // `retrieval_outcome` stays NULLABLE because the worker inserts `started` rows before retrieval
    // starts (D2). The state is what makes it required, so that guard is stateful.
    {
      key: 'retrieval_checks',
      sql: `ALTER TABLE opd_audit_retrieval_telemetry
  DROP CONSTRAINT IF EXISTS opd_audit_retrieval_telemetry_persistence_state_chk,
  DROP CONSTRAINT IF EXISTS opd_audit_retrieval_telemetry_role_chk,
  DROP CONSTRAINT IF EXISTS opd_audit_retrieval_telemetry_outcome_chk,
  ADD CONSTRAINT opd_audit_retrieval_telemetry_persistence_state_chk CHECK (persistence_state IN (${q(RETRIEVAL_PERSISTENCE_STATES)})),
  ADD CONSTRAINT opd_audit_retrieval_telemetry_role_chk CHECK (retrieval_role IN (${q(RETRIEVAL_ROLES)})),
  ADD CONSTRAINT opd_audit_retrieval_telemetry_outcome_chk CHECK (
  (persistence_state = 'started' AND retrieval_outcome IS NULL)
  OR (persistence_state IN (${q(OUTCOME_REQUIRED_STATES)}) AND retrieval_outcome IS NOT NULL)
  OR persistence_state IN (${q(OUTCOME_EITHER_STATES)})
)`,
    },
    // ── 4. Indexes on the retrieval table ───────────────────────────────────────────────────────
    { key: 'idx_started_at', sql: `CREATE INDEX IF NOT EXISTS opd_art_started_at_idx ON opd_audit_retrieval_telemetry (started_at DESC)` },
    { key: 'idx_state_started_at', sql: `CREATE INDEX IF NOT EXISTS opd_art_state_started_at_idx ON opd_audit_retrieval_telemetry (persistence_state, started_at DESC)` },
    { key: 'idx_audit_id', sql: `CREATE INDEX IF NOT EXISTS opd_art_audit_id_idx ON opd_audit_retrieval_telemetry (audit_id) WHERE audit_id IS NOT NULL` },
    { key: 'idx_uid_engine', sql: `CREATE INDEX IF NOT EXISTS opd_art_uid_engine_idx ON opd_audit_retrieval_telemetry (uid, engine_version, started_at DESC)` },
    { key: 'idx_route_invocation', sql: `CREATE INDEX IF NOT EXISTS opd_art_route_invocation_idx ON opd_audit_retrieval_telemetry (route, invocation_id, started_at DESC)` },
    { key: 'idx_experiment', sql: `CREATE INDEX IF NOT EXISTS opd_art_experiment_idx ON opd_audit_retrieval_telemetry (experiment_run_id, pair_id) WHERE experiment_run_id IS NOT NULL` },
    { key: 'idx_role_state', sql: `CREATE INDEX IF NOT EXISTS opd_art_role_state_idx ON opd_audit_retrieval_telemetry (retrieval_role, persistence_state, started_at DESC)` },
    { key: 'idx_nonterminal', sql: `CREATE INDEX IF NOT EXISTS opd_art_nonterminal_idx ON opd_audit_retrieval_telemetry (persistence_state, started_at) WHERE persistence_state IN (${q(NON_TERMINAL_PERSISTENCE_STATES)})` },
    // ── 5. Invocation accounting ────────────────────────────────────────────────────────────────
    {
      key: 'invocation_table',
      sql: `CREATE TABLE IF NOT EXISTS opd_retrieval_invocations (
  invocation_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  route TEXT NOT NULL,
  route_class TEXT NOT NULL,
  app_source TEXT NOT NULL DEFAULT 'standalone',
  deployment_sha TEXT NULL,
  vercel_request_id TEXT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NULL,
  closure_state TEXT NOT NULL DEFAULT 'closure_unknown',
  declared_retrievals INTEGER NOT NULL DEFAULT 0,
  telemetry_write_failures INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT opd_ri_kind_chk CHECK (kind IN (${q(INVOCATION_KINDS)})),
  CONSTRAINT opd_ri_closure_chk CHECK (closure_state IN (${q(INVOCATION_CLOSURE_STATES)}))
)`,
    },
    { key: 'idx_ri_open', sql: `CREATE INDEX IF NOT EXISTS opd_ri_open_idx ON opd_retrieval_invocations (started_at) WHERE closure_state = 'closure_unknown'` },
    { key: 'idx_ri_route_time', sql: `CREATE INDEX IF NOT EXISTS opd_ri_route_time_idx ON opd_retrieval_invocations (route, started_at DESC)` },
    { key: 'idx_ri_kind_time', sql: `CREATE INDEX IF NOT EXISTS opd_ri_kind_time_idx ON opd_retrieval_invocations (kind, started_at DESC)` },
    // ── 6. Per-run telemetry-write failure evidence ─────────────────────────────────────────────
    {
      key: 'failure_table',
      sql: `CREATE TABLE IF NOT EXISTS opd_retrieval_telemetry_failures (
  id BIGSERIAL PRIMARY KEY,
  invocation_id TEXT NOT NULL,
  retrieval_run_id UUID NULL,
  retrieval_role TEXT NULL,
  failed_phase TEXT NOT NULL,
  intended_state TEXT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  error_class TEXT NOT NULL,
  CONSTRAINT opd_rtf_phase_chk CHECK (failed_phase IN (${q(TELEMETRY_FAILURE_PHASES)})),
  CONSTRAINT opd_rtf_run_chk CHECK (
    (failed_phase IN (${q(RUN_SCOPED_FAILURE_PHASES)}) AND retrieval_run_id IS NOT NULL AND retrieval_role IS NOT NULL)
    OR failed_phase IN (${q(TELEMETRY_FAILURE_PHASES.filter((p) => !(RUN_SCOPED_FAILURE_PHASES as readonly string[]).includes(p)))})
  )
)`,
    },
    // ── 6a. THE FAILURE-TABLE CHECKS, RE-APPLIED (pass 0a, kickoff §2.1) ────────────────────────
    //
    // ⚠️ THE INLINE CONSTRAINTS ABOVE REACH A FRESH TABLE ONLY. `CREATE TABLE IF NOT EXISTS` is a
    // NO-OP when the table exists, so on any database that already has
    // `opd_retrieval_telemetry_failures` the OLD CHECKs survive — and the old phase list does not
    // contain `retrieval_terminal_rejected`. The durable evidence addendum v7 §8 exists to produce
    // would then be REJECTED BY THE CONSTRAINT, silently turning a new safety record into a write
    // error on exactly the path that is already failing.
    //
    // Production does not have this table. The measurement branch does, or will. That is enough.
    //
    // The drop-then-add form is the same idiom the `retrieval_checks` statement above uses, so the
    // widened form applies whether the table is new or existing. Idempotent: `DROP … IF EXISTS`
    // tolerates absence, and each ADD names a constraint the same statement has already freed.
    //
    // ⚠️ ONE ALTER, NOT FOUR (v9 §6.1). Unlike the retrieval table, this one DOES carry both CHECKs
    // inline in its CREATE TABLE, so a failure between a drop and an add could not leave a FRESH
    // table unconstrained. The reason to collapse it is the same either way: one lock, one
    // validation pass over existing rows, and no window in which an EXISTING table has lost a
    // constraint that nothing later restores. Drops still run before adds — by ALTER TABLE's pass
    // ordering, not by their left-to-right position.
    {
      key: 'failure_checks',
      sql: `ALTER TABLE opd_retrieval_telemetry_failures
  DROP CONSTRAINT IF EXISTS opd_rtf_phase_chk,
  DROP CONSTRAINT IF EXISTS opd_rtf_run_chk,
  ADD CONSTRAINT opd_rtf_phase_chk CHECK (failed_phase IN (${q(TELEMETRY_FAILURE_PHASES)})),
  ADD CONSTRAINT opd_rtf_run_chk CHECK (
    (failed_phase IN (${q(RUN_SCOPED_FAILURE_PHASES)}) AND retrieval_run_id IS NOT NULL AND retrieval_role IS NOT NULL)
    OR failed_phase IN (${q(TELEMETRY_FAILURE_PHASES.filter((p) => !(RUN_SCOPED_FAILURE_PHASES as readonly string[]).includes(p)))})
  )`,
    },
    { key: 'idx_rtf_run', sql: `CREATE INDEX IF NOT EXISTS opd_rtf_run_idx ON opd_retrieval_telemetry_failures (retrieval_run_id, failed_phase, observed_at DESC) WHERE retrieval_run_id IS NOT NULL` },
    { key: 'idx_rtf_invocation', sql: `CREATE INDEX IF NOT EXISTS opd_rtf_invocation_idx ON opd_retrieval_telemetry_failures (invocation_id, observed_at DESC)` },
    { key: 'idx_rtf_phase_time', sql: `CREATE INDEX IF NOT EXISTS opd_rtf_phase_time_idx ON opd_retrieval_telemetry_failures (failed_phase, observed_at DESC)` },
    // ── 7. Table comments. THE TEXT DIFFERS PER TABLE, because the tables differ (D2) ────────────
    {
      key: 'comment_retrieval',
      sql: `COMMENT ON TABLE opd_audit_retrieval_telemetry IS 'Stage 0a rerank telemetry, one row per retrieval execution. Observation only: no ranking decision reads this table. uid is a re-identification key and carries controls no weaker than opd_note_audits (admin-gated reads only). No clinical text: identifiers, enums, counts, timings and keyed HMACs only. Retention 90 days from started_at; the purge is operator-scheduled and is NOT implemented here.'`,
    },
    {
      key: 'comment_invocations',
      sql: `COMMENT ON TABLE opd_retrieval_invocations IS 'Stage 0a invocation accounting, one row per serverless invocation that declared retrieval work, plus reconciler runs. Observation only. No clinical text and NO PATIENT IDENTIFIER — it joins to the uid-bearing table and inherits its handling. Admin access only. Retention 90 days from started_at; the purge is operator-scheduled and is NOT implemented here.'`,
    },
    {
      key: 'comment_failures',
      sql: `COMMENT ON TABLE opd_retrieval_telemetry_failures IS 'Stage 0a telemetry-write failure evidence, one row per failed write. Observation only. No clinical text and NO PATIENT IDENTIFIER. error_class is a class name and is never a message or a value. Admin access only. Retention 90 days from observed_at — this table has no started_at — and the purge is operator-scheduled and is NOT implemented here.'`,
    },
  ];
}

/**
 * The CONDITIONAL step (D2). Applied only when the table is empty, because an existing row's role
 * cannot be reconstructed and a failed `SET NOT NULL` would abort the migration over history rather
 * than over anything this build wrote. Run as an explicit route step, not a `DO` block, so the
 * decision is visible in the `steps` response instead of buried in a server-side branch.
 */
export const RETRIEVAL_ROLE_NOT_NULL_SQL =
  'ALTER TABLE opd_audit_retrieval_telemetry ALTER COLUMN retrieval_role SET NOT NULL';

/** The three tables this build owns. Used by the non-exposure scan (D3) and by the stop rule. */
export const TELEMETRY_TABLES = [
  'opd_audit_retrieval_telemetry', 'opd_retrieval_invocations', 'opd_retrieval_telemetry_failures',
] as const;
