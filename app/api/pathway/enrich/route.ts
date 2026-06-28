import { NextRequest, NextResponse } from 'next/server';
import { enrichPathway } from '@/lib/pathway';
import { normStageKind, normStageFlag, type SkeletonStage } from '@/lib/pathway-core';

export const runtime = 'nodejs';
export const maxDuration = 300;

// POST /api/pathway/enrich — Pro pass: enrich the skeleton spine with grounded
// evidence / decision criteria / value + deterministic EHRC tariffs.
// Body: { scenario, proposedActions?, patient?, workingDiagnosis?, stages: SkeletonStage[] }
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

  const rawStages = Array.isArray(body.stages) ? body.stages : [];
  const stages: SkeletonStage[] = (rawStages as unknown[])
    .map((r) => {
      if (!r || typeof r !== 'object') return null;
      const o = r as Record<string, unknown>;
      const id = typeof o.id === 'string' ? o.id.trim() : '';
      const title = typeof o.title === 'string' ? o.title.trim() : '';
      const action = typeof o.action === 'string' ? o.action.trim() : '';
      if (!id || (!title && !action)) return null;
      return { id, kind: normStageKind(o.kind), title: title || action, action, flag: normStageFlag(o.flag) };
    })
    .filter((x): x is SkeletonStage => !!x)
    .slice(0, 8);

  if (stages.length === 0) {
    return NextResponse.json({ ok: false, error: 'stages are required' }, { status: 400 });
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

  const workingDiagnosis = typeof body.workingDiagnosis === 'string' && body.workingDiagnosis.trim()
    ? body.workingDiagnosis.trim() : null;

  try {
    const { enrichment, sources, traceId } = await enrichPathway({
      scenario,
      proposedActions: proposedActions && proposedActions.length ? proposedActions : undefined,
      patient: hasPatient ? patient : undefined,
      workingDiagnosis,
      stages,
    });
    return NextResponse.json({ ok: true, enrichment, sources, traceId });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
