import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { sql } from '@/lib/db';
import { invalidatePolicyCache } from '@/lib/scoring-policy/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

/**
 * POST /api/admin/migrate-scoring-policy
 *
 * Applies, IN ORDER and IN ONE CALL:
 *   · migrations/0026_scoring_policy.sql        — scoring_policy_versions + scoring_policy_drafts + v1 seeds
 *   · migrations/0027_opd_completeness_items.sql — opd_note_audits.completeness_items jsonb
 *
 * Auth: ADMIN_TOKEN (Bearer / ?token=) OR a logged-in admin session cookie — so V can run it
 * one-click from an authenticated browser session, exactly like migrate-lvc-concepts.
 *
 * ═══ WHY THE DDL IS INLINED RATHER THAN READ FROM migrations/*.sql ═══
 * `migrations/` is not bundled into the Vercel serverless function — only files reachable through
 * the import graph are. Reading them at runtime would work locally and 404 in production, which is
 * the worst possible failure mode for a migration runner. Every other migrate-* route in this repo
 * inlines its DDL for the same reason. The statements below are byte-equivalent to the two .sql
 * files; the files remain the reviewable source of truth and this route the executable one.
 *
 * ═══ RE-RUNNING IS A NO-OP ═══
 * Every statement is CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT EXISTS, and both seeds are
 * guarded by WHERE NOT EXISTS on (note_type, version). A second POST reports `already_present` for
 * the seeds and `ok` for the DDL, and changes nothing. Verified by the shape of the report, not
 * merely asserted: the seed steps read back the row count they found.
 */
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;

  const steps: Record<string, string> = {};
  try {
    // ── 0026 · scoring_policy_versions ─────────────────────────────────────────────────────────
    await run(`CREATE TABLE IF NOT EXISTS scoring_policy_versions (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      note_type         TEXT NOT NULL,
      version           INT  NOT NULL,
      weights           JSONB NOT NULL,
      weights_sha256    TEXT,
      rationale         TEXT NOT NULL,
      published_by      TEXT,
      published_by_name TEXT,
      published_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      is_active         BOOLEAN NOT NULL DEFAULT FALSE,
      supersedes        INT,
      app_source        TEXT NOT NULL DEFAULT 'standalone',
      UNIQUE (note_type, version)
    )`, []);
    // Exactly one active version per note type.
    await run(`CREATE UNIQUE INDEX IF NOT EXISTS scoring_policy_versions_one_active
      ON scoring_policy_versions (note_type) WHERE is_active`, []);
    await run(`CREATE INDEX IF NOT EXISTS scoring_policy_versions_note_type_version
      ON scoring_policy_versions (note_type, version DESC)`, []);
    steps.scoring_policy_versions = 'ok';

    // ── 0026 · scoring_policy_drafts ───────────────────────────────────────────────────────────
    await run(`CREATE TABLE IF NOT EXISTS scoring_policy_drafts (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      note_type   TEXT NOT NULL UNIQUE,
      weights     JSONB NOT NULL,
      updated_by  TEXT,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      app_source  TEXT NOT NULL DEFAULT 'standalone'
    )`, []);
    steps.scoring_policy_drafts = 'ok';

    // ── 0026 · seed v1, all-Standard, per note type (PRD §3) ───────────────────────────────────
    // All-Standard is the IDENTITY ELEMENT of the weighting: §2.3 reduces algebraically to the
    // legacy flat proportion, so seeding changes NO score anywhere. That is what makes it safe to
    // run this on production before anyone opens the screen.
    const DS_V1 = {
      patient_name: 'standard', uhid: 'standard', treating_doctor: 'standard',
      date_admission: 'standard', date_discharge: 'standard', reason_admission: 'standard',
      significant_findings: 'standard', diagnosis: 'standard', condition_at_discharge: 'standard',
      investigations: 'standard', procedures_performed: 'standard', medications_administered: 'standard',
      treatment_given: 'standard', followup_advice: 'standard', discharge_medication: 'standard',
      patient_instructions: 'standard', urgent_care_instructions: 'standard', outcome: 'standard',
      cause_of_death: 'standard', doctor_signature: 'standard', signed_datetime: 'standard',
    };
    const OPD_V1 = {
      presenting_complaint: 'standard', presenting_complaint_symptoms: 'standard',
      relevant_history: 'standard', examination: 'standard', vitals: 'standard',
      diagnosis: 'standard', allergy_status: 'standard', medication_dosing: 'standard',
      investigations: 'standard', obstetric_vitals: 'standard', gravidity_parity: 'standard',
      lmp_edd: 'standard', ga_pog: 'standard',
    };
    const RATIONALE = 'Initial — equal weight across all fields, reproduces legacy scoring.';

    for (const [noteType, vector] of [['discharge_summary', DS_V1], ['opd_rx', OPD_V1]] as const) {
      const existing = await run(
        `SELECT version FROM scoring_policy_versions WHERE note_type = $1 AND version = 1`, [noteType],
      );
      if (existing.length) {
        steps[`seed_${noteType}`] = 'already_present';
        continue;
      }
      await run(
        `INSERT INTO scoring_policy_versions
           (note_type, version, weights, rationale, published_by_name, is_active, supersedes)
         SELECT $1, 1, $2::jsonb, $3, 'System', TRUE, NULL
         WHERE NOT EXISTS (SELECT 1 FROM scoring_policy_versions WHERE note_type = $1 AND version = 1)`,
        [noteType, JSON.stringify(vector), RATIONALE],
      );
      steps[`seed_${noteType}`] = 'seeded_v1';
    }

    // ── 0027 · opd_note_audits.completeness_items ──────────────────────────────────────────────
    await run(`ALTER TABLE opd_note_audits ADD COLUMN IF NOT EXISTS completeness_items jsonb`, []);
    await run(`CREATE INDEX IF NOT EXISTS opd_note_audits_completeness_items_present
      ON opd_note_audits (audited_at DESC) WHERE completeness_items IS NOT NULL`, []);
    steps.opd_completeness_items = 'ok';

    // The active-policy cache is module-scoped with a 60s TTL; drop it so the very first render
    // after the migration reads the seeded v1 instead of waiting out the fallback entry.
    invalidatePolicyCache();

    // ── verification read-back, so the response PROVES what is there rather than asserting it ──
    const seeded = await run(
      `SELECT note_type, version, is_active FROM scoring_policy_versions ORDER BY note_type, version`, [],
    );
    const hasCol = await run(
      `SELECT 1 AS ok FROM information_schema.columns
        WHERE table_name = 'opd_note_audits' AND column_name = 'completeness_items'`, [],
    );

    return NextResponse.json({
      ok: true,
      steps,
      verification: {
        versions: seeded.map((r) => `${r.note_type}/v${r.version}${r.is_active ? ' (active)' : ''}`),
        opd_completeness_items_column: hasCol.length > 0,
      },
      note: 'Re-running this endpoint is a no-op. Seeding v1 all-Standard does not change any score — it reproduces legacy scoring exactly.',
    });
  } catch (e) {
    // Partial application is reported, not hidden: `steps` shows exactly how far it got, and every
    // statement is independently idempotent, so a re-POST resumes safely.
    return NextResponse.json({ ok: false, steps, error: String((e as Error).message) }, { status: 500 });
  }
}
