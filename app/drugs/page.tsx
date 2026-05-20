import DrugsClient from './drugs-client';

export const metadata = { title: 'Drugs · Even-Tutor' };

export default function DrugsPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900 sm:text-3xl">Drug Dosing & Interactions</h1>
      <p className="mt-1 text-sm text-slate-500">
        Look up a single drug, or check interactions among up to 5 drugs. Grounded in MKSAP, StatPearls, and UpToDate.
      </p>
      <div className="mt-6"><DrugsClient /></div>
    </div>
  );
}
