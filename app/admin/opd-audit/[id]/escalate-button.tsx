'use client';
import { useState } from 'react';

// PRD §9.5 — "Escalate to Gemini". A quiet whole-note action. The portable package (de-identified
// note text + CDMSS findings + domain scores + engine_version + a fixed re-audit prompt) is
// pre-built server-side and handed in as `pkg`. This does Copy + Download <uid>-escalation.md —
// no network call, no structured import (the consumer is the CM's own Gemini, then Claude + this repo).

export function EscalateButton({ pkg, uid }: { pkg: string; uid: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(pkg);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked — download still works */ }
  }

  function download() {
    const blob = new Blob([pkg], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${uid || 'note'}-escalation.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex items-center gap-1.5">
      <button type="button" onClick={copy} title="Copy the de-identified note + audit + re-audit prompt for your own Gemini"
        className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[10.5px] font-medium text-slate-500 hover:border-brand/40 hover:text-brand">
        {copied ? 'Copied' : 'Escalate to Gemini · copy'}
      </button>
      <button type="button" onClick={download} title="Download <uid>-escalation.md"
        className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[10.5px] font-medium text-slate-500 hover:border-brand/40 hover:text-brand">
        ↓ .md
      </button>
    </div>
  );
}
