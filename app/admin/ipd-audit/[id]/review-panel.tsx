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
import { useEffect, useState } from 'react';
// §12.4 — ONE remembered key, shared with both publish surfaces in the Scoring policy module.
import { rememberedAttribution, rememberAttribution, isValidAttribution, ATTRIBUTION_LABEL, ATTRIBUTION_HELP } from '@/lib/admin-attribution';

export interface ExistingReview { note: string; reviewedByName: string | null; at: string | null }

export default function ReviewPanel({ auditId, initial }: { auditId: string; initial: ExistingReview | null }) {
  const [note, setNote] = useState(initial?.note ?? '');
  const [saved, setSaved] = useState<ExistingReview | null>(initial);
  // §12.4 — an EXISTING review's recorded author wins; otherwise fall back to the remembered name,
  // so she types it once across both publish surfaces and every review note.
  const [reviewedBy, setReviewedBy] = useState(initial?.reviewedByName ?? '');
  useEffect(() => {
    if (!initial?.reviewedByName) setReviewedBy((v) => v || rememberedAttribution());
  }, [initial?.reviewedByName]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A name-only edit still counts as dirty — an old review saved before §12.4 has no author, and
  // adding one must be savable without touching the note.
  const dirty = note.trim() !== (saved?.note ?? '').trim()
    || reviewedBy.trim() !== (saved?.reviewedByName ?? '').trim();

  const save = async () => {
    if (!note.trim()) { setError('Write something first — an empty review is not a review.'); return; }
    if (!isValidAttribution(reviewedBy)) { setError('Add your name — it is recorded with the review.'); return; }
    setBusy(true); setError(null);
    try {
      rememberAttribution(reviewedBy);
      const res = await fetch('/api/ipd-audit/review', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ auditId, note, reviewedByName: reviewedBy.trim() }),
      });
      const json = (await res.json()) as { ok?: boolean; review?: ExistingReview; error?: string };
      if (!res.ok || !json.ok) { setError(json.error ?? 'Could not save.'); return; }
      setSaved(json.review ?? { note: note.trim(), reviewedByName: reviewedBy.trim(), at: new Date().toISOString() });
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
            {/* §12.4 — recorded name where present, 'Unknown' where absent. Reviews saved before
                attribution existed keep reading honestly; nothing is backfilled or substituted. */}
            {`${saved.reviewedByName ?? 'Unknown'} · `}
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

      <label className="mt-2 block">
        <span className="text-[12px] font-semibold text-slate-800">{ATTRIBUTION_LABEL}</span>
        <input
          value={reviewedBy}
          onChange={(e) => setReviewedBy(e.target.value)}
          placeholder="Dr Binita Priyambada"
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-[13px]"
        />
        <span className="text-[11px] text-slate-400">{ATTRIBUTION_HELP}</span>
      </label>

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
