export default function Page() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900">Topic Synthesis</h1>
      <p className="mt-2 text-slate-600">Name a topic. The LLM stitches together chunks across books into a study guide.</p>
      <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        Coming in sprint T5. The scaffold is live; the feature is next on the build queue.
      </div>
    </div>
  );
}
