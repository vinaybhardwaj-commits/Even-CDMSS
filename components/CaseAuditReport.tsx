'use client';

import type { ReactNode } from 'react';
import {
  Info, BookOpen, AlertTriangle, IndianRupee, Lightbulb, ClipboardCheck, Route, ExternalLink,
} from 'lucide-react';
import type { AuditReport, AuditFinding, FieldStatus, NetValue, TariffRef } from '@/lib/doc-audit-core';
import { sourceLabel, type Source } from '@/lib/citations-core';

const inr = (n: number) => '₹' + Number(n).toLocaleString('en-IN');

const STATUS_BADGE: Record<FieldStatus, string> = {
  present: 'bg-teal-50 text-teal-800',
  partial: 'bg-amber-50 text-amber-800',
  missing: 'bg-red-50 text-red-800',
  na: 'bg-slate-100 text-slate-500',
};
const STATUS_LABEL: Record<FieldStatus, string> = { present: 'Present', partial: 'Partial', missing: 'Missing', na: 'N/A' };
const STATUS_ORDER: Record<FieldStatus, number> = { missing: 0, partial: 1, na: 2, present: 3 };

const NET_BADGE: Record<NetValue, string> = {
  'high-value': 'bg-teal-50 text-teal-800',
  'context-dependent': 'bg-amber-50 text-amber-800',
  'low-value': 'bg-red-50 text-red-800',
  uncertain: 'bg-slate-100 text-slate-600',
};
const NET_LABEL: Record<NetValue, string> = {
  'high-value': 'High value', 'context-dependent': 'Context-dependent', 'low-value': 'Low value', uncertain: 'Uncertain',
};

function tariffLine(t: TariffRef): string {
  const parts: string[] = [];
  if (t.kind === 'investigation') {
    if (t.opd != null) parts.push(`${inr(t.opd)} OPD`);
    if (t.general != null) parts.push(`${inr(t.general)} general`);
  } else {
    if (t.general != null) parts.push(`${inr(t.general)} general`);
    if (t.private != null) parts.push(`${inr(t.private)} private`);
    if (t.suite != null) parts.push(`${inr(t.suite)} suite`);
  }
  return parts.join(' · ');
}

