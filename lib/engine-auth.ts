import { timingSafeEqual } from 'node:crypto';

/**
 * Machine-to-machine auth for /api/engines/*. The only credential is
 * `Authorization: Bearer <NEWCAT_ENGINE_TOKEN>`. Unset or empty env means every request is refused.
 * Compared with timingSafeEqual on equal-length buffers (unequal length is refused before the compare).
 * No query-param secret, no CRON_SECRET, no cookies, and never the x-vercel-cron header.
 */
export function hasEngineBearer(req: { headers: { get(name: string): string | null } }): boolean {
  const secret = process.env.NEWCAT_ENGINE_TOKEN;
  if (!secret) return false;
  const got = Buffer.from(req.headers.get('authorization') || '', 'utf8');
  const want = Buffer.from(`Bearer ${secret}`, 'utf8');
  if (got.length !== want.length) return false;
  return timingSafeEqual(got, want);
}
