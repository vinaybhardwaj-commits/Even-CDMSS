import { NextRequest, NextResponse } from 'next/server';
import { matchLowValueCare, type MatchInput } from '@/lib/lvc';
import { analyzeValue } from '@/lib/lvc-value';
import type { Region } from '@/lib/lvc-core';
import { makeNdjsonStream, ndjsonHeaders, type Stage } from '@/lib/stream';

export const runtime = 'nodejs';
export const maxDuration = 300; // Pro applicability judge over the candidate pool + value audit loop

const REGIONS = new Set(['US', 'CA', 'IN']);

// POST /api/appropriateness — Appropriateness / Low-Value-Care check (CW.3).
// Streams NDJSON progress events (so the client shows the live CDMSS pipeline bar like Ask/DDx),
// then a single {type:'result'} carrying the flags + value analysis + sources, then {type:'done'}.
// Body: { scenario, proposedActions?: string[], patient?: {age?, sex?}, regionFilter?: Region[], preferRegion?: Region }
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
    forceOllama: body.providerOverride === 'ollama',   // lab probe: whole pipeline on the free mini
  };

  const { stream, emit, close } = makeNdjsonStream();
  const t0 = Date.now();

  (async () => {
    try {
      // Flag matcher (CW seed-dependent) and value analysis (seed-independent) run in
      // parallel. The value pass drives the progress bar via onProgress; it soft-fails
      // to null internally so it never breaks the response.
      const [result, value] = await Promise.all([
        matchLowValueCare(input),
        analyzeValue({
          scenario, proposedActions, patient: hasPatient ? patient : undefined,
          forceOllama: body.providerOverride === 'ollama',
          onProgress: (stage, msg) => emit({ type: 'progress', stage: stage as Stage, msg, ms: Date.now() - t0 }),
        }),
      ]);
      emit({
        type: 'result',
        data: {
          ok: true,
          ...result,
          valueAnalysis: value.valueAnalysis,
          valueSources: value.sources,
          valueTraceId: value.traceId,
        },
      });
      emit({ type: 'done', ms: Date.now() - t0 });
    } catch (e) {
      emit({ type: 'error', message: String((e as Error).message) });
    } finally {
      close();
    }
  })();

  const headers = ndjsonHeaders();
  return new Response(stream, { headers });
}
