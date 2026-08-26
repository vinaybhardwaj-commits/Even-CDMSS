/**
 * lib/preop/run.ts — the deterministic ₹0 sweep: detect episodes, assemble inputs,
 * recompute snapshots, write through the versions rail (PRD §6; Build Plan B2).
 *
 * THERE IS NO MODEL IN THIS FILE, and there is none anywhere below it. Every tick is
 * SQL plus the pure cores. The extraction and narrative rails (PRD §7) attach at B5/B6
 * behind their own flags; with those flags off — which is how Slice 1 ships — this
 * sweep IS the whole engine, degraded in coverage and correct in behaviour.
 *
 * Sweep-is-the-retry, the readmissions posture: nothing is queued and nothing is
 * marked failed. A source that faulted this tick simply did not observe anything, the
 * affected instrument widened to a range and said so on the card, and the next tick
 * tries again. The only thing a fault can cost is an input.
 *
 * The clock enters here, ONCE, and is passed down as arguments — `todayIst` and
 * `computedAt`. Everything below this line is pure.
 */

import {
  bookingComorbidityObservations, composeSnapshot, creatinineObservation,
  icdObservations, procedureObservation, PAC_NONE,
  type EpisodeFacts, type Observation, type PacState, type PreopInputId, type PreopSnapshot,
} from '../preop-assemble-core';
import {
  fetchCreatinine, fetchOpdIcd, fetchPacReports, fetchUpcomingEpisodes,
  type PacRow, type PreopEpisodeRow,
} from './db13';
import {
  pacAgeMismatch, pacBodyMetrics, pacObservations, parsePacComponentJson,
  type ParsedPac,
} from '../preop-pac-map-core';
import { PREOP_ENGINE_VERSION, recordSweep, saveSnapshot, type SaveOutcome } from './store';

/** PREOP_EXTRACT_ENABLED (PRD §7). Ships OFF; B5 builds what it gates. */
export function preopExtractEnabled(): boolean {
  return process.env.PREOP_EXTRACT_ENABLED === '1';
}

/** How far ahead the board looks. The mockup's tile counts "surgery date today or later". */
export const PREOP_HORIZON_DAYS = 60;

/** A PAC counts for an episode when it was finalized in this window around the surgery. */
export const PAC_WINDOW_DAYS_BEFORE = 90;
export const PAC_WINDOW_DAYS_AFTER = 1;

// ── date arithmetic, done once, in IST ──────────────────────────────────────────

