'use client';

import {
  Info, AlertTriangle, IndianRupee, ListChecks, ClipboardCheck, Route, Scale, BookOpen,
} from 'lucide-react';
import type { AuditReport, AuditFinding, FieldStatus } from '@/lib/doc-audit-core';
import type { Source } from '@/lib/citations-core';
import { DOMAIN_SHORT, type ValueScorecard, type Band } from '@/lib/value-score-core';
import {
  inr, MetricCard, Collapsible, SectionTitle, TariffBlock, EvidenceList, EstimatesList,
  CitationChips, SourcesPanel, NET_BADGE, NET_LABEL,
} from '@/components/right-care/kit';

const STATUS_BADGE: Record<FieldStatus, string> = {
  present: 'bg-teal-50 text-teal-800',
  partial: 'bg-amber-50 text-amber-800',
  missing: 'bg-red-50 text-red-800',
  na: 'bg-slate-100 text-slate-500',
};
const STATUS_LABEL: Record<FieldStatus, string> = { present: 'Present', partial: 'Partial', missing: 'Missing', na: 'N/A' };
const STATUS_ORDER: Record<FieldStatus, number> = { missing: 0, partial: 1, na: 2, present: 3 };

const BAND_STYLE: Record<Band, { ring: string; text: string; bg: string; label: string }> = {
  A: { ring: '#0d9488', text: 'text-teal-700', bg: 'bg-teal-50', label: 'Excellent value' },
  B: { ring: '#16a34a', text: 'text-green-700', bg: 'bg-green-50', label: 'Good value' },
  C: { ring: '#d97706', text: 'text-amber-700', bg: 'bg-amber-50', label: 'Mixed value' },
  D: { ring: '#ea580c', text: 'text-orange-700', bg: 'bg-orange-50', label: 'Low value' },
  E: { ring: '#dc2626', text: 'text-red-700', bg: 'bg-red-50', label: 'Poor value' },
};
const barColor = (s: number) => s >= 85 ? 'bg-teal-500' : s >= 70 ? 'bg-green-500' : s >= 55 ? 'bg-amber-500' : s >= 40 ? 'bg-orange-500' : 'bg-red-500';

