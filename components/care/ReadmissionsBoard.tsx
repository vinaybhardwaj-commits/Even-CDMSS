'use client';

/**
 * /care/readmissions — the flat case-card list (CDMSS-READMISSIONS-R1-PRD v1.1 §3,
 * 17 Aug 2026; supersedes the Phase-2 lane board). Renders what the readmission agent
 * already stored, one card per finding: identity (KX-first), the index→readmit path with
 * the extracted diagnosis / indication / procedure, a situation line when true, eight
 * artefact-coverage chips, the Medical-justification + `Return stay bill` cells (R3: the return
 * stay's hospital bill, computed fresh by the list route on every load — never stored, never the
 * encounter id), the two advisory judgements ONLY as exception lines when they say something
 * (R4.1, R41-1: suspected red, not_suggested quiet, unknown silent; the negligence line carries
 * the advisory caveat), the R4.1 case line under the path (the stored account's first sentence,
 * R41-3), and ONE button that downloads a `.md` case brief built client-side (R3: Part 2 carries
 * both stays' bills by service type).
 *
 * R4 (CDMSS-READMISSIONS-R4-PRD v1.0, R4-1): clicking anywhere on a card (except its button)
 * opens the case page /care/readmissions/case/[key] — the dedup key, already the card key.
 *
 * READ-ONLY. Nothing on this page mutates a finding — the download is the only transmit
 * (decision 8), it calls no model, and it writes nothing. The route payload is still
 * lane-grouped (decision 11); this file flattens with `lanes.flatMap` and sorts
 * review-first (sortForCardList). The held-out sample and the not-auditable rows sit
 * behind one toggle, default off (decision 2). Tiles are gone (decision 1).
 *
 * ALL judgement lives in lib/readmission-surface-core.ts (sort, chips, situation line,
 * justification mapping, identity precedence) and lib/readmission/brief.ts (the brief) so
 * it is unit-tested; this file is markup and fetch. Missing data renders `unknown`, never
 * a guess; a failed case fetch still downloads a thinner brief from the card row alone.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { RotateCw, Download } from 'lucide-react';
import {
  BILLS_UNAVAILABLE_NOTICE, cardIdentityLine, caseHref, chipText, coverageChips, countsLine, isHeldOut, isReviewFinding,
  judgementExceptionLines, justificationCell, pathSegments, returnStayBill, returnStayBillSub, situationLine,
  sortForCardList,
  type ChipState, type LaneGroup, type SurfaceFinding, type SurfaceTiles,
} from '@/lib/readmission-surface-core';
import { composeBrief, type BillBreakdown, type ExtractSubset } from '@/lib/readmission/brief';

type BoardData = {
  ok: boolean;
  lanes: LaneGroup[];
  tiles: SurfaceTiles;
  pendingCount: number;
  reviewCount: number;
  total: number;
  namesResolved: boolean;
  /** R3: the batched bill fetch answered. Absent (older route) reads as resolved. */
  billsResolved?: boolean;
  error?: string;
};

export type CaseDetail = {
  ok: boolean;
  row: SurfaceFinding;
  indexExtract: ExtractSubset | null;
  readmitExtract: ExtractSubset | null;
  /** R3: both stays' bills by service_type — the brief's Part 2 tables. */
  indexBill?: BillBreakdown | null;
  readmitBill?: BillBreakdown | null;
};

/** R2 five states (constraints §4b): present solid · empty / absent / unknown hollow
 *  (the copy tells them apart — see chipText) · n/a greyed. Exhaustive by the compiler. */
const CHIP_STATE: Record<ChipState, string> = {
  present: 'bg-emerald-100 text-emerald-800 border border-emerald-200',
  empty: 'bg-transparent text-amber-800 border border-amber-300',
  absent: 'bg-transparent text-slate-600 border border-slate-300',
  unknown: 'bg-transparent text-slate-500 border border-slate-200 border-dashed',
  'n/a': 'bg-slate-50 text-slate-400 border border-slate-100 line-through',
};

/** IST clock stamp for the brief header — the only clock the composer sees. */
function istStamp(): string {
  const d = new Date(Date.now() + 5.5 * 3_600_000);
  return d.toISOString().replace('T', ' ').slice(0, 16);
}

