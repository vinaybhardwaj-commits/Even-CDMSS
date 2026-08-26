// The Pre-op Risk Agent worker (PRD CDMSS-PREOP-RISK-AGENT-v1.1-LOCKED §6; Build Plan B2).
// Mirrors /api/readmission/worker: same auth guard, same sweep-is-the-retry posture —
// with one difference that matters, stated plainly: THIS WORKER MAKES NO MODEL CALL.
// Every tick is deterministic SQL plus the pure cores, and it costs ₹0.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ── THE CRON ↔ maxDuration COVENANT (PRD §6, Build Plan; the readmit rule, kept) ──
// The cron interval MUST clear this box, and any change to one moves the other IN THE
// SAME COMMIT.
//
//   cron          "30 0-16 * * *" UTC  = hourly, 06:00–22:00 IST → interval 3,600,000 ms
//   box                                                            300,000 ms
//   margin                                                       3,300,000 ms   PASS
//
// What has to fit inside the box. These are MEASURED on live db13 + production Neon on
// 26 Aug 2026, not estimated — four real ticks against the 19-episode upcoming window:
//   episode query (surgery_cases ⋈ individuals)                       1,376 ms
//   3 parallel source queries — the slowest sets the term:
//     OPD ICD (individuals-prescriptions, the big table)              9,902 ms
//     creatinine 302 ms · PAC 293 ms                                  (hidden by the ICD leg)
//   19 × (pure compute + at most 3 Neon statements)
//   MEASURED WHOLE TICKS                                     3,359 · 5,065 · 5,265 · 5,667 ms
//   ONE OBSERVED SLOW TICK (Metabase contention, same code)          55,383 ms
//   box                                                             300,000 ms
//   margin against the slow tick                                    ~244,000 ms   PASS
//
// The steady state is cheaper than the first tick, not more expensive: an 'unchanged'
// episode makes ONE Neon read and zero writes, so a board that has stopped moving costs
// almost nothing. The scaling term is the per-episode round trip and the episode query
// caps at 500 rows, so the worst case is ~26× today's 19 — still inside the box against
// the measured per-episode cost, and the 55 s outlier says the real risk is Metabase
// latency rather than episode count. If the upcoming window ever approaches the 500-row
// cap, redo this arithmetic in the same commit that raises it.
export const maxDuration = 300;

import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { runPreopSweep, preopExtractEnabled, PREOP_HORIZON_DAYS } from '@/lib/preop/run';
import { boardCounts, PREOP_ENGINE_VERSION } from '@/lib/preop/store';

/**
 * Behaviour per tick: ONE deterministic sweep. Detect every upcoming, non-cancelled
 * surgical episode; assemble its inputs from the booking form, the member's OPD ICD
 * codes, the Eka creatinine and the KareXpert PAC report reached through the UHID
 * bridge; recompute the snapshot; write it through the versions rail idempotently on
 * (episode_key, PREOP_ENGINE_VERSION).
 *
 * A second tick over unchanged evidence writes NOTHING — no finding row, no version
 * row — because the snapshot fingerprint is identical and the store short-circuits on
 * it. That is the B2 idempotency gate, and it is measurable by row counts rather than
 * by argument.
 *
 *   ?dry_run=1     → compute and report the tally, write nothing (the pre-migration probe)
 *   ?horizon=<n>   → look n days ahead instead of the default 60
 */

// Execution guard — byte-for-byte the readmission worker's: Vercel Cron (un-spoofable
// x-vercel-cron), Bearer CRON_SECRET / ?secret=, or an admin session.
async function authed(req: NextRequest): Promise<boolean> {
  const isCron = req.headers.get('x-vercel-cron') !== null;
  const auth = req.headers.get('authorization') || '';
  const bearerOk = !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const secret = req.nextUrl.searchParams.get('secret');
  const secretOk = !!process.env.CRON_SECRET && !!secret && secret === process.env.CRON_SECRET;
  if (isCron || bearerOk || secretOk) return true;
  try { return await isAdminUnlocked(); } catch { return false; }
}

export async function GET(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const p = req.nextUrl.searchParams;
  const dryRun = p.get('dry_run') === '1';
  const horizonRaw = Number(p.get('horizon') || PREOP_HORIZON_DAYS);
  const horizonDays = Number.isFinite(horizonRaw) ? Math.max(1, Math.min(365, Math.round(horizonRaw))) : PREOP_HORIZON_DAYS;

  try {
    const sweep = await runPreopSweep({ horizonDays, dryRun });
    const counts = dryRun ? null : await boardCounts();
    return NextResponse.json({
      ok: true,
      engine: PREOP_ENGINE_VERSION,
      mode: dryRun ? 'dry_run' : 'sweep',
      // The flags are reported on every tick so their state is never a matter of belief.
      extraction: preopExtractEnabled() ? 'on' : 'off (PREOP_EXTRACT_ENABLED unset — extractable inputs stay UNKNOWN and instruments widen)',
      narrative: 'off (B6 has not been built; there is no model in this worker at all)',
      sweep,
      counts,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
