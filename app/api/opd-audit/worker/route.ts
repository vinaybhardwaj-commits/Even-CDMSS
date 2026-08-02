export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// 300 → 800 (V, 30 Jul 2026). Pro's GA ceiling; 300 was the platform DEFAULT, not a cap.
// Per-note latency moved from a 36–115s spread to 124–545s when the Phase-2 determinism pin
// began sending a fixed 4096-token thinking budget on the production Gemini path
// (opd-note-audit.ts:970). At conc=5 that put whole notes past the 300s box: on 30 Jul the
// worker orphaned ~2 traces in 'running' for every 1 it completed (283 vs 146), all of them
// still unresolved 5h later — the invocation dies and the in-flight notes are simply lost.
// 800s clears the observed p75 (425s) and max (538s) with headroom, and recovers the wasted
// two-thirds WITHOUT raising concurrency (which would aggravate the open gemini-2.5-pro 403s).
export const maxDuration = 800;

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { auditOpdNote } from '@/lib/opd-note-audit';
import { countOpdNotesForDay, fetchOpdNotesForDay, fetchOpdNoteByUid, istYesterday } from '@/lib/metabase';
import { saveOpdAudit, auditedUidsForDayAnyVersion, auditedCountForDayAnyVersion, earliestAuditedDay, deleteOpdAuditsForUid } from '@/lib/opd-audit-store';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { getSettings, setSetting } from '@/lib/mini-backfill';
import { OPD_ENGINE_VERSION } from '@/lib/opd-note-audit-core';

// Fix A (intake eligibility): house-account doctor_uids excluded from the audit corpus. Lives in
// app_settings audit_intake_doctor_exclusions (JSON uid array); fail-safe → this seeded constant (so an
// exclusion-list read failure NEVER silently ADMITS an excluded note). A name-rule fallback in
// lib/metabase catches future house accounts even when absent from this list.
const INTAKE_KEY = 'audit_intake_doctor_exclusions';
const SEED_INTAKE_EXCLUSIONS = ['jE0Io6Y1Nh3E7OkbxcLY', '0bNLwwdtvCy8xw5w11VY', 'iyoFsE8BSNtp3wDfwyQP', 'Wa0ItOcg2VAOerUbwGa3', '6lBF0FPc03eNhrxgrCV6', 'DzuoUgxvw3NXZgo3P7T2', 'v1OyiGME6gQpWt0nQOWm'];
async function intakeExclusions(): Promise<string[]> {
  try {
    const s = await getSettings([INTAKE_KEY]);
    const raw = s[INTAKE_KEY];
    if (raw) { const j = JSON.parse(raw); if (Array.isArray(j)) { const l = j.map((x) => String(x).trim()).filter(Boolean); if (l.length) return l; } }
  } catch { /* fall through to the seeded constant — never admit an excluded note on a read failure */ }
  return SEED_INTAKE_EXCLUSIONS;
}

// FORWARD CUTOFF (V, 2 Jul): the Gemini worker only audits notes dated ON/AFTER this day — i.e.
// genuinely NEW notes going forward. Everything before it (all history + un-audited old notes) is
// left to the free mini backfill. Stored in app_settings; set via ?set_forward_from=YYYY-MM-DD.
const FWD_KEY = 'opd_gemini_forward_from';
async function forwardCutoff(): Promise<string | null> {
  const s = await getSettings([FWD_KEY]).catch(() => ({} as Record<string, string>));
  const v = s[FWD_KEY] || '';
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

// Execution guard (spends LLM compute): Vercel Cron (un-spoofable x-vercel-cron), a manual
// trigger carrying Bearer CRON_SECRET / ?secret=CRON_SECRET, OR a logged-in admin session
// (so the dashboard's one-click "Re-audit" button works without handling any secret).
async function authed(req: NextRequest): Promise<boolean> {
  const isCron = req.headers.get('x-vercel-cron') !== null;
  const auth = req.headers.get('authorization') || '';
  const bearerOk = !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const secret = req.nextUrl.searchParams.get('secret');
  const secretOk = !!process.env.CRON_SECRET && !!secret && secret === process.env.CRON_SECRET;
  if (isCron || bearerOk || secretOk) return true;
  try { return await isAdminUnlocked(); } catch { return false; }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (it: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }));
  return out;
}

function addDays(day: string, delta: number): string {
  const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + delta); return d.toISOString().slice(0, 10);
}

