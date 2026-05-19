import AskClient from './ask-client';

export const metadata = { title: 'Ask · Even-Tutor' };

export default function AskPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900">Ask</h1>
      <p className="mt-1 text-sm text-slate-500">
        Free-form medical question. Answered from MKSAP only. Citations expandable.
      </p>
      <div className="mt-6">
        <AskClient />
      </div>
    </div>
  );
}
