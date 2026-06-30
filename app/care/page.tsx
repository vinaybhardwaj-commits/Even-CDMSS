export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { isCareUnlocked } from '@/lib/care-cookie';
import { sql } from '@/lib/db';
import PullMember from '@/components/care/PullMember';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

type Row = {
  presc_uid: string; date: string | null; coverage: string | null; priority: string | null;
  pitch_allowed: boolean | null; citation_coverage_pct: number | null; n_findings: number | null;
};

export default async function CareWorklist() {
  if (process.env.CCB_ENABLED !== '1') notFound();
  if (!(await isCareUnlocked())) redirect('/care/login');

  let rows: Row[] = [];
  try {
    rows = (await run(
      `SELECT presc_uid,
              to_char(note_date AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS date,
              coverage, priority, pitch_allowed, citation_coverage_pct, n_findings
       FROM ccb_briefs
       ORDER BY pitch_allowed DESC NULLS LAST, citation_coverage_pct DESC NULLS LAST, created_at DESC
       LIMIT 100`,
    )) as Row[];
  } catch { rows = []; }

  return (
    <div className="mx-auto max-w-4xl px-5 py-8" style={{ fontFamily: 'system-ui, sans-serif' }}>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[20px] font-semibold text-slate-900">Care Conversation Brief</h1>
          <p className="text-[12.5px] text-slate-500">Worklist — surgical/specialist candidates first. Advisory; not a clinician assessment.</p>
        </div>
      </div>

      <div className="mt-5"><PullMember /></div>

      <div className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-left text-[12.5px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="px-3 py-2 font-medium">Date</th>
              <th className="px-3 py-2 font-medium">Coverage</th>
              <th className="px-3 py-2 font-medium">Priority</th>
              <th className="px-3 py-2 font-medium">Pitch</th>
              <th className="px-3 py-2 font-medium">Grounded</th>
              <th className="px-3 py-2 font-medium">Findings</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400">No briefs yet. Pull a member above, or wait for the daily batch.</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.presc_uid} className={`border-t border-slate-100 hover:bg-slate-50 ${r.pitch_allowed ? 'bg-violet-50/30' : ''}`}>
                <td className="px-3 py-2 text-slate-700">{r.date || '—'}</td>
                <td className="px-3 py-2">{r.coverage === 'rich' ? <span className="text-teal-700">Rich</span> : <span className="text-slate-400">Order-only</span>}</td>
                <td className="px-3 py-2 capitalize text-slate-600">{r.priority || '—'}</td>
                <td className="px-3 py-2">{r.pitch_allowed ? <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-800">On</span> : <span className="text-slate-300">—</span>}</td>
                <td className="px-3 py-2 text-slate-600">{r.citation_coverage_pct != null ? `${r.citation_coverage_pct}%` : '—'}</td>
                <td className="px-3 py-2 text-slate-600">{r.n_findings ?? '—'}</td>
                <td className="px-3 py-2 text-right"><Link href={`/care/${r.presc_uid}`} className="text-teal-700 hover:underline">Open →</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
