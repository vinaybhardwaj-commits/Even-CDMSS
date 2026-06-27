'use client';

import { useState } from 'react';
import { Loader2, Flag, X, ExternalLink, Info, Scale, Lightbulb, BookOpen, AlertTriangle, IndianRupee } from 'lucide-react';
import { levelToScore, VALUE_DISCLAIMER, type ValueAnalysis, type ValueIntervention, type Level, type NetValue, type TariffRef } from '@/lib/lvc-value-core';

const inr = (n: number) => '₹' + Number(n).toLocaleString('en-IN');

type Region = 'US' | 'CA' | 'IN';
type LvcFlag = {
  id: string;
  statement: string;
  society: string;
  region: Region;
  specialty: string | null;
  rationale: string | null;
  consider_instead: string | null;
  why_it_applies: string;
  confidence: number;
  citation: { url: string | null; doi: string | null; pmid: string | null; year: number | null };
};
type MatchResult = {
  ok: boolean;
  flags: LvcFlag[];
  candidates: { name: string }[];
  considered: number;
  empty: boolean;
  traceId?: string;
  valueAnalysis?: ValueAnalysis | null;
  valueTraceId?: string;
  error?: string;
};

type RegionMode = 'all' | 'india' | 'us' | 'ca';
const REGION_OPTIONS: [RegionMode, string][] = [
  ['all', 'All'], ['india', 'India-first'], ['us', 'US only'], ['ca', 'Canada only'],
];
const REGION_BADGE: Record<Region, string> = {
  US: 'bg-amber-50 text-amber-800',
  CA: 'bg-blue-50 text-blue-800',
  IN: 'bg-teal-50 text-teal-800',
};
const EXAMPLES = [
  '62F, asymptomatic cT1c N0 ER+ breast cancer. Planning staging PET-CT before surgery.',
  '34M, 5 days of non-specific low back pain, no red flags. Considering MRI lumbar spine.',
  'Otherwise-well adult with acute viral URTI for 3 days. Patient requesting antibiotics.',
];

function regionToBody(mode: RegionMode): { regionFilter?: Region[]; preferRegion?: Region } {
  switch (mode) {
    case 'india': return { preferRegion: 'IN' };
    case 'us': return { regionFilter: ['US'] };
    case 'ca': return { regionFilter: ['CA'] };
    default: return {};
  }
}

