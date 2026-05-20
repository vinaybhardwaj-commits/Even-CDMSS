import { NextResponse } from 'next/server';
export async function GET() { return NextResponse.json({ error: 'gone — Browse retired in v0.2' }, { status: 410 }); }
