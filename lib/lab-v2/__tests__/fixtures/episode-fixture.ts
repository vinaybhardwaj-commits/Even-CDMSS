/**
 * lib/lab-v2/__tests__/fixtures/episode-fixture.ts — ONE synthetic episode, and the eight
 * dependency implementations that carry it through the pipeline without a database, a corpus or
 * a model.
 *
 * ⚠️ WHY THIS FILE EXISTS AND WHY IT IS SHARED.
 *
 * Decision 47 moves the seven-stage pipeline out of `lib/ipd-episode/run.ts` and into
 * `lib/ipd-episode/compute.ts` VERBATIM. "Verbatim" is a claim, and a claim needs a witness. The
 * witness is this episode: its output was captured from the PRE-EXTRACTION `run.ts` — the file as
 * it stood at `2c5d03a7` — and `episode-preimage.json` beside this file is that capture, byte for
 * byte. `b2-extraction.test.ts` runs the SAME episode through `computeEpisodeAudit` and asserts
 * equality against it.
 *
 * Nothing here is a patient. Every name, note and identifier is invented; the clinical content is
 * a textbook appendicectomy with three days of stay, chosen because it produces a plan with a
 * `first_24h` anchor, a `pre_discharge` anchor and the episode-level checkpoint — three
 * checkpoints, which is enough for the resolver, the digest and the grouping arithmetic to have
 * something to do.
 *
 * THE STUBS ARE HONEST ABOUT WHAT THEY REPLACE. Seven of the eight return frozen data. The
 * eighth, `checkpoint`, returns a canned `CheckpointResult` rather than calling Haiku — which is
 * exactly what the IPD lab adapter does on an exact replay, so the shape is the one that matters.
 */
import type { EpisodeEvent } from '../../../ipd-episode/assemble-core';
import type { AssembledEpisode } from '../../../ipd-episode/assemble';
import type { CheckpointResult } from '../../../ipd-episode/checkpoint';
import type { ExpectedCourse } from '../../../ipd-episode/checkpoint-core';
import { checkpointEntryRefs } from '../../../ipd-episode/checkpoint-core';
import type { EpisodeAuditRow, CheckpointWriteRow, StoredExtraction } from '../../../ipd-episode/store';

export const FIXTURE_ENCOUNTER = 'IPFIX0000001';
export const FIXTURE_ADMITTED_AT = '2026-08-01T06:00:00.000Z';
export const FIXTURE_DISCHARGED_AT = '2026-08-04T09:00:00.000Z';

const ev = (
  n: number, at: string | null, day: number, type: EpisodeEvent['event_type'], summary: string,
  detail: Record<string, unknown> = {}, author: string | null = null,
): EpisodeEvent => ({
  event_id: `fx-${n}`,
  occurred_at: at,
  day_index: day,
  event_type: type,
  summary,
  detail,
  author_name: author,
  author_role: author ? 'RMO' : null,
  responsible_clinician_id: 'fx-clin-1',
  provenance: { source_table: 'kx_clinical_template_progress_reports', source_record_id: `fx-src-${n}`, source_timestamp: at },
  evidence_tier: 'A',
});

/** The single assembled course. Every model input in the pipeline is a filter over exactly this. */
export const FIXTURE_EVENTS: EpisodeEvent[] = [
  ev(1, FIXTURE_ADMITTED_AT, 0, 'admission', 'admitted with right iliac fossa pain', { chief_complaint: 'right iliac fossa pain' }),
  ev(2, '2026-08-01T08:30:00.000Z', 0, 'note', 'acute abdomen, tender RIF, guarding', { text: 'tender right iliac fossa with guarding' }, 'Dr Fixture One'),
  ev(3, '2026-08-01T11:00:00.000Z', 0, 'lab_order', 'full blood count ordered', { test_name: 'full blood count' }),
  ev(4, '2026-08-02T09:15:00.000Z', 1, 'note', 'post-operative day 1, afebrile, tolerating orals', { text: 'afebrile, tolerating orals' }, 'Dr Fixture Two'),
  ev(5, '2026-08-03T09:00:00.000Z', 2, 'note', 'wound clean and dry', { text: 'wound clean and dry' }, 'Dr Fixture Two'),
  ev(6, FIXTURE_DISCHARGED_AT, 3, 'discharge', 'discharged home, stable', { discharge_type: 'DISCHARGED' }),
];

