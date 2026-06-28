'use client';

import {
  Loader2, ShieldAlert, Stethoscope, Microscope, Pill, DoorOpen, CalendarCheck,
  GitBranch, BookOpen, AlertTriangle, IndianRupee, ArrowRightCircle, Info, Route,
} from 'lucide-react';
import {
  mergeStages, PATHWAY_DISCLAIMER,
  type PathwaySkeleton, type PathwayEnrichment, type StageKind, type StageFlag, type MergedStage, type TariffRef,
} from '@/lib/pathway-core';

const inr = (n: number) => '₹' + Number(n).toLocaleString('en-IN');

const KIND_ICON: Record<StageKind, typeof ShieldAlert> = {
  triage: ShieldAlert, assessment: Stethoscope, diagnosis: Microscope,
  treatment: Pill, disposition: DoorOpen, followup: CalendarCheck,
};

const FLAG_BADGE: Record<StageFlag, string> = {
  essential: 'bg-blue-50 text-blue-800',
  routine: 'bg-slate-100 text-slate-600',
  'high-value': 'bg-teal-50 text-teal-800',
  'context-dependent': 'bg-amber-50 text-amber-800',
  'low-value': 'bg-red-50 text-red-800',
  caution: 'bg-amber-50 text-amber-800',
  followup: 'bg-slate-100 text-slate-600',
};
const FLAG_LABEL: Record<StageFlag, string> = {
  essential: 'Essential', routine: 'Routine', 'high-value': 'High value',
  'context-dependent': 'Context-dependent', 'low-value': 'Question this · low value',
  caution: 'Caution', followup: 'Follow-up',
};
// The marker ring colour echoes the flag.
const FLAG_RING: Record<StageFlag, string> = {
  essential: 'border-blue-400 text-blue-600',
  routine: 'border-slate-300 text-slate-500',
  'high-value': 'border-teal-400 text-teal-600',
  'context-dependent': 'border-amber-400 text-amber-600',
  'low-value': 'border-red-400 text-red-600',
  caution: 'border-amber-400 text-amber-600',
  followup: 'border-slate-300 text-slate-500',
};

const DETECTED_LABEL: Record<string, string> = {
  presentation: 'Undifferentiated presentation', diagnosis: 'Diagnosis given', order: 'Specific order', mixed: 'Mixed',
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

export default function PathwayTrace({
  skeleton, enrichment, enriching, skeletonTraceId, enrichTraceId,
}: {
  skeleton: PathwaySkeleton;
  enrichment: PathwayEnrichment | null;
  enriching: boolean;
  skeletonTraceId?: string;
  enrichTraceId?: string;
}) {
  const merged = mergeStages(skeleton.stages, enrichment);

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-blue-50 px-2.5 py-0.5 text-[11.5px] font-medium text-blue-800">
            Detected: {DETECTED_LABEL[skeleton.detectedStage] ?? skeleton.detectedStage}
          </span>
          {skeleton.workingDiagnosis && (
            <span className="rounded-full border border-slate-200 bg-white px-2.5 py-0.5 text-[11.5px] text-slate-600">
              Working dx: <span className="font-medium text-slate-800">{skeleton.workingDiagnosis}</span> · {skeleton.diagnosisCertainty} certainty
            </span>
          )}
        </div>
        {skeleton.summary && <p className="mt-2 text-[13px] leading-relaxed text-slate-700">{skeleton.summary}</p>}

        {skeleton.needsDdx && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
            <GitBranch className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <div className="text-[12.5px] leading-relaxed text-amber-900">
              <span className="font-medium">Diagnosis not established.</span> This is a management pathway — for the differential, work it up in DDx first.{' '}
              <a href="/ddx" className="inline-flex items-center gap-1 font-medium text-amber-800 underline hover:text-amber-900">
                Open DDx <ArrowRightCircle className="h-3.5 w-3.5" />
              </a>
            </div>
          </div>
        )}
      </div>

      <div className="mb-1 flex items-center gap-1.5 text-xs text-slate-500">
        <Route className="h-3.5 w-3.5" /> Traced care path — each step annotated for value and appropriateness
      </div>

      <ol className="relative space-y-3 pl-7">
        <span className="absolute left-[11px] top-2 bottom-2 w-px bg-slate-200" aria-hidden />
        {merged.map((s, i) => (
          <StageCard key={s.id} stage={s} index={i + 1} enriching={enriching && !s.enriched} />
        ))}
      </ol>

      <p className="text-[11px] leading-relaxed text-slate-400">{enrichment?.disclaimer || PATHWAY_DISCLAIMER}</p>

      {(skeletonTraceId || enrichTraceId) && (
        <div className="flex gap-4 text-xs text-slate-400">
          {skeletonTraceId && (
            <a href={`/admin/observability/${skeletonTraceId}`} className="inline-flex items-center gap-1 hover:text-slate-600">
              <Info className="h-3 w-3" /> Skeleton trace
            </a>
          )}
          {enrichTraceId && (
            <a href={`/admin/observability/${enrichTraceId}`} className="inline-flex items-center gap-1 hover:text-slate-600">
              <Info className="h-3 w-3" /> Enrichment trace
            </a>
          )}
        </div>
      )}
    </div>
  );
}

