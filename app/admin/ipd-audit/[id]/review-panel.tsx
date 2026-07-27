'use client';
/**
 * "Your review" (PRD §6.4) — Dr. Binita's overall note on one audit.
 *
 * Solves her stated problem: *"I will keep losing sight of which one I have seen."* Saving writes
 * one `ipd_audit_feedback` row with `kind='review'`; that row's EXISTENCE is the Reviewed marker on
 * the list, so there is no separate flag to drift out of sync with the note.
 *
 * Client component because it owns a textarea and a fetch. Composed into CaseAuditReport through
 * its `reviewPanel` slot by report-with-triage.tsx — the same posture as `findingActions`, so the
 * shared renderer stays byte-identical for every other caller.
 */
import { useState } from 'react';

export interface ExistingReview { note: string; reviewedByName: string | null; at: string | null }

export default function ReviewPanel({ auditId, initial }: { auditId: string; initial: ExistingReview | null }) {
  const [note, setNote] = useState(initial?.note ?? '');
  const [saved, setSaved] = useState<ExistingReview | null>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = note.trim() !== (saved?.note ?? '').trim();

  const save = async () => {
    if (!note.trim()) { setError('Write something first — an empty review is not a review.'); return; }
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/ipd-audit/review', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ auditId, note }),
      });
      const json = (await res.json()) as { ok?: boolean; review?: ExistingReview; error?: string };
      if (!res.ok || !json.ok) { setError(json.error ?? 'Could not save.'); return; }
      setSaved(json.review ?? { note: note.trim(), reviewedByName: null, at: new Date().toISOString() });
    } catch {
      setError('Could not save — your text is still here.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[13.5px] font-semibold text-slate-900">Your review</h3>
        {saved && (
          <span className="text-[11.5px] text-slate-400">
            {saved.reviewedByName ? `${saved.reviewedByName} · ` : ''}
            {saved.at ? new Date(saved.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : ''}
          </span>
        )}
      </div>
      <p className="mt-0.5 text-[11.5px] text-slate-400">
        Your own note on this case. Saving also marks it reviewed in the list, so you can see what you have already read.
      </p>

      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={4}
        placeholder="What did you make of this discharge summary?"
        className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-[13px]"
      />

      {error && <p className="mt-2 rounded-lg bg-red-50 px-3 py-1.5 text-[12.5px] text-red-700">{error}</p>}

      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={save}
          disabled={busy || !dirty}
          className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
        >
          {busy ? 'Saving…' : saved ? 'Update review' : 'Save review'}
        </button>
        {!dirty && saved && <span className="text-[11.5px] text-emerald-700">Saved</span>}
      </div>
    </section>
  );
}
