import TopicsClient from './topics-client';
export const metadata = { title: 'Topics · Even-Tutor' };

export default function TopicsPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900">Topic Synthesis</h1>
      <p className="mt-1 text-sm text-slate-500">
        Name a topic. The LLM stitches together MKSAP excerpts across books into a structured study guide.
      </p>
      <div className="mt-6"><TopicsClient /></div>
    </div>
  );
}
