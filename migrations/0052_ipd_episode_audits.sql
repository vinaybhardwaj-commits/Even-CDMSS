-- 0052_ipd_episode_audits — the IPD EPISODE audit's three tables (engine `ipd-episode-audit/0.1`,
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
  app_source            TEXT NOT NULL DEFAULT 'standalone',

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
  --
  -- DEFAULT 0 ON EVERY COUNTED COLUMN, and the reason is that NULL and 0 are different claims.
  -- "no divergent findings" is a result; "we do not know how many divergent findings there were"
  -- is an absence. A nullable counter makes SUM() and AVG() silently skip rows, so a cohort with
  -- one unwritten column reports a mean over a denominator nobody chose. The writer also coalesces
  -- (lib/ipd-episode/store.ts) — the default is the backstop for a future column added to the DDL
  -- and not yet to the INSERT, which is exactly how a null gets in.
  divergence_index      INTEGER DEFAULT 0,
  completeness_pct      INTEGER DEFAULT 0,

  -- counters (§6.1) — one column per counter
  n_findings            INTEGER DEFAULT 0,
  n_divergence_pass     INTEGER DEFAULT 0,
  n_fidelity_pass       INTEGER DEFAULT 0,
  n_omission            INTEGER DEFAULT 0,
  n_commission          INTEGER DEFAULT 0,
  n_timing              INTEGER DEFAULT 0,
  n_sequencing          INTEGER DEFAULT 0,
  n_divergent           INTEGER DEFAULT 0,
  n_context_dependent   INTEGER DEFAULT 0,
  n_unassessable        INTEGER DEFAULT 0,
  n_concordant          INTEGER DEFAULT 0,
  n_low_value           INTEGER DEFAULT 0,
  -- EVERY discarded finding: A2 domain drops plus parse failures. n_parse_failed breaks out the
  -- second cause. Both exist because an episode once lost 5 of 15 divergence findings with every
  -- counter reading 0 — a discard that leaves no number anywhere is indistinguishable from a clean
  -- run, and it was only found by reading a trace.
  n_dropped_invalid     INTEGER DEFAULT 0,
  n_parse_failed        INTEGER DEFAULT 0,

  checkpoint_count      INTEGER DEFAULT 0,
  evidence_tiers        JSONB,
  real_course           JSONB,
  findings              JSONB,
  commentary            JSONB,

  model_checkpoint      TEXT,
  model_judge           TEXT,
  trace_id              TEXT,
  de_identified         BOOLEAN DEFAULT TRUE,

  -- Whatever went wrong on an episode that still produced a row, in prose: findings repaired,
  -- findings discarded, a rejected commentary, an entirely uncited expected course.
  error_detail          TEXT,

  -- The evidence behind error_detail: one entry per DISCARDED finding, carrying the raw fragment
  -- (truncated to 1000 chars) and the validation error that killed it, tagged with its pass. The
  -- counter says how many were lost; this says what they were.
  raw_judge_error       JSONB
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
  -- INTEGER[], matching PRD §7.2 and the type of mksap_chunks.id, which is what these ARE
  -- (lib/ipd-episode/checkpoint-core.ts resolves the model's ordinals to real chunk ids before
  -- anything is stored). The store's INSERT casts $8::int[] and a contract test pins the two
  -- together: a mismatch here would be rejected by Postgres inside a catch, and every checkpoint
  -- row — which is where input_cutoff_at and input_event_count live, the blinding proof — would
  -- vanish without a sound.
  citation_ids       INTEGER[],
  expected_course    JSONB,
  status             TEXT,
  error_detail       TEXT,
  model              TEXT,
  trace_id           TEXT,

  -- Grounding, as SCALARS. An expected course whose every entry cites nothing is a failed
  -- checkpoint that looks successful — it has a status of 'ok', a real retrieval_query and eight
  -- real citation_ids on the row itself. These two columns make "how many entries did this
  -- checkpoint actually ground?" answerable across the cohort in one query, with no jsonb parsing.
  uncited_entry_count INTEGER DEFAULT 0,
  entry_count         INTEGER DEFAULT 0
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
