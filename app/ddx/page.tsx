export const metadata = { title: 'Differential Diagnosis · Even-Tutor' };

export default function Page() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900">Differential Diagnosis</h1>
      <p className="mt-2 max-w-xl text-sm text-slate-600">Enter a clinical presentation; get a ranked differential with rule-out-the-worst-first prioritization, distinguishing features, and recommended investigations — grounded in UpToDate-DiffDx and StatPearls pathophysiology.</p>
      <div className="mt-8 rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">
        <div className="flex items-center gap-2 font-semibold">Coming in v0.3</div>
        <p className="mt-2 leading-relaxed">
          The PRD is locked. This feature lands after the v0.2 foundation (PWA shell + new Ask) is stable.
          For now, the Ask tab can answer most clinical questions across MKSAP, StatPearls, and UpToDate.
        </p>
      </div>
    </div>
  );
}
