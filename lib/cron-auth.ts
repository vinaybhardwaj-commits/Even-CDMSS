/**
 * Cron caller auth. The `x-vercel-cron` request header is NOT a credential: any client can send it.
 * Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` when CRON_SECRET is set, so the bearer is
 * the only cron proof. Never read `x-vercel-cron` in an auth decision (guarded by a test).
 */
export function hasCronBearer(req: { headers: { get(name: string): string | null } }): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return (req.headers.get('authorization') || '') === `Bearer ${secret}`;
}
