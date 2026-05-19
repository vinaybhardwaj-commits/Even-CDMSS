import DdxClient from './ddx-client';

export const metadata = { title: 'DDx · Even-Tutor' };

export default function DdxPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900 sm:text-3xl">Differential Diagnosis</h1>
      <p className="mt-1 text-sm text-slate-500">
        Enter a clinical presentation. Get a ranked differential — cannot-miss diagnoses first, then most likely, then other considerations. Cited.
      </p>
      <div className="mt-6"><DdxClient /></div>
    </div>
  );
}
