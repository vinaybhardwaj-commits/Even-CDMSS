import Link from 'next/link';
import { sql } from '@/lib/db';
import { isAdminUnlocked, adminTokenConfigured } from '@/lib/admin-cookie';
import { fetchFlywheelData, fetchProgrammeData } from '@/lib/learning';
import { pct, type FlywheelView } from '@/lib/learning-flywheel-core';
import type { Meter } from '@/lib/model-programme-core';
import { MineButton, ReviewButtons, MissedRuleButtons, SuppressionButtons } from './controls';

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
type Provenance = {
  nOccurrences?: number; nUncited?: number; nDoctors?: number; depts?: string[]; sampleSubjects?: string[]; dominantDomain?: string;
  // reviewer-driven origins
  nFlags?: number; reviewers?: string[]; category?: string | null; sampleComments?: string[]; source?: string;
  nFalseNitpick?: number; precision?: number; nLabeled?: number;
};
type Payload = {
  statement?: string; action_type?: string; rationale?: string; keywords?: string[]; provenance?: string; topic?: string; query_terms?: string;
  signal_type?: string; discriminator?: string | null; match_kind?: string; scope?: string; action?: string; reason?: string;
};
type Proposal = {
  id: string; type: string; status: string; title: string; confidence: number; n_support: number;
  suggested_reviewer: string; reviewed_by: string | null; reviewed_at: string | null; review_note: string | null;
  payload: Payload; evidence: Evidence[]; provenance: Provenance;
};

const REVIEWER_LABEL: Record<string, string> = { pharmacy_ams: 'Pharmacy / AMS', dept_lead: 'Dept lead', owner: 'Hospital PM' };
const STATUSES = ['proposed', 'approved', 'rejected', 'all'] as const;

// A proposal is reviewer-driven (Section 2) if it came from missed flags or false clusters.
const isMissedOrigin = (p: Proposal): boolean =>
  p.type === 'missed_rule' || p.type === 'suppression' || (p.type === 'harvest_topic' && p.provenance.source === 'missed_flags');

function Locked() {
  return (
    <div>
      <h1 className="font-serif text-[26px] font-semibold text-slate-900">Learning loop</h1>
      <p className="mt-1.5 text-sm text-slate-500">Locked. <Link href="/admin/opd-audit" className="text-brand hover:underline">Unlock an admin surface</Link> first.</p>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'proposed') return null;
  return <span className={`ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium ${status === 'approved' ? 'bg-emerald-50 text-emerald-700' : status === 'rejected' ? 'bg-red-50 text-red-700' : 'bg-slate-100 text-slate-500'}`}>{status}</span>;
}
function ReviewedLine({ p }: { p: Proposal }) {
  if (p.status === 'proposed' || !(p.reviewed_by || p.review_note)) return null;
  return <div className="mt-2 text-[10.5px] text-slate-400">{p.status} by {p.reviewed_by || 'reviewer'}{p.review_note ? ` — “${p.review_note}”` : ''}</div>;
}

