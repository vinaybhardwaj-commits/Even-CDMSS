'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';

type Chapter = { chapter: string; chunks: number; first_page: number; last_page: number };

export default function BookFilter({ book, chapters }: { book: string; chapters: Chapter[] }) {
  const [filter, setFilter] = useState('');
  const showFilter = chapters.length > 30;
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return chapters;
    return chapters.filter((c) => c.chapter.toLowerCase().includes(q));
  }, [chapters, filter]);

  return (
    <>
      {showFilter && (
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={`Filter ${chapters.length} chapters by name…`}
          className="mt-4 w-full rounded-lg border border-slate-300 bg-white p-2 text-sm shadow-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
        />
      )}
      <p className="mt-3 text-xs text-slate-400">
        Showing {filtered.length.toLocaleString()}{filtered.length !== chapters.length ? ` of ${chapters.length.toLocaleString()}` : ''}
      </p>
      <ol className="mt-3 divide-y rounded-lg border bg-white shadow-sm">
        {filtered.slice(0, 500).map((c) => (
          <li key={c.chapter}>
            <Link
              href={`/browse/${encodeURIComponent(book)}/${encodeURIComponent(c.chapter)}`}
              className="flex items-center justify-between px-4 py-2.5 hover:bg-slate-50"
            >
              <span className="text-sm text-slate-800">{c.chapter}</span>
              <span className="text-xs text-slate-400">
                {c.chunks} chunk{c.chunks !== 1 ? 's' : ''}
                {c.first_page && <> · p.{c.first_page}{c.last_page !== c.first_page ? `–${c.last_page}` : ''}</>}
              </span>
            </Link>
          </li>
        ))}
      </ol>
      {filtered.length > 500 && (
        <p className="mt-3 text-center text-xs text-slate-400">First 500 shown. Type to narrow.</p>
      )}
    </>
  );
}
