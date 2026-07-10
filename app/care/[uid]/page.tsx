export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { redirect, notFound } from 'next/navigation';
import { isCareUnlocked } from '@/lib/care-cookie';
import CareBriefSplit from '@/components/care/CareBriefSplit';

/**
 * CCB v2 P2 — the brief screen is now split-screen: source document beside the findings,
 * full width. The CAT sidebar collapses for this route via the shell's existing `fullBleed`
 * mechanism (components/Shell.tsx), the same one Review Mode uses — no shell fork, no new layout.
 */
export default async function CareBriefPage({ params }: { params: Promise<{ uid: string }> }) {
  if (process.env.CCB_ENABLED !== '1') notFound();
  if (!(await isCareUnlocked())) redirect('/care/login');
  const { uid } = await params;
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(uid)) notFound();

  return <CareBriefSplit uid={uid} />;
}
