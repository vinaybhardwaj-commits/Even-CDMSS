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
 * v_stage_latency          — PER-LEG wall time by stage, provider and model (Unit D, DEC-B7,
 *                            3 Aug 2026), so a provider budget can be MEASURED instead of derived.
 *                            NO payload.
 *
 * WHY v_stage_latency EXISTS. Every latency figure in this system was a subtraction of two
 * whole-trace percentiles, because per-leg latency was not observable: v_trace_summary carries only
 * `total_ms`, its `model_summary` is null on every row sampled, and trace_events is PHI-blocked by
 * lib/sql-guard-core.ts. That is how "the OPD audit runs p50 267 s" survived unchallenged for a
 * week while the real p50 was 52–93 s, and how a route budget came to be sized against one LLM leg
 * when the audit makes two or three. trace_events already stores what is needed — lib/trace.ts
 * passes `Date.now() - t0` as latency_ms on the llm_response event and `stage` carries the leg
 * label — so this is an exposure, not new instrumentation.
 *
 * ⚠️ `payload` IS EXCLUDED AND MUST STAY EXCLUDED. It is the only PHI-bearing column on the table
 * and it holds BOTH the prompt messages and the model's output text.
 *
 * ⚠️ `call_model` and `call_provider` are REAL COLUMNS, promoted out of the JSONB by
 * migrations/0012_reasoning_fingerprint.sql and stamped by buildEnvelope at the tracedChat choke
 * point. They must be read as columns, never out of payload. Without them the view averages a
 * Gemini leg together with a qwen fallback leg into one number — which is precisely the class of
 * error this whole build exists to correct. A model slug and a provider name carry nothing
 * clinical, and both are already exposed in aggregate on opd_note_audits.model and .provider.
 *
 * ⚠️ `tokens_out` IS THE POINT, not a bonus column (V, 3 Aug 2026, after the build began).
 * CDMSS-DETERMINISM-MECHANISM-EVIDENCE-3-AUG-2026.md — 24 live calls on clinical-infra and
 * OpenRouter — found that output is a DETERMINISTIC FUNCTION OF THINKING-TOKEN SPEND: two runs with
 * the same reasoning tokens returned byte-identical output, two runs with different spend did not,
 * zero exceptions. `tokens_out` here is REASONING-INCLUSIVE (lib/trace.ts records it as
 * total − prompt), so run-to-run variance in it on identical input is the observable that PREDICTS
 * A BAND FLIP. Without it this view measures latency and misses the thing latency is a symptom of.
 * From migrations/0012_reasoning_fingerprint.sql:17, the same migration as call_model/call_provider.
 *
 * ⚠️ THE NAME deliberately contains neither `traces` nor `trace_events` as whole words, so it
 * passes BLOCKED_RELATIONS in lib/sql-guard-core.ts WITHOUT that file changing — that file's own
 * comment says to widen access by adding a view, never by editing the list.
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
    await run(`CREATE OR REPLACE VIEW v_stage_latency AS
      SELECT e.trace_id, t.feature, e.stage, e.kind, e.ts, e.latency_ms, e.app_source,
             e.call_model, e.call_provider, e.tokens_out
        FROM trace_events e
        JOIN traces t ON t.trace_id = e.trace_id`, []);
    return NextResponse.json({ ok: true, migrated: ['v_trace_summary', 'v_appropriateness_summary', 'v_stage_latency'] });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
