/**
 * lib/ipd-episode/checkpoint-core.ts — the PURE half of the blinded checkpoint pass (PRD §3.3):
 * the retrieval query builder, the user-message assembly, and the output parser.
 *
 * NO db, NO model, NO Next.
 *
 * WHAT MAKES A CHECKPOINT BLIND is not this file's prose — it is that its caller hands it a list
 * produced by `eventsBeforeDayStart` / `episodeLevelEvents` in assemble-core. Nothing here can
 * reach the discharge event, the extracted case, `discharge_type`, `los_days` or
 * `discharge_date_time`, because nothing here is given the episode: it is given a filtered list
 * and an admission envelope, and it renders exactly what it is given.
 */

import { extractJsonObject } from '../lvc-value-core';
import { collapseSpaces, type EpisodeEvent } from './assemble-core';

export const RETRIEVAL_TOP_K = 8;
const NOTE_QUERY_CHARS = 400;

// ── retrieval query (PRD §3.3.2) ─────────────────────────────────────────────────────────────

export interface RetrievalQueryInput {
  treatingDepartmentName: string | null;
  admissionType: string | null;
  admitSource: string | null;
  remarks: string | null;
  /** Events already filtered to the checkpoint's cut-off — never the whole episode. */
  eventsBeforeCutoff: EpisodeEvent[];
}

/**
 * The retrieval query, built in the order §3.3.2 names: treating department, admission type,
 * admit source, admission remarks, then the first 400 characters of the MOST RECENT note or
 * initial assessment before the cut-off.
 *
 * "Most recent before the cut-off" is read off the already-filtered list, so the query cannot
 * describe a note the checkpoint is not allowed to see.
 */
export function buildRetrievalQuery(input: RetrievalQueryInput): string {
  const parts: string[] = [];
  for (const v of [input.treatingDepartmentName, input.admissionType, input.admitSource, input.remarks]) {
    const t = (v ?? '').trim();
    if (t) parts.push(t);
  }
  const narrative = [...input.eventsBeforeCutoff]
    .filter((e) => (e.event_type === 'note' || e.event_type === 'initial_assessment') && e.occurred_at && e.summary.trim())
    .sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)))
    .pop();
  if (narrative) parts.push(narrative.summary.slice(0, NOTE_QUERY_CHARS));
  return collapseSpaces(parts.join(' ')).slice(0, 1200);
}

// ── the user message ─────────────────────────────────────────────────────────────────────────

export interface RetrievedExcerpt { id: number; label: string; text: string }

export interface CheckpointUserInput {
  checkpointId: string;
  checkpointType: 'daily' | 'episode';
  dayIndex: number;
  /** ISO 8601 UTC. For a daily checkpoint this is the day boundary; for the episode-level one it
   *  is the last documented moment. Recorded on the row as `input_cutoff_at` — the blinding proof. */
  cutoffAt: string;
  admissionContext: string;
  events: EpisodeEvent[];
  excerpts: RetrievedExcerpt[];
}

/** One event, rendered for a prompt. Ids and timestamps are copied through verbatim. */
export function renderEvent(e: EpisodeEvent): string {
  const when = e.occurred_at ?? 'time not recorded';
  const who = e.author_name ? ` [author ${e.author_name}${e.author_role ? `, ${e.author_role}` : ''}]` : '';
  const detail = e.detail && Object.keys(e.detail).length ? ` ${JSON.stringify(e.detail)}` : '';
  return `- ${when} · day ${e.day_index} · ${e.event_type} · tier ${e.evidence_tier} · `
    + `[${e.provenance.source_table} ${e.provenance.source_record_id}]${who} ${e.summary}${detail}`;
}

