import HelpCard from '@/components/HelpCard';
import AskClient from './ask-client';

export const metadata = { title: 'Ask · Even CDMSS' };

export default function AskPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900 sm:text-3xl">Ask</h1>
      <p className="mt-1 text-sm text-slate-500">
        Free-form clinical questions, answered from MKSAP, StatPearls, and UpToDate with inline citations.
      </p>
            <HelpCard
        storageKey="ask"
        title='MKSAP-grounded clinical questions'
        bullets={[
          "Type or dictate a clinical question — works best when phrased as a real consult ('first-line for HFrEF NYHA III')",
          'Voice input is supported in Chrome and Safari — tap the mic, speak, the text streams in',
          'Inline citations [n] are clickable — tap to scroll to the source chunk and see the supporting text',
          'Every query is logged to your Shift Review log automatically — no separate save step',
        ]}
      />
      <div className="mt-4 flex flex-wrap gap-2">
        <a href="/ask/hyponatremia" className="inline-flex items-center gap-1.5 rounded-md border border-brand bg-brand-faint px-3 py-1.5 text-sm font-medium text-brand hover:bg-brand hover:text-white">Hyponatremia workup →</a>
        <a href="/ask/abg" className="inline-flex items-center gap-1.5 rounded-md border border-brand bg-brand-faint px-3 py-1.5 text-sm font-medium text-brand hover:bg-brand hover:text-white">Interpret ABG →</a>
        <a href="/ask/news2" className="inline-flex items-center gap-1.5 rounded-md border border-brand bg-brand-faint px-3 py-1.5 text-sm font-medium text-brand hover:bg-brand hover:text-white">
          Compute NEWS2 score →
        </a>
      </div>
      <div className="mt-6"><AskClient /></div>
    </div>
  );
}
