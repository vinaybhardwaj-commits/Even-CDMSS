export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { isCareUnlocked } from '@/lib/care-cookie';
import CareBriefClient from '@/components/care/CareBriefClient';

export default async function CareBriefPage({ params }: { params: Promise<{ uid: string }> }) {
  if (process.env.CCB_ENABLED !== '1') notFound();
  if (!(await isCareUnlocked())) redirect('/care/login');
  const { uid } = await params;
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(uid)) notFound();

  return (
    <div className="mx-auto max-w-3xl px-5 py-8" style={{ fontFamily: 'system-ui, sans-serif' }}>
      <Link href="/care" className="inline-flex items-center gap-1 text-[12.5px] text-slate-500 hover:text-slate-700">
        <ArrowLeft className="h-3.5 w-3.5" /> Worklist
      </Link>
      <h1 className="mt-2 text-[19px] font-semibold text-slate-900">Care conversation brief</h1>
      <p className="mb-5 text-[12px] text-slate-400">Episode {uid}</p>
      <CareBriefClient uid={uid} />
    </div>
  );
}