// ── Section 1: proposals from what the audits FOUND (existing, enriched) ──
function FoundCard({ p }: { p: Proposal }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">{p.type === 'lvc_rule' ? 'Low-value rule' : p.type === 'harvest_topic' ? 'Evidence-harvest topic' : p.type}</span>
        <span className="rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700">→ {REVIEWER_LABEL[p.suggested_reviewer] || p.suggested_reviewer}</span>
        <span className="text-[10.5px] text-slate-400">confidence {Math.round(p.confidence * 100)}% · seen {p.n_support}×</span>
        <StatusBadge status={p.status} />
      </div>

      <div className="mt-2 text-[14px] font-medium text-slate-900">{p.payload.statement || p.title}</div>
      {p.payload.rationale && <p className="mt-1 text-[12px] leading-snug text-slate-600">{p.payload.rationale}</p>}

      {Array.isArray(p.payload.keywords) && p.payload.keywords.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {p.payload.keywords.slice(0, 10).map((k, i) => <span key={i} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">{k}</span>)}
        </div>
      )}

      {p.type === 'harvest_topic' && p.payload.query_terms && (
        <div className="mt-1.5 text-[11.5px] leading-snug text-slate-600">
          Corpus gap — supported by a citation in only <strong className="text-slate-700">{Math.max(0, (p.provenance.nOccurrences ?? 0) - (p.provenance.nUncited ?? 0))}</strong> of {p.provenance.nOccurrences ?? p.n_support} encounters. Approving adds this PubMed harvest query to the literature engine:
          <code className="ml-1 rounded bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-800">{p.payload.query_terms}</code>
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
        ? <ReviewButtons id={p.id} approveLabel={p.type === 'harvest_topic' ? 'Approve → harvester' : 'Approve → Right Care'} />
        : <ReviewedLine p={p} />}
    </div>
  );
}

// ── Section 2: reviewer-driven proposals (missed flags + false clusters) ──
function MissedCard({ p }: { p: Proposal }) {
  const rvs = (p.provenance.reviewers || []).join(', ');
  const chip = p.type === 'missed_rule'
    ? <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10.5px] font-medium text-emerald-800">rule candidate · from missed flags</span>
    : p.type === 'suppression'
      ? <span className="rounded-full bg-rose-50 px-2 py-0.5 text-[10.5px] font-medium text-rose-700">suppression candidate · from false clusters</span>
      : <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[10.5px] font-medium text-sky-700">harvest candidate · from missed flags</span>;
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center gap-2">
        {chip}
        <span className="rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700">→ {REVIEWER_LABEL[p.suggested_reviewer] || p.suggested_reviewer}</span>
        <StatusBadge status={p.status} />
      </div>

      <div className="mt-2 text-[14px] font-medium text-slate-900">{p.payload.statement || p.title}</div>

      {p.type === 'suppression' ? (
        <div className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-[11.5px] leading-relaxed text-slate-600">
          <strong className="text-slate-700">{p.provenance.nFalseNitpick ?? p.n_support}</strong> findings labeled false/nitpick by <strong className="text-slate-700">{(p.provenance.reviewers || []).length}</strong> reviewer{(p.provenance.reviewers || []).length === 1 ? '' : 's'}
          {p.provenance.precision != null && <> · precision <strong className="text-slate-700">{p.provenance.precision.toFixed(2)}</strong> where labeled</>}
          {p.provenance.nLabeled != null && <> ({p.provenance.nLabeled} labeled)</>}
          <span className="mt-1 block text-slate-500">
            signal <code className="rounded bg-white px-1 py-0.5 text-[10.5px] text-slate-700">{p.payload.signal_type}</code>
            {p.payload.discriminator ? <> · subject contains “{p.payload.discriminator}”</> : <> · whole type</>}
            {' '}· action <strong>{p.payload.action}</strong> · matches audit_suppression shape · dual-label safety invariant applies on approval.
          </span>
        </div>
      ) : (
        <div className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-[11.5px] leading-relaxed text-slate-600">
          <strong className="text-slate-700">{p.provenance.nFlags ?? p.n_support}</strong> missed-flag{(p.provenance.nFlags ?? 1) === 1 ? '' : 's'}
          {p.provenance.category && <> (category: {p.provenance.category})</>}
          {rvs && <> · flagged by {rvs}</>}
          {' '}· corpus check: <strong className="text-slate-700">{p.type === 'missed_rule' ? 'citable' : 'uncitable'}</strong> → {p.type === 'missed_rule' ? 'qualifies as a rule' : 'routed as a harvest gap'}
          {p.provenance.sampleComments && p.provenance.sampleComments.length > 0 && (
            <span className="mt-1 block text-slate-400">e.g. “{p.provenance.sampleComments.slice(0, 2).join('” · “')}”</span>
          )}
          {p.type === 'harvest_topic' && p.payload.query_terms && (
            <span className="mt-1 block">adds harvest query <code className="rounded bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-800">{p.payload.query_terms}</code> on approval.</span>
          )}
        </div>
      )}

      {p.status === 'proposed'
        ? (p.type === 'missed_rule' ? <MissedRuleButtons id={p.id} />
          : p.type === 'suppression' ? <SuppressionButtons id={p.id} />
            : <ReviewButtons id={p.id} approveLabel="Approve → harvester" />)
        : <ReviewedLine p={p} />}
    </div>
  );
}

