import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';

export async function GET(req: NextRequest, ctx: { params: Promise<{ traceId: string }> }) {
  const denied = requireAdmin(req); if (denied) return denied;
  const { traceId } = await ctx.params;

  const traceRows = (await sql`SELECT * FROM traces WHERE trace_id = ${traceId}`) as Array<Record<string, unknown>>;
  if (traceRows.length === 0) return NextResponse.json({ error: 'trace not found' }, { status: 404 });

  const events = (await sql`SELECT seq, ts, kind, stage, payload, latency_ms FROM trace_events
                            WHERE trace_id = ${traceId} ORDER BY seq ASC`) as Array<Record<string, unknown>>;

  return NextResponse.json({ trace: traceRows[0], events });
}
