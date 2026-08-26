/**
 * lib/preop/gate.ts — the one place the pre-op surface's gate is defined.
 *
 * It lives in lib/ rather than beside the routes because a Next.js route module may
 * export ONLY route handlers and route config: exporting a helper from
 * app/api/.../route.ts type-checks under `tsc --noEmit` and then fails `next build` with
 * "not a valid Route export field". Caught by the production build on 26 Aug, which is
 * exactly the class of defect the SREWS `surgeryDateKey` lesson is about — the app graph
 * is checked by a different tool than the library graph.
 *
 * Every consumer re-checks independently: the board page, the case page, and all three
 * read/write routes call this rather than trusting whoever called them.
 */
import { isCareUnlocked } from '../care-cookie';
import { isAdminUnlocked } from '../admin-cookie';

/** Both flags, ANDed. PREOP_SURFACE_ENABLED ships OFF; V flips it after deploy verification. */
export function preopSurfaceEnabled(): boolean {
  return process.env.CCB_ENABLED === '1' && process.env.PREOP_SURFACE_ENABLED === '1';
}

/** The care-manager cookie, or an admin session. Fail-closed on any error. */
export async function preopAuthed(): Promise<boolean> {
  try { if (await isCareUnlocked()) return true; } catch { /* fall through */ }
  try { return await isAdminUnlocked(); } catch { return false; }
}

/** Flag state, reported on every payload — never a matter of belief on a clinical screen. */
export function preopFlagState(): { extraction: 'on' | 'off'; narrative: 'on' | 'off' } {
  return {
    extraction: process.env.PREOP_EXTRACT_ENABLED === '1' ? 'on' : 'off',
    narrative: process.env.PREOP_NARRATIVE_ENABLED === '1' ? 'on' : 'off',
  };
}
