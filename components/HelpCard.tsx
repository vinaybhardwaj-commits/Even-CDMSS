'use client';

import { useState, useEffect } from 'react';
import { Info, X, ChevronDown, ChevronUp } from 'lucide-react';

type Props = {
  storageKey: string;
  title: string;
  body?: string;
  bullets: string[];
  defaultOpen?: boolean;
};

export default function HelpCard({ storageKey, title, body, bullets, defaultOpen = true }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const [dismissed, setDismissed] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const d = localStorage.getItem(`help.${storageKey}.dismissed`);
    if (d === '1') setDismissed(true);
    const o = localStorage.getItem(`help.${storageKey}.open`);
    if (o === '0') setOpen(false);
    setHydrated(true);
  }, [storageKey]);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (typeof window !== 'undefined') localStorage.setItem(`help.${storageKey}.open`, next ? '1' : '0');
  }
  function dismiss() {
    setDismissed(true);
    if (typeof window !== 'undefined') localStorage.setItem(`help.${storageKey}.dismissed`, '1');
  }

  if (!hydrated || dismissed) return null;

  return (
    <div className="mb-4 rounded-xl border border-sky-200 bg-sky-50/70 text-sm">
      <button onClick={toggle} className="flex w-full items-center gap-2 px-3 py-2 text-left">
        <Info className="h-4 w-4 shrink-0 text-sky-700" />
        <span className="flex-1 font-semibold text-sky-900">{title}</span>
        {open ? <ChevronUp className="h-4 w-4 text-sky-700" /> : <ChevronDown className="h-4 w-4 text-sky-700" />}
        <button
          onClick={(e) => { e.stopPropagation(); dismiss(); }}
          aria-label="Dismiss help"
          className="rounded-full p-1 text-sky-600 hover:bg-sky-100"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </button>
      {open && (
        <>
          {body && (
            <p className="px-9 pb-3 text-sky-900/90 leading-snug">{body}</p>
          )}
          <ul className="ml-9 list-disc space-y-1 pb-3 pr-4 text-sky-900">
            {bullets.map((b, i) => <li key={i}>{b}</li>)}
          </ul>
        </>
      )}
    </div>
  );
}
