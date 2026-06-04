export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
export async function POST() { return NextResponse.json({ error: 'gone — Practice retired in v0.2; will return as part of /review in v0.6' }, { status: 410 }); }