import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import type { NextRequest } from 'next/server';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';

// Creates the opd_note_audits table (M2). Idempotent. Mirrors migrations/0007_opd_note_audits.sql.
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req); if (denied) return denied;
  const steps: Record<string, string> = {};
  try {
    await sql`CREATE TABLE IF NOT EXISTS opd_note_audits (
      id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      audited_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      app_source           TEXT NOT NULL DEFAULT 'standalone',
      uid                  TEXT NOT NULL,
      consult_uid          TEXT,
      doctor_uid           TEXT,
      kx_encounter_id      TEXT,
      note_date            TIMESTAMPTZ,
      prescription_type    TEXT,
      consult_type         TEXT,
      de_identified        BOOLEAN NOT NULL DEFAULT TRUE,
      note_quality_index   INT NOT NULL,
      band                 TEXT NOT NULL,
      score_documentation       INT,
      score_note_quality        INT,
      score_appropriateness     INT,
      score_prescribing_safety  INT,
      score_patient_centred     INT,
      pdqi9                JSONB,
      completeness_pct     INT,
      n_missing_mandatory  INT,
      n_findings           INT NOT NULL DEFAULT 0,
      n_low_value          INT NOT NULL DEFAULT 0,
      n_context_dependent  INT NOT NULL DEFAULT 0,
      n_interaction_alerts INT NOT NULL DEFAULT 0,
      findings             JSONB,
      suggestions          JSONB,
      engine_version       TEXT NOT NULL DEFAULT 'opd-note-audit/0.1',
      model                TEXT,
      trace_id             TEXT,
      latency_ms           INT
    )`;
    steps.table = 'ok';
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS opd_note_audits_uid_engine_uq ON opd_note_audits (uid, engine_version)`;
    await sql`CREATE INDEX IF NOT EXISTS opd_note_audits_note_date_idx ON opd_note_audits (note_date DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS opd_note_audits_doctor_idx ON opd_note_audits (doctor_uid)`;
    await sql`CREATE INDEX IF NOT EXISTS opd_note_audits_band_idx ON opd_note_audits (band)`;
    await sql`CREATE INDEX IF NOT EXISTS opd_note_audits_consult_type_idx ON opd_note_audits (consult_type)`;
    steps.indexes = 'ok';
    const cols = (await sql`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'opd_note_audits'`) as Array<{ n: number }>;
    steps.columns = String(cols[0]?.n ?? 0);
    return NextResponse.json({ ok: true, steps });
  } catch (e) {
    return NextResponse.json({ ok: false, steps, error: String((e as Error).message) }, { status: 500 });
  }
}
