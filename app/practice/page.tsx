import PracticeClient from './practice-client';
export const metadata = { title: 'Practice · Even-Tutor' };

export default function PracticePage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900">Practice</h1>
      <p className="mt-1 text-sm text-slate-500">
        Each card is a fresh multiple-choice question generated from a real MKSAP self-assessment item. Pick an answer, then reveal.
      </p>
      <div className="mt-6"><PracticeClient /></div>
    </div>
  );
}
