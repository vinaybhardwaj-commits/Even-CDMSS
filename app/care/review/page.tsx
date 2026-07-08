export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { redirect, notFound } from 'next/navigation';
import { isCareUnlocked } from '@/lib/care-cookie';
import ReviewSession from './review-session';

/**
 * Review Mode (Gold-Label Review-Mode PRD §2) — full-screen, keyboard-first, one FINDING per screen.
 * Lives under /care behind the SAME care-manager gate as /care/triage (§1.4 — no new auth). The
 * client component owns the queue fetch, the roster-driven identity picker, and the label POSTs.
 */
export default async function ReviewPage() {
  if (process.env.CCB_ENABLED !== '1') notFound();
  if (!(await isCareUnlocked())) redirect('/care/login');
  return <ReviewSession />;
}
