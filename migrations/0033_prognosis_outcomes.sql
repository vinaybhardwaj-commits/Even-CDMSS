-- 0033_prognosis_outcomes.sql — 4 Aug 2026
-- PX PHASE 2 (outcome linkage) PRD §5.1 — decisions P-1, P-2, P-5, P-7, P-10.
--
-- WHY. 423 prognosis blocks are stored in ipd_discharge_audits and nothing has ever checked them
-- against what actually happened to the patient. This table records real outcomes against those
-- predictions, so the three headline metrics (true positives, unpredicted outcomes, over-warning
-- rate) become computable at all.
--
-- P-1 POLYMORPHIC SOURCE. source_table + source_id serves both the nightly IPD corpus
-- (ipd_discharge_audits, keyed by document_id) and manual case audits (appropriateness_runs) from
-- one table. The parent PRD keyed outcomes to appropriateness_runs.id alone; that was correct in
-- July and is wrong now — the 423 blocks live in ipd_discharge_audits.
--
-- P-2 THE STABLE BINDING. matched_complication_hash = sha256 of the normalized complication name
-- (trim, lower-case, collapse whitespace), hex, first 16 chars — computed in
-- lib/prognosis-outcomes-core.ts. The integer matched_complication is ADVISORY, for debugging
-- only: the ipd_discharge_audits upsert (ON CONFLICT ... DO UPDATE SET report = EXCLUDED.report)
-- rewrites the complications array in place on re-audit, so a stored index silently re-points, and
-- an engine bump writes a NEW row that orphans the link. Every read path resolves by hash; a hash
-- matching nothing renders `unresolved`, never re-pointed by index.
--
-- P-5 FOUR CLASSIFICATIONS. predicted_occurred | unpredicted_occurred | benefit_failure |
-- no_adverse_outcome. The fourth is what makes over-warning computable: without it an absent row
-- is ambiguous between "nothing happened" and "nobody looked" (null means unknown, not zero — the
-- investigations-lookup rule). A no_adverse_outcome row carries matched_complication_hash = NULL.
--
-- P-7 APPEND-ONLY WITH SUPERSEDE. A correction INSERTs a new row with supersedes_id and flips
-- superseded = TRUE on the old row in one atomic statement (lib/prognosis-outcomes-store.ts).
-- No UPDATE of content, no DELETE. The partial index serves the common read: current rows only.
--
-- P-8 (deliberate, ruled by V 4 Aug): this table is NOT added to BLOCKED_RELATIONS — it stays
-- readable by the Lab MCP. observed_outcome and notes are human free text with only a UI warning
-- (P-6) between the typist and PHI. The revisit trigger is the first name/MRN/phone found in
-- either column; see the PRD §0 "recorded risk on P-8".
--
-- ADDITIVE, IDEMPOTENT. CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS — running this
-- twice is a no-op (PRD §6). No backfill: history starts when the loop starts.

CREATE TABLE IF NOT EXISTS prognosis_outcomes (
  id                  BIGSERIAL PRIMARY KEY,
  source_table        TEXT NOT NULL,      -- 'ipd_discharge_audits' | 'appropriateness_runs'
  source_id           TEXT NOT NULL,      -- document_id, or the run id
  source_engine       TEXT,               -- engine_version at link time; NULL for appropriateness_runs
  app_source          TEXT,
  source              TEXT NOT NULL,      -- complaint|readmission|revisit|reoperation|call|other
  observed_outcome    TEXT NOT NULL,
  observed_at         DATE,
  horizon_days        INT,
  matched_complication      INT,          -- index at link time. Advisory only. NULL = nobody predicted it
  matched_complication_hash TEXT,         -- the stable binding. NULL = unpredicted
  classification      TEXT NOT NULL,      -- predicted_occurred | unpredicted_occurred | benefit_failure | no_adverse_outcome
  reviewed_by_name    TEXT,
  notes               TEXT,
  supersedes_id       BIGINT REFERENCES prognosis_outcomes(id),
  superseded          BOOLEAN NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS prognosis_outcomes_source_idx
  ON prognosis_outcomes (source_table, source_id) WHERE superseded = FALSE;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- ROLLBACK. The table is additive and nothing else references it; prefer leaving it in place.
-- If it must go (this deletes recorded human outcome observations — do not do it casually):
--
--   DROP INDEX IF EXISTS prognosis_outcomes_source_idx;
--   DROP TABLE IF EXISTS prognosis_outcomes;
