export const metadata = { title: 'Drug Dosing & Interactions · Even-Tutor' };

export default function Page() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900">Drug Dosing & Interactions</h1>
      <p className="mt-2 max-w-xl text-sm text-slate-600">Look up dosing, indications, renal/hepatic adjustments. Check N-way drug interactions with severity, mechanism, and management — sourced from UpToDate-Drugs and UpToDate-Interactions.</p>
      <div className="mt-8 rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">
        <div className="flex items-center gap-2 font-semibold">Coming in v0.4</div>
        <p className="mt-2 leading-relaxed">
          The PRD is locked. This feature lands after the v0.2 foundation (PWA shell + new Ask) is stable.
          For now, the Ask tab can answer most clinical questions across MKSAP, StatPearls, and UpToDate.
        </p>
      </div>
    </div>
  );
}
