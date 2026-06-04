import Link from 'next/link';
import { sql } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Literature engine · CAT Admin' };

type Topic = { id: number; topic: string; query_terms: string; enabled: boolean; last_run_at: string | null; max_per_run: number };
type RunRow = { id: number; kind: string; topic_id: number | null; started_at: string; found: number; inserted: number; skipped_dup: number; rejected: number; errors: number };
type Article = { pmid: string; title: string | null; journal: string | null; year: number | null; evidence_tier: number | null; citation_count: number | null; status: string };

const TABS: [string, string][] = [['topics', 'Topics'], ['runs', 'Runs'], ['library', 'Library'], ['retractions', 'Retractions']];

async function count(p: unknown): Promise<number> {
  try { const r = (await (p as Promise<Array<{ n: number }>>)); return r[0]?.n ?? 0; } catch { return 0; }
}
async function rows<T>(p: unknown): Promise<T[]> {
  try { return (await (p as Promise<T[]>)); } catch { return []; }
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-slate-100 px-4 py-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-2xl font-semibold text-slate-900">{value}</div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">{text}</div>;
}

export default async function LiteratureAdmin({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab = 'topics' } = await searchParams;

  const corpus = await count(sql`SELECT count(*)::int AS n FROM mksap_chunks`);
  const pubmed = await count(sql`SELECT count(*)::int AS n FROM mksap_chunks WHERE source = 'pubmed'`);
  const hidden = await count(sql`SELECT count(*)::int AS n FROM mksap_chunks WHERE visible = false`);
  const topicsEnabled = await count(sql`SELECT count(*)::int AS n FROM ingest_topics WHERE enabled`);

  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900 sm:text-3xl">Literature engine</h1>
      <p className="mt-1 text-sm text-slate-500">
        Daily PubMed harvest into the CDMSS corpus, with continuous retraction screening. Internal admin surface — not shown to clinicians.
      </p>

      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi label="Corpus chunks" value={corpus.toLocaleString()} />
        <Kpi label="PubMed chunks" value={pubmed.toLocaleString()} />
        <Kpi label="Hidden (retracted)" value={hidden.toLocaleString()} />
        <Kpi label="Topics enabled" value={String(topicsEnabled)} />
      </div>

      <div className="mt-6 flex gap-5 border-b border-slate-200">
        {TABS.map(([key, label]) => (
          <Link
            key={key}
            href={`/admin/literature?tab=${key}`}
            className={`-mb-px pb-2 text-sm ${tab === key ? 'border-b-2 border-slate-900 font-medium text-slate-900' : 'text-slate-500 hover:text-slate-800'}`}
          >
            {label}
          </Link>
        ))}
      </div>

      <div className="mt-5">
        {tab === 'topics' && <TopicsTab />}
        {tab === 'runs' && <RunsTab />}
        {tab === 'library' && <LibraryTab />}
        {tab === 'retractions' && <RetractionsTab />}
      </div>
    </div>
  );
}

async function TopicsTab() {
  const list = await rows<Topic>(sql`SELECT id, topic, query_terms, enabled, last_run_at, max_per_run FROM ingest_topics ORDER BY id`);
  if (list.length === 0) return <Empty text="No topics yet. Run migration 0002 to seed the 22 starter topics." />;
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <table className="w-full text-sm" style={{ tableLayout: 'fixed' }}>
        <thead>
          <tr className="text-left text-slate-500">
            <th className="px-4 py-2 font-normal" style={{ width: '34%' }}>Topic</th>
            <th className="px-2 py-2 font-normal" style={{ width: '38%' }}>Query terms</th>
            <th className="px-2 py-2 font-normal" style={{ width: '14%' }}>Status</th>
            <th className="px-4 py-2 font-normal" style={{ width: '14%' }}>Last run</th>
          </tr>
        </thead>
        <tbody>
          {list.map((t) => (
            <tr key={t.id} className="border-t border-slate-100 align-top">
              <td className="px-4 py-2.5 text-slate-800">{t.topic}</td>
              <td className="px-2 py-2.5 font-mono text-xs text-slate-500">{t.query_terms}</td>
              <td className="px-2 py-2.5">
                <span className={`rounded px-2 py-0.5 text-xs ${t.enabled ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                  {t.enabled ? 'enabled' : 'paused'}
                </span>
              </td>
              <td className="px-4 py-2.5 text-slate-500">{t.last_run_at ? new Date(t.last_run_at).toLocaleString() : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

async function RunsTab() {
  const list = await rows<RunRow>(sql`SELECT id, kind, topic_id, started_at, found, inserted, skipped_dup, rejected, errors FROM ingest_runs ORDER BY started_at DESC LIMIT 50`);
  if (list.length === 0) return <Empty text="No runs yet — the harvester hasn't run. It will populate here once the daily job is wired up (Phase 2)." />;
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-slate-500">
            <th className="px-4 py-2 font-normal">When</th><th className="px-2 py-2 font-normal">Kind</th>
            <th className="px-2 py-2 font-normal">Found</th><th className="px-2 py-2 font-normal">Inserted</th>
            <th className="px-2 py-2 font-normal">Deduped</th><th className="px-2 py-2 font-normal">Rejected</th>
          </tr>
        </thead>
        <tbody>
          {list.map((r) => (
            <tr key={r.id} className="border-t border-slate-100">
              <td className="px-4 py-2.5 text-slate-500">{new Date(r.started_at).toLocaleString()}</td>
              <td className="px-2 py-2.5">{r.kind}</td>
              <td className="px-2 py-2.5">{r.found}</td>
              <td className="px-2 py-2.5 text-emerald-700">{r.inserted}</td>
              <td className="px-2 py-2.5 text-slate-500">{r.skipped_dup}</td>
              <td className="px-2 py-2.5 text-amber-700">{r.rejected}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

async function LibraryTab() {
  const list = await rows<Article>(sql`SELECT pmid, title, journal, year, evidence_tier, citation_count, status FROM ingested_articles ORDER BY first_ingested_at DESC LIMIT 50`);
  if (list.length === 0) return <Empty text="No articles ingested yet. Harvested abstracts will appear here with provenance and a hide/unhide control." />;
  return (
    <div className="space-y-2">
      {list.map((a) => (
        <div key={a.pmid} className="rounded-lg border border-slate-200 bg-white p-3">
          <div className="text-sm text-slate-800">{a.title ?? a.pmid}</div>
          <div className="mt-0.5 text-xs text-slate-500">
            {a.journal}{a.year ? ` · ${a.year}` : ''} · PMID {a.pmid}
            {a.citation_count != null ? ` · ${a.citation_count} citations` : ''}
            {a.status !== 'active' ? ` · ${a.status}` : ''}
          </div>
        </div>
      ))}
    </div>
  );
}

async function RetractionsTab() {
  const list = await rows<Article>(sql`SELECT pmid, title, journal, year, evidence_tier, citation_count, status FROM ingested_articles WHERE status = 'retracted' ORDER BY first_ingested_at DESC LIMIT 50`);
  if (list.length === 0) return <Empty text="No retractions detected. The sentinel auto-hides any retracted article from retrieval and lists it here." />;
  return (
    <div className="space-y-2">
      {list.map((a) => (
        <div key={a.pmid} className="rounded-lg border border-rose-200 bg-rose-50 p-3">
          <div className="text-sm text-rose-900">{a.title ?? a.pmid}</div>
          <div className="mt-0.5 text-xs text-rose-700">{a.journal}{a.year ? ` · ${a.year}` : ''} · PMID {a.pmid} · hidden from retrieval</div>
        </div>
      ))}
    </div>
  );
}
