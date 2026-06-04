export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
export async function POST() { return NextResponse.json({ error: 'gone — replaced by /api/ask, /api/ddx, /api/drugs/* in v0.2+' }, { status: 410 }); }
export async function GET()  { return NextResponse.json({ error: 'gone — replaced by /api/ask, /api/ddx, /api/drugs/* in v0.2+' }, { status: 410 }); }