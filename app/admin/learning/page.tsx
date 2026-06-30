import Link from 'next/link';
import { sql } from '@/lib/db';
import { isAdminUnlocked, adminTokenConfigured } from '@/lib/admin-cookie';
import { MineButton, ReviewButtons } from './controls';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Learning loop · Admin · CAT' };

const APP = process.env.APP_SOURCE || 'standalone';
const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const n = (v: unknown): number => Number(v ?? 0);
function parseJson<T>(v: unknown, f: T): T {
  if (v == null) return f;
  if (typeof v === 'object') return v as T;
  if (typeof v === 'string') { try { return JSON.parse(v) as T; } catch { return f; } }
  return f;
}

type Evidence = { n?: number; source?: string; book?: string; item_number?: string | null; url?: string | null; preview?: string };
type Provenance = { nOccurrences?: number; nDoctors?: number; depts?: string[]; sampleSubjects?: string[]; dominantDomain?: string };
type Payload = { statement?: string; action_type?: string; rationale?: string; keywords?: string[]; provenance?: string };
type Proposal = {
  id: string; type: string; status: string; title: string; confidence: number; n_support: number;
  suggested_reviewer: string; reviewed_by: string | null; reviewed_at: string | null; review_note: string | null;
  payload: Payload; evidence: Evidence[]; provenance: Provenance;
};

const REVIEWER_LABEL: Record<string, string> = { pharmacy_ams: 'Pharmacy / AMS', dept_lead: 'Dept lead', owner: 'Hospital PM' };
const STATUSES = ['proposed', 'approved', 'rejected', 'all'] as const;

function Locked() {
  return (
    <div>
      <h1 className="font-serif text-[26px] font-semibold text-slate-900">Learning loop</h1>
      <p className="mt-1.5 text-sm text-slate-500">Locked. <Link href="/admin/opd-audit" className="text-brand hover:underline">Unlock an admin surface</Link> first.</p>
    </div>
  );
}

