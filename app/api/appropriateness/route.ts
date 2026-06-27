import { NextRequest, NextResponse } from 'next/server';
import { matchLowValueCare, type MatchInput } from '@/lib/lvc';
import type { Region } from '@/lib/lvc-core';

export const runtime = 'nodejs';
export const maxDuration = 300; // Pro applicability judge over the candidate pool

const REGIONS = new Set(['US', 'CA', 'IN']);

// POST /api/appropriateness — Appropriateness / Low-Value-Care check (CW.3).
// Body: { scenario, proposedActions?: string[], patient?: {age?, sex?}, regionFilter?: Region[], preferRegion?: Region }
// Returns the matcher result (flags + candidates + trace id). Opt-in surface → 'surface' floor.
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  const scenario = typeof body.scenario === 'string' ? body.scenario.trim() : '';
  if (scenario.length < 3) {
    return NextResponse.json({ ok: false, error: 'scenario is required' }, { status: 400 });
  }

  const proposedActions = Array.isArray(body.proposedActions)
    ? (body.proposedActions as unknown[]).filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((s) => s.trim())
    : undefined;

  const patientIn = (body.patient ?? {}) as { age?: unknown; sex?: unknown };
  const age = Number(patientIn.age);
  const patient = {
    age: Number.isFinite(age) && age > 0 && age < 130 ? Math.round(age) : undefined,
    sex: typeof patientIn.sex === 'string' && patientIn.sex.trim() ? patientIn.sex.trim() : undefined,
  };
  const hasPatient = patient.age != null || patient.sex != null;

  const regionFilter = Array.isArray(body.regionFilter)
    ? (body.regionFilter as unknown[]).filter((x): x is Region => typeof x === 'string' && REGIONS.has(x))
    : undefined;
  const preferRegion = typeof body.preferRegion === 'string' && REGIONS.has(body.preferRegion)
    ? (body.preferRegion as Region)
    : undefined;

  const input: MatchInput = {
    scenario,
    proposedActions,
    patient: hasPatient ? patient : undefined,
    surface: 'surface',
    regionFilter: regionFilter && regionFilter.length ? regionFilter : undefined,
    preferRegion,
  };

  try {
    const result = await matchLowValueCare(input);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
