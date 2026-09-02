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
      completeness_pct      INTEGER,
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
      de_identified         BOOLEAN DEFAULT TRUE,
      error_detail          TEXT
    )`;
    steps.audits_table = 'ok';

    // ADD COLUMN for a table that already exists from an earlier run of this route — CREATE TABLE
    // IF NOT EXISTS is a no-op there and would leave the column behind. Same shape as the 0014
    // `report` column added to ipd_discharge_audits.
    await sql`ALTER TABLE ipd_episode_audits ADD COLUMN IF NOT EXISTS error_detail TEXT`;
    await sql`ALTER TABLE ipd_episode_audits ALTER COLUMN app_source SET DEFAULT 'standalone'`;
    steps.audits_columns = 'ok';

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
      trace_id           TEXT
    )`;
    await sql`CREATE INDEX IF NOT EXISTS ipd_episode_checkpoints_audit_idx ON ipd_episode_checkpoints (episode_audit_id)`;
    steps.checkpoints_table = 'ok';

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
