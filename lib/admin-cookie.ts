import { cookies } from 'next/headers';
import { timingSafeEqual } from 'crypto';

export const ADMIN_COOKIE = 'cat_admin';

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  try { return timingSafeEqual(ab, bb); } catch { return false; }
}

// Fail-closed gate for the observability surface (which exposes raw clinical
// queries / possible PHI). Locked unless the cat_admin cookie matches ADMIN_TOKEN.
// If ADMIN_TOKEN is unset, the surface stays LOCKED (never open by default).
export async function isAdminUnlocked(): Promise<boolean> {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return false;
  const jar = await cookies();
  const val = jar.get(ADMIN_COOKIE)?.value || '';
  return !!val && safeEq(val, token);
}

export function adminTokenConfigured(): boolean {
  return !!process.env.ADMIN_TOKEN;
}
