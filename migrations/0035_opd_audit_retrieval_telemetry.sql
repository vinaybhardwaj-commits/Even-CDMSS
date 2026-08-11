-- 0035_opd_audit_retrieval_telemetry.sql — CDMSS-RERANK-TELEMETRY-CC-KICKOFF-11-AUG-2026 §4.2.
--
-- Stage 0a. OBSERVATION ONLY: this table records what retrieval did. Nothing reads it to make a
-- ranking decision, and no production reader selects from it (§6.4 asserts that).
--
-- IDEMPOTENT. Every statement is IF NOT EXISTS / guarded, so re-running changes nothing.
--
-- ⚠️ INFERRED SQL. Written without a live DB. Validate against the live schema before running.
-- The one hard dependency is `opd_note_audits(id)`, verified present as a UUID PRIMARY KEY at
-- migrations/0007_opd_note_audits.sql:12, so the FK below is valid as written.
--
-- ── WHY A DEDICATED TABLE AND NOT trace_events ─────────────────────────────────────────────────
-- The rerank judge is TRACELESS by requirement (kickoff constraint 2: passing a parent trace id
-- into governedChat changes transport behaviour). It therefore writes no trace and no trace_event,
-- which is exactly why the 11 Aug throttle-rate census could count 21 local substitutions and not
-- say which caller owned them, and why the cost tracker — which joins trace_events to traces —
-- shows zero rupees for every rerank call ever made.
--
-- ── RETENTION, ACCESS AND DELETION (§4.2, required) ────────────────────────────────────────────
-- `uid` is a re-identification key. It is the SAME key as opd_note_audits.uid and it receives the
-- SAME controls, no weaker:
--   · ACCESS.    Admin-gated surfaces only. No clinician-facing route and no patient-facing route
--                may select from this table. It is operational telemetry, not a clinical record.
--   · RETENTION. 90 days from started_at. This table exists to measure nightly windows and
--                reconcile them; a run older than a quarter answers no live question. The purge is
--                NOT automated by this migration — automating a delete against a table that may
--                hold the only evidence of an unreconciled incident is a decision, not a default.
--                Owner sets the schedule; the index on started_at makes the delete cheap.
--   · DELETION.  A patient erasure that removes an opd_note_audits row must remove the rows here
--                that carry the same uid. The FK is ON DELETE SET NULL (below) so a deleted audit
--                does not silently drop its telemetry, which would destroy the reconciliation
--                record; the uid column is what the erasure must target, deliberately and by name.
--   · NO CLINICAL TEXT. §4.3/§6.4: identifiers, enums, counts, timings and keyed HMACs only. No
--                query, passage, prompt or rendered scorer context is ever stored here.

