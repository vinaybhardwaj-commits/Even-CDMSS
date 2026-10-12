-- migrations/lab-v2/0003_paired_audit.sql
-- Paired signed-vs-override OPD audits. LAB_V2_DATABASE_URL only.
--
-- Applied by /api/admin/lab-v2/migrate, which reads every migrations/lab-v2/*.sql in
-- name order. Nothing here is created in the production database, and nothing here is
-- read by doctors.evenos.app.
--
-- override_text is the alternate prescription. It lives in this store and nowhere else.
-- clinician_uid is constrained so an override arm cannot be stamped with the
-- signing doctor's uid.

CREATE TABLE IF NOT EXISTS lab_v2.paired_audit_runs (
  id                    uuid PRIMARY KEY,
  owner                 text NOT NULL,
  experiment_label      text NOT NULL,
  idempotency_key       text NOT NULL,
  engine_version        text NOT NULL,
  prompt_hash           text NOT NULL,
  model                 text NOT NULL,
  provider              text NOT NULL,
  status                text NOT NULL,
  stop_reason           text,
  max_llm_calls         integer NOT NULL,
  max_spend_microusd    bigint,
  calls_used            integer NOT NULL DEFAULT 0,
  spend_microusd        bigint NOT NULL DEFAULT 0,
  unpriced              boolean NOT NULL DEFAULT false,
  signed_repeats        integer NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  finished_at           timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS paired_audit_runs_owner_idem
  ON lab_v2.paired_audit_runs (owner, idempotency_key);

CREATE TABLE IF NOT EXISTS lab_v2.paired_audit_results (
  id                 uuid PRIMARY KEY,
  uid                text NOT NULL,
  arm                text NOT NULL,
  engine_version     text NOT NULL,
  prompt_hash        text NOT NULL,
  repeat_idx         integer NOT NULL,
  clinician_uid      text,
  result             jsonb NOT NULL,
  calls              integer NOT NULL DEFAULT 0,
  spend_microusd     bigint NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  -- The override arm is never attributed to the signing doctor.
  CONSTRAINT paired_audit_results_author_ck
    CHECK (arm = 'signed' OR clinician_uid IS NULL)
);

-- One billed result per (uid, arm, engine, prompt, repeat). A later run reuses the row.
CREATE UNIQUE INDEX IF NOT EXISTS paired_audit_results_dedupe
  ON lab_v2.paired_audit_results (uid, arm, engine_version, prompt_hash, repeat_idx);

CREATE TABLE IF NOT EXISTS lab_v2.paired_audit_items (
  id              uuid PRIMARY KEY,
  run_id          uuid NOT NULL REFERENCES lab_v2.paired_audit_runs(id),
  uid             text NOT NULL,
  external_ref    text NOT NULL,
  arm             text NOT NULL,
  repeat_idx      integer NOT NULL,
  status          text NOT NULL,
  skip_reason     text,
  -- Set when a tick claims the row. A tick that dies mid-item leaves status 'running';
  -- the next tick requeues a claim older than 20 minutes. A live tick finishes well
  -- inside that window, so two overlapping crons do not both bill the same item.
  claimed_at      timestamptz,
  -- Alternate prescription. NULL on the signed arm. Never selected by the results tool.
  override_text   text,
  result_id       uuid REFERENCES lab_v2.paired_audit_results(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  CONSTRAINT paired_audit_items_override_ck
    CHECK (arm <> 'signed' OR override_text IS NULL)
);

CREATE INDEX IF NOT EXISTS paired_audit_items_run_idx
  ON lab_v2.paired_audit_items (run_id, status, uid);
