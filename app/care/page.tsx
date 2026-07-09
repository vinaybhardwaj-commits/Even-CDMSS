export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { ArrowRight, MessageSquareHeart, ClipboardCheck, ListChecks } from 'lucide-react';
import { isCareUnlocked } from '@/lib/care-cookie';
import { sql } from '@/lib/db';
import { CCB_ENGINE_VERSION } from '@/lib/ccb-brief-core';
import { OPD_ENGINE_VERSIONS_CURRENT } from '@/lib/opd-note-audit-core';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const APP = process.env.APP_SOURCE || 'standalone';

/**
 * Managed Care — the chooser home for the /care surface (PRD §4). Two purpose-built sub-modules
 * that share the care-manager auth + CAT shell: member-centric Care Conversation Briefs and
 * doctor-centric OPD Audit Triage. Deep CCB routes stay put.
 */
export default async function ManagedCareHome() {
  if (process.env.CCB_ENABLED !== '1') notFound();
  if (!(await isCareUnlocked())) redirect('/care/login');

  // Live "needs attention" counts (best-effort; each independently soft-fails to null).
  const [briefsR, triageR] = await Promise.all([
    run(`SELECT count(DISTINCT individual_uid)::int n FROM ccb_briefs
         WHERE engine_version = $1 AND pitch_allowed = true AND individual_uid IS NOT NULL`, [CCB_ENGINE_VERSION]).catch(() => []),
    run(`SELECT count(DISTINCT doctor_uid)::int n FROM opd_note_audits
         WHERE app_source = $1 AND engine_version = ANY($2)
           AND (note_date AT TIME ZONE 'Asia/Kolkata')::date =
               (SELECT max((note_date AT TIME ZONE 'Asia/Kolkata')::date) FROM opd_note_audits WHERE app_source = $1 AND engine_version = ANY($2))`,
      [APP, [...OPD_ENGINE_VERSIONS_CURRENT]]).catch(() => []),
  ]);
  const briefsCount = Number((briefsR as Record<string, unknown>[])[0]?.n ?? 0);
  const triageCount = Number((triageR as Record<string, unknown>[])[0]?.n ?? 0);

  const cards = [
    {
      href: '/care/briefs',
      icon: MessageSquareHeart,
      title: 'Care Conversation Briefs',
      desc: 'Look up a member and prep a grounded call — or work today’s flagged list. Member-centric.',
      count: briefsCount, countLabel: 'members flagged', tint: 'violet',
    },
    {
      href: '/care/triage',
      icon: ClipboardCheck,
      title: 'OPD Audit Triage',
      desc: 'Clear last night’s audit signals doctor-by-doctor: kill the noise, decide what matters, route the real ones. Doctor-centric.',
      count: triageCount, countLabel: 'doctors audited', tint: 'sky',
    },
    {
      href: '/care/review',
      icon: ListChecks,
      title: 'Review Mode',
      desc: 'Keyboard-first gold-label triage — adjudicate audit findings fast to build the reviewed standard. Pick your reviewer identity to start.',
      count: 0, countLabel: '', tint: 'emerald',
    },
  ] as const;

  const tintClasses: Record<string, { badge: string; icon: string }> = {
    violet: { badge: 'bg-violet-100 text-violet-800', icon: 'text-violet-500' },
    sky: { badge: 'bg-sky-100 text-sky-800', icon: 'text-sky-500' },
    emerald: { badge: 'bg-emerald-100 text-emerald-800', icon: 'text-emerald-500' },
  };

  return (
    <div className="mx-auto max-w-3xl px-5 py-8" style={{ fontFamily: 'system-ui, sans-serif' }}>
      <div className="flex items-center gap-2">
        <h1 className="text-[20px] font-semibold text-slate-900">Managed Care</h1>
        <span className="rounded-full bg-teal-50 px-2 py-0.5 text-[11px] text-teal-700">Advisory · care management</span>
      </div>
      <p className="mt-0.5 text-[12.5px] text-slate-500">Two rooms, one team. Pick where the work is.</p>

      <div className="mt-5 grid gap-3.5 sm:grid-cols-2">
        {cards.map((c) => {
          const Icon = c.icon;
          const t = tintClasses[c.tint];
          return (
            <Link key={c.href} href={c.href}
              className="group flex flex-col rounded-2xl border border-slate-200 bg-white p-4 transition hover:border-slate-300 hover:shadow-sm">
              <div className="flex items-center justify-between">
                <Icon className={`h-5 w-5 ${t.icon}`} />
                {c.count > 0 && (
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${t.badge}`}>
                    {c.count} {c.countLabel}
                  </span>
                )}
              </div>
              <div className="mt-3 flex items-center gap-1.5 text-[15px] font-semibold text-slate-900">
                {c.title}
                <ArrowRight className="h-3.5 w-3.5 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-slate-500" />
              </div>
              <p className="mt-1 text-[12.5px] leading-relaxed text-slate-500">{c.desc}</p>
            </Link>
          );
        })}
      </div>

      {process.env.CONCORDANCE_ENABLED === '1' && (
        <Link href="/concordance"
          className="mt-3.5 flex items-center gap-2 rounded-2xl border border-slate-200 bg-white p-4 text-[13px] text-slate-600 transition hover:border-slate-300 hover:shadow-sm">
          <span className="font-semibold text-slate-900">Concordance</span>
          <span className="text-slate-400">— sanity-check a member's lab result before a call.</span>
          <ArrowRight className="ml-auto h-3.5 w-3.5 text-slate-300" />
        </Link>
      )}

      <p className="mt-5 text-[11.5px] text-slate-400">
        Advisory throughout — never a clinician score. Audit signals are a high-sensitivity screen; nothing reaches a doctor until a care manager validates and routes it.
      </p>
    </div>
  );
}