export function buildCheckpointUser(input: CheckpointUserInput): string {
  const head = input.checkpointType === 'episode'
    ? `EPISODE-LEVEL CHECKPOINT (${input.checkpointId}). Everything documented up to the last recorded moment of this admission is below. The admission has not been closed for you: you are not told how it ended.`
    : `DAY ${input.dayIndex} CHECKPOINT (${input.checkpointId}). Everything documented BEFORE ${input.cutoffAt} is below, and nothing after it.`;

  const k = input.excerpts.length;
  // THE RANGE IS STATED AS A NUMBER, not implied by how many blocks follow. 42 of 42 entries came
  // back uncited on the first live episode, and the prompt at the time both invited empty arrays
  // and never said what the legal numbers were. A model cannot cite a range it was not given.
  const excerpts = k
    ? `\nNORMATIVE EXCERPTS — excerpts are numbered 1 to ${k}. Every entry you return must carry at least one of these numbers in its citation_ids.\n${input.excerpts.map((x, i) => `[${i + 1}] ${x.label}\n${x.text}`).join('\n\n')}`
    : `\nNORMATIVE EXCERPTS: none were retrieved for this checkpoint. There are no numbers to cite, so leave citation_ids empty throughout — this is the one case where that is expected.`;

  const closer = k
    ? `State the expected next 24 hours as the JSON object described in your instructions. Every entry must carry at least one citation_ids value between 1 and ${k}.`
    : 'State the expected next 24 hours as the JSON object described in your instructions.';

  return `${head}

ADMISSION CONTEXT
${input.admissionContext}

DOCUMENTED SO FAR (${input.events.length} event${input.events.length === 1 ? '' : 's'})
${input.events.length ? input.events.map(renderEvent).join('\n') : '(nothing beyond the admission itself)'}
${excerpts}

${closer}`;
}

