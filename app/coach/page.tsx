import HelpCard from '@/components/HelpCard';
import CoachClient from './coach-client';

export const metadata = { title: 'Coach · Even CDMSS' };

export default function CoachPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900 sm:text-3xl">Clinical Reasoning Coach</h1>
      <p className="mt-1 text-sm text-slate-500">
        Socratic multi-turn teaching. The coach never gives the answer — it probes your reasoning. Difficulty adapts as you go.
      </p>
            <HelpCard
        storageKey="coach"
        title='Socratic clinical reasoning coach'
        bullets={[
          'Pick a Topic (free text or chip) or paste a Case vignette — start at novice / intermediate / advanced',
          'The coach NEVER tells you the answer — it probes with questions, evaluates each reply, and adapts difficulty',
          '✓ Correct / ~ Partial / ✗ Off-track shows under each of your messages with a one-line rationale',
          "Session ends automatically when the coach decides you've mastered the topic, or you tap End for a summary",
        ]}
      />
      <div className="mt-6"><CoachClient /></div>
    </div>
  );
}