/** The escalate-button Blob pattern (app/admin/opd-audit/[id]/escalate-button.tsx). */
function saveMarkdown(filename: string, markdown: string) {
  const blob = new Blob([markdown], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Fetch the pinned case detail, overlay the card's KX identity (decision 13 — the case
 * route does not re-join it), compose, download. Any failure on the fetch degrades to a
 * brief built from the card row alone; nothing here can leave the user without a file.
 */
export async function downloadBrief(card: SurfaceFinding): Promise<void> {
  let detail: CaseDetail | null = null;
  try {
    const r = await fetch(`/api/care/readmissions/case?dedup_key=${encodeURIComponent(card.dedupKey)}`);
    if (r.ok) {
      const j = (await r.json()) as CaseDetail;
      if (j.ok && j.row) detail = j;
    }
  } catch { /* thinner brief below */ }
  // R3: the case route's returnBill is the fresher read (same state rule); the card's is the
  // fallback so a thinner brief still says what the card said.
  const row: SurfaceFinding = detail
    ? { ...detail.row, patientName: card.patientName, ageGender: card.ageGender ?? detail.row.ageGender ?? null, indexCase: detail.row.indexCase ?? card.indexCase ?? null, returnBill: detail.row.returnBill ?? card.returnBill ?? null }
    : card;
  const brief = composeBrief({
    row,
    indexExtract: detail?.indexExtract ?? null,
    readmitExtract: detail?.readmitExtract ?? null,
    indexBill: detail?.indexBill ?? null,
    readmitBill: detail?.readmitBill ?? null,
    generatedAt: istStamp(),
    detailFetched: detail != null,
  });
  saveMarkdown(brief.filename, brief.markdown);
}

function Cell({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-line bg-canvas px-3 py-2">
      <div className="text-[10.5px] uppercase tracking-wider text-slate-500">{k}</div>
      <div className="mt-0.5 text-[12.5px] font-semibold text-slate-900">{v}</div>
      {sub && <div className="mt-0.5 text-[10.5px] italic text-slate-500">{sub}</div>}
    </div>
  );
}

function CaseCard({ f }: { f: SurfaceFinding }) {
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const audited = f.auditStatus === 'audited';
  const situation = situationLine(f);
  const review = isReviewFinding(f);
  const href = caseHref(f.dedupKey);

  // R4-1: the WHOLE card opens the case page; the download button below stops propagation so a
  // click on it never navigates. Keyboard: Enter / Space on the focused card.
  const open = () => router.push(href);
  return (
    <div role="link" tabIndex={0} aria-label={`Open case ${cardIdentityLine(f)}`}
      onClick={open}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
      className={`mb-3 cursor-pointer rounded-xl border bg-paper p-4 shadow-card transition hover:border-brand/40 focus:outline-none focus:ring-2 focus:ring-brand/30 ${review ? 'border-red-200' : 'border-line'}`}>
      {/* Zone 1 — identity (KX-first) */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[14.5px] font-semibold text-slate-900">{cardIdentityLine(f)}</div>
          {/* Zone 2 — path */}
          <div className="mt-1 text-[12.5px] text-slate-600">
            {pathSegments(f).map((seg, i) => (
              <span key={i}>{i > 0 && ' · '}{i === 0 ? <b className="font-semibold text-slate-900">{seg}</b> : seg}</span>
            ))}
          </div>
          {situation && <div className="mt-1 text-[12px] font-medium text-red-700">{situation}</div>}
          {/* R4.1 (R41-3) — the case line: the first sentence of the stored, code-validated account */}
          {f.caseLine && <div className="mt-1 text-[12.5px] italic text-slate-700">{f.caseLine}</div>}
        </div>
      </div>

      {/* Zone 3 — coverage chips */}
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {coverageChips(f).map((c) => (
          <span key={c.key} title={`${c.label}: ${c.state}`}
            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${CHIP_STATE[c.state]}`}>
            {chipText(c)}
          </span>
        ))}
      </div>

      {/* Zone 4 — R4.1 (R41-1/2): the two always-valued cells; judgements only as exception lines */}
      {audited ? (
        <>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Cell k="Medical justification" v={justificationCell(f)} />
            <Cell k="Return stay bill" v={returnStayBill(f)} sub={returnStayBillSub(f)} />
          </div>
          {judgementExceptionLines(f).map((l) => (
            <div key={l.key} className={`mt-2 text-[12px] ${l.tone === 'red' ? 'font-medium text-red-700' : 'text-slate-500'}`}>
              {l.text}{l.caveat && <span className="ml-1 text-[10.5px] italic text-slate-400">— {l.caveat}</span>}
            </div>
          ))}
        </>
      ) : (
        // §3: one line. The qualifier names WHY for the two statuses the toggle reveals —
        // a held-out row will never be audited, by design, and saying only "not yet" would
        // promise otherwise (flagged in the R1 report as a one-line deviation).
        <p className="mt-3 text-[12px] text-slate-500">
          Not yet audited
          {f.auditStatus === 'excluded' && <span className="text-slate-400"> · held out by design</span>}
          {f.auditStatus === 'not_auditable' && <span className="text-slate-400"> · not auditable{f.notAuditableReason ? ` — ${f.notAuditableReason}` : ''}</span>}
        </p>
      )}

      {/* Action row */}
      <div className="mt-3 flex items-center justify-end">
        <button type="button" disabled={busy}
          onClick={(e) => { e.stopPropagation(); setBusy(true); void downloadBrief(f).finally(() => setBusy(false)); }}
          onKeyDown={(e) => e.stopPropagation()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-2.5 py-1 text-[12px] font-medium text-slate-600 transition hover:border-brand/40 hover:text-brand disabled:opacity-50">
          <Download className="h-3 w-3" />Download case brief · .md
        </button>
      </div>
    </div>
  );
}

export default function ReadmissionsBoard() {
  const [data, setData] = useState<BoardData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showHeldOut, setShowHeldOut] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const r = await fetch('/api/care/readmissions/list');
      const j = (await r.json()) as BoardData;
      if (!r.ok || !j.ok) throw new Error(String(j.error || `status ${r.status}`));
      setData(j);
    } catch (e) { setErr(String((e as Error).message)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Decision 11: the payload stays lane-grouped; the board flattens and sorts here.
  const flat = useMemo(() => sortForCardList((data?.lanes ?? []).flatMap((g) => g.rows)), [data]);
  const heldOutCount = useMemo(() => flat.filter(isHeldOut).length, [flat]);
  const visible = useMemo(() => (showHeldOut ? flat : flat.filter((r) => !isHeldOut(r))), [flat, showHeldOut]);

  return (
    <div className="mx-auto max-w-content px-5 py-7">
      <div className="mb-3.5 text-[12px] text-slate-500">
        <Link href="/care" className="font-medium text-brand">Managed Care</Link> › Readmissions
      </div>

      <div className="flex items-center gap-2">
        <h1 className="font-serif text-[23px] font-semibold tracking-tight text-slate-900">Readmissions</h1>
        <span className="rounded-full bg-brand-faint px-2.5 py-0.5 text-[11px] font-medium text-brand-dark">Advisory · care management</span>
        <button onClick={() => void load()} disabled={loading}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-[12px] text-slate-600 transition hover:bg-slate-50 disabled:opacity-50">
          <RotateCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />Refresh
        </button>
      </div>
      <p className="mt-1 text-[12.5px] text-slate-500">
        Every readmission the agent has audited, one card each. The agent proposes; you decide what to escalate.
      </p>

      {data && (
        <p className="mt-4 text-[12.5px] text-slate-700">{countsLine(data.reviewCount, data.pendingCount)}</p>
      )}

      {err && <p className="mt-4 text-[12px] text-red-700">{err}</p>}
      {loading && !data && <p className="mt-6 text-[13px] text-slate-400">Loading…</p>}

      {data && data.total > 0 && !data.namesResolved && (
        <p className="mt-1 text-[11.5px] text-slate-500">
          Patient names are unavailable right now — cards are identified by UHID.
        </p>
      )}
      {data && data.total > 0 && data.billsResolved === false && (
        <p className="mt-1 text-[11.5px] text-slate-500">{BILLS_UNAVAILABLE_NOTICE}</p>
      )}
      {data && data.total === 0 && !loading && (
        <p className="mt-6 text-[13px] text-slate-500">
          No audited findings yet{data.pendingCount > 0 ? ' — the sweep has not reached the detected ones.' : '.'}
        </p>
      )}

      {data && heldOutCount > 0 && (
        <label className="mt-3 flex items-center gap-2 text-[12px] text-slate-600">
          <input type="checkbox" checked={showHeldOut} onChange={(e) => setShowHeldOut(e.target.checked)} className="h-3.5 w-3.5" />
          Show held-out and not-auditable cases ({heldOutCount})
        </label>
      )}

      <div className="mt-4">
        {visible.map((f) => <CaseCard key={f.dedupKey} f={f} />)}
      </div>

      <p className="mt-7 border-t border-line pt-3.5 text-[11.5px] leading-relaxed text-slate-500">
        Advisory throughout — never a clinician score, never a court or council finding. The agent is a high-sensitivity
        screen: it surfaces what to look at and shows its evidence. Oncology, dialysis and obstetric readmissions are
        expected by design and held out of the default view.{' '}
        <b className="font-semibold text-slate-700">The brief is the only transmit; nothing on this page changes a finding.</b>
      </p>
    </div>
  );
}