function StageCard({ stage, index, enriching }: { stage: MergedStage; index: number; enriching: boolean }) {
  const Icon = KIND_ICON[stage.kind] ?? Stethoscope;
  const borderTone = stage.flag === 'low-value' ? 'border-red-200' : 'border-slate-200';
  return (
    <li className="relative">
      <span className={`absolute -left-7 top-1.5 flex h-[22px] w-[22px] items-center justify-center rounded-full border-2 bg-white ${FLAG_RING[stage.flag]}`}>
        <Icon className="h-3 w-3" />
      </span>
      <div className={`rounded-xl border ${borderTone} bg-white p-4`}>
        <div className="flex items-start justify-between gap-3">
          <div className="text-sm font-medium leading-snug text-slate-900">{index} · {stage.title}</div>
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${FLAG_BADGE[stage.flag]}`}>{FLAG_LABEL[stage.flag]}</span>
        </div>

        <p className="mt-2 text-[13px] leading-relaxed text-slate-700">{stage.detail || stage.action}</p>

        {stage.decisionCriteria && (
          <p className="mt-2 border-l-2 border-slate-200 pl-2.5 text-[12.5px] leading-relaxed text-slate-600">
            <span className="text-slate-400">Branches if:</span> {stage.decisionCriteria}
          </p>
        )}

        {stage.tariffs && stage.tariffs.length > 0 && (
          <div className="mt-2.5 rounded-lg border border-teal-200 bg-teal-50 p-2.5">
            <div className="flex items-center gap-1 text-[11px] font-medium text-teal-800">
              <IndianRupee className="h-3 w-3" /> EHRC charge master — cited tariff (not an estimate)
            </div>
            <ul className="mt-1 space-y-0.5">
              {stage.tariffs.map((t) => (
                <li key={t.code} className="text-[12px] text-teal-900">
                  <span className="font-medium">{t.item}</span> <span className="text-teal-700">({t.code})</span>: {tariffLine(t)}
                </li>
              ))}
            </ul>
          </div>
        )}

        {stage.alternatives && stage.alternatives.length > 0 && (
          <div className="mt-2.5">
            <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Alternatives</div>
            <ul className="mt-1 space-y-0.5">
              {stage.alternatives.map((a, i) => (
                <li key={i} className="text-[12.5px] text-slate-600"><span className="font-medium text-slate-800">{a.name}</span>{a.note ? ` — ${a.note}` : ''}</li>
              ))}
            </ul>
          </div>
        )}

        {stage.evidence && stage.evidence.length > 0 && (
          <div className="mt-2.5">
            <div className="flex items-center gap-1 text-[11px] font-medium text-slate-500"><BookOpen className="h-3 w-3" /> Evidence</div>
            <ul className="mt-1 list-disc pl-4 text-[12px] text-slate-600">
              {stage.evidence.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          </div>
        )}

        {stage.estimates && stage.estimates.length > 0 && (
          <div className="mt-2.5 rounded-lg border border-dashed border-amber-300 bg-amber-50 p-2.5">
            <div className="flex items-center gap-1 text-[11px] font-medium text-amber-700"><AlertTriangle className="h-3 w-3" /> Model estimates — not validated</div>
            <ul className="mt-1 list-disc pl-4 text-[12px] text-amber-900">
              {stage.estimates.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          </div>
        )}

        {stage.citations && stage.citations.length > 0 && (
          <div className="mt-2 text-[11px] text-slate-400">Source: {stage.citations.join(' · ')}</div>
        )}

        {enriching && (
          <div className="mt-2 flex items-center gap-1.5 text-[11.5px] text-slate-400">
            <Loader2 className="h-3 w-3 animate-spin" /> enriching this step…
          </div>
        )}
      </div>
    </li>
  );
}