/** T-5 — the model column records what actually SERVED, not a hardcoded literal. The old
 *  hardcoded Pro string kept reporting Pro while every call silently fell back to
 *  qwen2.5:14b on the Mac mini (26–30 Jul, 367 rows) — which is precisely what hid the
 *  SERVICE_DISABLED incident for four days. tracedChat's llm_response event carries the
 *  POST-fallback model (`actualModel`), so the audit's own trace is the source of truth.
 *  Null when unknown (no trace / LLM leg dead) — an honest gap, never a guess. */
/** Unit B (§5, 2 Aug 2026) — the SERVED provider beside the served model.
 *
 *  `model` alone cannot answer "who graded this": `google/gemini-2.5-pro` is Gemini via the
 *  OpenRouter bridge and `gemini-2.5-pro` is Gemini via Vertex, and after 30 July we could not tell
 *  which — a large part of why a three-day outage stayed hidden.
 *
 *  ONE QUERY, ONE ROW, BOTH FIELDS, deliberately. Reading them separately could pair a model from
 *  one event with a provider from another and attribute the call to a route it never took, which is
 *  a worse lie than the ambiguity being fixed. `provider` on the llm_response payload is set AFTER
 *  fallback (lib/trace.ts:337/401 reassign it to 'ollama' when the local model serves), so it is
 *  the served route, never the intended one. */
async function servedCallFor(traceId: string | undefined): Promise<{ model: string | null; provider: string | null }> {
  const none = { model: null, provider: null };
  if (!traceId) return none;
  try {
    const rows = (await (sql as unknown as (q: string, p: unknown[]) => Promise<{ model?: string; provider?: string }[]>)(
      `SELECT payload->>'model' AS model, payload->>'provider' AS provider FROM trace_events
        WHERE trace_id = $1 AND kind IN ('llm_response', 'llm_stream_usage')
          AND stage = 'opd_audit_analyze'
        ORDER BY seq DESC LIMIT 1`,
      [traceId],
    ));
    const r = rows?.[0];
    return {
      model: typeof r?.model === 'string' && r.model ? r.model : null,
      provider: typeof r?.provider === 'string' && r.provider ? r.provider : null,
    };
  } catch { return none; }
}

// Audit one batch of NEVER-YET-AUDITED notes for a single IST day. The Gemini worker only touches
// genuinely NEW notes (no audit at ANY engine version) — re-auditing already-audited notes to a
// newer engine is the free mini backfill's job (V, 2 Jul: Gemini forward-only, mini for old + re-audits).
async function processDay(day: string, max: number, conc: number, exclude: string[]) {
  const total = await countOpdNotesForDay(day, exclude);
  // §1 exception: auditedUidsForDayAnyVersion does NOT filter excluded_reason (see the store) — excluded
  // uids stay in the "already audited" set so they're never re-admitted.
  const already = await auditedUidsForDayAnyVersion(day);
  if (already.length >= total) return { day, total, audited: already.length, processed: 0, remaining: 0, done: true, results: [] as unknown[] };
  const rows = await fetchOpdNotesForDay(day, already, max, exclude);
  const results = await mapLimit(rows, conc, async (row) => {
    const started = Date.now();
    try {
      const audit = await auditOpdNote(row);
      const served = await servedCallFor(audit.traceId);
      const status = await saveOpdAudit(audit, { model: served.model, provider: served.provider, latencyMs: Date.now() - started });
      return { uid: audit.keys.uid, index: audit.scorecard.headline, band: audit.scorecard.band, status };
    } catch (e) {
      return { uid: String((row as Record<string, unknown>).uid || ''), error: String((e as Error).message) };
    }
  });
  // 'updated' = a retry landed on a llm_leg_failed row at the write-target version (addendum F v2
  // task 2) — completed work, counted the same as a fresh insert.
  const inserted = results.filter((r) => 'status' in r && ['inserted', 'updated'].includes((r as { status?: string }).status ?? '')).length;
  const audited = already.length + inserted;
  const remaining = Math.max(0, total - audited);
  return { day, total, audited, processed: results.length, remaining, done: remaining === 0, results };
}

