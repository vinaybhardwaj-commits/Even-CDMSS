'use client';

import Link from 'next/link';
import { Stethoscope } from 'lucide-react';
import CalculatorShell from './CalculatorShell';
import type { CalculatorConfig, CalculatorResult, FormField } from '@/lib/calculators/types';
import { computeTimi, type TimiInputs } from '@/lib/calculators/math/timi';

const YN = (pts: number) => [
  { value: true,  label: 'Yes', points: pts },
  { value: false, label: 'No',  points: 0 },
];

const FIELDS: FormField[] = [
  { key: 'age_ge_65', label: 'Age ≥ 65', type: 'bool', required: true,
    subtitle: 'Patient age 65 or above at presentation.',
    options: YN(1),
    staticTooltip: 'Patient age 65 or above at presentation.' },
  { key: 'ge_3_risk_factors', label: '≥ 3 CAD risk factors', type: 'bool', required: true,
    subtitle: 'Count of three or more: HTN, hypercholesterolemia, DM, family CAD, current smoker.',
    options: YN(1),
    staticTooltip: 'HTN, hypercholesterolemia, DM, family history of CAD, current smoker — count of three or more.' },
  { key: 'known_cad_50', label: 'Known CAD with stenosis ≥ 50%', type: 'bool', required: true,
    subtitle: 'Documented coronary stenosis ≥ 50% on prior angiography.',
    options: YN(1),
    staticTooltip: 'Documented coronary stenosis ≥50% on prior angiography.' },
  { key: 'asa_in_7d', label: 'Aspirin use in past 7 days', type: 'bool', required: true,
    subtitle: 'Any aspirin dose taken in the past 7 days (proxy for higher baseline risk + aspirin-failure).',
    options: YN(1),
    staticTooltip: 'Any aspirin dose taken in the past 7 days (suggests baseline higher risk, plus implies aspirin-failure).' },
  { key: 'severe_angina_24h', label: 'Severe angina (≥ 2 episodes within 24 h)', type: 'bool', required: true,
    subtitle: 'Two or more anginal episodes in the preceding 24 hours.',
    options: YN(1),
    staticTooltip: 'Two or more episodes of anginal pain in the preceding 24 hours.' },
  { key: 'elevated_markers', label: 'Elevated cardiac markers', type: 'bool', required: true,
    subtitle: 'Troponin (or CK-MB if troponin unavailable) above the local 99th-percentile upper reference limit.',
    options: YN(1),
    staticTooltip: 'Troponin (or CK-MB if troponin unavailable) above the local 99th-percentile upper reference limit.' },
  { key: 'st_dev_0_5', label: 'ST deviation ≥ 0.5 mm', type: 'bool', required: true,
    subtitle: 'ST elevation OR ST depression of at least 0.5 mm on the presenting ECG.',
    options: YN(1),
    staticTooltip: 'ST elevation OR ST depression of at least 0.5 mm on the presenting ECG.' },
];

const CFG: CalculatorConfig = {
  name: 'timi',
  displayTitle: 'TIMI — UA/NSTEMI risk',
  moduleHome: 'ask',
  pasteModeEnabled: false,
  apiPath: '/api/calculators/timi',
  resultSections: ['interpretation'],
  typicalLatencySec: 2,
  fields: FIELDS,
};

type Det = { score: number; band: string; band_label: string };

const BAND_COLOR: Record<string, string> = {
  low: 'bg-emerald-100 text-emerald-700',
  intermediate: 'bg-yellow-100 text-yellow-800',
  high: 'bg-red-200 text-red-800',
};

const TIMI_KEYS: Array<keyof TimiInputs> = [
  'age_ge_65', 'ge_3_risk_factors', 'known_cad_50',
  'asa_in_7d', 'severe_angina_24h', 'elevated_markers', 'st_dev_0_5',
];

function Result({ result }: { result: CalculatorResult & { deterministic: Det } }) {
  const d = result.deterministic;
  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
          <span className="text-5xl font-bold tracking-tight text-slate-900">{d.score}</span>
          <span className="text-sm text-slate-500">/ 7 TIMI</span>
          <span className={`ml-auto inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold ${BAND_COLOR[d.band] ?? ''}`}>{d.band_label}</span>
        </div>
      </div>
      <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div className="mb-2 flex items-center gap-2">
          <Stethoscope className="h-4 w-4 text-brand" />
          <h2 className="text-sm font-semibold text-slate-900">Clinical interpretation</h2>
        </div>
        <div className="text-sm leading-relaxed text-slate-700">{d.band_label}.</div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Link href={`/ask?q=${encodeURIComponent('My TIMI score is ' + d.score + ' (' + d.band_label + '). Does this push me toward an early invasive strategy?')}`}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:border-brand hover:text-brand">
          Ask deeper about this score
        </Link>
      </div>
      <div className="text-xs text-slate-400">Trace: <code className="rounded bg-slate-100 px-1.5 py-0.5">{result.trace_id}</code></div>
    </div>
  );
}

export default function TimiCalculator() {
  return (
    <CalculatorShell<Det>
      config={CFG}
      renderResult={Result}
      liveScore={(v) => {
        const complete = TIMI_KEYS.every((k) => typeof v[k] === 'boolean');
        const inputs = Object.fromEntries(TIMI_KEYS.map((k) => [k, v[k] === true])) as unknown as TimiInputs;
        try {
          const r = computeTimi(inputs);
          return { score: r.score, max: 7, band: r.band, band_label: r.band_label, complete };
        } catch { return null; }
      }}
    />
  );
}
