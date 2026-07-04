export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { requireAdmin } from '@/lib/admin-gate';
import { sql } from '@/lib/db';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

/**
 * One-click, idempotent: (re)create the DE-IDENTIFIED summary views the Lab MCP `audit_query`
 * tool reads instead of the PHI-bearing base tables. Admin or ?token=ADMIN_TOKEN.
 *
 * v_trace_summary          — pipeline behaviour WITHOUT the clinical text: feature, status,
 *                            severity, timings, model_summary, error_message. NO input /
 *                            question_preview / final_answer_text / meta / trace_events.payload.
 * v_appropriateness_summary — Right-Care run structure WITHOUT the pasted case: mode, scenario,
 *                            doc_type, source/finding counts, de_identified flag, timestamp.
 *                            NO input / output / summary free-text.
 */
export async function GET(req: NextRequest) {
  if (!(await isAdminUnlocked())) { const denied = requireAdmin(req); if (denied) return denied; }
  try {
    await run(`CREATE OR REPLACE VIEW v_trace_summary AS
      SELECT trace_id, feature, status, severity, started_at, finished_at, total_ms,
             model_summary, error_message, parent_trace_id, app_source
        FROM traces`, []);
    await run(`CREATE OR REPLACE VIEW v_appropriateness_summary AS
      SELECT id, created_at, mode, app_source, doc_type, n_sources, n_findings, de_identified
        FROM appropriateness_runs`, []);
    return NextResponse.json({ ok: true, migrated: ['v_trace_summary', 'v_appropriateness_summary'] });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