/** Whole days from `todayIst` to `surgeryDate`, both YYYY-MM-DD. null when unknown. */
export function daysBetweenDays(todayIst: string, surgeryDate: string | null): number | null {
  if (!surgeryDate || !/^\d{4}-\d{2}-\d{2}$/.test(surgeryDate) || !/^\d{4}-\d{2}-\d{2}$/.test(todayIst)) return null;
  const a = Date.parse(`${todayIst}T00:00:00Z`);
  const b = Date.parse(`${surgeryDate}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/** The IST calendar day for an instant — the sweep's own "today". */
export function istDay(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/**
 * The PAC report that belongs to THIS episode: the latest final report inside the
 * window around the surgery date. The bridge is patient-level (individuals.kx_uhid), so
 * a patient with two episodes would otherwise inherit the same PAC for both — the
 * window is what keeps one anaesthetist's evaluation attached to one operation.
 * With no surgery date, the latest final report stands.
 */
export function pacForEpisode(reports: PacRow[], surgeryDate: string | null): PacRow | null {
  const finals = reports.filter((r) => (r.status ?? '').toLowerCase() === 'final' && r.createdAt);
  if (!finals.length) return null;
  const inWindow = surgeryDate
    ? finals.filter((r) => {
        const d = daysBetweenDays(String(r.createdAt).slice(0, 10), surgeryDate);
        return d != null && d >= -PAC_WINDOW_DAYS_AFTER && d <= PAC_WINDOW_DAYS_BEFORE;
      })
    : finals;
  const pool = inWindow.length ? inWindow : [];
  if (!pool.length) return null;
  return pool.reduce((best, r) => (String(r.createdAt) > String(best.createdAt) ? r : best), pool[0]);
}

// ── one episode's observations ──────────────────────────────────────────────────

export interface EpisodeSources {
  creatinine: Array<{ value: number | null; unit: string | null; at: string | null }>;
  icd: Array<{ codes: string[]; at: string | null; ref: string | null }>;
  pac: PacRow | null;
}

export interface AssembledEpisode {
  facts: EpisodeFacts;
  observations: Observation[];
  notClosedBy: PreopInputId[];
  bookingEnumerated: boolean;
  bookingOnly: boolean;
  pac: PacState;
  unmappedBookingTerms: string[];
  unmatchedIcd: string[];
  /** B3: the mapped PAC, for the case page. null when no report is attached. */
  parsedPac: ParsedPac | null;
  /** B3: how many instrument inputs the PAC actually supplied */
  pacInputCount: number;
  /** B3: the PAC's own recorded age disagrees with the dob-derived age by this many years */
  pacAgeMismatch: number | null;
}

/**
 * Turn one episode row plus its sources into the argument list composeSnapshot wants.
 * PURE — every fetch already happened.
 */
export function assembleEpisode(ep: PreopEpisodeRow, src: EpisodeSources): AssembledEpisode {
  const observations: Observation[] = [];

  // 1 · the booking form: the procedure's risk class and the comorbidity enumeration
  const proc = procedureObservation(ep.procedure, ep.docId);
  if (proc) observations.push(proc);
  const booking = bookingComorbidityObservations(ep.comorbidities, ep.docId, ep.createdAt);
  observations.push(...booking.observations);

  // 2 · OPD: structured ICD codes off the member's consults
  const unmatchedIcd: string[] = [];
  for (const row of src.icd) {
    const mapped = icdObservations(row.codes, row.at, row.ref);
    observations.push(...mapped.observations);
    unmatchedIcd.push(...mapped.unmatched);
  }

  // 3 · the lab: the newest creatinine wins (the fetch returns oldest first)
  const newestCreat = src.creatinine.length ? src.creatinine[src.creatinine.length - 1] : null;
  if (newestCreat) {
    const obs = creatinineObservation(newestCreat.value, newestCreat.unit, newestCreat.at, 'eka');
    if (obs) observations.push(obs);
  }

  // 4 · the PAC. B3 maps the template's opaque keys to semantic fields and feeds the
  //     DETERMINISTIC ones — coded review-of-systems values, medication checkboxes and
  //     the investigations creatinine — as PAC-sourced observations, which outrank
  //     BOOKING and OPD. Free text (diagnosis, other history, examination) is carried
  //     for display and read by nobody: inferring a condition from prose is B5.
  const parsedPac = src.pac ? parsePacComponentJson(src.pac.componentJson) : null;
  let pacInputCount = 0;
  if (src.pac && parsedPac) {
    const obs = pacObservations(parsedPac, src.pac.createdAt, src.pac.uid);
    pacInputCount = obs.length;
    observations.push(...obs);
  }
  const pac: PacState = src.pac
    ? {
        onFile: true,
        status: src.pac.status,
        // The anaesthetist's conclusion box when they filled it, the note's closing line
        // otherwise. Quoted verbatim either way, never paraphrased, never replaced.
        verdict: parsedPac?.conclusion ?? src.pac.closingLine,
        reportUid: src.pac.uid,
        finalizedAt: src.pac.createdAt,
        workflowStatus: ep.pacWorkflowStatus,
        workflowLoggedAt: ep.pacWorkflowLoggedAt,
      }
    : { ...PAC_NONE, workflowStatus: ep.pacWorkflowStatus, workflowLoggedAt: ep.pacWorkflowLoggedAt };

  const facts: EpisodeFacts = {
    episodeKey: ep.docId,
    individualUid: ep.individualUid,
    uhid: ep.uhid,
    patientName: ep.patientName,
    age: ep.age,
    sex: ep.sex,
    procedure: ep.procedure,
    hospital: ep.hospitalUid,
    surgeryDate: ep.surgeryDate,
    surgeon: null,           // treating_doctor_uid is a uid, not a name — B4 resolves it
    department: null,
  };

  return {
    facts,
    observations,
    notClosedBy: booking.notClosedBy,
    bookingEnumerated: booking.enumerated,
    // No OPD consult, no lab, no PAC: the booking form is the only document on file.
    bookingOnly: src.icd.length === 0 && src.creatinine.length === 0 && src.pac === null,
    pac,
    unmappedBookingTerms: booking.unmapped,
    unmatchedIcd,
    parsedPac,
    pacInputCount,
    pacAgeMismatch: parsedPac ? pacAgeMismatch(parsedPac, ep.age) : null,
  };
}

// ── the sweep ───────────────────────────────────────────────────────────────────

export interface PreopSweepResult {
  engine: string;
  todayIst: string;
  episodes: number;
  written: Record<SaveOutcome, number>;
  byTier: Record<string, number>;
  needsReview: number;
  pacLinked: number;
  pacWorkflowCompleteWithoutReport: number;
  bookingOnly: number;
  withCreatinine: number;
  withIcd: number;
  notComputable: number;
  /** sources that FAULTED this tick — every coverage number above is a floor, not a fact,
   *  whenever this is non-empty (the 26 Aug lesson: a 504'd ICD query reported "0") */
  degradedSources: string[];
  unmappedBookingTerms: Record<string, number>;
  unmatchedIcd: Record<string, number>;
  ms: number;
  errors: string[];
}

/**
 * One tick. Idempotent on (episode_key, PREOP_ENGINE_VERSION): a second tick over
 * unchanged evidence recomputes the same fingerprint and lib/preop/store.ts writes
 * nothing at all — no finding row, no version row. That is the B2 gate.
 */
export async function runPreopSweep(opts: { now?: Date; horizonDays?: number; dryRun?: boolean } = {}): Promise<PreopSweepResult> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const todayIst = istDay(now);
  const computedAt = now.toISOString();
  const errors: string[] = [];

  const episodeFetch = await fetchUpcomingEpisodes(opts.horizonDays ?? PREOP_HORIZON_DAYS);
  if (episodeFetch.error) errors.push(episodeFetch.error);
  const episodes = episodeFetch.rows;
  const individualUids = episodes.map((e) => e.individualUid);
  const uhids = episodes.map((e) => e.uhid).filter((u): u is string => !!u);

  const [creat, icd, pacs] = await Promise.all([
    fetchCreatinine(individualUids),
    fetchOpdIcd(individualUids),
    fetchPacReports(uhids),
  ]);
  // A source that FAULTED and a source that is genuinely empty produce the same rows and
  // must never produce the same report. Both the error line and the degraded flag ride
  // all the way out to the response and the heartbeat row.
  const degraded: string[] = [];
  for (const f of [creat, icd, pacs]) if (f.error) { errors.push(f.error); degraded.push(f.error.split(':')[0]); }
  const creatRows = creat.rows, icdRows = icd.rows, pacRows = pacs.rows;

  const creatByUid = new Map<string, EpisodeSources['creatinine']>();
  for (const r of creatRows) {
    const list = creatByUid.get(r.individualUid) ?? [];
    list.push({ value: r.value, unit: r.unit, at: r.at });
    creatByUid.set(r.individualUid, list);
  }
  const icdByUid = new Map<string, EpisodeSources['icd']>();
  for (const r of icdRows) {
    const list = icdByUid.get(r.individualUid) ?? [];
    list.push({ codes: r.codes, at: r.at, ref: r.ref });
    icdByUid.set(r.individualUid, list);
  }
  const pacByUhid = new Map<string, PacRow[]>();
  for (const r of pacRows) {
    const list = pacByUhid.get(r.uhid) ?? [];
    list.push(r);
    pacByUhid.set(r.uhid, list);
  }

  const written: Record<SaveOutcome, number> = { inserted: 0, updated: 0, unchanged: 0, skipped: 0 };
  const byTier: Record<string, number> = {};
  const unmappedBookingTerms: Record<string, number> = {};
  const unmatchedIcd: Record<string, number> = {};
  let needsReview = 0, pacLinked = 0, bookingOnly = 0, withCreatinine = 0, withIcd = 0;
  let notComputable = 0, pacWorkflowCompleteWithoutReport = 0;

  for (const ep of episodes) {
    const src: EpisodeSources = {
      creatinine: creatByUid.get(ep.individualUid) ?? [],
      icd: icdByUid.get(ep.individualUid) ?? [],
      pac: pacForEpisode(ep.uhid ? (pacByUhid.get(ep.uhid) ?? []) : [], ep.surgeryDate),
    };
    const a = assembleEpisode(ep, src);
    const snap: PreopSnapshot = composeSnapshot({
      engineVersion: PREOP_ENGINE_VERSION,
      episode: a.facts,
      observations: a.observations,
      pac: a.pac,
      daysToSurgery: daysBetweenDays(todayIst, ep.surgeryDate),
      reviewed: false,                       // the store re-reads the stored review state
      includeExtracted: preopExtractEnabled(),
      bookingEnumerated: a.bookingEnumerated,
      notClosedBy: a.notClosedBy,
      bookingOnly: a.bookingOnly,
      computedAt,
    });

    byTier[snap.tier.tier] = (byTier[snap.tier.tier] ?? 0) + 1;
    if (snap.tier.needsReview) needsReview++;
    if (a.pac.onFile) pacLinked++;
    else if ((ep.pacWorkflowStatus ?? '').toUpperCase() === 'COMPLETED') pacWorkflowCompleteWithoutReport++;
    if (a.bookingOnly) bookingOnly++;
    if (src.creatinine.length) withCreatinine++;
    if (src.icd.length) withIcd++;
    if (snap.rcri.kind === 'not_computable' || snap.mfi5.kind === 'not_computable' || snap.charlson.kind === 'not_computable') notComputable++;
    for (const t of a.unmappedBookingTerms) unmappedBookingTerms[t] = (unmappedBookingTerms[t] ?? 0) + 1;
    for (const c of a.unmatchedIcd) unmatchedIcd[c] = (unmatchedIcd[c] ?? 0) + 1;

    if (opts.dryRun) continue;
    const r = await saveSnapshot(snap);
    written[r.outcome]++;
    if (r.error) errors.push(`${ep.docId}: ${r.error}`);
  }

  const ms = Date.now() - started;
  const result: PreopSweepResult = {
    engine: PREOP_ENGINE_VERSION, todayIst, episodes: episodes.length, written, byTier,
    needsReview, pacLinked, pacWorkflowCompleteWithoutReport, bookingOnly,
    withCreatinine, withIcd, notComputable, unmappedBookingTerms, unmatchedIcd, ms,
    degradedSources: degraded,
    errors: errors.slice(0, 20),
  };
  if (!opts.dryRun) {
    await recordSweep({
      engineVersion: PREOP_ENGINE_VERSION, episodes: episodes.length,
      inserted: written.inserted, updated: written.updated, unchanged: written.unchanged,
      skipped: written.skipped, byTier, pacLinked, ms, degradedSources: degraded,
      notes: errors.length ? `${degraded.length ? `DEGRADED [${degraded.join(', ')}] ` : ''}${errors.slice(0, 3).join(' | ')}`.slice(0, 500) : null,
    });
  }
  return result;
}