// ── Section 0: flywheel strip ──
function Flywheel({ v }: { v: FlywheelView }) {
  const rules = v.actions.approved.filter((a) => a.type === 'lvc_rule' || a.type === 'missed_rule').reduce((s, a) => s + a.n, 0);
  const harvest = v.actions.approved.filter((a) => a.type === 'harvest_topic').reduce((s, a) => s + a.n, 0);
  const supp = v.actions.suppressions;
  const St = ({ label, big, sub }: { label: string; big: string; sub: string }) => (
    <div className="flex-1 rounded-xl border border-slate-200 bg-white px-2 py-2.5 text-center">
      <div className="text-[10px] font-semibold uppercase tracking-[0.04em] text-slate-400">{label}</div>
      <div className="text-[17px] font-semibold tabular-nums text-slate-800">{big}</div>
      <div className="mt-0.5 text-[11px] text-slate-500">{sub}</div>
    </div>
  );
  const Arrow = () => <div className="flex items-center px-1 text-[16px] text-slate-300">→</div>;
  return (
    <div className="mt-3 flex items-stretch gap-0">
      <St label="Audits" big={v.audits.count.toLocaleString()} sub={`${v.audits.perDay}/day · ${v.audits.engine}`} />
      <Arrow />
      <St label="Signals" big={(v.signals.findings + v.signals.labels).toLocaleString()} sub={`${v.signals.findings.toLocaleString()} findings · ${v.signals.labels} reviewer labels`} />
      <Arrow />
      <St label="Actions" big={(rules + harvest + supp).toLocaleString()} sub={`${rules} rules · ${harvest} harvest · ${supp} suppressions`} />
      <Arrow />
      <St label="Better audits" big={`${pct(v.better.attribution)} · ${pct(v.better.grounded)}`} sub="rule attribution · grounded findings" />
    </div>
  );
}

