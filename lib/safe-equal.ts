import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string compare for credentials (request value vs env secret).
 * False on non-string input, empty strings (an unset secret never matches) and length mismatch.
 * The length check leaks length only, which timingSafeEqual requires anyway.
 */
export function safeEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length === 0 || b.length === 0) return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