/** The admission context line every checkpoint gets. Carries no outcome field by construction. */
export function admissionContextLine(a: {
  treatingDepartmentName: string | null; admissionType: string | null;
  admitSource: string | null; speciality: string | null; remarks: string | null;
}): string {
  const parts = [
    a.speciality ? `Speciality: ${a.speciality}` : null,
    a.treatingDepartmentName ? `Department: ${a.treatingDepartmentName}` : null,
    a.admissionType ? `Admission type: ${a.admissionType}` : null,
    a.admitSource ? `Admitted from: ${a.admitSource}` : null,
    a.remarks ? `Admission remarks: ${a.remarks}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join('\n') : '(the admission row carries no department, type or source)';
}

// ── output (PRD §3.3.4) ──────────────────────────────────────────────────────────────────────

export interface ExpectedItem { item: string; by_day: number | null; rationale: string; citation_ids: number[] }
export interface ExpectedMonitoring { item: string; frequency: string; rationale: string; citation_ids: number[] }
export interface EscalationTrigger { trigger: string; action: string; citation_ids: number[] }

export interface ExpectedCourse {
  expected_diagnostics: ExpectedItem[];
  expected_therapeutics: ExpectedItem[];
  expected_monitoring: ExpectedMonitoring[];
  escalation_triggers: EscalationTrigger[];
  expected_los_days: number | null;
  expected_disposition: string | null;
  uncertainty: string[];
}

const asText = (v: unknown, cap = 600): string => (v == null ? '' : collapseSpaces(String(v)).slice(0, cap));
const asNum = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) ? n : null; };

/**
 * The model cites by ORDINAL — the prompt numbers its excerpts [1]…[k] — and what gets STORED is
 * the real `mksap_chunks` id that ordinal stood for.
 *
 * ⚠️ THIS IS WHY THE TWO citation_ids FIELDS MEAN THE SAME THING. The checkpoint ROW stores the
 * chunk ids retrieval returned; before this mapping, each expected-course ENTRY stored a small
 * integer between 1 and 8. Both were called `citation_ids`, both were `int[]`, and neither the UI
 * nor a validator could tell them apart — entry "3" meant "the third excerpt of this checkpoint"
 * while the row's "3" would have meant chunk 3, a different passage entirely. Mapping here makes
 * one vocabulary: everything downstream of this function speaks chunk ids.
 *
 * An ordinal outside [1..k] is DROPPED, never renumbered and never passed through as if it were
 * already an id — a citation to an excerpt that was never shown is not a citation.
 */
function asCitationIds(v: unknown, chunkIds: readonly number[]): number[] {
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  for (const raw of v.slice(0, 16)) {
    const ordinal = Number(raw);
    if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > chunkIds.length) continue;
    const chunkId = chunkIds[ordinal - 1];
    if (Number.isFinite(chunkId) && !out.includes(chunkId)) out.push(chunkId);
  }
  return out;
}

/** The inverse, for rendering: a stored chunk id back to the ordinal the next prompt shows for it.
 *  0 when this checkpoint did not carry that chunk — the caller drops it rather than printing a
 *  number the reader cannot look up. */
export function ordinalForChunkId(chunkId: number, chunkIds: readonly number[]): number {
  return chunkIds.indexOf(chunkId) + 1;
}

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v.slice(0, 40) : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {});

/**
 * Parse a checkpoint response. Returns null when nothing usable came back — the caller records
 * `status = 'error'` on the row and carries on, because one failed checkpoint is a gap in the
 * expected course, not a failed episode.
 *
 * `chunkIds` is the ORDERED list of `mksap_chunks` ids the prompt showed as [1]…[k], so a cited
 * ordinal is resolved to the id it stood for and every stored `citation_ids` — on the entry and on
 * the checkpoint row alike — is a chunk id.
 */
export function parseExpectedCourse(text: string, chunkIds: readonly number[]): ExpectedCourse | null {
  const o = extractJsonObject(text);
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;

  const items = (v: unknown): ExpectedItem[] => arr(v).map((raw) => {
    const e = obj(raw);
    return { item: asText(e.item), by_day: asNum(e.by_day), rationale: asText(e.rationale), citation_ids: asCitationIds(e.citation_ids, chunkIds) };
  }).filter((e) => e.item !== '');

  const monitoring: ExpectedMonitoring[] = arr(r.expected_monitoring).map((raw) => {
    const e = obj(raw);
    return { item: asText(e.item), frequency: asText(e.frequency, 200), rationale: asText(e.rationale), citation_ids: asCitationIds(e.citation_ids, chunkIds) };
  }).filter((e) => e.item !== '');

  const triggers: EscalationTrigger[] = arr(r.escalation_triggers).map((raw) => {
    const e = obj(raw);
    return { trigger: asText(e.trigger), action: asText(e.action), citation_ids: asCitationIds(e.citation_ids, chunkIds) };
  }).filter((e) => e.trigger !== '');

  const course: ExpectedCourse = {
    expected_diagnostics: items(r.expected_diagnostics),
    expected_therapeutics: items(r.expected_therapeutics),
    expected_monitoring: monitoring,
    escalation_triggers: triggers,
    expected_los_days: asNum(r.expected_los_days),
    expected_disposition: asText(r.expected_disposition, 200) || null,
    uncertainty: arr(r.uncertainty).map((u) => asText(u, 300)).filter(Boolean),
  };

  const any = course.expected_diagnostics.length || course.expected_therapeutics.length
    || course.expected_monitoring.length || course.escalation_triggers.length
    || course.expected_disposition || course.uncertainty.length;
  return any ? course : null;
}

/**
 * How many entries of an expected course came back with no usable citation, and how many entries
 * there were at all.
 *
 * ⚠️ THIS COUNTS. IT NEVER REPAIRS. The obvious "fix" for an uncited entry is to look for an
 * excerpt whose text overlaps the item and attach it — and that would be fabrication with extra
 * steps: a citation asserts "this expectation was DERIVED FROM that passage", which a string
 * overlap cannot establish. An invented citation is worse than a missing one, because the missing
 * one is caught by the uncited cap and the invented one silently lifts it.
 *
 * So the count is surfaced instead — `uncited_entry_count` on the checkpoint row — which makes the
 * failure visible in a scalar column without anyone reading jsonb, and lets a validator ask "how
 * many entries did this checkpoint ground?" of the whole cohort in one query.
 */
export function countUncitedEntries(course: ExpectedCourse | null): { uncited: number; total: number } {
  if (!course) return { uncited: 0, total: 0 };
  const lists: { citation_ids: number[] }[] = [
    ...course.expected_diagnostics, ...course.expected_therapeutics,
    ...course.expected_monitoring, ...course.escalation_triggers,
  ];
  return { uncited: lists.filter((e) => e.citation_ids.length === 0).length, total: lists.length };
}

/** True when a checkpoint had excerpts to cite, produced entries, and cited NONE of them — the
 *  failure mode measured on IP-1286, and the trigger for the one retry in checkpoint.ts. */
export function everyEntryUncited(course: ExpectedCourse | null, excerptCount: number): boolean {
  if (!course || excerptCount <= 0) return false;
  const { uncited, total } = countUncitedEntries(course);
  return total > 0 && uncited === total;
}

// ── checkpoint entry references (the uncited-entry cap's key, PRD §4.4) ──────────────────────

export interface CheckpointEntryRef { ref: string; citation_ids: number[] }

export const CHECKPOINT_ENTRY_SECTIONS = ['diagnostics', 'therapeutics', 'monitoring', 'escalation'] as const;

/**
 * Every entry of one expected course, addressed as `<checkpoint-id>/<section>/<n>`. This is the
 * reference the diff pass puts in `checkpoint_ref`, and it is what lets §4.4's cap be applied in
 * CODE: a finding built on an entry whose `citation_ids` is empty is capped, whatever the model
 * claimed about it.
 */
export function checkpointEntryRefs(checkpointId: string, course: ExpectedCourse | null): CheckpointEntryRef[] {
  if (!course) return [];
  const out: CheckpointEntryRef[] = [];
  const push = (section: string, list: { citation_ids: number[] }[]) => {
    list.forEach((e, i) => out.push({ ref: `${checkpointId}/${section}/${i + 1}`, citation_ids: e.citation_ids }));
  };
  push('diagnostics', course.expected_diagnostics);
  push('therapeutics', course.expected_therapeutics);
  push('monitoring', course.expected_monitoring);
  push('escalation', course.escalation_triggers);
  return out;
}

/**
 * An expected course, rendered for the diff pass with its entry references attached.
 *
 * CITATIONS ARE RENDERED BACK AS ORDINALS, from the stored chunk ids via this checkpoint's own id
 * list. The diff pass is shown the same [1]…[k] numbering the checkpoint pass was, so it cites the
 * way it is told to; run.ts then resolves those ordinals against THE CHECKPOINT THE FINDING
 * REFERENCES, which is the only list they were ever numbered against. Showing raw chunk ids here
 * would ask a model to copy five-digit numbers exactly, which is a transcription error waiting to
 * become a citation to someone else's passage.
 */
export function renderExpectedCourse(
  checkpointId: string, dayIndex: number, type: 'daily' | 'episode',
  course: ExpectedCourse | null, chunkIds: readonly number[] = [],
): string {
  if (!course) return `${checkpointId} (${type}, day ${dayIndex}): no expected course was produced for this checkpoint.`;
  const lines: string[] = [`${checkpointId} (${type}, day ${dayIndex}) — expected course:`];
  const cite = (ids: number[]) => {
    const ordinals = ids.map((id) => ordinalForChunkId(id, chunkIds)).filter((o) => o > 0);
    return ordinals.length ? ` [citations ${ordinals.join(', ')}]` : ' [no citation]';
  };
  course.expected_diagnostics.forEach((e, i) => lines.push(`  ${checkpointId}/diagnostics/${i + 1} · by day ${e.by_day ?? '?'} · ${e.item} — ${e.rationale}${cite(e.citation_ids)}`));
  course.expected_therapeutics.forEach((e, i) => lines.push(`  ${checkpointId}/therapeutics/${i + 1} · by day ${e.by_day ?? '?'} · ${e.item} — ${e.rationale}${cite(e.citation_ids)}`));
  course.expected_monitoring.forEach((e, i) => lines.push(`  ${checkpointId}/monitoring/${i + 1} · ${e.item} (${e.frequency}) — ${e.rationale}${cite(e.citation_ids)}`));
  course.escalation_triggers.forEach((e, i) => lines.push(`  ${checkpointId}/escalation/${i + 1} · if ${e.trigger} then ${e.action}${cite(e.citation_ids)}`));
  if (course.expected_los_days != null) lines.push(`  expected length of stay: ${course.expected_los_days} day(s)`);
  if (course.expected_disposition) lines.push(`  expected disposition: ${course.expected_disposition}`);
  if (course.uncertainty.length) lines.push(`  uncertainty: ${course.uncertainty.join('; ')}`);
  return lines.join('\n');
}
