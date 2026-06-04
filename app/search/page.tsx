import HelpCard from '@/components/HelpCard';
import SearchClient from './search-client';

export const metadata = { title: 'Search · CAT' };

export default function SearchPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900 sm:text-3xl">Semantic Search</h1>
      <p className="mt-1 text-sm text-slate-500">
        Search the Even Hospital Database directly and see the ranked source passages — no LLM synthesis, just the underlying evidence with citations.
      </p>
      <HelpCard
        storageKey="search"
        title="About semantic search"
        bullets={[
          'Returns the most similar corpus chunks for your query, ranked by relevance',
          'No answer is synthesised — you read the source passages yourself',
          'Use it to verify a citation or find primary material fast',
        ]}
      />
      <div className="mt-6"><SearchClient /></div>
    </div>
  );
}
