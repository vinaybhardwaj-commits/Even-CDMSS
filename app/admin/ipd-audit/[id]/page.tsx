// /admin/ipd-audit/[id] — the IPD audit REPORT (S3.4): full-bleed split, the real GCS
// discharge PDF beside the findings (the CCB CareBriefSplit posture; Shell's fullBleed
// predicate covers this route). RIGHT column reuses the shipped CaseAuditReport renderer on
// the persisted de-identified report, plus the first-class Low-Value Care triage panel.
// PHI (patient name / UHID / consultant) is joined from db13 AT READ TIME for the header of
// this access-controlled view only — it is never stored on the audit row.
import Link from 'next/link';
import { sql } from '@/lib/db';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { bandColor } from '@/lib/opd-audit-ui';
import type { AuditReport, AuditFinding } from '@/lib/doc-audit-core';
import CaseAuditReport from '@/components/CaseAuditReport';
import { fetchIpdDoc, fetchIpdAdmissionHeader } from '@/lib/ipd-audit/db13';
import FindingTriage from './finding-triage';

export const dynamic = 'force-dynamic';

function LockedMsg() {
  return (
    <div className="mx-auto max-w-md py-16 text-center text-sm text-slate-500">
      This report is access-controlled. <Link href="/admin/ipd-audit" className="text-brand hover:underline">Unlock the IPD audit surface</Link> first.
    </div>
  );
}

const pdfSrc = (u: string) => `${u}#toolbar=0&navpanes=0&view=FitH`;

