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
import { getSettings, setSetting } from '@/lib/mini-backfill';
import { fetchClosedEpisodes, isEncounterId } from '@/lib/ipd-episode/db13';
import {
  IPD_EPISODE_ENGINE_VERSION, auditedEncounterIds, skipIsRetryable, skipRows,
} from '@/lib/ipd-episode/store';
import { runEpisodeAudit, runEpisodeBatch, MAX_CANDIDATES_EXAMINED } from '@/lib/ipd-episode/run';

/**
 * The soft lock. `app_settings` key `ipd_episode_lock`, written at the start of a tick and released
 * in `finally`, so the TTL only decides what happens when a tick DIES without releasing.
 *
 * ⚠️ ITS OWN TTL, AND THE ARITHMETIC IS THE WHOLE REASON. The IPD module's shared helper
 * (lib/mini-backfill's `lockHeld` / MB_LOCK_TTL_MS) uses 210 s, sized for a tick that audits two
 * OPD notes inside a 300 s function cap. THIS route's box is 800 s and one episode can legitimately
 * run ~520 s — so a shared 210 s TTL declared a perfectly healthy tick dead at the four-minute mark
 * and let a second tick start beside it. Two ticks each holding three Opus calls is exactly the
 * request storm the IPD discharge worker's header documents at length.
 *
 * 780 s sits just under the 800 s box: long enough that no tick which is still inside its own
 * invocation is ever called stale, short enough that a crashed tick's lock clears before the next
 * cadence rather than wedging the worker until someone clears the key by hand.
 *
 * The lock is advisory, not a queue. If it ever were bypassed, the (encounter_id, engine_version)
 * unique index still makes a duplicate audit an UPSERT of the same row — never a second one.
 */
const LOCK_KEY = 'ipd_episode_lock';

/** 780 s. Coupled to `maxDuration` above: raise the box and this must move with it, in the same
 *  commit — a TTL shorter than the work it guards is the defect this constant exists to fix.
 *  Module-local, not exported: Next.js allows a route file to export only its handlers and route
 *  config, so the contract test reads this file as source (the idiom this build already uses for
 *  the PHI and no-id-rewriting assertions). */
const IPD_EPISODE_LOCK_TTL_MS = 780 * 1000;

/** True when a lock fresher than the TTL exists — i.e. another tick is still running. Local, not
 *  the 210 s shared helper: see the note above. */
function lockHeld(lockTs: string | null, now: Date = new Date(), ttlMs: number = IPD_EPISODE_LOCK_TTL_MS): boolean {
  if (!lockTs) return false;
  const t = Date.parse(lockTs);
  return Number.isFinite(t) && now.getTime() - t < ttlMs;
}

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
 * The candidate QUEUE, in ascending discharge order (§3.1). "Un-audited" is decided by the audit
 * TABLE, not by a cursor — the table is the watermark, so a missed tick self-heals and a caught-up
 * run is a cheap no-op. A skip row past its 14-day retry window is excluded here rather than
 * attempted and re-skipped.
 *
 * ⚠️ NOT TRUNCATED TO `max`. It used to be, and that was the bug: a batch of two candidates that
 * both failed selection audited nothing and reported a full tick. The queue is now handed whole to
 * `runEpisodeBatch`, which stops when `max` episodes have actually reached the model stages —
 * or when it has examined `MAX_CANDIDATES_EXAMINED` of them, so a cohort where nothing qualifies
 * cannot make a tick walk the entire list.
 *
 * The db13 query already drops episodes with no progress note (§3.1 condition 2), so the queue is
 * mostly real candidates before this filter runs at all.
 */
async function candidateQueue(): Promise<{ encounterId: string; dischargedAt: string | null }[]> {
  const [closed, audited, skips] = await Promise.all([
    fetchClosedEpisodes(2000),
    auditedEncounterIds(),
    skipRows(),
  ]);
  const done = new Set(audited);
  const stale = new Set(skips.filter((s) => !skipIsRetryable(s.discharged_at)).map((s) => s.encounter_id));
  const out: { encounterId: string; dischargedAt: string | null }[] = [];
  for (const c of closed) {
    if (done.has(c.encounterId) || stale.has(c.encounterId)) continue;
    out.push({ encounterId: c.encounterId, dischargedAt: c.dischargeDateTime });
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

    const queue = await candidateQueue();
    if (!queue.length) {
      return NextResponse.json({
        ok: true, mode: 'sweep', engine: IPD_EPISODE_ENGINE_VERSION, caughtUp: true,
        queueLength: 0, candidatesExamined: 0, audited: 0, skipped: 0,
        skippedByReason: {}, errors: 0, processed: 0, results: [],
      });
    }

    // SEQUENTIAL, deliberately (see the box arithmetic above). No concurrency knob exists.
    // A selection skip costs one db13 read and does NOT consume a slot — `max` bounds model spend,
    // which is the only thing the box is short of.
    const { results, tally } = await runEpisodeBatch(queue, max, runEpisodeAudit);

    return NextResponse.json({
      ok: true,
      mode: 'sweep',
      engine: IPD_EPISODE_ENGINE_VERSION,
      // What this tick actually did, per §5 of the review: how many candidates were looked at, how
      // many were audited, how many were skipped and for exactly which reason, how many errored.
      queueLength: queue.length,
      candidatesExamined: tally.candidatesExamined,
      audited: tally.audited,
      skipped: tally.skipped,
      skippedByReason: tally.skippedByReason,
      errors: tally.errors,
      // `capReached` says a tick stopped on MAX_CANDIDATES_EXAMINED rather than on `max` — i.e. it
      // walked 50 candidates without filling the batch, which means the queue is mostly unqualified
      // and is worth knowing rather than inferring from a low audited count.
      examineCap: MAX_CANDIDATES_EXAMINED,
      capReached: tally.capReached,
      caughtUp: tally.exhausted && tally.audited === 0,
      processed: results.length,
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
