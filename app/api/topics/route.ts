import { NextResponse } from 'next/server';
export async function POST() { return NextResponse.json({ error: 'gone — Topics retired in v0.2; use /api/ask for general queries' }, { status: 410 }); }