export default async function IpdAuditReport({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await isAdminUnlocked())) return <LockedMsg />;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return <div className="p-8 text-sm text-slate-500">Bad audit id.</div>;

  const rows = (await sql(`SELECT * FROM ipd_discharge_audits WHERE id = $1 LIMIT 1`, [id])) as Array<Record<string, unknown>>;
  const r = rows[0];
  if (!r) return <div className="p-8 text-sm text-slate-500">Audit not found. <Link href="/admin/ipd-audit" className="text-brand hover:underline">Back to overview</Link></div>;

  const documentId = String(r.document_id);
  const ipUid = r.ip_uid ? String(r.ip_uid) : null;
  const [doc, header, feedback] = await Promise.all([
    fetchIpdDoc(documentId).catch(() => null),
    ipUid ? fetchIpdAdmissionHeader(ipUid).catch(() => null) : Promise.resolve(null),
    sql(
      `SELECT DISTINCT ON (finding_ref) finding_ref, verdict FROM ipd_audit_feedback
       WHERE audit_id = $1 AND finding_ref IS NOT NULL ORDER BY finding_ref, created_at DESC`,
      [id],
    ) as unknown as Promise<Array<{ finding_ref: string; verdict: string }>>,
  ]);
  const triaged = new Map(feedback.map((f) => [f.finding_ref, f.verdict]));

  const report = (typeof r.report === 'string' ? JSON.parse(r.report) : r.report) as AuditReport | null;
  const findings = (report?.findings ?? (typeof r.findings === 'string' ? JSON.parse(String(r.findings)) : r.findings) ?? []) as AuditFinding[];
  const lvcFindings = findings.filter((f) => f.verdict === 'low-value' || f.verdict === 'context-dependent');
  const band = String(r.band);
  const pdfUrl = doc?.pdfUrl ?? null;
  const exportBase = `/api/admin/ipd-audit-export?id=${id}`;

  return (
    <div className="flex h-screen flex-col">
      {/* corner bar — pl-14 clears the floating ☰ the full-bleed shell shows */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-white py-2 pl-14 pr-4">
        <div className="flex min-w-0 items-center gap-3">
          <Link href="/admin/ipd-audit" className="whitespace-nowrap text-xs text-slate-500 hover:text-brand">← IPD audits</Link>
          <span className="truncate text-[13px]">
            <b className="text-slate-800">{header?.patientName ?? 'Patient'}</b>
            {header?.uhid && <span className="ml-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">{header.uhid}</span>}
            {header?.ageGender && <span className="ml-1.5 text-[11px] text-slate-500">{header.ageGender}</span>}
            <span className="ml-1.5 text-[11px] text-slate-500">{ipUid} · {header?.speciality ?? String(r.speciality ?? '—')}{header?.team ? ` · ${header.team}` : ''}{header?.ward ? ` · ${header.ward}` : ''}</span>
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-md bg-slate-800 px-2 py-0.5 text-[10.5px] font-semibold text-white" title="Identifiers joined from db13 at read time; never stored with the audit">Access-controlled · PHI read-time</span>
          <span className="rounded-md px-2 py-0.5 text-[11px] font-semibold text-white" style={{ background: bandColor(band) }}>{band} · {Number(r.care_value_index)}</span>
          {pdfUrl && <a href={pdfUrl} target="_blank" className="text-xs text-brand hover:underline">Discharge PDF ↗</a>}
          <a href={`${exportBase}&mode=report`} className="text-xs text-brand hover:underline">Audit report ↓</a>
          <a href={`${exportBase}&mode=combined`} className="text-xs text-brand hover:underline">Combined ↓</a>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* LEFT — the real discharge PDF */}
        <div className="flex min-h-[40vh] flex-col bg-[#525659] md:min-h-0 md:flex-[1.05]">
          {pdfUrl ? (
            <iframe src={pdfSrc(pdfUrl)} key={pdfUrl} title="Discharge summary PDF" className="h-full w-full border-0 bg-white" />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-slate-300">Discharge PDF unavailable (db13 link lost)</div>
          )}
        </div>

        {/* RIGHT — findings */}
        <div className="min-h-0 flex-1 overflow-auto bg-white">
          <div className="mx-auto max-w-3xl px-5 py-6">
            {/* first-class Low-Value Care panel + triage */}
            <div className="rounded-xl border border-slate-200 bg-white">
              <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
                <span className="text-[13px] font-semibold text-slate-800">Low-Value Care findings</span>
                <span className="text-[11px] text-slate-500">{lvcFindings.length} of {findings.length} findings · runs on every summary</span>
              </div>
              {lvcFindings.length === 0 ? (
                <div className="px-4 py-5 text-center text-sm text-slate-500">No low-value or context-dependent findings on this summary.</div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {lvcFindings.map((f) => (
                    <li key={f.subject} className="px-4 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-[13px] font-semibold text-slate-800">{f.subject}</span>
                        <FindingTriage auditId={id} findingRef={f.subject} initial={triaged.get(f.subject)} />
                      </div>
                      <div className="mt-0.5 text-[11px] text-slate-500">
                        <span className={`mr-1.5 rounded px-1.5 py-0.5 font-semibold ${f.verdict === 'low-value' ? 'bg-rose-50 text-rose-700' : 'bg-amber-50 text-amber-700'}`}>{f.verdict}</span>
                        {f.domain && <span className="mr-1.5 text-slate-400">{f.domain}</span>}
                        {f.rationale}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* the shipped Case-Audit renderer over the persisted de-identified report */}
            <div className="mt-5">
              {report ? (
                <CaseAuditReport report={report} analyzeTraceId={r.trace_id ? String(r.trace_id) : undefined} />
              ) : (
                <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
                  This row predates the full-report column (0014) — re-run “Audit now” on the document to render the complete report.
                </div>
              )}
            </div>

            {/* billing panel slot — S7 */}
            <div className="mt-5 rounded-xl border border-dashed border-slate-200 bg-slate-50/50 px-4 py-3 text-[12px] text-slate-400">
              Billing envelope &amp; documented-vs-billed reconciliation — lands in S7 (kx_billing_records join).
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-3 text-[11px] text-slate-400">
              <span>engine {String(r.engine_version)}</span>
              {r.model != null && <span>model {String(r.model)}</span>}
              {r.trace_id != null && <Link href={`/admin/observability/${r.trace_id}`} className="text-brand hover:underline">trace {String(r.trace_id).slice(0, 8)}…</Link>}
              <span>audited {String(r.audited_at).slice(0, 16)}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
