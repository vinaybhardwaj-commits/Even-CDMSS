import Link from 'next/link';

const CARDS = [
  { href: '/ask', title: 'Ask', blurb: 'Free-form medical questions answered from MKSAP with citations.' },
  { href: '/search', title: 'Search', blurb: 'Semantic search over the corpus — see the raw chunks, no LLM.' },
  { href: '/browse', title: 'Browse', blurb: '12 books, 275 chapters, 8,790 chunks. Read by topic.' },
  { href: '/practice', title: 'Practice', blurb: 'Quiz mode from MKSAP self-assessment items.' },
  { href: '/topics', title: 'Topics', blurb: 'LLM-synthesized study guide across books for a named topic.' },
];

export default function Home() {
  return (
    <div>
      <h1 className="text-3xl font-semibold text-slate-900">Welcome.</h1>
      <p className="mt-2 max-w-2xl text-slate-600">
        MKSAP 19 corpus is loaded — 7.9M tokens across 12 books, indexed for semantic search. Pick a workflow below.
      </p>
      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {CARDS.map((c) => (
          <Link
            key={c.href}
            href={c.href}
            className="group rounded-lg border bg-white p-5 shadow-sm transition hover:border-brand hover:shadow"
          >
            <h2 className="text-lg font-semibold text-brand group-hover:text-brand-light">{c.title}</h2>
            <p className="mt-2 text-sm text-slate-600">{c.blurb}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