export const FIXTURE_ASSEMBLED: AssembledEpisode = {
  envelope: {
    encounterId: FIXTURE_ENCOUNTER,
    memberId: 'FX-MEMBER-0001',
    facilityName: 'Fixture General Hospital',
    speciality: 'General Surgery',
    admittedAt: FIXTURE_ADMITTED_AT,
    dischargedAt: FIXTURE_DISCHARGED_AT,
    losDays: 3,
    dischargeType: 'DISCHARGED',
    treatingDepartmentName: 'General Surgery',
    admissionType: 'EMERGENCY',
    admitSource: 'CASUALTY',
    remarks: 'right iliac fossa pain for one day, vomiting twice',
    responsibleClinicianId: 'fx-clin-1',
  },
  events: FIXTURE_EVENTS,
  sourcesPresent: ['kx_ip_admissions', 'kx_clinical_template_progress_reports', 'kx_discharge_summary_records', 'discharge_extracted_cases'],
  notes: ['fixture episode: assembled from frozen inputs'],
};

export const FIXTURE_EXTRACTION: StoredExtraction = {
  extractionVersion: 'doc-extract/2',
  extractedJson: {
    primary_diagnosis: 'acute appendicitis',
    procedures: ['laparoscopic appendicectomy'],
    discharge_medications: ['paracetamol 1 g QDS'],
  },
  memberId: 'FX-MEMBER-0001',
  extractedAt: '2026-08-04T12:00:00.000Z',
};

export const FIXTURE_DISCHARGE_ROW: Record<string, unknown> = {
  ipd_no: FIXTURE_ENCOUNTER,
  discharge_date_time: FIXTURE_DISCHARGED_AT,
  discharge_type: 'DISCHARGED',
};

export const FIXTURE_NOTE_ROWS: Record<string, unknown>[] = [
  { encounter_id: FIXTURE_ENCOUNTER, uid: 'fx-note-1' },
  { encounter_id: FIXTURE_ENCOUNTER, uid: 'fx-note-2' },
];

/** One expected course, the same for every checkpoint, so the resolver's grouping arithmetic runs. */
function fixtureCourse(): ExpectedCourse {
  return {
    expected_diagnostics: [{
      item: 'full blood count with white cell count',
      by_day: 0,
      rationale: 'suspected appendicitis needs an inflammatory marker',
      citation_ids: [901],
      matcher: { kind: 'lab', terms: ['full blood count', 'white cell'] },
      proposed_severity: 'moderate',
      recurrence: 'once',
    }],
    expected_therapeutics: [{
      item: 'perioperative antibiotic prophylaxis',
      by_day: 0,
      rationale: 'standard before appendicectomy',
      citation_ids: [902],
      matcher: { kind: 'drug', terms: ['cefuroxime', 'metronidazole', 'antibiotic'] },
      proposed_severity: 'major',
      recurrence: 'once',
    }],
    expected_monitoring: [{
      item: 'daily wound review',
      frequency: 'daily',
      rationale: 'post-operative wound surveillance',
      citation_ids: [],
      matcher: { kind: 'note', terms: ['wound'] },
      proposed_severity: 'minor',
      recurrence: 'repeat',
    }],
    escalation_triggers: [{
      trigger: 'temperature above 38.5 after day 2',
      action: 'septic screen and surgical review',
      citation_ids: [901],
      matcher: { kind: 'note', terms: ['septic screen'] },
      proposed_severity: 'major',
      recurrence: 'once',
    }],
    expected_los_days: 3,
    expected_disposition: 'home',
  uncertainty: ['no operative note in the frozen course'],
  };
}

/** One canned checkpoint. No model call, no retrieval, no clock — every field is fixed. */
export function fixtureCheckpoint(a: {
  checkpointId: string; checkpointType: 'daily' | 'episode'; anchorKind: string;
  dayIndex: number; cutoffAt: string; inputEventCount: number;
}): CheckpointResult {
  const course = fixtureCourse();
  return {
    checkpointId: a.checkpointId,
    dayIndex: a.dayIndex,
    checkpointType: a.checkpointType,
    anchorKind: a.anchorKind,
    cutoffAt: a.cutoffAt,
    inputEventCount: a.inputEventCount,
    retrievalQuery: 'acute appendicitis management',
    retrievalFailed: false,
    citationIds: [901, 902],
    citationSources: { '901': 'MKSAP', '902': 'StatPearls' },
    retrievedTitles: ['Appendicitis — diagnosis', 'Appendicectomy — perioperative care'],
    retrievalOffTopic: false,
    offTopicExcerptCount: 0,
    normativeDropped: 0,
    retrievalSkipped: false,
    day0QueryFromOt: false,
    queryUnderspecified: false,
    temperature: 0,
    seed: 7,
    model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
    maxTokens: 8000,
    finishReason: 'stop',
    attempts: 1,
    entriesTruncated: 0,
    retrievalMs: 0,
    wallMs: 0,
    promptEvents: a.inputEventCount,
    inputEventsRaw: a.inputEventCount,
    expectedCourse: course,
    entryRefs: checkpointEntryRefs(a.checkpointId, course),
    status: 'ok',
    errorDetail: null,
    uncitedEntryCount: 1,
    entryCount: 4,
    retriedForCitations: false,
  } as CheckpointResult;
}

