-- 0051_ipd_episode_audits — the IPD EPISODE audit's three tables (engine `ipd-episode-audit/0.1`,
-- PRD §7). ADDITIVE IN FULL: no existing table is altered and nothing here touches
-- ipd_discharge_audits, which this engine only ever READS (its score is shown beside this one,
-- labelled as the discharge engine's, per decision 14).
--
-- WHY NEW TABLES RATHER THAN COLUMNS ON ipd_discharge_audits (decision 9): the two engines answer
-- different questions on different keys. The discharge engine grades one document keyed on
-- document_id; this one grades a whole admission keyed on encounter_id, and carries a per-day
-- checkpoint child table the other has no use for.
--
-- PHI POSTURE — OMISSION, NOT HASHING (decision 23). These tables carry encounter_id, ip_uid and
-- member_id as re-identification keys and nothing else that could name a person. There is no
-- uhid column, no patient name, no age, no gender, no birth date, no mobile and no address, and
-- there is no hash of any of them: the repo has never hashed an identifier and a hash of a small
-- identifier space is not de-identification. Names are joined at RENDER time from db13 by the
-- existing namesForIpUids path and are never written here.

CREATE TABLE IF NOT EXISTS ipd_episode_audits (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audited_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  app_source            TEXT,

  engine_version        TEXT NOT NULL,

  -- link-back keys (re-identification path into db13; never sent to a model)
  encounter_id          TEXT NOT NULL,
  ip_uid                TEXT NOT NULL,
  member_id             TEXT,

  facility_name         TEXT,
  speciality            TEXT,
  admitted_at           TIMESTAMPTZ,
  discharged_at         TIMESTAMPTZ,
  los_days              INTEGER,
  discharge_type        TEXT,
  extraction_version    TEXT,

  -- headline
  divergence_index      INTEGER,
  completeness_pct      INTEGER,

  -- counters (§6.1) — one column per counter
  n_findings            INTEGER,
  n_divergence_pass     INTEGER,
  n_fidelity_pass       INTEGER,
  n_omission            INTEGER,
  n_commission          INTEGER,
  n_timing              INTEGER,
  n_sequencing          INTEGER,
  n_divergent           INTEGER,
  n_context_dependent   INTEGER,
  n_unassessable        INTEGER,
  n_concordant          INTEGER,
  n_low_value           INTEGER,
  n_dropped_invalid     INTEGER,

  checkpoint_count      INTEGER,
  evidence_tiers        JSONB,
  real_course           JSONB,
  findings              JSONB,
  commentary            JSONB,

  model_checkpoint      TEXT,
  model_judge           TEXT,
  trace_id              TEXT,
  de_identified         BOOLEAN DEFAULT TRUE
);

-- Idempotency: a re-run at the same engine version refreshes the row in place; a future engine
-- version audits the same admission again beside it rather than over it.
CREATE UNIQUE INDEX IF NOT EXISTS ipd_episode_audits_encounter_engine_uq
  ON ipd_episode_audits (encounter_id, engine_version);
CREATE INDEX IF NOT EXISTS ipd_episode_audits_discharged_idx ON ipd_episode_audits (discharged_at DESC);
CREATE INDEX IF NOT EXISTS ipd_episode_audits_speciality_idx ON ipd_episode_audits (speciality);
CREATE INDEX IF NOT EXISTS ipd_episode_audits_ip_uid_idx     ON ipd_episode_audits (ip_uid);

-- One row per checkpoint. `input_cutoff_at` and `input_event_count` are THE BLINDING PROOF: the
-- orchestrator recomputes both from the stored real_course and demands they agree with the day
-- boundary and the count of events before it (§14 step 8).
CREATE TABLE IF NOT EXISTS ipd_episode_checkpoints (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_audit_id   UUID REFERENCES ipd_episode_audits(id) ON DELETE CASCADE,
  day_index          INTEGER NOT NULL,
  checkpoint_type    TEXT NOT NULL,
  generated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  input_cutoff_at    TIMESTAMPTZ NOT NULL,
  input_event_count  INTEGER,
  retrieval_query    TEXT,
  retrieval_failed   BOOLEAN DEFAULT FALSE,
  citation_ids       INTEGER[],
  expected_course    JSONB,
  status             TEXT,
  error_detail       TEXT,
  model              TEXT,
  trace_id           TEXT
);

CREATE INDEX IF NOT EXISTS ipd_episode_checkpoints_audit_idx ON ipd_episode_checkpoints (episode_audit_id);

-- Skips are a RECORD, not an absence: "we looked and this episode does not qualify" is a finding.
-- Retried each tick until 14 days after discharge, then left alone (§3.1).
CREATE TABLE IF NOT EXISTS ipd_episode_skips (
  encounter_id    TEXT NOT NULL,
  engine_version  TEXT NOT NULL,
  reason          TEXT NOT NULL,
  first_seen      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempts        INTEGER NOT NULL DEFAULT 1,
  discharged_at   TIMESTAMPTZ,
  PRIMARY KEY (encounter_id, engine_version)
);

CREATE INDEX IF NOT EXISTS ipd_episode_skips_discharged_idx ON ipd_episode_skips (discharged_at DESC);
