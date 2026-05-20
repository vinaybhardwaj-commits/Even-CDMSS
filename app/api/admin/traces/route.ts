import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const denied = requireAdmin(req); if (denied) return denied;
  const feature = req.nextUrl.searchParams.get('feature');
  const status = req.nextUrl.searchParams.get('status');
  const limit = Math.min(200, parseInt(req.nextUrl.searchParams.get('limit') || '50', 10));
  const since = req.nextUrl.searchParams.get('since'); // ISO timestamp

  const wheres: string[] = ['1=1'];
  const params: unknown[] = [];
  let p = 1;
  if (feature) { wheres.push(`feature = $${p++}`); params.push(feature); }
  if (status) { wheres.push(`status = $${p++}`); params.push(status); }
  if (since) { wheres.push(`started_at >= $${p++}`); params.push(since); }
  const q = `SELECT trace_id, user_id, feature, status, started_at, finished_at, total_ms, error_message,
             (SELECT COUNT(*) FROM trace_events WHERE trace_events.trace_id = traces.trace_id)::int AS event_count
             FROM traces WHERE ${wheres.join(' AND ')} ORDER BY started_at DESC LIMIT ${limit}`;
  const rows = await (sql as unknown as (q: string, p: unknown[]) => Promise<unknown[]>)(q, params);
  return NextResponse.json({ traces: rows });
}
