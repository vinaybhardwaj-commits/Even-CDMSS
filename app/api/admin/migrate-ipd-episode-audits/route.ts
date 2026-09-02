import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import type { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { isAdminUnlocked } from '@/lib/admin-cookie';

export const runtime = 'nodejs';

/**
 * Creates the three IPD Episode Audit tables (PRD §7). Idempotent — every statement is
 * IF NOT EXISTS, so running it twice is a no-op. Mirrors migrations/0052_ipd_episode_audits.sql
 * byte-for-byte in intent; the .sql file is the reference copy, this route is the executable
 * path, because `migrations/` is not bundled into the Vercel serverless function.
 *
 * Auth is the shipped pattern: ADMIN_TOKEN (Bearer / ?token=) OR a logged-in admin session.
 *
 * ⚠️ THIS IS THE ROUTE V MUST RUN before the worker writes anything:
 *     POST /api/admin/migrate-ipd-episode-audits   (on the preview deployment)
 * Preview and Production share DATABASE_URL, so it writes to the real Neon database.
 */
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;
  const steps: Record<string, string> = {};
  try {
    await sql`CREATE TABLE IF NOT EXISTS ipd_episode_audits (
      id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      audited_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      app_source            TEXT NOT NULL DEFAULT 'standalone',
      engine_version        TEXT NOT NULL,
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
      divergence_index      INTEGER,
      scoring_status        TEXT NOT NULL DEFAULT 'ok',
      completeness_pct      INTEGER DEFAULT 0,
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
      error_detail          TEXT,
      raw_judge_error       JSONB
    )`;
    steps.audits_table = 'ok';

    // ── repairs for a table an earlier run of this route already created ──────────────────────
    // CREATE TABLE IF NOT EXISTS is a no-op on an existing table, so every column and default
    // added after the first successful run has to be applied explicitly. Same shape as the 0014
    // `report` column added to ipd_discharge_audits. All of this is idempotent.
    await sql`ALTER TABLE ipd_episode_audits ADD COLUMN IF NOT EXISTS error_detail TEXT`;
    await sql`ALTER TABLE ipd_episode_audits ADD COLUMN IF NOT EXISTS raw_judge_error JSONB`;
    await sql`ALTER TABLE ipd_episode_audits ADD COLUMN IF NOT EXISTS n_parse_failed INTEGER DEFAULT 0`;
    await sql`ALTER TABLE ipd_episode_audits ADD COLUMN IF NOT EXISTS scoring_status TEXT NOT NULL DEFAULT 'ok'`;
    await sql`ALTER TABLE ipd_episode_audits ALTER COLUMN app_source SET DEFAULT 'standalone'`;
    steps.audits_columns = 'ok';

    // DEFAULT 0 on every counted column (see the DDL note): a null counter is not "zero findings",
    // it is "unknown", and it makes an aggregate skip the row instead of counting it.
    // divergence_index is deliberately absent: it may be NULL under scoring_status
    // 'no_expectations', and a DEFAULT 0 would make "not scorable" indistinguishable from "the
    // worst episode we have ever seen".
    for (const col of [
      'completeness_pct', 'n_findings', 'n_divergence_pass', 'n_fidelity_pass',
      'n_omission', 'n_commission', 'n_timing', 'n_sequencing', 'n_divergent', 'n_context_dependent',
      'n_unassessable', 'n_concordant', 'n_low_value', 'n_dropped_invalid', 'n_parse_failed',
      'checkpoint_count',
    ]) {
      // identifier interpolation, not a value: `col` comes from this literal list and never from a
      // request, so there is nothing here for a caller to influence.
      await sql(`ALTER TABLE ipd_episode_audits ALTER COLUMN ${col} SET DEFAULT 0`);
    }
    await sql`ALTER TABLE ipd_episode_audits ALTER COLUMN divergence_index DROP DEFAULT`;
    steps.audits_defaults = 'ok';

    await sql`CREATE UNIQUE INDEX IF NOT EXISTS ipd_episode_audits_encounter_engine_uq ON ipd_episode_audits (encounter_id, engine_version)`;
    await sql`CREATE INDEX IF NOT EXISTS ipd_episode_audits_discharged_idx ON ipd_episode_audits (discharged_at DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS ipd_episode_audits_speciality_idx ON ipd_episode_audits (speciality)`;
    await sql`CREATE INDEX IF NOT EXISTS ipd_episode_audits_ip_uid_idx ON ipd_episode_audits (ip_uid)`;
    steps.audits_indexes = 'ok';

    await sql`CREATE TABLE IF NOT EXISTS ipd_episode_checkpoints (
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
      trace_id           TEXT,
      uncited_entry_count INTEGER DEFAULT 0,
      entry_count         INTEGER DEFAULT 0,
      citation_sources    JSONB,
      retrieved_titles    TEXT[],
      retrieval_offtopic  BOOLEAN DEFAULT FALSE
    )`;
    await sql`CREATE INDEX IF NOT EXISTS ipd_episode_checkpoints_audit_idx ON ipd_episode_checkpoints (episode_audit_id)`;
    await sql`ALTER TABLE ipd_episode_checkpoints ADD COLUMN IF NOT EXISTS uncited_entry_count INTEGER DEFAULT 0`;
    await sql`ALTER TABLE ipd_episode_checkpoints ADD COLUMN IF NOT EXISTS entry_count INTEGER DEFAULT 0`;
    await sql`ALTER TABLE ipd_episode_checkpoints ADD COLUMN IF NOT EXISTS citation_sources JSONB`;
    await sql`ALTER TABLE ipd_episode_checkpoints ADD COLUMN IF NOT EXISTS retrieved_titles TEXT[]`;
    await sql`ALTER TABLE ipd_episode_checkpoints ADD COLUMN IF NOT EXISTS retrieval_offtopic BOOLEAN DEFAULT FALSE`;
    steps.checkpoints_table = 'ok';

    // ── citation_ids must be INTEGER[] ────────────────────────────────────────────────────────
    // The store inserts `$8::int[]`. If this column were ever created as TEXT[], Postgres would
    // reject every checkpoint INSERT — and that INSERT is inside a catch, so the rows would
    // disappear in silence, taking input_cutoff_at and input_event_count (the blinding proof) with
    // them. This engine has only ever declared INTEGER[], so on any table it created the repair
    // below is a no-op; it exists so a table created by some other hand cannot poison the writer.
    //
    // GUARDED ON THE CATALOGUE so it is genuinely idempotent: an unconditional ALTER TYPE rewrites
    // the whole table on every run. `_int4` is the pg_type name for integer[].
    const citationType = (await sql`
      SELECT a.atttypid::regtype::text AS t
      FROM pg_attribute a
      WHERE a.attrelid = 'ipd_episode_checkpoints'::regclass
        AND a.attname = 'citation_ids' AND a.attnum > 0 AND NOT a.attisdropped
    `) as Array<{ t: string }>;
    const current = citationType[0]?.t ?? 'unknown';
    if (current === 'integer[]') {
      steps.checkpoints_citation_ids = 'integer[] — already correct, no rewrite';
    } else {
      // USING …::text[]::integer[] converts a text[] column elementwise; on an empty table it is
      // trivially safe, and on a populated one it fails loudly rather than dropping data.
      await sql`ALTER TABLE ipd_episode_checkpoints
                ALTER COLUMN citation_ids TYPE INTEGER[] USING citation_ids::text[]::integer[]`;
      steps.checkpoints_citation_ids = `repaired from ${current} to integer[]`;
    }

    await sql`CREATE TABLE IF NOT EXISTS ipd_episode_skips (
      encounter_id    TEXT NOT NULL,
      engine_version  TEXT NOT NULL,
      reason          TEXT NOT NULL,
      first_seen      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      attempts        INTEGER NOT NULL DEFAULT 1,
      discharged_at   TIMESTAMPTZ,
      PRIMARY KEY (encounter_id, engine_version)
    )`;
    await sql`CREATE INDEX IF NOT EXISTS ipd_episode_skips_discharged_idx ON ipd_episode_skips (discharged_at DESC)`;
    steps.skips_table = 'ok';

    const counts = (await sql`SELECT count(*)::int AS n FROM ipd_episode_audits`) as Array<{ n: number }>;
    steps.rows = String(counts[0]?.n ?? 0);
    return NextResponse.json({ ok: true, steps });
  } catch (e) {
    return NextResponse.json({ ok: false, steps, error: String((e as Error).message) }, { status: 500 });
  }
}
