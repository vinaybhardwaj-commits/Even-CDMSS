export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * /api/mcp — the CDMSS "Lab" remote MCP server (Streamable-HTTP / JSON-RPC 2.0).
 *
 * A key-gated experimentation surface: run the FREE Mac-mini pipeline over Metabase
 * artifacts or pasted text, control mini backfills, and add vetted material to the
 * corpus (quarantined). MINI ONLY — no tool here can reach Gemini, alter the engine/
 * prompts, or write a production table (corpus writes are inert `labq:` until activated).
 *
 * Auth: header `x-api-key: <LAB_API_KEY>` or `Authorization: Bearer <LAB_API_KEY>`.
 * If LAB_API_KEY is unset, the endpoint is DISABLED (503) — so it's dark until V sets the key.
 *
 * Add as a custom connector in Claude: URL https://even-cdmss.vercel.app/api/mcp,
 * auth = the LAB_API_KEY as a bearer token / api key header.
 */
import { timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { LAB_TOOLS, callLabTool } from '@/lib/mcp-tools';

const SERVER_INFO = { name: 'cdmss-lab', version: '1.0.0' };
const PROTOCOL_VERSION = '2024-11-05';

function keyValid(req: NextRequest): boolean {
  const key = process.env.LAB_API_KEY;
  if (!key) return false; // unset ⇒ endpoint disabled (handled by caller as 503)
  const hdr = req.headers.get('x-api-key') || '';
  const auth = req.headers.get('authorization') || '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  const presented = hdr || bearer;
  if (!presented) return false;
  const a = Buffer.from(presented); const b = Buffer.from(key);
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
}

function rpcResult(id: unknown, result: unknown) { return NextResponse.json({ jsonrpc: '2.0', id, result }); }
function rpcError(id: unknown, code: number, message: string, status = 200) {
  return NextResponse.json({ jsonrpc: '2.0', id, error: { code, message } }, { status });
}

export async function GET() {
  // Simple liveness / discovery ping (not part of JSON-RPC).
  if (!process.env.LAB_API_KEY) return NextResponse.json({ ok: false, error: 'LAB_API_KEY not set — MCP disabled' }, { status: 503 });
  return NextResponse.json({ ok: true, server: SERVER_INFO, transport: 'jsonrpc-http', tools: LAB_TOOLS.map((t) => t.name) });
}

export async function POST(req: NextRequest) {
  if (!process.env.LAB_API_KEY) return NextResponse.json({ error: 'LAB_API_KEY not set — MCP disabled' }, { status: 503 });
  if (!keyValid(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch { return rpcError(null, -32700, 'parse error'); }

  const id = body.id ?? null;
  const method = String(body.method || '');
  const params = (body.params && typeof body.params === 'object') ? body.params as Record<string, unknown> : {};

  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
        instructions: 'CDMSS Lab — free mini-pipeline experimentation. mini_analyze (audit a Metabase note or pasted text → lab store), backfill_control, corpus_add + corpus_manage (quarantined until activated), lab_query. Nothing here uses Gemini or changes CDMSS analysis.',
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return new NextResponse(null, { status: 202 });
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: LAB_TOOLS });
    case 'tools/call': {
      const toolName = String(params.name || '');
      const args = (params.arguments && typeof params.arguments === 'object') ? params.arguments as Record<string, unknown> : {};
      if (!LAB_TOOLS.some((t) => t.name === toolName)) return rpcError(id, -32602, `unknown tool: ${toolName}`);
      const result = await callLabTool(toolName, args);
      return rpcResult(id, result);
    }
    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}
