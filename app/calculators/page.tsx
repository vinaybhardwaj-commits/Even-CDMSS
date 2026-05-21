import Link from 'next/link';
import { Pill, Activity, Beaker, Droplet, Timer } from 'lucide-react';
import HelpCard from '@/components/HelpCard';

export const metadata = { title: 'Calculators · Even CDMSS' };

const CALCULATORS = [
  {
    href: '/calculators/egfr',
    title: 'eGFR',
    subtitle: 'CKD-EPI 2021 + Cockcroft-Gault',
    desc: 'Renal function for drug dosing. Both equations always compute. Result pushes to Drugs session context so the next drug lookup is renal-adjusted automatically.',
    Icon: Pill,
    badge: 'Deterministic',
  },
  {
    href: '/calculators/news2',
    title: 'NEWS2',
    subtitle: 'National Early Warning Score (RCP 2017)',
    desc: '8-element bedside deterioration score. Scale 1 + Scale 2 (COPD/Type-2 RF). Auto-banner amber at ≥5, red at ≥7.',
    Icon: Activity,
    badge: 'Deterministic',
  },
  {
    href: '/calculators/abg',
    title: 'ABG interpreter',
    subtitle: 'Acid-base + oxygenation',
    desc: 'Winters\' / compensation, anion gap (with albumin correction), delta-delta, P/F + A-a. qwen 14b synthesizes the ranked differential and next workup.',
    Icon: Beaker,
    badge: 'LLM-native',
  },
  {
    href: '/calculators/hyponatremia',
    title: 'Hyponatremia',
    subtitle: 'Workup synthesizer',
    desc: 'Glucose-corrected Na (Katz/Hillier), tonicity, free-water excess, ODS-risk ceiling. qwen 14b ranked differential keyed to volume status + meds.',
    Icon: Droplet,
    badge: 'LLM-native',
  },
  {
    href: '/calculators/sepsis-bundle',
    title: 'Sepsis 1-h bundle',
    subtitle: 'SSC 2021 compliance tracker',
    desc: 'Live countdown + per-element status. Optional qwen 14b evidence sidebar cached 7 days per user. No LLM on the main path.',
    Icon: Timer,
    badge: 'Checklist',
  },
] as const;

const BADGE_COLOR: Record<string, string> = {
  'Deterministic': 'bg-slate-100 text-slate-600',
  'LLM-native':    'bg-brand-faint text-brand',
  'Checklist':     'bg-emerald-100 text-emerald-700',
};

export default function CalculatorsPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900 sm:text-3xl">Calculators</h1>
      <p className="mt-1 text-sm text-slate-500">
        Bedside math for renal function, deterioration, acid-base, sodium, and sepsis. Deterministic by default — LLM only where synthesis adds clinical leverage.
      </p>
      <HelpCard
        storageKey="calculators"
        title='Five bedside calculators with deterministic math + LLM-grounded synthesis'
        bullets={[
          'eGFR pushes its result into Drugs so the next lookup is renal-adjusted automatically',
          'NEWS2 auto-banners amber at ≥5, red at ≥7 — link straight into Coach for deterioration recognition',
          'ABG + Hyponatremia stream a 6-section interpretation (qwen 14b) grounded in MKSAP/StatPearls/UpToDate',
          'Sepsis 1-h bundle tracker uses zero LLM on main path; evidence sidebar cached 7 days per user',
        ]}
      />
      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {CALCULATORS.map((c) => {
          const Icon = c.Icon;
          return (
            <Link key={c.href} href={c.href}
                  className="group flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition hover:border-brand hover:shadow">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-brand-faint text-brand">
                <Icon className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-semibold text-slate-900 group-hover:text-brand">{c.title}</span>
                  <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ${BADGE_COLOR[c.badge]}`}>{c.badge}</span>
                </div>
                <div className="mt-0.5 text-[11px] uppercase tracking-wide text-slate-400">{c.subtitle}</div>
                <p className="mt-1.5 text-xs leading-relaxed text-slate-600">{c.desc}</p>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
