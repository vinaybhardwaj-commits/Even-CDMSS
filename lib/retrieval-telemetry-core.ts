/**
 * lib/retrieval-telemetry-core.ts — the PURE core of Stage 0a rerank telemetry.
 * CDMSS-RERANK-TELEMETRY-CC-KICKOFF-11-AUG-2026 §4.2, §4.3, §4.6.
 *
 * OBSERVATION ONLY. Nothing here decides a ranking, chooses a provider, sizes a batch or reaches a
 * prompt. No fs, no net, no clock, no process.env — `node:crypto` is computation, and the HMAC key
 * is passed IN so this module can be unit-tested without a secret and can never leak one.
 *
 * ⚠️ NO CLINICAL TEXT EVER REACHES A FIELD DEFINED HERE. Every identifier-shaped value is a keyed
 * HMAC and every measurement is a count, an enum or a timing. §6.4 asserts it on fixtures; the
 * types are written so the honest version is also the easy one — there is no `text` field to fill.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 1. VERSIONS — independent of the application deployment (§4.3)
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The row contract (the columns in migrations/0035). Bumped when a COLUMN changes.
 * Separate from the manifest version on purpose: the JSONB payload evolves far faster than the
 * scalar columns, and a canary window must be able to say "one schema version" about each.
 */
export const TELEMETRY_SCHEMA_VERSION = 1;

/** The JSONB manifest contract. Bumped when a manifest FIELD changes. */
export const MANIFEST_SCHEMA_VERSION = 1;

/**
 * The HMAC key generation. §4.3 requires a versioned key identifier: a rotated key produces
 * different digests for identical input, and without this a window would silently compare
 * pre-rotation and post-rotation HMACs as if they disagreed.
 */
export const HMAC_KEY_VERSION = 'k1';

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 2. PERSISTENCE STATES (§4.2) — one vocabulary, pinned to the CHECK constraint
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * ⚠️ THIS LIST AND THE CHECK CONSTRAINT IN migrations/0035 ARE ONE FACT IN TWO PLACES, and a unit
 * test pins them byte-for-byte. §4.2 asks for a database constraint OR an equivalently centralized
 * runtime definition; this build ships both, because the failure they guard is different at each
 * end — the constraint stops a bad write, the union type stops a bad read.
 */
export const RETRIEVAL_PERSISTENCE_STATES = [
  /** Written BEFORE any provider work (§4.5 step 1). A killed invocation stays visible as this. */
  'started',
  /** Retrieval finished; no audit row resulted (a throw downstream, or nothing to persist). */
  'completed_unpersisted',
  /** The audit persisted and this run is its retrieval. */
  'persisted_complete',
  /** The audit persisted but the manifest is incomplete — recorded, never silently upgraded. */
  'persisted_partial',
  /** Telemetry's own write failed. Fail-visibly (constraint 8): the gap is stated, not hidden. */
  'telemetry_persistence_failed',
  /** The audit write failed or lost its ON CONFLICT race. The telemetry SURVIVES (§4.5 step 5). */
  'audit_persistence_failed',
  /** Reconciled from a stale `started` after max invocation duration + grace (§4.5 step 6). */
  'aborted',
  /** Retrieval did not run for this note (no orders, no candidates) — counted, not missing. */
  'not_eligible',
] as const;

export type RetrievalPersistenceState = typeof RETRIEVAL_PERSISTENCE_STATES[number];

/** Terminal for canary purposes: a window closes only when every run reaches one of these. */
export const TERMINAL_PERSISTENCE_STATES: readonly RetrievalPersistenceState[] = [
  'completed_unpersisted', 'persisted_complete', 'persisted_partial',
  'telemetry_persistence_failed', 'audit_persistence_failed', 'aborted', 'not_eligible',
] as const;