export default function CaseAuditReport({
  report, extractTraceId, analyzeTraceId,
}: {
  report: AuditReport;
  extractTraceId?: string;
  analyzeTraceId?: string;
}) {
  const c = report.completeness;
  const sc = report.valueScore;
  const flagged = report.findings.filter((f) => f.verdict === 'low-value' || f.verdict === 'context-dependent').length;
  const items = [...c.items].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
  const presentCount = c.items.filter((i) => i.status === 'present' || i.status === 'na').length;
  const avoidable = (sc?.lowValueSpend ?? 0) + (sc?.excessBedDayCost ?? 0);
  const overuse = report.diff.filter((d) => d.kind === 'overuse');
  const gaps = report.diff.filter((d) => d.kind === 'gap');
  const fixes = [...report.suggestions].sort((a, b) => a.priority - b.priority);
  const pct = Math.round(c.coverage * 100);

  return (
    <div className="space-y-4">
      {/* ── Verdict header: read the bottom line in two seconds ── */}
      {sc ? (
        <VerdictHeader sc={sc} avoidable={avoidable} flagged={flagged} pct={pct} extractTraceId={extractTraceId} analyzeTraceId={analyzeTraceId} />
      ) : (
        <TraceRow extractTraceId={extractTraceId} analyzeTraceId={analyzeTraceId} />
      )}

      {/* ── Key-number strip: money first ── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricCard
          label="Avoidable spend"
          value={avoidable > 0 ? inr(avoidable) : '—'}
          sub={avoidable > 0 ? costParts(sc) : 'none tariffed'}
          tone={avoidable > 0 ? 'bad' : 'good'}
        />
        <MetricCard label="Completeness" value={`${pct}%`} sub={`${presentCount}/${c.items.length} fields · ${c.missingMandatory.length} mandatory gap${c.missingMandatory.length === 1 ? '' : 's'}`} tone={c.coverage >= 0.85 ? 'good' : c.coverage >= 0.6 ? 'warn' : 'bad'} />
        <MetricCard label="Flagged decisions" value={String(flagged)} sub="appropriateness / low-value" tone={flagged === 0 ? 'good' : 'bad'} />
        <MetricCard label="Idealised gaps" value={String(report.diff.length)} sub={`${overuse.length} over-use · ${gaps.length} missed`} tone="neutral" />
      </div>

      {/* Stay facts (non-identifying) */}
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

      {/* ── Care-Value breakdown: radar + per-domain bars + cost detail ── */}
      {sc && <BreakdownPanel sc={sc} />}

      {/* ── Top fixes: the actionable punchline, elevated ── */}
      {fixes.length > 0 && (
        <section className="overflow-hidden rounded-xl border border-teal-200">
          <div className="flex items-center gap-1.5 border-b border-teal-100 bg-teal-50/70 px-3.5 py-2 text-[12.5px] font-medium text-teal-800">
            <ListChecks className="h-3.5 w-3.5" /> Top fixes — highest priority first
          </div>
          <ol className="divide-y divide-slate-100 bg-white">
            {fixes.map((s, i) => (
              <li key={i} className="flex gap-2.5 px-3.5 py-2.5 text-[13px] leading-relaxed text-slate-700">
                <span className="font-medium text-teal-700">{i + 1}</span>
                <span className="flex-1">{s.text}{s.ref ? <span className="text-[11px] text-slate-400"> · {s.ref}</span> : null}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* ── Flagged decisions ── */}
      {report.findings.length > 0 && (
        <section>
          <SectionTitle icon={<AlertTriangle className="h-3.5 w-3.5" />} text="Appropriateness & low-value decisions" />
          <div className="space-y-3">
            {report.findings.map((f, i) => <FindingCard key={i} f={f} sources={report.sources} />)}
          </div>
        </section>
      )}

      {/* ── Idealised course vs actual ── */}
      <section>
        <SectionTitle icon={<Route className="h-3.5 w-3.5" />} text="Idealised course vs actual" />
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
            <DiffCol title="Done — not needed" tone="bad" items={overuse} />
            <DiffCol title="Ideal — but missing" tone="warn" items={gaps} />
          </div>
        )}
      </section>

      {/* ── Reference detail: collapsed by default ── */}
      <Collapsible title="Completeness audit (NABH + clinical)" icon={<ClipboardCheck className="h-3.5 w-3.5" />} count={`${presentCount}/${c.items.length}`}>
        <div className="overflow-hidden rounded-lg border border-slate-200">
          {items.map((it, i) => (
            <div key={it.key} className={`flex items-center justify-between gap-3 px-3 py-2 ${i ? 'border-t border-slate-100' : ''}`}>
              <span className="text-[13px] text-slate-800">{it.label} <span className="text-[11px] text-slate-400">{it.ref}</span></span>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_BADGE[it.status]}`}>{STATUS_LABEL[it.status]}</span>
            </div>
          ))}
        </div>
      </Collapsible>

      {report.sources && report.sources.length > 0 && (
        <Collapsible title="Sources — retrieved from the CDMSS corpus" icon={<BookOpen className="h-3.5 w-3.5" />} count={report.sources.length}>
          <SourcesPanel sources={report.sources} />
        </Collapsible>
      )}

      <p className="text-[11px] leading-relaxed text-slate-400">{report.disclaimer}</p>
    </div>
  );
}

function costParts(sc?: ValueScorecard): string {
  if (!sc) return '';
  const p: string[] = [];
  if (sc.excessBedDayCost) p.push('bed-days');
  if (sc.lowValueSpend) p.push('low-value');
  return p.length ? p.join(' + ') : 'tariffed';
}

function TraceRow({ extractTraceId, analyzeTraceId }: { extractTraceId?: string; analyzeTraceId?: string }) {
  if (!extractTraceId && !analyzeTraceId) return null;
  return (
    <div className="flex gap-4 text-xs text-slate-400">
      {extractTraceId && <a href={`/admin/observability/${extractTraceId}`} className="inline-flex items-center gap-1 hover:text-slate-600"><Info className="h-3 w-3" /> Extract trace</a>}
      {analyzeTraceId && <a href={`/admin/observability/${analyzeTraceId}`} className="inline-flex items-center gap-1 hover:text-slate-600"><Info className="h-3 w-3" /> Audit trace</a>}
    </div>
  );
}

function VerdictHeader({ sc, avoidable, flagged, pct, extractTraceId, analyzeTraceId }: {
  sc: ValueScorecard; avoidable: number; flagged: number; pct: number; extractTraceId?: string; analyzeTraceId?: string;
}) {
  const b = BAND_STYLE[sc.band];
  return (
    <section className={`rounded-xl border border-slate-200 ${b.bg} p-4`}>
      <div className="flex items-start gap-4">
        <div className="flex h-[68px] w-[68px] shrink-0 flex-col items-center justify-center rounded-full border-4 bg-white" style={{ borderColor: b.ring }}>
          <span className={`text-[22px] font-semibold leading-none ${b.text}`}>{sc.headline}</span>
          <span className="text-[10px] text-slate-400">/ 100</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Scale className={`h-4 w-4 ${b.text}`} />
            <span className={`text-[17px] font-semibold leading-tight ${b.text}`}>Band {sc.band} · {b.label}</span>
            <span className="rounded-full bg-white/70 px-2 py-0.5 text-[10.5px] font-medium text-slate-500">{sc.confidence} confidence</span>
            {(extractTraceId || analyzeTraceId) && (
              <span className="ml-auto flex items-center gap-3 text-[11px] text-slate-400">
                {extractTraceId && <a href={`/admin/observability/${extractTraceId}`} className="inline-flex items-center gap-1 hover:text-slate-600"><Info className="h-3 w-3" /> Extract</a>}
                {analyzeTraceId && <a href={`/admin/observability/${analyzeTraceId}`} className="inline-flex items-center gap-1 hover:text-slate-600"><Info className="h-3 w-3" /> Trace</a>}
              </span>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12.5px] text-slate-600">
            {avoidable > 0 && (
              <span className="inline-flex items-center gap-1"><IndianRupee className="h-3.5 w-3.5 text-red-600" /><span className="font-semibold text-red-700">{inr(avoidable)}</span> potentially avoidable</span>
            )}
            {avoidable > 0 && <span className="text-slate-300">·</span>}
            <span>{flagged} flagged decision{flagged === 1 ? '' : 's'}</span>
            <span className="text-slate-300">·</span>
            <span>completeness {pct}%</span>
          </div>
        </div>
      </div>
    </section>
  );
}

function ValueRadar({ sc }: { sc: ValueScorecard }) {
  const size = 168, cx = size / 2, cy = size / 2, R = 58;
  const doms = sc.domains;
  const n = doms.length;
  const pt = (i: number, r: number) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const;
  };
  const ring = (frac: number) => doms.map((_, i) => pt(i, R * frac).join(',')).join(' ');
  const shape = doms.map((d, i) => pt(i, R * Math.max(0, Math.min(100, d.score)) / 100).join(',')).join(' ');
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} className="shrink-0">
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <polygon key={f} points={ring(f)} fill="none" stroke="#e5e7eb" strokeWidth="1" />
      ))}
      {doms.map((_, i) => { const [x, y] = pt(i, R); return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke="#e5e7eb" strokeWidth="1" />; })}
      <polygon points={shape} fill="#0d948833" stroke="#0d9488" strokeWidth="1.5" />
      {doms.map((d, i) => {
        const [x, y] = pt(i, R + 12);
        return <text key={d.domain} x={x} y={y} textAnchor="middle" dominantBaseline="middle" className="fill-slate-500" style={{ fontSize: 8.5 }}>{DOMAIN_SHORT[d.domain]}</text>;
      })}
    </svg>
  );
}

function BreakdownPanel({ sc }: { sc: ValueScorecard }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <SectionTitle icon={<Scale className="h-3.5 w-3.5" />} text="Care-Value breakdown" />
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="mx-auto sm:mx-0"><ValueRadar sc={sc} /></div>
        <div className="flex-1 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
          {sc.domains.map((d) => (
            <div key={d.domain}>
              <div className="flex items-baseline justify-between text-[12px]">
                <span className="text-slate-700">{d.label}</span>
                <span className="font-medium text-slate-900">{Math.round(d.score)}</span>
              </div>
              <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
                <div className={`h-full rounded-full ${barColor(d.score)}`} style={{ width: `${Math.max(0, Math.min(100, d.score))}%` }} />
              </div>
              <div className="mt-0.5 text-[10.5px] text-slate-400">{d.basis}</div>
            </div>
          ))}
        </div>
      </div>

      {(sc.lowValueSpend != null || sc.excessBedDayCost != null || sc.roomCategoryInflation != null) && (
        <div className="mt-3 space-y-0.5 border-t border-slate-100 pt-2.5 text-[11.5px]">
          {sc.lowValueSpend != null && (
            <div className="inline-flex items-center gap-1 text-slate-600"><IndianRupee className="h-3 w-3" />{inr(sc.lowValueSpend)} tariffed low-value spend</div>
          )}
          {sc.excessBedDayCost != null && (
            <div className="text-amber-700">+ {inr(sc.excessBedDayCost)} {sc.costNote ? `· ${sc.costNote}` : 'avoidable bed-days'}</div>
          )}
          {sc.roomCategoryInflation != null && (
            <div className="text-slate-500">+ {inr(sc.roomCategoryInflation)} vs general-ward rates for the same orders{sc.roomTier ? ` · ${sc.roomTier} category` : ''} <span className="text-slate-400">(informational)</span></div>
          )}
        </div>
      )}

      <p className="mt-3 text-[10.5px] leading-relaxed text-slate-400">{sc.caveat}</p>
    </section>
  );
}

function FindingCard({ f, sources }: { f: AuditFinding; sources?: Source[] }) {
  const border = f.verdict === 'low-value' ? 'border-l-red-500' : f.verdict === 'context-dependent' ? 'border-l-amber-500' : 'border-l-slate-300';
  return (
    <div className={`rounded-r-xl border border-l-[3px] border-slate-200 bg-white p-4 ${border}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="text-sm font-medium leading-snug text-slate-900">{f.subject}</div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${NET_BADGE[f.verdict]}`}>{NET_LABEL[f.verdict]}</span>
          <span className="text-[11px] text-slate-400">conf {f.confidence.toFixed(2)}</span>
        </div>
      </div>
      {f.rationale && <p className="mt-2 text-[13px] leading-relaxed text-slate-700">{f.rationale}</p>}
      {f.citation_ids && f.citation_ids.length > 0 && sources && sources.length > 0 && <CitationChips ids={f.citation_ids} sources={sources} />}
      {f.tariffs && f.tariffs.length > 0 && <TariffBlock tariffs={f.tariffs} />}
      <EvidenceList items={f.evidence} />
      <EstimatesList items={f.estimates} />
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
