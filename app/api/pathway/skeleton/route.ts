import { NextRequest, NextResponse } from 'next/server';
import { traceSkeleton } from '@/lib/pathway';

export const runtime = 'nodejs';
export const maxDuration = 300;

// POST /api/pathway/skeleton — fast Flash pass: classify stage + ordered care-path spine.
// Body: { scenario, proposedActions?: string[], patient?: { age?, sex? } }
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

  try {
    const { skeleton, traceId } = await traceSkeleton({
      scenario,
      proposedActions: proposedActions && proposedActions.length ? proposedActions : undefined,
      patient: hasPatient ? patient : undefined,
    });
    return NextResponse.json({ ok: true, skeleton, traceId });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
