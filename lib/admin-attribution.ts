/**
 * Self-declared author name for governed changes (PRD §12.4, decision 16 — V, 28 Jul 2026).
 *
 * ⚠️ THIS IS AN ATTESTATION, NOT AUTHENTICATION. CDMSS admin access is a shared token with no user
 * identity attached, so a name typed into a box is not proof of who typed it. It is still worth
 * capturing: it turns an anonymous log into an accountable one, and it is what a governance record
 * needs to be readable six months later. Every label that renders this must say so — never "Verified
 * by", never "Signed by" (§12.4).
 *
 * ONE KEY, THREE PREFILL POINTS. The publish modal, the lab-packages publish panel and the IPD
 * review panel all read and write THIS key, so a name typed in any one of them prefills the other
 * two — "she types her name once, not on every publish and every review note". Defining the key
 * here rather than repeating the literal in three components is the only thing that makes that
 * guarantee hold; three copies would drift and silently split the memory in two.
 *
 * No imports, no server dependencies — safe in any client component.
 */

/** The single localStorage key. Do NOT inline this string anywhere else. */
export const ATTRIBUTION_STORAGE_KEY = 'cdmss.admin.changedBy';

/** Minimum length after trimming, enforced in the UI and again server-side. */
export const MIN_ATTRIBUTION_CHARS = 2;

/** Persist verbatim after trimming — no normalisation, no title-casing, no roster match. */
export const MAX_ATTRIBUTION_CHARS = 200;

/** The honest label and helper text, defined once so all three fields read identically (§12.4). */
export const ATTRIBUTION_LABEL = 'Your name';
export const ATTRIBUTION_HELP =
  'Recorded with this change. Self-declared — CDMSS admin access is a shared token.';

/** True when a candidate name is acceptable. Pure and total. */
export function isValidAttribution(name: unknown): boolean {
  return typeof name === 'string' && name.trim().length >= MIN_ATTRIBUTION_CHARS;
}

/**
 * Normalise for storage: trim and cap. Deliberately does NOT change case or spelling —
 * "Dr Binita Priyambada" and "binita" are both acceptable input; the point is a human-readable
 * record, not a foreign key.
 */
export function cleanAttribution(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const v = name.trim().slice(0, MAX_ATTRIBUTION_CHARS);
  return v.length >= MIN_ATTRIBUTION_CHARS ? v : null;
}

/** The server-side rejection message, shared by all three routes so the wording cannot drift. */
export const ATTRIBUTION_REQUIRED_ERROR =
  'Your name is required — it is recorded with this change. (Self-declared; admin access is a shared token.)';

/** Read the remembered name. Never throws — private mode / disabled storage yields ''. */
export function rememberedAttribution(): string {
  try {
    return typeof window === 'undefined' ? '' : (window.localStorage.getItem(ATTRIBUTION_STORAGE_KEY) ?? '');
  } catch {
    return '';
  }
}

/** Remember the name for next time. Never throws — a storage failure must not cost the save. */
export function rememberAttribution(name: string): void {
  try {
    const v = cleanAttribution(name);
    if (v && typeof window !== 'undefined') window.localStorage.setItem(ATTRIBUTION_STORAGE_KEY, v);
  } catch {
    /* storage is a convenience, never a precondition */
  }
}