/**
 * Count-agnostic, resumable, GAP-PROOF OPD note-quality worker.
 *
 * Two modes:
 *  • ?day=YYYY-MM-DD  → audit just that day (manual backfill / spot-fill).
 *  • default (cron)   → SWEEP a lookback window ending yesterday IST, working the OLDEST
 *    un-audited day first. So a missed night (weekend, deploy gap) is caught up automatically
 *    on the next run, oldest-first, until the whole window is complete. The window is floored
 *    at the earliest-ever audited day, so it never reaches back before the system launched,
 *    and it's idempotent (uid+engine_version), so caught-up days are cheap no-ops — no re-charge.
 *
 *  ?max (12→ default 15, ≤30) · ?conc (default 5, ≤8) · ?lookback (default OPD_AUDIT_LOOKBACK or 4, ≤14).
 */
export async function GET(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const p = req.nextUrl.searchParams;
  const max = Math.max(1, Math.min(30, Number(p.get('max') || 15)));
  const conc = Math.max(1, Math.min(8, Number(p.get('conc') || 5)));
  const dayParam = p.get('day');

  // Admin: set / clear the forward cutoff (?set_forward_from=YYYY-MM-DD, or =off).
  const setFwd = p.get('set_forward_from');
  if (setFwd != null) {
    const val = /^\d{4}-\d{2}-\d{2}$/.test(setFwd) ? setFwd : '';
    await setSetting(FWD_KEY, val);
    return NextResponse.json({ ok: true, forward_from: val || null });
  }

  // Re-audit hook (Fix B / decision 2): re-run the full Gemini audit at 0.81.7 for a CSV of uids (≤25),
  // one current row per uid (DELETE-then-INSERT). Admin/CRON gate is the same `authed` above.
  const reauditCsv = p.get('reaudit_uids');
  if (reauditCsv != null) {
    const uids = reauditCsv.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 25);
    const results = await mapLimit(uids, conc, async (uid) => {
      try {
        const row = await fetchOpdNoteByUid(uid);
        if (!row) return { uid, error: 'note not found in db13' };
        const audit = await auditOpdNote(row);           // 0.81.7 — consult_types-aware framing
        const deleted = await deleteOpdAuditsForUid(uid); // drop ALL prior rows → single current row
        const served = await servedCallFor(audit.traceId);
        const status = await saveOpdAudit(audit, { model: served.model, provider: served.provider });
        return { uid, deleted, status, band: audit.scorecard.band, index: audit.scorecard.headline };
      } catch (e) { return { uid, error: String((e as Error).message) }; }
    });
    return NextResponse.json({ ok: true, mode: 'reaudit', engine: OPD_ENGINE_VERSION, count: uids.length, results });
  }

  try {
    const cutoff = await forwardCutoff();
    const exclude = await intakeExclusions();

    // Manual single-day mode.
    if (dayParam && /^\d{4}-\d{2}-\d{2}$/.test(dayParam)) {
      if (cutoff && dayParam < cutoff) {
        return NextResponse.json({ ok: true, mode: 'day', day: dayParam, skipped: `before Gemini forward cutoff ${cutoff} — history is the mini backfill's job`, processed: 0 });
      }
      const r = await processDay(dayParam, max, conc, exclude);
      return NextResponse.json({ ok: true, mode: 'day', ...r });
    }

    // Sweep mode: oldest incomplete day in the lookback window. Floor = the forward cutoff if set
    // (Gemini forward-only), else the earliest-audited day (legacy gap-fill).
    const lookback = Math.max(1, Math.min(14, Number(p.get('lookback') || process.env.OPD_AUDIT_LOOKBACK || 4)));
    const yesterday = istYesterday();
    const baseFloor = (await earliestAuditedDay()) || yesterday;
    const floor = cutoff && cutoff > baseFloor ? cutoff : baseFloor;
    const days: string[] = [];
    for (let i = lookback - 1; i >= 0; i--) { const d = addDays(yesterday, -i); if (d >= floor) days.push(d); }
    const window = { from: days[0] ?? yesterday, to: yesterday };

    for (const d of days) {
      const total = await countOpdNotesForDay(d, exclude);
      if (total === 0) continue;
      const auditedCount = await auditedCountForDayAnyVersion(d);
      if (auditedCount < total) {
        const r = await processDay(d, max, conc, exclude);
        return NextResponse.json({ ok: true, mode: 'sweep', window, ...r });
      }
    }
    return NextResponse.json({ ok: true, mode: 'sweep', window, caughtUp: true, done: true, processed: 0 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