export function isTerminalState(s: string): boolean {
  return (TERMINAL_PERSISTENCE_STATES as readonly string[]).includes(s);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 3. ROUTE TAXONOMY (§5 step 1)
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Every entrypoint that can execute an OPD retrieval. The class is what §8's overlap analysis
 * groups by; the route is the specific caller, kept so "which backfill" stays answerable.
 *
 * `unknown_route` exists because §4.4's rule against guessing applies here too: a retrieval reached
 * from a caller this list does not name is recorded as unknown, never assigned to the nearest match.
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

export type RouteClass = 'worker' | 'backfill' | 'lab' | 'manual' | 'unknown';

const ROUTE_CLASS: Readonly<Record<RetrievalRoute, RouteClass>> = {
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
};

export function routeClassOf(route: string): RouteClass {
  return ROUTE_CLASS[route as RetrievalRoute] ?? 'unknown';
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 4. KEYED HMAC (§4.3) — plain hashes of patient-derived text are not acceptable
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * HMAC-SHA-256 over UTF-8, prefixed with its key version so a rotation is visible in the value
 * itself rather than inferred from a timestamp. Returns `<keyVersion>:<hex>`.
 *
 * ⚠️ WHY NOT sha256. A retrieval query and a passage are patient-derived. An unkeyed digest of a
 * short clinical string is reversible by dictionary attack — the digest IS the text, for anyone
 * willing to enumerate. The key is the whole protection, so it is required, non-empty, and never
 * defaulted: a missing key throws rather than silently degrading to something weaker.
 */
export function telemetryHmac(secret: string, value: string, keyVersion = HMAC_KEY_VERSION): string {
  if (typeof secret !== 'string' || secret.length === 0) {
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
// 5. MANIFEST (§4.3)
// ════════════════════════════════════════════════════════════════════════════════════════════════

export type ExpansionStatus = 'expanded' | 'skipped' | 'failed_open';

/**
 * The terminal outcome of one rerank batch. §6.2 requires these to be DISTINCT: a parse failure and
 * a missing score key are different defects with different fixes, and collapsing them is how a
 * scoring gap becomes invisible.
 */
export type BatchOutcome =
  | 'success'
  | 'terminal_failure'
  | 'parse_failure'
  | 'missing_score_key'
  | 'nonnumeric_score';

/** Where a batch was actually served. `unattributed` is a recorded state, never a guess (§4.4). */
export type ServedRouteClass = 'vertex' | 'openrouter' | 'local' | 'unattributed';

export interface ManifestBatch {
  /** STABLE index derived from candidate boundaries, never promise completion order (constraint 7). */
  batch_index: number;
  candidate_start: number;
  candidate_end: number;
  intended_provider: string;
  intended_model: string;
  /** What actually served it. Null model with `unattributed` is the honest unavailable case. */
  served_route_class: ServedRouteClass;
  served_model: string | null;
  /** Ordered attempt outcomes, from the transport's own evidence — never reconstructed. */
  attempts: Array<{ attempt: number; outcome: string; status: number | null }>;
  outcome: BatchOutcome;
  expected_score_keys: number;
  /** Keys that arrived AND parsed as a finite number. A legitimate 0 counts here (§6.2). */
  finite_score_keys: number;
  /** Null, not zero, when the provider returned no usage (§4.6). */
  prompt_tokens: number | null;
  completion_tokens: number | null;
}

export interface RetrievalManifest {
  manifest_schema_version: number;
  hmac_key_version: string;
  expansion: { status: ExpansionStatus; input_hmac: string | null };
  /** Ordered pre-rerank candidates. Ids and HMACs only — never passage text. */
  pre_rerank_candidate_ids: number[];
  pre_rerank_passage_hmacs: string[];
  candidate_pool_size: number;
  expected_batch_count: number;
  intended_backend: string;
  intended_model: string;
  ordered_final_candidate_ids: number[];
  /** HMAC of the EXACT rendered scorer context — the byte-identity anchor for §6.1. */
  scorer_context_hmac: string | null;
  retrieval_config: Record<string, string | number | boolean>;
  corpus_version: string | null;
  batches: ManifestBatch[];
  operational: {
    route: RetrievalRoute;
    route_class: RouteClass;
    invocation_id: string | null;
    deployment_sha: string | null;
    started_at: string;
    completed_at: string | null;
    active_backfill_run_id: string | null;
    active_lab_experiment_id: string | null;
    routing_flags: Record<string, string>;
  };
}

/** Structural validation. Returns violation CODES only — never a value, never a fragment. */
export function validateManifest(m: RetrievalManifest): string[] {
  const v: string[] = [];
  if (m?.manifest_schema_version !== MANIFEST_SCHEMA_VERSION) v.push('manifest_version_unrecognized');
  if (!m?.hmac_key_version) v.push('hmac_key_version_absent');
  if (!Array.isArray(m?.batches)) { v.push('batches_absent'); return v; }
  if (m.batches.length !== m.expected_batch_count) v.push('batch_count_mismatch');
  const seen = new Set<number>();
  for (const b of m.batches) {
    if (seen.has(b.batch_index)) v.push('duplicate_batch_index');
    seen.add(b.batch_index);
    if (b.candidate_end <= b.candidate_start) v.push('bad_candidate_boundaries');
    if (b.served_route_class === 'unattributed' && b.served_model !== null) v.push('unattributed_with_model');
    if (b.finite_score_keys > b.expected_score_keys) v.push('score_keys_exceed_expected');
  }
  // Batches must be orderable by their boundaries independently of completion order (constraint 7).
  const byIndex = [...m.batches].sort((a, b) => a.batch_index - b.batch_index);
  for (let i = 1; i < byIndex.length; i++) {
    if (byIndex[i].candidate_start < byIndex[i - 1].candidate_end) v.push('overlapping_batches');
  }
  return v;
}

/** The counters the row carries, derived from the manifest so the two can never disagree. */
export function batchCounters(m: RetrievalManifest): {
  vertex: number; openrouter: number; local: number; failed: number; unattributed: number; retries_429: number;
} {
  const c = { vertex: 0, openrouter: 0, local: 0, failed: 0, unattributed: 0, retries_429: 0 };
  for (const b of m?.batches ?? []) {
    if (b.served_route_class === 'vertex') c.vertex += 1;
    else if (b.served_route_class === 'openrouter') c.openrouter += 1;
    else if (b.served_route_class === 'local') c.local += 1;
    else c.unattributed += 1;
    if (b.outcome !== 'success') c.failed += 1;
    c.retries_429 += (b.attempts ?? []).filter((a) => a.outcome === 'http_429').length;
  }
  return c;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 6. COST (§4.6) — unknown usage stays unknown
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
export function aggregateRerankUsage(manifests: RetrievalManifest[]): RerankUsageBucket[] {
  const buckets = new Map<string, RerankUsageBucket>();
  for (const m of manifests ?? []) {
    for (const b of m?.batches ?? []) {
      const provider = b.served_route_class;
      const model = b.served_model ?? 'unattributed';
      const key = `${provider} ${model}`;
      let e = buckets.get(key);
      if (!e) {
        e = { provider, model, batches: 0, attempts: 0, prompt_tokens: null, completion_tokens: null, batches_with_unknown_usage: 0 };
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