export default async function LearningPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  if (!(await isAdminUnlocked())) { adminTokenConfigured(); return <Locked />; }
  const sp = await searchParams;
  const status = (STATUSES as readonly string[]).includes(sp.status || '') ? (sp.status as string) : 'proposed';

  const countRows = (await run(`SELECT status, count(*)::int AS n FROM learning_proposals WHERE app_source = $1 GROUP BY status`, [APP]).catch(() => [])) as { status: string; n: number }[];
  const counts: Record<string, number> = {};
  let total = 0;
  for (const r of countRows) { counts[r.status] = r.n; total += r.n; }

  const rows = (await run(
    status === 'all'
      ? `SELECT id,type,status,title,payload,evidence,provenance,confidence,n_support,suggested_reviewer,reviewed_by,reviewed_at,review_note FROM learning_proposals WHERE app_source = $1 ORDER BY (status='proposed') DESC, confidence DESC, n_support DESC LIMIT 200`
      : `SELECT id,type,status,title,payload,evidence,provenance,confidence,n_support,suggested_reviewer,reviewed_by,reviewed_at,review_note FROM learning_proposals WHERE app_source = $1 AND status = $2 ORDER BY confidence DESC, n_support DESC LIMIT 200`,
    status === 'all' ? [APP] : [APP, status],
  ).catch(() => [])) as Record<string, unknown>[];

  const proposals: Proposal[] = rows.map((r) => ({
    id: String(r.id), type: String(r.type), status: String(r.status), title: String(r.title || ''),
    confidence: n(r.confidence), n_support: n(r.n_support), suggested_reviewer: String(r.suggested_reviewer || 'owner'),
    reviewed_by: r.reviewed_by ? String(r.reviewed_by) : null, reviewed_at: r.reviewed_at ? String(r.reviewed_at) : null,
    review_note: r.review_note ? String(r.review_note) : null,
    payload: parseJson<Payload>(r.payload, {}), evidence: parseJson<Evidence[]>(r.evidence, []), provenance: parseJson<Provenance>(r.provenance, {}),
  }));

  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-brand">LEARNING LOOP</div>
      <h1 className="font-serif text-[26px] font-semibold text-slate-900">Rule proposals from your audits</h1>
      <p className="mt-1 max-w-3xl text-sm text-slate-500">
        Low-value-care patterns mined from the OPD audits, each evidence-cited, awaiting review. <span className="text-slate-600">Approving publishes the rule to the <strong>Right Care</strong> appropriateness engine (active, cited, EHRC-mined); rejecting drops it. The OPD audit scoring engine is unchanged.</span>
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {STATUSES.map((s) => (
          <Link key={s} href={`/admin/learning?status=${s}`}
            className={`rounded-full border px-2.5 py-1 text-[11.5px] ${status === s ? 'border-brand/40 bg-brand-faint text-brand' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`}>
            {s === 'all' ? `all ${total}` : `${s} ${counts[s] ?? 0}`}
          </Link>
        ))}
        <span className="ml-auto"><MineButton /></span>
      </div>

      {proposals.length === 0 ? (
        <div className="mt-4 rounded-xl border border-slate-200 bg-white p-6 text-center text-[13px] text-slate-500">
          No {status === 'all' ? '' : status} proposals yet. Click <span className="font-medium text-brand">↻ Run miner</span> to scan the last 90 days of audits.
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          {proposals.map((p) => (
            <div key={p.id} className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">{p.type === 'lvc_rule' ? 'Low-value rule' : p.type}</span>
                <span className="rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700">→ {REVIEWER_LABEL[p.suggested_reviewer] || p.suggested_reviewer}</span>
                <span className="text-[10.5px] text-slate-400">confidence {Math.round(p.confidence * 100)}% · seen {p.n_support}×</span>
                {p.status !== 'proposed' && (
                  <span className={`ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium ${p.status === 'approved' ? 'bg-emerald-50 text-emerald-700' : p.status === 'rejected' ? 'bg-red-50 text-red-700' : 'bg-slate-100 text-slate-500'}`}>{p.status}</span>
                )}
              </div>

              <div className="mt-2 text-[14px] font-medium text-slate-900">{p.payload.statement || p.title}</div>
              {p.payload.rationale && <p className="mt-1 text-[12px] leading-snug text-slate-600">{p.payload.rationale}</p>}

              {Array.isArray(p.payload.keywords) && p.payload.keywords.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {p.payload.keywords.slice(0, 10).map((k, i) => <span key={i} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">{k}</span>)}
                </div>
              )}

              <div className="mt-2 text-[11px] text-slate-500">
                Seen <strong className="text-slate-700">{p.provenance.nOccurrences ?? p.n_support}×</strong> across <strong className="text-slate-700">{p.provenance.nDoctors ?? 0}</strong> doctors
                {p.provenance.depts && p.provenance.depts.length > 0 ? ` · ${p.provenance.depts.join(', ')}` : ''}
                {p.provenance.sampleSubjects && p.provenance.sampleSubjects.length > 0 && (
                  <span className="block text-slate-400">e.g. {p.provenance.sampleSubjects.slice(0, 3).join(' · ')}</span>
                )}
              </div>

              {p.evidence.length > 0 && (
                <div className="mt-2 border-t border-slate-100 pt-2">
                  <div className="text-[10px] font-medium uppercase tracking-wide text-slate-400">Evidence ({p.evidence.length})</div>
                  <ul className="mt-1 space-y-0.5">
                    {p.evidence.slice(0, 4).map((e, i) => (
                      <li key={i} className="text-[11px] text-slate-600">
                        <span className="text-slate-700">{e.book || e.source || 'source'}</span>
                        {e.url ? <a href={e.url} target="_blank" rel="noopener noreferrer" className="ml-1 text-brand hover:underline">PubMed ↗</a> : (e.item_number ? <span className="ml-1 text-slate-400">#{e.item_number}</span> : null)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {p.status === 'proposed'
                ? <ReviewButtons id={p.id} />
                : (p.reviewed_by || p.review_note) && (
                  <div className="mt-2 text-[10.5px] text-slate-400">{p.status} by {p.reviewed_by || 'reviewer'}{p.review_note ? ` — “${p.review_note}”` : ''}</div>
                )}
            </div>
          ))}
        </div>
      )}

      <p className="mt-5 text-[11px] text-slate-400">Advisory. Mined from de-identified audit findings; every rule requires corpus evidence (evidence over frequency). Approved rules become active, cited entries in the Right Care appropriateness engine; the OPD audit scoring engine is unchanged.</p>
    </div>
  );
}
