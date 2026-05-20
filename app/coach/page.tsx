import CoachClient from './coach-client';

export const metadata = { title: 'Coach · Even-Tutor' };

export default function CoachPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900 sm:text-3xl">Clinical Reasoning Coach</h1>
      <p className="mt-1 text-sm text-slate-500">
        Socratic multi-turn teaching. The coach never gives the answer — it probes your reasoning. Difficulty adapts as you go.
      </p>
      <div className="mt-6"><CoachClient /></div>
    </div>
  );
}
