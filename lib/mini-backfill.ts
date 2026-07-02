/**
 * lib/mini-backfill.ts — state + gating for the AUTONOMOUS mini-pipeline backfill.
 *
 * The autopilot slowly audits db13 OPD history BACKWARDS in time on the Mac-mini
 * (engine `<prod>-<tag>`, default tag 'mini'), inside a compute window so the mini
 * is free for research during the day:
 *   · window 'night'  → runs only 00:00–05:00 IST (V asleep)
 *   · window 'always' → runs on every cron tick (V's daytime switch)
 * All state lives in the EXISTING app_settings key/value table — no migration.
 *
 * Keys: mini_backfill_enabled ('1'/'0') · mini_backfill_window ('night'|'always') ·
 * mini_backfill_cursor (day being worked, marches backwards) · mini_backfill_floor
 * (stop day; default = first db13 note, 2024-03-25) · mini_backfill_tag (engine
 * suffix; change it to re-audit a period with a new run, e.g. 'mini2') ·
 * mini_backfill_n (notes per tick, ≤4) · mini_backfill_lock (soft lock ISO ts) ·
 * mini_backfill_last (last tick summary json, for the admin module).
 */
import { sql } from './db';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

export const MB_KEYS = {
  enabled: 'mini_backfill_enabled',
  window: 'mini_backfill_window',
  cursor: 'mini_backfill_cursor',
  floor: 'mini_backfill_floor',
  tag: 'mini_backfill_tag',
  n: 'mini_backfill_n',
  lock: 'mini_backfill_lock',
  last: 'mini_backfill_last',
  prod: 'mini_backfill_prod',   // '1' → write the PLAIN prod engine version (0.6), visible on dashboards
} as const;

export const MB_DEFAULT_FLOOR = '2024-03-25'; // first auditable db13 OPD note
export const MB_LOCK_TTL_MS = 4.5 * 60 * 1000; // soft lock: ticks every 5 min, runs ≤ ~4.5 min

export interface MiniBackfillState {
  enabled: boolean;
  window: 'night' | 'always';
  cursor: string | null;   // null = not started; autopilot seeds it on first tick
  floor: string;
  tag: string;
  n: number;
  lock: string | null;
  last: Record<string, unknown> | null;
  prod: boolean;   // write plain prod engine version (correct dashboards) vs isolated '-<tag>'
}

export async function getSettings(keys: string[]): Promise<Record<string, string>> {
  const rows = await run(
    `SELECT key, value FROM app_settings WHERE key = ANY($1)`, [keys],
  ).catch(() => [] as Record<string, unknown>[]);
  const out: Record<string, string> = {};
  for (const r of rows) out[String(r.key)] = String(r.value ?? '');
  return out;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await run(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );
}

export async function readState(): Promise<MiniBackfillState> {
  const s = await getSettings(Object.values(MB_KEYS));
  let last: Record<string, unknown> | null = null;
  try { last = s[MB_KEYS.last] ? JSON.parse(s[MB_KEYS.last]) : null; } catch { last = null; }
  return {
    enabled: s[MB_KEYS.enabled] === '1',
    window: s[MB_KEYS.window] === 'always' ? 'always' : 'night',
    cursor: /^\d{4}-\d{2}-\d{2}$/.test(s[MB_KEYS.cursor] || '') ? s[MB_KEYS.cursor] : null,
    floor: /^\d{4}-\d{2}-\d{2}$/.test(s[MB_KEYS.floor] || '') ? s[MB_KEYS.floor] : MB_DEFAULT_FLOOR,
    tag: (s[MB_KEYS.tag] || 'mini').replace(/[^a-z0-9-]/gi, '').slice(0, 24) || 'mini',
    n: Math.max(1, Math.min(4, Number(s[MB_KEYS.n]) || 4)),
    lock: s[MB_KEYS.lock] || null,
    last,
    prod: s[MB_KEYS.prod] === '1',
  };
}

/** IST hour (0–23) right now. */
export function istHour(now: Date = new Date()): number {
  return Number(now.toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }));
}

/** Is the compute window open? night = 00:00–04:59 IST; always = any time. */
export function windowOpen(win: 'night' | 'always', now: Date = new Date()): boolean {
  if (win === 'always') return true;
  const h = istHour(now);
  return h >= 0 && h < 5;
}

/** Soft lock: true if a fresher-than-TTL lock exists (another tick still running). */
export function lockHeld(lockTs: string | null, now: Date = new Date()): boolean {
  if (!lockTs) return false;
  const t = Date.parse(lockTs);
  return Number.isFinite(t) && now.getTime() - t < MB_LOCK_TTL_MS;
}

export function prevDay(day: string): string {
  const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10);
}