/** What the stubs were asked to do, in order — the skip ledger the pipeline writes as it goes. */
export interface FixtureLedger {
  skips: { reason: string; detail?: string | null }[];
  cleared: string[];
  saved: { row: EpisodeAuditRow; checkpoints: CheckpointWriteRow[] }[];
  checkpointCalls: string[];
}

export function fixtureLedger(): FixtureLedger {
  return { skips: [], cleared: [], saved: [], checkpointCalls: [] };
}

/**
 * The eight dependencies of decision 47, as frozen implementations. Returned as a plain object so
 * the same literal satisfies `EpisodeComputeDependencies` after the extraction and can be spread
 * into a stub module before it.
 */
export function fixtureDeps(ledger: FixtureLedger) {
  return {
    fetchDischargeSummary: async (_encounterId: string) => {
      void _encounterId;
      return FIXTURE_DISCHARGE_ROW as never;
    },
    fetchProgressNotes: async (_encounterId: string, _limit?: number) => {
      void _encounterId; void _limit;
      return FIXTURE_NOTE_ROWS as never[];
    },
    fetchExtractionByIpUid: async (_ipUid: string) => {
      void _ipUid;
      return FIXTURE_EXTRACTION;
    },
    assembleEpisode: async (_a: { encounterId: string; extractedCase: unknown; extractionVersion: string | null }) => {
      void _a;
      return FIXTURE_ASSEMBLED;
    },
    recordSkip: async (a: { reason: string; detail?: string | null }) => {
      ledger.skips.push({ reason: a.reason, detail: a.detail ?? null });
      return 'recorded' as const;
    },
    clearSkip: async (encounterId: string, _engineVersion?: string) => {
      void _engineVersion;
      ledger.cleared.push(encounterId);
    },
    saveEpisodeAudit: async (row: EpisodeAuditRow, checkpoints: CheckpointWriteRow[]) => {
      ledger.saved.push({ row, checkpoints });
      return { status: 'inserted' as const, auditId: 'fx-audit-0001', failedCheckpoints: 0 };
    },
    checkpoint: async (a: {
      checkpointId: string; checkpointType: 'daily' | 'episode'; anchorKind?: string;
      dayIndex: number; cutoffAt: string; events: EpisodeEvent[];
    }) => {
      ledger.checkpointCalls.push(a.checkpointId);
      return fixtureCheckpoint({
        checkpointId: a.checkpointId, checkpointType: a.checkpointType,
        anchorKind: a.anchorKind ?? 'episode', dayIndex: a.dayIndex,
        cutoffAt: a.cutoffAt, inputEventCount: a.events.length,
      });
    },
  };
}

/**
 * Every field whose value is a wall clock. They are stripped before comparison because the point
 * of the comparison is the PIPELINE's arithmetic, and a millisecond is not part of it.
 */
export const TIMING_KEYS = new Set([
  'latencyMs', 'assemble_ms', 'retrieval_ms', 'checkpoint_ms', 'checkpoint_max_ms',
  'checkpoint_wall_ms', 'diff_ms', 'fidelity_ms', 'commentary_ms', 'wall_ms',
  'deadline_at', 'budget_remaining_ms', 'diff_remaining_ms', 'fidelity_remaining_ms',
  'remainingMsAtAttempt', 'checkpointWallMs', 'traceId', 'trace_id', 'traceld',
]);

/** Deep copy with every timing key removed and every object key sorted — a comparable shape. */
export function stripTimings(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripTimings);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      if (TIMING_KEYS.has(k)) continue;
      out[k] = stripTimings((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}
