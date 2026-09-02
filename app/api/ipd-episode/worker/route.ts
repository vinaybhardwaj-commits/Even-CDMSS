export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
/**
 * 800 s, matching app/api/ipd-audit/worker/route.ts (PRD §11). THE BATCH MUST FIT THE BOX, and
 * this engine's arithmetic is different from the discharge worker's because its unit of work is
 * an ADMISSION, not a document:
 *
 *   per episode, worst case:
 *     up to 8 checkpoints (7 daily + 1 episode-level) × Haiku ≈ 8 × ~25 s   =  200 s
 *     A1 diff        × Opus                                                 ≈  100 s
 *     A2 fidelity    × Opus                                                 ≈  100 s
 *     B commentary   × Opus (up to 2 validation attempts)                   ≈   80 s
 *     db13 assembly (9 reads) + retrieval (8 calls) + persist               ≈   40 s
 *                                                                             ------
 *     one episode                                                            ~520 s
 *     box                                                                      800 s
 *
 * ⚠️ SO max DEFAULTS TO 2 AND CAPS AT 5, AND PROCESSING IS SEQUENTIAL. Two episodes at ~520 s
 * worst case do not both fit, which is deliberate and safe: an episode that does not finish
 * writes no row, and the NEXT TICK SWEEPS IT AGAIN because un-audited episodes are selected by
 * their absence from ipd_episode_audits. The sweep is the retry. What must never happen is
 * CONCURRENT episodes — three Opus calls each — which is why there is no ?conc= here at all and
 * why the lock below exists.
 *
 * ⚠️ maxDuration, max, and the leg count are coupled. Changing one without redoing this
 * arithmetic is how a route ends up in a box it cannot fit. There is NO CRON ENTRY (decision 19):
 * vercel.json is untouched and the orchestrator triggers this by hand for the validation run.
 */
export const maxDuration = 800;

import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { getSettings, setSetting, lockHeld } from '@/lib/mini-backfill';
import { fetchClosedEpisodes, isEncounterId } from '@/lib/ipd-episode/db13';
import {
  IPD_EPISODE_ENGINE_VERSION, auditedEncounterIds, skipIsRetryable, skipRows,
} from '@/lib/ipd-episode/store';
import { runEpisodeAudit, type RunEpisodeResult } from '@/lib/ipd-episode/run';

/**
 * The soft lock. `app_settings` key `ipd_episode_lock`, with the TTL mechanics the IPD module
 * already uses (lib/mini-backfill's lockHeld / MB_LOCK_TTL_MS = 210 s, shared by
 * lib/ipd-audit/backfill.ts). The lock is written at the start of a tick and released in
 * `finally`, so the TTL only matters when a tick dies without releasing.
 *
 * ⚠️ THE TTL IS SHORTER THAN THIS ROUTE'S BOX (210 s against 800 s). That is a deliberate,
 * ACCEPTED limitation and not an oversight: a tick that runs longer than 210 s can have its lock
 * treated as stale by a second tick. Nothing here is a queue and nothing double-writes — the
 * (encounter_id, engine_version) unique index makes a duplicate audit an UPSERT of the same row,
 * not a second one — so the cost of a stale-lock overlap is duplicated model spend on one
 * episode, not a corrupt row. Sharing the module's one lock helper was preferred over inventing a
 * second TTL constant; a dedicated TTL belongs with the cron entry, which decision 19 defers.
 */
const LOCK_KEY = 'ipd_episode_lock';

/** Execution guard (this route spends LLM compute): Vercel Cron, Bearer/query CRON_SECRET, or a
 *  logged-in admin session. Byte-identical in shape to the IPD discharge worker's. */
