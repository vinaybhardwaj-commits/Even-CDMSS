import HelpCard from '@/components/HelpCard';
import DdxClient from './ddx-client';

export const metadata = { title: 'DDx · Even Staff Portal' };

export default function DdxPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900 sm:text-3xl">Differential Diagnosis</h1>
      <p className="mt-1 text-sm text-slate-500">
        Structured clinical presentations turned into a cited differential from the Even Hospital Database. Cannot-miss first, then most likely, then other considerations.
      </p>
      <HelpCard
        storageKey="ddx"
        title="About this differential-diagnosis tool"
        body="Even DDx takes a structured clinical presentation (chief complaint plus any age/sex/history/exam/vitals), searches the same curated database that powers /ask, and synthesises a JSON differential with cannot-miss diagnoses up top, then most-likely, then other considerations — every claim cited to a textbook excerpt or PLOS abstract. A second model audits the draft for missed dangerous diagnoses, implausible likelihoods, and unsupported claims before you see it. Typical end-to-end latency 90 s – 3 min per case."
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