export default function CaseAuditReport({
  report, extractTraceId, analyzeTraceId,
}: {
  report: AuditReport;
  extractTraceId?: string;
  analyzeTraceId?: string;
}) {
  const c = report.completeness;
  const flagged = report.findings.filter((f) => f.verdict === 'low-value' || f.verdict === 'context-dependent').length;
  const items = [...c.items].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
  const presentCount = c.items.filter((i) => i.status === 'present' || i.status === 'na').length;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Metric label="Completeness" value={`${Math.round(c.coverage * 100)}%`} sub={`${presentCount}/${c.items.length} fields · ${c.missingMandatory.length} mandatory gaps`} tone={c.coverage >= 0.85 ? 'good' : c.coverage >= 0.6 ? 'warn' : 'bad'} />
        <Metric label="Flagged decisions" value={String(flagged)} sub="appropriateness / low-value" tone={flagged === 0 ? 'good' : 'bad'} />
        <Metric label="Idealised vs actual" value={`${report.diff.length} gaps`} sub={`${report.diff.filter((d) => d.kind === 'overuse').length} over-use · ${report.diff.filter((d) => d.kind === 'gap').length} missed`} tone="neutral" />
      </div>

      {report.adminFacts && (report.adminFacts.lengthOfStayDays != null || report.adminFacts.admissionType || report.adminFacts.careSetting) && (
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-slate-500">
          <span className="font-medium text-slate-600">Stay facts</span>
          {report.adminFacts.lengthOfStayDays != null && (
            <span className="rounded-full bg-slate-100 px-2 py-0.5">Length of stay: {report.adminFacts.lengthOfStayDays} day{report.adminFacts.lengthOfStayDays === 1 ? '' : 's'}</span>
          )}
          {report.adminFacts.admissionType && <span className="rounded-full bg-slate-100 px-2 py-0.5 capitalize">{report.adminFacts.admissionType}</span>}
          {report.adminFacts.careSetting && <span className="rounded-full bg-slate-100 px-2 py-0.5 capitalize">{report.adminFacts.careSetting.replace(/_/g, ' ')}</span>}
          <span className="text-slate-400">· informs the value findings, not stored as dates</span>
        </div>
      )}

      <section>
        <SectionTitle icon={<ClipboardCheck className="h-3.5 w-3.5" />} text="Completeness audit (NABH + clinical)" />
        <div className="overflow-hidden rounded-xl border border-slate-200">
          {items.map((it, i) => (
            <div key={it.key} className={`flex items-center justify-between gap-3 px-3.5 py-2.5 ${i ? 'border-t border-slate-100' : ''}`}>
              <span className="text-[13px] text-slate-800">{it.label} <span className="text-[11px] text-slate-400">{it.ref}</span></span>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_BADGE[it.status]}`}>{STATUS_LABEL[it.status]}</span>
            </div>
          ))}
        </div>
      </section>

      {report.findings.length > 0 && (
        <section>
          <SectionTitle icon={<AlertTriangle className="h-3.5 w-3.5" />} text="Appropriateness & low-value decisions" />
          <div className="space-y-3">
            {report.findings.map((f, i) => <FindingCard key={i} f={f} sources={report.sources} />)}
          </div>
        </section>
      )}

      <section>
        <SectionTitle icon={<Route className="h-3.5 w-3.5" />} text="Idealised course" />
        {report.idealisedSummary && <p className="mb-2 text-[13px] leading-relaxed text-slate-700">{report.idealisedSummary}</p>}
        {report.idealisedStages && report.idealisedStages.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-1.5">
            {report.idealisedStages.map((s) => (
              <span key={s.id} className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11.5px] text-slate-600">{s.title}</span>
            ))}
          </div>
        )}
        {report.diff.length > 0 && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <DiffCol title="Done — not needed" tone="bad" items={report.diff.filter((d) => d.kind === 'overuse')} />
            <DiffCol title="Ideal — but missing" tone="warn" items={report.diff.filter((d) => d.kind === 'gap')} />
          </div>
        )}
      </section>

      {report.suggestions.length > 0 && (
        <section>
          <SectionTitle icon={<Lightbulb className="h-3.5 w-3.5" />} text="Prioritised suggestions" />
          <ol className="list-decimal space-y-1.5 pl-5 text-[13px] leading-relaxed text-slate-700">
            {report.suggestions.map((s, i) => (
              <li key={i}>{s.text}{s.ref ? <span className="text-[11px] text-slate-400"> · {s.ref}</span> : null}</li>
            ))}
          </ol>
        </section>
      )}

      {report.sources && report.sources.length > 0 && <AuditSourcesPanel sources={report.sources} />}

      <p className="text-[11px] leading-relaxed text-slate-400">{report.disclaimer}</p>

      {(extractTraceId || analyzeTraceId) && (
        <div className="flex gap-4 text-xs text-slate-400">
          {extractTraceId && <a href={`/admin/observability/${extractTraceId}`} className="inline-flex items-center gap-1 hover:text-slate-600"><Info className="h-3 w-3" /> Extract trace</a>}
          {analyzeTraceId && <a href={`/admin/observability/${analyzeTraceId}`} className="inline-flex items-center gap-1 hover:text-slate-600"><Info className="h-3 w-3" /> Audit trace</a>}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, sub, tone }: { label: string; value: string; sub: string; tone: 'good' | 'warn' | 'bad' | 'neutral' }) {
  const color = tone === 'good' ? 'text-teal-700' : tone === 'warn' ? 'text-amber-700' : tone === 'bad' ? 'text-red-700' : 'text-slate-900';
  return (
    <div className="rounded-lg bg-slate-50 p-3.5">
      <div className="text-[13px] text-slate-500">{label}</div>
      <div className={`text-2xl font-medium ${color}`}>{value}</div>
      <div className="text-[11px] text-slate-400">{sub}</div>
    </div>
  );
}

function SectionTitle({ icon, text }: { icon: ReactNode; text: string }) {
  return <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-slate-500">{icon} {text}</div>;
}

function FindingCard({ f, sources }: { f: AuditFinding; sources?: Source[] }) {
  const border = f.verdict === 'low-value' ? 'border-red-200' : f.verdict === 'context-dependent' ? 'border-amber-200' : 'border-slate-200';
  return (
    <div className={`rounded-xl border ${border} bg-white p-4`}>
      <div className="flex items-start justify-between gap-3">
        <div className="text-sm font-medium leading-snug text-slate-900">{f.subject}</div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${NET_BADGE[f.verdict]}`}>{NET_LABEL[f.verdict]}</span>
          <span className="text-[11px] text-slate-400">conf {f.confidence.toFixed(2)}</span>
        </div>
      </div>
      {f.rationale && <p className="mt-2 text-[13px] leading-relaxed text-slate-700">{f.rationale}</p>}

      {f.citation_ids && f.citation_ids.length > 0 && sources && sources.length > 0 && (
        <AuditCitationChips ids={f.citation_ids} sources={sources} />
      )}

      {f.tariffs && f.tariffs.length > 0 && (
        <div className="mt-2.5 rounded-lg border border-teal-200 bg-teal-50 p-2.5">
          <div className="flex items-center gap-1 text-[11px] font-medium text-teal-800"><IndianRupee className="h-3 w-3" /> EHRC charge master — cited tariff (not an estimate)</div>
          <ul className="mt-1 space-y-0.5">
            {f.tariffs.map((t) => (
              <li key={t.code} className="text-[12px] text-teal-900"><span className="font-medium">{t.item}</span> <span className="text-teal-700">({t.code})</span>: {tariffLine(t)}</li>
            ))}
          </ul>
        </div>
      )}

      {f.evidence.length > 0 && (
        <div className="mt-2.5">
          <div className="flex items-center gap-1 text-[11px] font-medium text-slate-500"><BookOpen className="h-3 w-3" /> Evidence</div>
          <ul className="mt-1 list-disc pl-4 text-[12px] text-slate-600">{f.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </div>
      )}
      {f.estimates.length > 0 && (
        <div className="mt-2.5 rounded-lg border border-dashed border-amber-300 bg-amber-50 p-2.5">
          <div className="flex items-center gap-1 text-[11px] font-medium text-amber-700"><AlertTriangle className="h-3 w-3" /> Model estimates — not validated</div>
          <ul className="mt-1 list-disc pl-4 text-[12px] text-amber-900">{f.estimates.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

function DiffCol({ title, tone, items }: { title: string; tone: 'bad' | 'warn'; items: { text: string; ref?: string }[] }) {
  const cls = tone === 'bad' ? 'border-red-200 bg-red-50 text-red-900' : 'border-amber-200 bg-amber-50 text-amber-900';
  const head = tone === 'bad' ? 'text-red-700' : 'text-amber-700';
  return (
    <div className={`rounded-xl border ${cls} p-3`}>
      <div className={`mb-1.5 text-[11px] font-medium ${head}`}>{title}</div>
      {items.length === 0 ? (
        <div className="text-[12px] text-slate-500">None identified.</div>
      ) : (
        <ul className="list-disc space-y-1 pl-4 text-[12.5px] leading-relaxed">
          {items.map((d, i) => <li key={i}>{d.text}{d.ref ? <span className="text-[11px] opacity-70"> · {d.ref}</span> : null}</li>)}
        </ul>
      )}
    </div>
  );
}

function AuditCitationChips({ ids, sources }: { ids: number[]; sources: Source[] }) {
  const byN = new Map(sources.map((s) => [s.n, s]));
  const cited = ids.map((n) => byN.get(n)).filter((s): s is Source => !!s);
  if (cited.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className="text-[10.5px] uppercase tracking-wide text-slate-400">Cited</span>
      {cited.map((s) => s.url ? (
        <a key={s.n} href={s.url} target="_blank" rel="noopener noreferrer" title={s.preview}
          className="inline-flex items-center gap-0.5 rounded-full border border-teal-200 bg-teal-50 px-1.5 py-0.5 text-[10.5px] font-medium text-teal-800 hover:bg-teal-100">
          [{s.n}] <ExternalLink className="h-2.5 w-2.5" />
        </a>
      ) : (
        <span key={s.n} title={s.preview}
          className="rounded-full border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10.5px] font-medium text-slate-600">[{s.n}]</span>
      ))}
    </div>
  );
}

function AuditSourcesPanel({ sources }: { sources: Source[] }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
        <BookOpen className="h-3 w-3" /> Sources ({sources.length}) — retrieved from the CDMSS corpus
      </div>
      <ol className="space-y-1.5">
        {sources.map((s) => (
          <li key={s.n} className="text-[12px] leading-relaxed text-slate-600">
            <span className="font-medium text-slate-700">[{s.n}]</span> {sourceLabel(s)}
            {s.url && (
              <a href={s.url} target="_blank" rel="noopener noreferrer" className="ml-1 inline-flex items-center gap-0.5 text-brand hover:underline">
                PubMed <ExternalLink className="h-2.5 w-2.5" />
              </a>
            )}
            {s.preview && <span className="block text-[11px] text-slate-400">{s.preview.slice(0, 160)}{s.preview.length > 160 ? '…' : ''}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}
