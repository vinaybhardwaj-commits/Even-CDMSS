import Link from 'next/link';
import { sql } from '@/lib/db';
import { isAdminUnlocked, adminTokenConfigured } from '@/lib/admin-cookie';
import RunsBrowser, { type RunRow } from './runs-browser';
import type { ExportRun } from '@/lib/runs-export';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Appropriateness runs · CAT Admin' };

const APP = process.env.APP_SOURCE || 'standalone';
const run = sql as unknown as (q: string, p?: unknown[]) => Promise<Record<string, unknown>[]>;

function Locked({ configured, bad }: { configured: boolean; bad: boolean }) {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900">Appropriateness runs</h1>
      <p className="mt-1 text-sm text-slate-500">Research retention of every Appropriateness run. De-identified, but access-controlled.</p>
      <div className="mt-8 max-w-sm rounded-lg border border-slate-200 bg-white p-5">
        {!configured ? (
          <p className="text-sm text-rose-700">Locked. Set the <code className="rounded bg-slate-100 px-1">ADMIN_TOKEN</code> environment variable to enable this surface.</p>
        ) : (
          <form method="POST" action="/api/admin/unlock">
            <label className="block text-sm font-medium text-slate-700">Admin token</label>
            <input type="password" name="token" autoFocus className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm" placeholder="Enter admin token" />
            {bad && <p className="mt-2 text-xs text-rose-600">Incorrect token.</p>}
            <button type="submit" className="mt-3 rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white">Unlock</button>
          </form>
        )}
      </div>
    </div>
  );
}

function parseOutput(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object') return v as Record<string, unknown>;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return {}; } }
  return {};
}

export default async function AppropriatenessRunsAdmin({ searchParams }: { searchParams: Promise<{ locked?: string }> }) {
  const sp = await searchParams;
  if (!(await isAdminUnlocked())) return <Locked configured={adminTokenConfigured()} bad={sp.locked === '1'} />;

  let rows: Record<string, unknown>[] = [];
  try {
    rows = await run(
      `SELECT id, mode, to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') created_at,
              scenario, doc_type, summary, n_sources, n_findings, output
       FROM appropriateness_runs WHERE app_source = $1 ORDER BY created_at DESC LIMIT 200`,
      [APP],
    );
  } catch { rows = []; }

  const runs: RunRow[] = rows.map((r) => ({
    id: String(r.id),
    mode: String(r.mode) as ExportRun['mode'],
    created_at: String(r.created_at),
    scenario: r.scenario == null ? null : String(r.scenario),
    docType: r.doc_type == null ? null : String(r.doc_type),
    summary: r.summary == null ? '' : String(r.summary),
    nSources: Number(r.n_sources ?? 0),
    nFindings: Number(r.n_findings ?? 0),
    output: parseOutput(r.output),
  }));

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 sm:text-3xl">Appropriateness runs</h1>
          <p className="mt-1 text-sm text-slate-500">Research retention of every Appropriateness check / Pathway / Case-audit run (de-identified). Download any run, or the whole corpus stacked, as Excel. Showing the latest {runs.length}.</p>
        </div>
        <div className="flex items-center gap-3 whitespace-nowrap pt-1">
          <Link href="/admin/observability" className="text-xs text-slate-400 hover:text-slate-700">Observability →</Link>
          <form method="POST" action="/api/admin/unlock?action=logout"><button className="text-xs text-slate-400 hover:text-slate-700">Lock</button></form>
        </div>
      </div>
      <div className="mt-6"><RunsBrowser runs={runs} /></div>
    </div>
  );
}