// ── Section 5: model programme meters ──
function Meters({ meters }: { meters: Meter[] }) {
  return (
    <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
      {meters.map((m) => (
        <div key={m.key} className={`rounded-xl border border-slate-200 p-3 ${m.armed ? 'opacity-65' : ''}`}>
          <div className="text-[10px] font-semibold uppercase tracking-[0.04em] text-slate-400">{m.label}</div>
          <div className={`mt-0.5 text-[15px] font-semibold tabular-nums ${m.armed ? 'text-slate-400' : 'text-slate-800'}`}>
            {m.armed ? 'armed' : m.value?.toLocaleString() ?? '—'}
            {!m.armed && <span className="text-[10.5px] font-normal text-slate-400"> / {m.target.toLocaleString()}</span>}
          </div>
          <div className="text-[10.5px] text-slate-400">{m.sub}</div>
          <div className="mt-1.5 h-[5px] overflow-hidden rounded-full bg-slate-100">
            <div className="h-full bg-emerald-500" style={{ width: `${Math.round((m.fill ?? 0) * 100)}%` }} />
          </div>
        </div>
      ))}
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
  const found = proposals.filter((p) => !isMissedOrigin(p));
  const missed = proposals.filter(isMissedOrigin);

  // Flywheel + programme are independent, fail-safe reads (any error → the pure builders render "—").
  const [flywheel, meters] = await Promise.all([
    fetchFlywheelData().catch(() => null),
    fetchProgrammeData().catch(() => [] as Meter[]),
  ]);

  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-brand">LEARNING LOOP</div>
      <h1 className="font-serif text-[26px] font-semibold text-slate-900">The flywheel console</h1>
      <p className="mt-1.5 max-w-3xl text-[13px] leading-relaxed text-slate-500">
        This console is CDMSS&apos;s improvement engine. Audits generate findings; reviewers label findings and flag what the audit missed; this loop turns both streams into proposals — new Right Care rules, literature-harvest topics, and suppressions of known false-positive classes. Nothing publishes itself: every proposal passes a human gate, every rule needs corpus evidence (evidence over frequency), and the audit scoring engine is never changed from here. The long game is the model programme below: the same corpus and labels this loop grows are what a distilled local model will train and be judged on.
      </p>

      {/* 0 · flywheel strip */}
      <div className="mt-6 text-[11px] font-semibold uppercase tracking-[0.06em] text-slate-400">The flywheel — is the loop turning? (this week)</div>
      {flywheel
        ? <Flywheel v={flywheel} />
        : <div className="mt-3 rounded-xl border border-slate-200 bg-white p-4 text-center text-[12px] text-slate-400">Flywheel data unavailable — “—”.</div>}

      {/* status tabs + miner */}
      <div className="mt-5 flex flex-wrap items-center gap-2">
        {STATUSES.map((s) => (
          <Link key={s} href={`/admin/learning?status=${s}`}
            className={`rounded-full border px-2.5 py-1 text-[11.5px] ${status === s ? 'border-brand/40 bg-brand-faint text-brand' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`}>
            {s === 'all' ? `all ${total}` : `${s} ${counts[s] ?? 0}`}
          </Link>
        ))}
        <span className="ml-auto"><MineButton /></span>
      </div>

      {/* 1 · proposals from what the audits FOUND */}
      <div className="mt-6 text-[11px] font-semibold uppercase tracking-[0.06em] text-slate-400">1 · Proposals — from what the audits found</div>
      <p className="mt-1 max-w-3xl text-[12px] leading-relaxed text-slate-500">Mined daily from recurring audit findings — a cluster must span ≥15 occurrences across ≥3 doctors AND carry corpus evidence before it may become a rule; high-volume patterns the corpus cannot cite become harvest topics instead.</p>
      {found.length === 0
        ? <div className="mt-3 rounded-xl border border-slate-200 bg-white p-6 text-center text-[13px] text-slate-500">No {status === 'all' ? '' : status} finding-mined proposals. Click <span className="font-medium text-brand">↻ Run miner</span> to scan the last 90 days.</div>
        : <div className="mt-3 space-y-3">{found.map((p) => <FoundCard key={p.id} p={p} />)}</div>}

      {/* 2 · from what the audits MISSED */}
      <div className="mt-7 text-[11px] font-semibold uppercase tracking-[0.06em] text-slate-400">2 · From what the audits missed — reviewer-driven</div>
      <p className="mt-1 max-w-3xl text-[12px] leading-relaxed text-slate-500">Mined from reviewer signals — missed-finding flags become rule or harvest candidates (≥2 flags; corpus-citable decides which), and finding classes reviewers repeatedly mark false become suppression candidates (≥3 false/nitpick across ≥2 reviewers). Every reviewer tap can improve the engine.</p>
      {missed.length === 0
        ? <div className="mt-3 rounded-xl border border-slate-200 bg-white p-6 text-center text-[13px] text-slate-500">No {status === 'all' ? '' : status} reviewer-mined proposals yet — these appear as missed-flags and false/nitpick labels accumulate.</div>
        : <div className="mt-3 space-y-3">{missed.map((p) => <MissedCard key={p.id} p={p} />)}</div>}

      {/* 5 · model programme */}
      <div className="mt-7 text-[11px] font-semibold uppercase tracking-[0.06em] text-slate-400">Model programme — the distillation math</div>
      <p className="mt-1 max-w-3xl text-[12px] leading-relaxed text-slate-500">Targets derive from measured sample-size math: ~15k teacher audits at a frozen v1 to train on, 1,500 held-out teacher–student pairs to evaluate against, ~500 adjudicated disagreements to decide who&apos;s right. Model-side meters stay “armed” until the engine freezes at v1 — the human-side meters move today.</p>
      {meters.length > 0
        ? <Meters meters={meters} />
        : <div className="mt-3 rounded-xl border border-slate-200 bg-white p-4 text-center text-[12px] text-slate-400">Programme meters unavailable — “—”.</div>}

      <p className="mt-6 text-[11px] text-slate-400">Advisory. Mined from de-identified audit findings and reviewer labels; every rule requires corpus evidence (evidence over frequency). Approved rules become active, cited entries in the Right Care appropriateness engine; suppressions pass the dual-label safety check before they take effect; the OPD audit scoring engine is unchanged.</p>
    </div>
  );
}
