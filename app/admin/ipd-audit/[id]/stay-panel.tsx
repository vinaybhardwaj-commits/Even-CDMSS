/**
 * app/admin/ipd-audit/[id]/stay-panel.tsx — the stay-library panel on the IPD case page
 * (CDMSS-CASE-AGENTS-SPINE-PRD-v1.0-27-AUG-2026, P3 / §5).
 *
 * §5: "the case page gains the stay-library panel and renders the new engine version alongside the
 * old. The parked list / calendar / search are not deleted." So this is ADDITIVE and sits beside the
 * existing report — it replaces nothing on the page, and the gold pills keep adjudicating the report
 * they always did.
 *
 * THE PANEL'S JOB IS TO SHOW A GAP AS A GAP. The most useful thing a stay-level audit can tell a
 * reviewer is which documents it never saw, and the most dangerous thing a surface can do is let an
 * unread class look like a clean one. So every class is listed whether or not it was found, an
 * unavailable class is coloured as a WARNING rather than a success, and the reason is printed in the
 * words P2 stored ("the look for this document failed — this is not evidence the document is
 * missing" reads differently from "it is not filed", and the difference is the point).
 *
 * Read-only and server-rendered. It runs no model and offers no re-score control; the one action is
 * the run button, which posts a document id to the admin route and appends a row under a NEW engine
 * version — it can never rewrite the `ipd-discharge-audit/0.2` row this page is showing.
 */
import Link from 'next/link';
import type { StayCoverageBlock } from '@/lib/ipd-audit/stay-material';
import { stayCoverageLine } from '@/lib/ipd-audit/stay-material';
import StayAuditRunButton from './stay-run-button';

/** The sibling stay-audit row, when one has been run for this document. */
export interface StaySiblingView {
  id: string;
  engineVersion: string;
  careValueIndex: number | null;
  band: string | null;
  nFindings: number | null;
  nLowValue: number | null;
  auditedAt: string | null;
  coverage: StayCoverageBlock | null;
}

const OK = { line: '#bbe7cd', bg: '#f2fbf6', ink: '#166534' };
const GAP = { line: '#e9d7a6', bg: '#fffaf0', ink: '#b25e09' };

function ClassRow({ label, status, copy, count }: { label: string; status: string; copy: string; count: number }) {
  const ok = status === 'ok';
  const c = ok ? OK : GAP;
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 border-t border-slate-100 px-4 py-2 first:border-t-0">
      <span className="min-w-[9.5rem] text-[12px] font-semibold text-slate-700">{label}</span>
      <span
        className="rounded-full border px-2 py-0.5 text-[10.5px] font-medium"
        style={{ borderColor: c.line, background: c.bg, color: c.ink }}
      >{ok ? `${count} read` : 'not available'}</span>
      <span className="text-[11.5px] text-slate-500">{copy}</span>
    </div>
  );
}

export default function StayPanel({
  documentId, coverage, sibling, isStayRow,
}: {
  documentId: string;
  /** The coverage to render — the sibling stay row's, or this row's own when it IS the stay row. */
  coverage: StayCoverageBlock | null;
  sibling: StaySiblingView | null;
  /** True when the row being viewed is itself the stay audit (so the "other reading" is the 0.2 one). */
  isStayRow: boolean;
}) {
  return (
    <div className="mt-2 rounded-xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-100 px-4 py-2.5">
        <span className="text-[13px] font-semibold text-slate-800">The stay, document by document</span>
        <span className="text-[11px] text-slate-500">
          {isStayRow ? 'this report is the stay-level audit' : 'the report above read the discharge summary only'}
        </span>
      </div>

      {coverage ? (
        <>
          <div className="px-4 pt-2.5 text-[11.5px] text-slate-600">{stayCoverageLine(coverage)}</div>
          <div className="mt-1.5">
            {coverage.classes.map((c) => (
              <ClassRow key={c.docKind} label={c.label} status={c.status} copy={c.copy} count={c.count} />
            ))}
          </div>
          {coverage.incomplete && (
            <div className="mx-4 mb-3 mt-2 rounded-lg border px-3 py-2 text-[11.5px]" style={{ borderColor: GAP.line, background: GAP.bg, color: GAP.ink }}>
              A class marked <b>not available</b> was not seen by this audit. That is not evidence the
              event did not happen — a missing operative note is not a clean theatre, and a missing
              medication record is not a drug that was never given.
            </div>
          )}
        </>
      ) : (
        <div className="px-4 py-3 text-[12px] text-slate-500">
          No stay-level audit has been run for this document yet. The report above read the discharge
          summary alone; the operative, pre-anaesthetic and progress notes on this stay have not been
          audited.
        </div>
      )}

      {sibling && (
        <div className="border-t border-slate-100 px-4 py-3">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-[12px] font-semibold text-slate-700">
              {isStayRow ? 'Discharge-only reading' : 'Stay-level reading'}
            </span>
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10.5px] text-slate-600">{sibling.engineVersion}</span>
            {sibling.careValueIndex != null && (
              <span className="text-[12px] text-slate-600">Care-Value Index <b className="font-serif text-[16px] text-slate-900">{sibling.careValueIndex}</b>{sibling.band ? ` · band ${sibling.band}` : ''}</span>
            )}
            {sibling.nFindings != null && <span className="text-[11.5px] text-slate-500">{sibling.nFindings} finding{sibling.nFindings === 1 ? '' : 's'}{sibling.nLowValue ? ` · ${sibling.nLowValue} low-value` : ''}</span>}
            <Link href={`/admin/ipd-audit/${sibling.id}`} className="text-[11.5px] text-brand hover:underline">open ↗</Link>
          </div>
          {/* Two readings of the same stay from different material. Neither replaces the other, and
              the older one is never rewritten — they are separate rows under separate engine
              versions, and a reviewer adjudicates each on its own page. */}
          <p className="mt-1 text-[10.5px] text-slate-400">
            Two readings of the same admission from different material. Both are kept; neither
            overwrites the other.
          </p>
        </div>
      )}

      {!isStayRow && (
        <div className="border-t border-slate-100 px-4 py-3">
          <StayAuditRunButton documentId={documentId} alreadyRun={!!sibling} />
        </div>
      )}
    </div>
  );
}
