import HelpCard from '@/components/HelpCard';
import DdxClient from './ddx-client';

export const metadata = { title: 'DDx · Even-Tutor' };

export default function DdxPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900 sm:text-3xl">Differential Diagnosis</h1>
      <p className="mt-1 text-sm text-slate-500">
        Enter a clinical presentation. Get a ranked differential — cannot-miss diagnoses first, then most likely, then other considerations. Cited.
      </p>
            <HelpCard
        storageKey="ddx"
        title='Differential diagnosis from a structured presentation'
        bullets={[
          'Chief complaint is required; age/sex/history/exam/vitals refine the differential when present',
          "Top group ('Cannot-miss') lists dangerous diagnoses to rule out FIRST, regardless of probability",
          'Tap a citation chip [n] on any DDx card to see the source excerpt below',
          'If the LLM flags Missing Info, adding those details will sharpen the differential — re-run with more',
        ]}
      />
      <div className="mt-6"><DdxClient /></div>
    </div>
  );
}
