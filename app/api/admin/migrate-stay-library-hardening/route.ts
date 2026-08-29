import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';

// The stay library's hardening migration (CDMSS-STAY-LIBRARY-HARDENING-PRD-v1.0-29-AUG-2026,
// H-D2 / H-D11; migration number 0049, reference copy in
// migrations/0049_stay_library_hardening.sql). Additive + idempotent; mirrors
// migrate-clinical-states (0047), which mirrored migrate-case-ask (0046). Auth: ADMIN_TOKEN
// (Bearer / ?token=) OR admin session.
//
// H1: clinical_state_versions — the prior reading of a library row, kept before it is overwritten.
// One row per OVERWRITE, written in the same SQL statement as the overwrite itself (a CTE in
// lib/stay-library/store.ts), so a failed snapshot blocks the overwrite instead of losing it. A
// fresh insert writes nothing here. `reason` is a closed set of two: 'upsert_overwrite' and
// (H3) 'superseded'.
//
// This route CREATEs one table and one index and ALTERs nothing, so it cannot touch an audit, a
// feedback row, an episode, a member-state snapshot or a library row. No engine version, no schema
// version, no flag. Running it twice is the same as running it once.
//
// SELF-VERIFYING: the response reports what pg_class actually holds afterwards, so the operator
// reads the database's answer rather than this route's optimism.
// ⚠️ INFERRED SQL/DDL throughout: this sandbox has no live Neon.

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;
  const steps: Record<string, string> = {};
  try {
    await sql`CREATE TABLE IF NOT EXISTS clinical_state_versions (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      snapshotted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      clinical_state_id UUID NOT NULL,
      doc_kind          TEXT NOT NULL,
      source_uid        TEXT NOT NULL,
      schema_version    TEXT NOT NULL,
      status            TEXT NOT NULL,
      state_json        JSONB NOT NULL,
      reason            TEXT NOT NULL
    )`;
    steps.create_clinical_state_versions = 'ok';
    await sql`CREATE INDEX IF NOT EXISTS clinical_state_versions_state_idx
      ON clinical_state_versions (clinical_state_id, snapshotted_at)`;
    steps.state_index = 'ok';

    // What the database says it now has — table presence, then the version rows already kept.
    const present = (await sql`SELECT to_regclass('public.clinical_state_versions') IS NOT NULL AS ok`) as Array<{ ok: boolean }>;
    steps.verified_table = present[0]?.ok ? 'present' : 'MISSING';
    const counted = (await sql`SELECT reason, count(*)::int AS n FROM clinical_state_versions GROUP BY reason`) as Array<{ reason: string; n: number }>;
    steps.versions_by_reason = JSON.stringify(
      Object.fromEntries(counted.map((r) => [String(r.reason), Number(r.n ?? 0)])),
    );
    return NextResponse.json({ ok: true, steps });
  } catch (e) {
    return NextResponse.json({ ok: false, steps, error: String((e as Error).message) }, { status: 500 });
  }
}