async function authed(req: NextRequest): Promise<boolean> {
  const isCron = req.headers.get('x-vercel-cron') !== null;
  const auth = req.headers.get('authorization') || '';
  const bearerOk = !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const secret = req.nextUrl.searchParams.get('secret');
  const secretOk = !!process.env.CRON_SECRET && !!secret && secret === process.env.CRON_SECRET;
  if (isCron || bearerOk || secretOk) return true;
  try { return await isAdminUnlocked(); } catch { return false; }
}

/**
 * The next episodes to audit, in ascending discharge order (§3.1). "Un-audited" is decided by the
 * audit TABLE, not by a cursor — the table is the watermark, so a missed tick self-heals and a
 * caught-up run is a cheap no-op. A skip row past its 14-day retry window is excluded here rather
 * than attempted and re-skipped.
 */
async function nextCandidates(max: number): Promise<{ encounterId: string; dischargedAt: string | null }[]> {
  const [closed, audited, skips] = await Promise.all([
    fetchClosedEpisodes(400),
    auditedEncounterIds(),
    skipRows(),
  ]);
  const done = new Set(audited);
  const stale = new Set(skips.filter((s) => !skipIsRetryable(s.discharged_at)).map((s) => s.encounter_id));
  const out: { encounterId: string; dischargedAt: string | null }[] = [];
  for (const c of closed) {
    if (done.has(c.encounterId) || stale.has(c.encounterId)) continue;
    out.push({ encounterId: c.encounterId, dischargedAt: c.dischargeDateTime });
    if (out.length >= max) break;
  }
  return out;
}

export async function GET(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const p = req.nextUrl.searchParams;
  const max = Math.max(1, Math.min(5, Number(p.get('max') || 2)));
  const one = p.get('encounter');

  // The lock is checked BEFORE any db13 read: a held lock must cost nothing.
  const settings = await getSettings([LOCK_KEY]).catch(() => ({} as Record<string, string>));
  if (lockHeld(settings[LOCK_KEY] || null)) {
    return NextResponse.json({ ok: true, locked: true, engine: IPD_EPISODE_ENGINE_VERSION });
  }
  await setSetting(LOCK_KEY, new Date().toISOString()).catch(() => {});

  try {
    // ?encounter= — run ONE named episode, whatever the sweep would have chosen. Used for the
    // orchestrator's spot checks. The id is shape-checked and never rewritten.
    if (one) {
      if (!isEncounterId(one)) {
        return NextResponse.json({ ok: false, error: 'bad encounter id' }, { status: 400 });
      }
      const r = await runEpisodeAudit({ encounterId: one });
      return NextResponse.json({ ok: true, mode: 'encounter', engine: IPD_EPISODE_ENGINE_VERSION, processed: 1, results: [r] });
    }

    const candidates = await nextCandidates(max);
    if (!candidates.length) {
      return NextResponse.json({ ok: true, mode: 'sweep', engine: IPD_EPISODE_ENGINE_VERSION, caughtUp: true, processed: 0, results: [] });
    }

    // SEQUENTIAL, deliberately (see the box arithmetic above). No concurrency knob exists.
    const results: RunEpisodeResult[] = [];
    for (const c of candidates) {
      results.push(await runEpisodeAudit({ encounterId: c.encounterId, dischargedAtHint: c.dischargedAt }));
    }

    return NextResponse.json({
      ok: true,
      mode: 'sweep',
      engine: IPD_EPISODE_ENGINE_VERSION,
      processed: results.length,
      audited: results.filter((r) => r.status === 'inserted' || r.status === 'updated').length,
      skipped: results.filter((r) => r.skip).length,
      errors: results.filter((r) => r.error).length,
      results,
    });
  } catch (e) {
    // Even the top-level catch answers 200: this route is triggered by hand and by cron, and a
    // 500 tells a caller nothing a recorded error does not (§8: no path returns a 500).
    return NextResponse.json({ ok: false, engine: IPD_EPISODE_ENGINE_VERSION, error: String((e as Error).message) });
  } finally {
    await setSetting(LOCK_KEY, '').catch(() => {});
  }
}