CREATE TABLE IF NOT EXISTS opd_audit_retrieval_telemetry (
  -- §4.1: one id per retrieval EXECUTION. Not an audit id, and never derived from
  -- (uid, engine_version) — two concurrent executions for the same note must stay two rows.
  retrieval_run_id             UUID PRIMARY KEY,

  -- Linked only AFTER the audit persistence result is known (§4.5 step 4). NULL is a real,
  -- expected state: a losing ON CONFLICT race, a failed save, or a retrieval that never produced
  -- an audit row at all. ON DELETE SET NULL so erasing an audit never erases the evidence that a
  -- retrieval happened — §4.2 forbids creating synthetic audit rows to populate this column, and
  -- the mirror of that rule is that losing the audit must not silently delete the telemetry.
  audit_id                     UUID NULL REFERENCES opd_note_audits(id) ON DELETE SET NULL,

  trace_id                     TEXT NULL,
  uid                          TEXT NULL,
  engine_version               TEXT NULL,

  -- Route taxonomy (§5 step 1): which entrypoint executed this retrieval.
  route                        TEXT NOT NULL,
  -- The serverless invocation, so worker/backfill/lab overlap is analysable (§8).
  invocation_id                TEXT NULL,
  app_source                   TEXT NOT NULL,
  -- The addendum's point: a clean local tree proves nothing about what Vercel serves. Every row
  -- carries the SHA that produced it, so a canary window can prove it ran on one deployment.
  deployment_sha               TEXT NULL,
  telemetry_schema_version     INTEGER NOT NULL,

  -- A/A and experiment linkage (§4.1: deliberate replicates must stay distinguishable).
  experiment_run_id            TEXT NULL,
  pair_id                      TEXT NULL,
  replicate                    TEXT NULL,

  -- §4.2: the state vocabulary is a DATABASE CONSTRAINT, so an unknown state cannot be written by
  -- a caller that skipped the runtime definition. Kept in lockstep with RETRIEVAL_PERSISTENCE_STATES
  -- in lib/retrieval-telemetry-core.ts, which a unit test pins against this list byte-for-byte.
  persistence_state            TEXT NOT NULL,

  started_at                   TIMESTAMPTZ NOT NULL,
  completed_at                 TIMESTAMPTZ NULL,

  expansion_status             TEXT NULL,
  expansion_route_class        TEXT NULL,
  rerank_route_class           TEXT NULL,

  -- The reconciliation pair the canary gate turns on (§7): expected must equal recorded.
  expected_rerank_batches      INTEGER NULL,
  recorded_rerank_batches      INTEGER NULL,

  -- Counters, by served route. `unattributed` is its own column and NOT folded into any other —
  -- §7 requires an unattributed batch and a MISSING batch to be reported separately.
  rerank_vertex_batches        INTEGER NOT NULL DEFAULT 0,
  rerank_openrouter_batches    INTEGER NOT NULL DEFAULT 0,
  rerank_local_batches         INTEGER NOT NULL DEFAULT 0,
  rerank_failed_batches        INTEGER NOT NULL DEFAULT 0,
  rerank_unattributed_batches  INTEGER NOT NULL DEFAULT 0,
  rerank_429_attempts          INTEGER NOT NULL DEFAULT 0,

  -- Keyed HMAC of the EXACT rendered scorer context (§4.3). Keyed, not a plain hash: a plain hash
  -- of patient-derived text is reversible by dictionary attack and §4.3 rejects it.
  context_hmac                 TEXT NULL,

  retrieval_manifest           JSONB NULL,
  -- Fail-visibly (§ constraint 8): when telemetry itself failed, the reason is recorded rather
  -- than the row being dropped. A dropped row is indistinguishable from a retrieval that never ran.
  telemetry_error              TEXT NULL,

  CONSTRAINT opd_audit_retrieval_telemetry_persistence_state_chk CHECK (persistence_state IN (
    'started',
    'completed_unpersisted',
    'persisted_complete',
    'persisted_partial',
    'telemetry_persistence_failed',
    'audit_persistence_failed',
    'aborted',
    'not_eligible'
  ))
);

-- ── Indexes (§4.2: nightly reconciliation, audit linkage, route/invocation overlap, experiment
-- linkage, persistence state) ───────────────────────────────────────────────────────────────────

-- Nightly window scans and the stale-start reconciler both range over started_at.
CREATE INDEX IF NOT EXISTS opd_art_started_at_idx
  ON opd_audit_retrieval_telemetry (started_at DESC);

-- The stale-start reconciler's hot path: `started` rows older than max duration + grace.
CREATE INDEX IF NOT EXISTS opd_art_state_started_at_idx
  ON opd_audit_retrieval_telemetry (persistence_state, started_at DESC);

-- Audit linkage, and the "which audits have no telemetry" half of the canary gate.
CREATE INDEX IF NOT EXISTS opd_art_audit_id_idx
  ON opd_audit_retrieval_telemetry (audit_id) WHERE audit_id IS NOT NULL;

-- Concurrency: two executions for the same note must be visible AS two.
CREATE INDEX IF NOT EXISTS opd_art_uid_engine_idx
  ON opd_audit_retrieval_telemetry (uid, engine_version, started_at DESC);

-- Route/invocation overlap analysis (§8: worker vs active backfill vs hosted lab).
CREATE INDEX IF NOT EXISTS opd_art_route_invocation_idx
  ON opd_audit_retrieval_telemetry (route, invocation_id, started_at DESC);

-- Experiment linkage for A/A replicates.
CREATE INDEX IF NOT EXISTS opd_art_experiment_idx
  ON opd_audit_retrieval_telemetry (experiment_run_id, pair_id)
  WHERE experiment_run_id IS NOT NULL;

COMMENT ON TABLE opd_audit_retrieval_telemetry IS
  'Stage 0a rerank telemetry. Observation only — no ranking decision reads this table. Contains a '
  're-identification key (uid) and is admin-access only. Retention 90 days from started_at; purge '
  'is operator-scheduled, not automatic. See CDMSS-RERANK-TELEMETRY-CC-KICKOFF-11-AUG-2026 §4.2.';
