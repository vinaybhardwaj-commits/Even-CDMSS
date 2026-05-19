import SearchClient from './search-client';

export const metadata = { title: 'Search · Even-Tutor' };

export default function SearchPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900">Semantic Search</h1>
      <p className="mt-1 text-sm text-slate-500">
        Find MKSAP chunks by meaning. No LLM — just retrieval. Use it to verify what the corpus actually contains.
      </p>
      <div className="mt-6"><SearchClient /></div>
    </div>
  );
}
