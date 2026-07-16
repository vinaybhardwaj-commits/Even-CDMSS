'use client';
// Thin client wrapper (S3.2 fix): a server page cannot pass a function prop across the RSC
// boundary, so the findingActions render-prop is composed HERE — CaseAuditReport (shared,
// unchanged for other callers) gets the per-finding FindingTriage strip on EVERY finding.
import type { AuditReport, AuditFinding } from '@/lib/doc-audit-core';
import CaseAuditReport from '@/components/CaseAuditReport';
import FindingTriage from './finding-triage';

export default function ReportWithTriage({ report, auditId, triaged, analyzeTraceId }: {
  report: AuditReport;
  auditId: string;
  triaged: Record<string, string>;   // finding subject → latest adjudication verdict
  analyzeTraceId?: string;
}) {
  return (
    <CaseAuditReport
      report={report}
      analyzeTraceId={analyzeTraceId}
      findingActions={(f: AuditFinding) => (
        <FindingTriage auditId={auditId} findingRef={f.subject} initial={triaged[f.subject] ?? null} />
      )}
    />
  );
}