export default function AppropriatenessClient() {
  const [scenario, setScenario] = useState('');
  const [orders, setOrders] = useState('');
  const [age, setAge] = useState('');
  const [sex, setSex] = useState('');
  const [region, setRegion] = useState<RegionMode>('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MatchResult | null>(null);
  const [dismissed, setDismissed] = useState<Record<string, boolean>>({});

  async function run() {
    const s = scenario.trim();
    if (s.length < 3) { setError('Enter a clinical scenario.'); return; }
    setLoading(true); setError(null); setResult(null); setDismissed({});
    try {
      const proposedActions = orders
        .split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);
      const body: Record<string, unknown> = {
        scenario: s,
        ...(proposedActions.length ? { proposedActions } : {}),
        patient: { age: age ? Number(age) : undefined, sex: sex || undefined },
        ...regionToBody(region),
      };
      const r = await fetch('/api/appropriateness', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = (await r.json()) as MatchResult;
      if (!r.ok || !j.ok) throw new Error(j.error || `request failed (${r.status})`);
      setResult(j);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const visibleFlags = (result?.flags ?? []).filter((f) => !dismissed[f.id]);

  return (
    <div>
      <div className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
        <label className="text-xs font-medium text-slate-600">Clinical scenario</label>
        <textarea
          value={scenario}
          onChange={(e) => setScenario(e.target.value)}
          rows={3}
          placeholder="62F, asymptomatic early-stage breast cancer, planning staging PET-CT…"
          className="mt-1.5 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand focus:bg-white focus:outline-none"
        />

        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[2fr_0.7fr_1fr_1.1fr]">
          <div>
            <label className="text-xs font-medium text-slate-600">Proposed order(s) <span className="text-slate-400">· optional</span></label>
            <input
              value={orders}
              onChange={(e) => setOrders(e.target.value)}
              placeholder="staging PET-CT"
              className="mt-1.5 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand focus:bg-white focus:outline-none"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600">Age</label>
            <input
              value={age} onChange={(e) => setAge(e.target.value.replace(/[^0-9]/g, ''))}
              inputMode="numeric" placeholder="62"
              className="mt-1.5 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand focus:bg-white focus:outline-none"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600">Sex</label>
            <select
              value={sex} onChange={(e) => setSex(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 focus:border-brand focus:bg-white focus:outline-none"
            >
              <option value="">—</option>
              <option value="female">Female</option>
              <option value="male">Male</option>
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600">Region</label>
            <select
              value={region} onChange={(e) => setRegion(e.target.value as RegionMode)}
              className="mt-1.5 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 focus:border-brand focus:bg-white focus:outline-none"
            >
              {REGION_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            onClick={run} disabled={loading}
            className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            type="button"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Flag className="h-4 w-4" />}
            {loading ? 'Checking…' : 'Check appropriateness'}
          </button>
          <span className="text-xs text-slate-400">Extraction → recall → applicability check; only what applies is shown.</span>
        </div>

        {!scenario && (
          <div className="mt-3 flex flex-wrap gap-2">
            {EXAMPLES.map((ex) => (
              <button key={ex} type="button" onClick={() => setScenario(ex)}
                className="rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-600 hover:border-slate-300 hover:bg-slate-50">
                {ex.length > 52 ? ex.slice(0, 52) + '…' : ex}
              </button>
            ))}
          </div>
        )}
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {result && (
        <div className="mt-5 space-y-5">
          {result.valueAnalysis && result.valueAnalysis.interventions.length > 0 && (
            <div>
              <div className="mb-2 flex items-center gap-1.5 text-xs text-slate-500">
                <Scale className="h-3.5 w-3.5" /> Value analysis
              </div>
              {result.valueAnalysis.tariffs && result.valueAnalysis.tariffs.length > 0 && (
                <TariffBanner tariffs={result.valueAnalysis.tariffs} />
              )}
              <div className="space-y-3">
                {result.valueAnalysis.interventions.map((iv, i) => <ValueCard key={i} iv={iv} />)}
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-slate-400">{result.valueAnalysis.disclaimer || VALUE_DISCLAIMER}</p>
            </div>
          )}

          {visibleFlags.length > 0 ? (
            <div>
              <div className="mb-2 flex items-center gap-1.5 text-xs text-slate-500">
                <Flag className="h-3.5 w-3.5" />
                {visibleFlags.length} Choosing Wisely flag{visibleFlags.length === 1 ? '' : 's'}
              </div>
              <div className="space-y-3">
                {visibleFlags.map((f) => (
                  <FlagCard key={f.id} flag={f} onDismiss={() => setDismissed((d) => ({ ...d, [f.id]: true }))} />
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600">
              {result.valueAnalysis
                ? <>No specific Choosing Wisely list match for this order — the value analysis above is the assessment.</>
                : <><span className="font-medium text-slate-800">No low-value-care flags identified for this scenario.</span> Absence of a flag isn&apos;t an endorsement — it means nothing low-value was matched
                    {result.considered > 0 ? ` (checked ${result.considered} candidate recommendation${result.considered === 1 ? '' : 's'}).` : '.'}</>}
            </div>
          )}

          {(result.valueTraceId || result.traceId) && (
            <div className="flex gap-4 text-xs text-slate-400">
              {result.valueTraceId && (
                <a href={`/admin/observability/${result.valueTraceId}`} className="inline-flex items-center gap-1 hover:text-slate-600">
                  <Info className="h-3 w-3" /> Value trace
                </a>
              )}
              {result.traceId && (
                <a href={`/admin/observability/${result.traceId}`} className="inline-flex items-center gap-1 hover:text-slate-600">
                  <Info className="h-3 w-3" /> Flag trace
                </a>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FlagCard({ flag, onDismiss }: { flag: LvcFlag; onDismiss: () => void }) {
  const href = flag.citation.url
    || (flag.citation.doi ? `https://doi.org/${flag.citation.doi}` : null)
    || (flag.citation.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${flag.citation.pmid}/` : null);
  return (
    <div className="rounded-r-xl border border-l-0 border-slate-200 border-l-[3px] border-l-amber-500 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="text-sm font-medium leading-snug text-slate-900">{flag.statement}</div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${REGION_BADGE[flag.region] ?? 'bg-slate-100 text-slate-700'}`}>{flag.region}</span>
          <span className="text-[11px] text-slate-400">conf {flag.confidence.toFixed(2)}</span>
          <button type="button" onClick={onDismiss} aria-label="dismiss" className="text-slate-400 hover:text-slate-600"><X className="h-4 w-4" /></button>
        </div>
      </div>

      {flag.why_it_applies && (
        <p className="mt-2.5 text-[13px] leading-relaxed text-slate-600">
          <span className="font-medium text-slate-900">Why it applies here:</span> {flag.why_it_applies}
        </p>
      )}
      {flag.consider_instead && (
        <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">
          <span className="font-medium text-slate-900">Consider instead:</span> {flag.consider_instead}
        </p>
      )}

      <div className="mt-2.5 flex items-center justify-between border-t border-slate-100 pt-2 text-[11.5px] text-slate-400">
        <span>{flag.society}{flag.citation.year ? ` · ${flag.citation.year}` : ''}</span>
        {href && (
          <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-brand hover:underline">
            Source <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
    </div>
  );
}

const NET_BADGE: Record<NetValue, string> = {
  'high-value': 'bg-teal-50 text-teal-800',
  'context-dependent': 'bg-amber-50 text-amber-800',
  'low-value': 'bg-red-50 text-red-800',
  uncertain: 'bg-slate-100 text-slate-700',
};
const NET_LABEL: Record<NetValue, string> = {
  'high-value': 'High value', 'context-dependent': 'Context-dependent', 'low-value': 'Low value', uncertain: 'Uncertain',
};

function DimBar({ label, level, tone }: { label: string; level: Level; tone: 'benefit' | 'burden' }) {
  const score = levelToScore(level);
  const fill = tone === 'benefit' ? 'bg-teal-500' : 'bg-amber-500';
  return (
    <div className="flex items-center gap-2">
      <span className="w-28 shrink-0 text-[11px] text-slate-500">{label}</span>
      <div className="flex gap-1">
        {[1, 2, 3].map((n) => (
          <span key={n} className={`h-2.5 w-7 rounded-sm ${n <= score ? fill : 'bg-slate-200'}`} />
        ))}
      </div>
      <span className="text-[11px] capitalize text-slate-500">{level}</span>
    </div>
  );
}

function DimDetail({ label, d }: { label: string; d: { level: Level; detail: string } }) {
  if (!d.detail) return null;
  return <p><span className="font-medium text-slate-900">{label}:</span> {d.detail}</p>;
}

function ValueCard({ iv }: { iv: ValueIntervention }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="text-sm font-medium leading-snug text-slate-900">{iv.intervention}</div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${NET_BADGE[iv.net_value]}`}>{NET_LABEL[iv.net_value]}</span>
          <span className="text-[11px] text-slate-400">conf {iv.confidence.toFixed(2)}</span>
        </div>
      </div>

      {iv.summary && <p className="mt-2 text-[13px] leading-relaxed text-slate-700">{iv.summary}</p>}

      <div className="mt-3 space-y-1.5 rounded-lg bg-slate-50 p-3">
        <DimBar label="Long-term benefit" level={iv.long_term_benefit.level} tone="benefit" />
        <DimBar label="Harms / risks" level={iv.harms_risks.level} tone="burden" />
        <DimBar label="Upfront cost" level={iv.upfront_cost.level} tone="burden" />
        <DimBar label="Long-term care" level={iv.long_term_care.level} tone="burden" />
      </div>

      <div className="mt-3 space-y-2 text-[12.5px] leading-relaxed text-slate-600">
        <DimDetail label="Long-term benefit" d={iv.long_term_benefit} />
        <DimDetail label="Harms / risks" d={iv.harms_risks} />
        <DimDetail label="Upfront cost" d={iv.upfront_cost} />
        <DimDetail label="Long-term care needs" d={iv.long_term_care} />
      </div>

      {iv.alternatives.length > 0 && (
        <div className="mt-3">
          <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Alternatives</div>
          <ul className="mt-1 space-y-1">
            {iv.alternatives.map((a, i) => (
              <li key={i} className="text-[12.5px] text-slate-600"><span className="font-medium text-slate-800">{a.name}</span>{a.note ? ` — ${a.note}` : ''}</li>
            ))}
          </ul>
        </div>
      )}

      {iv.what_would_change.length > 0 && (
        <div className="mt-3 flex gap-2 rounded-lg border border-slate-100 bg-slate-50 p-2.5">
          <Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
          <div>
            <div className="text-[11px] font-medium text-slate-500">What would change this</div>
            <ul className="mt-0.5 list-disc pl-4 text-[12.5px] text-slate-600">
              {iv.what_would_change.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </div>
        </div>
      )}

      {iv.evidence.length > 0 && (
        <div className="mt-3">
          <div className="flex items-center gap-1 text-[11px] font-medium text-slate-500"><BookOpen className="h-3 w-3" /> Evidence</div>
          <ul className="mt-1 list-disc pl-4 text-[12px] text-slate-600">
            {iv.evidence.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        </div>
      )}

      {iv.estimates.length > 0 && (
        <div className="mt-3 rounded-lg border border-dashed border-amber-300 bg-amber-50 p-2.5">
          <div className="flex items-center gap-1 text-[11px] font-medium text-amber-700"><AlertTriangle className="h-3 w-3" /> Model estimates — not validated</div>
          <ul className="mt-1 list-disc pl-4 text-[12px] text-amber-900">
            {iv.estimates.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

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

function TariffBanner({ tariffs }: { tariffs: TariffRef[] }) {
  return (
    <div className="mb-3 rounded-lg border border-teal-200 bg-teal-50 p-3">
      <div className="flex items-center gap-1 text-[11px] font-medium text-teal-800">
        <IndianRupee className="h-3 w-3" /> EHRC charge master — cited tariff (not an estimate)
      </div>
      <ul className="mt-1.5 space-y-1">
        {tariffs.map((t) => (
          <li key={t.code} className="text-[12.5px] text-teal-900">
            <span className="font-medium">{t.item}</span> <span className="text-teal-700">({t.code})</span>: {tariffLine(t)}
          </li>
        ))}
      </ul>
    </div>
  );
}
