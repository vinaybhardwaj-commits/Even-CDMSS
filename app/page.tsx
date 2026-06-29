import Link from 'next/link';
import {
  MessagesSquare, Network, Pill, Calculator, ClipboardCheck, ClipboardList,
  BookOpen, GraduationCap, ArrowRight,
} from 'lucide-react';

export const metadata = { title: 'Home' };

const PRIMARY = [
  { href: '/ddx', label: 'Differential', desc: 'Structured presentation → cited differential, cannot-miss first.', Icon: Network },
  { href: '/drugs', label: 'Drugs', desc: 'Dosing, renal/hepatic adjustment, and interaction checks.', Icon: Pill },
  { href: '/calculators', label: 'Calculators', desc: '15 bedside scores — NEWS2, CURB-65, HEART, eGFR, and more.', Icon: Calculator },
  { href: '/appropriateness', label: 'Appropriateness', desc: 'Value check, care pathway, or retrospective case audit.', Icon: ClipboardCheck },
  { href: '/audit', label: 'Medication Audit', desc: 'Pharmacist chart review — allergy and drug-interaction cross-check.', Icon: ClipboardList },
];

const REFERENCE = [
  { href: '/knowledge', label: 'Knowledge base', desc: 'Search the corpus or browse by source.', Icon: BookOpen },
  { href: '/learn', label: 'Learn', desc: 'Coaching, practice questions, topic guides, and review.', Icon: GraduationCap },
];

export default function Home() {
  return (
    <div>
      <div className="mb-7">
        <h1 className="font-serif text-[30px] font-semibold leading-tight text-slate-900 sm:text-[36px]">
          What do you want to work through?
        </h1>
        <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-slate-500">
          CAT answers clinical questions from a curated evidence base, with a verifiable citation behind every claim. Advisory only — it never replaces clinical judgment.
        </p>
      </div>

      {/* Primary action: Ask */}
      <Link
        href="/ask"
        className="group mb-9 flex items-center gap-3 rounded-2xl border-2 border-brand bg-paper px-5 py-4 transition hover:bg-brand-faint"
      >
        <MessagesSquare className="h-6 w-6 shrink-0 text-brand" />
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-medium text-slate-900">Ask a clinical question</div>
          <div className="truncate text-[13px] text-slate-500">Grounded, cited answers — phrase it like a real consult</div>
        </div>
        <span className="flex shrink-0 items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-[13.5px] font-medium text-white transition group-hover:bg-brand-dark">
          Ask <ArrowRight className="h-4 w-4" />
        </span>
      </Link>

      <div className="mb-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400">Decision support</div>
      <div className="mb-9 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {PRIMARY.map(({ href, label, desc, Icon }) => (
          <Link
            key={href}
            href={href}
            className="group flex flex-col rounded-xl border border-slate-200 bg-paper p-4 shadow-card transition hover:-translate-y-0.5 hover:border-brand"
          >
            <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-brand-faint text-brand">
              <Icon className="h-5 w-5" />
            </span>
            <span className="text-[14.5px] font-medium text-slate-900 group-hover:text-brand">{label}</span>
            <span className="mt-1 text-[12.5px] leading-relaxed text-slate-500">{desc}</span>
          </Link>
        ))}
      </div>

      <div className="mb-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400">Reference &amp; learning</div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {REFERENCE.map(({ href, label, desc, Icon }) => (
          <Link
            key={href}
            href={href}
            className="group flex items-center gap-3 rounded-xl border border-dashed border-slate-300 bg-transparent p-4 transition hover:border-brand hover:bg-paper"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500 group-hover:bg-brand-faint group-hover:text-brand">
              <Icon className="h-[18px] w-[18px]" />
            </span>
            <span className="min-w-0">
              <span className="block text-[13.5px] font-medium text-slate-800 group-hover:text-brand">{label}</span>
              <span className="block truncate text-[12px] text-slate-500">{desc}</span>
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
