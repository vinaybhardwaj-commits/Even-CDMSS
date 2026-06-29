'use client';
import { useState, useMemo } from 'react';
import Link from 'next/link';
import { bandColor, scoreColor } from '@/lib/opd-audit-ui';

export type AuditRow = {
  id: string; time: string; doctor: string; consult: string; uid: string;
  band: string; index: number; lowVal: number; issue: string;
};

const BANDS = ['A', 'B', 'C', 'D', 'E'];

// Searchable / band-filterable / sortable list of EVERY audited note in the window —
// so any note is reachable, not just the worst-scoring ones. Client-side over rows the
// server already fetched (≤600), so search/sort is instant.
export default function AuditTable({ rows }: { rows: AuditRow[] }) {
  const [q, setQ] = useState('');
  const [band, setBand] = useState('');
  const [sort, setSort] = useState<'index' | 'time'>('index');

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let r = rows;
    if (band) r = r.filter((x) => x.band === band);
    if (needle) r = r.filter((x) => `${x.doctor} ${x.consult} ${x.issue} ${x.uid} ${x.band}`.toLowerCase().includes(needle));
    return [...r].sort((a, b) => (sort === 'index' ? a.index - b.index : b.time.localeCompare(a.time)));
  }, [rows, q, band, sort]);

  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-2.5">
        <span className="text-[11.5px] font-medium text-slate-600">All notes</span>
        <input
          value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Search doctor, diagnosis, drug, uid…"
          className="w-60 max-w-full rounded-lg border border-slate-200 px-2.5 py-1 text-[12px] text-slate-700 outline-none focus:border-brand"
        />
        <span className="flex overflow-hidden rounded-lg border border-slate-200 text-[11px]">
          <button onClick={() => setBand('')} className={`px-2 py-1 ${band === '' ? 'bg-brand text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`}>All</button>
          {BANDS.map((b) => (
            <button key={b} onClick={() => setBand(band === b ? '' : b)}
              className={`px-2 py-1 ${band === b ? 'text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`}
              style={band === b ? { background: bandColor(b) } : undefined}>{b}</button>
          ))}
        </span>
        <button onClick={() => setSort(sort === 'index' ? 'time' : 'index')}
          className="rounded-lg border border-slate-200 px-2 py-1 text-[11px] text-slate-500 hover:text-brand">
          sort: {sort === 'index' ? 'worst first' : 'newest'}
        </button>
        <span className="ml-auto text-[11px] text-slate-400">{filtered.length} of {rows.length}</span>
      </div>
      <div className="max-h-[520px] overflow-y-auto">
        <table className="w-full text-[11.5px]">
          <thead className="sticky top-0 z-10 bg-white text-[10px] text-slate-400 shadow-[0_1px_0_#f1efe9]">
            <tr>
              <th className="px-3 py-1.5 text-left font-normal">time</th>
              <th className="px-2 py-1.5 text-left font-normal">doctor</th>
              <th className="px-2 py-1.5 text-left font-normal">type</th>
              <th className="px-2 py-1.5 text-center font-normal">band</th>
              <th className="px-2 py-1.5 text-right font-normal">index</th>
              <th className="px-3 py-1.5 text-left font-normal">top issue</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id} className="border-t border-slate-50 hover:bg-slate-50">
                <td className="whitespace-nowrap px-3 py-1.5 text-slate-500">
                  <Link href={`/admin/opd-audit/${r.id}`} className="hover:text-brand">{r.time}</Link>
                </td>
                <td className="whitespace-nowrap px-2 py-1.5 text-slate-700">
                  <Link href={`/admin/opd-audit/${r.id}`} className="hover:text-brand hover:underline">{r.doctor}</Link>
                </td>
                <td className="whitespace-nowrap px-2 py-1.5 text-slate-400">{r.consult}</td>
                <td className="px-2 py-1.5 text-center"><span className="rounded px-1.5 py-0.5 text-[10px] font-medium text-white" style={{ background: bandColor(r.band) }}>{r.band}</span></td>
                <td className="px-2 py-1.5 text-right font-medium" style={{ color: scoreColor(r.index) }}>{r.index}</td>
                <td className="px-3 py-1.5">
                  <Link href={`/admin/opd-audit/${r.id}`} className="text-slate-600 hover:text-brand hover:underline">{r.issue}</Link>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-[12px] text-slate-400">No notes match.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
