export default function Page() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900">Ask a Question</h1>
      <p className="mt-2 text-slate-600">Free-form medical question → RAG → streamed answer with citations from MKSAP.</p>
      <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        Coming in sprint T1. The scaffold is live; the feature is next on the build queue.
      </div>
    </div>
  );
}
