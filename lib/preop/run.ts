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
  fetchCreatinine, fetchHospitalNames, fetchOpdIcd, fetchOpdNarrative, fetchPacReports,
  fetchUpcomingEpisodes,
  type PacRow, type PreopEpisodeRow,
} from './db13';
import {
  pacAgeMismatch, pacBodyMetrics, pacObservations, parsePacComponentJson,
  type ParsedPac,
} from '../preop-pac-map-core';
import {
  PREOP_ENGINE_VERSION, readRails, recordSweep, saveExtraction, saveNarrative, saveSnapshot,
  type SaveOutcome,
} from './store';
import {
  extractOne, preopExtractEnabled, preopExtractFields, PREOP_EXTRACT_BUDGET_MS,
  type ExtractCall, type ExtractOneResult,
} from './extract';
import { narrateOne, preopNarrativeEnabled, type NarrativeCall } from './narrative';
import { extractionObservations, type PreopExtraction } from '../preop-extract-core';
import {
  PREOP_NARRATIVE_BUDGET_MS, PREOP_NARRATIVE_MAX_PER_TICK, type PreopNarrative,
} from '../preop-narrative-core';

// The two flags live beside the rails they gate (lib/preop/extract.ts, lib/preop/narrative.ts)
// and are re-exported here because the worker route reads them off the sweep's own module.
export { preopExtractEnabled, preopNarrativeEnabled };

/**
 * Which rails run this tick. Defaults come from the environment; the OVERRIDE exists for
 * one purpose only — measuring a rail without committing to it — and the worker route
 * refuses to honour an override unless the tick is a dry run that writes nothing.
 */
export interface PreopRails { extract: boolean; narrative: boolean }

export function preopRailsFromEnv(): PreopRails {
  return { extract: preopExtractEnabled(), narrative: preopNarrativeEnabled() };
}

/**
 * THE LLM BOX. The worker's maxDuration is 300 s and the deterministic sweep measured
 * 3.4–5.7 s (one 55 s outlier under Metabase contention). This is the ceiling on what the
 * two rails may add on top, checked BEFORE each leg starts rather than after it overruns:
 * a leg is only begun if its own budget still fits inside what is left. 180 s leaves the
 * measured slow tick and the whole deterministic term inside the box with room over.
 * ⚠️ Any change to this, to the per-leg budgets, or to maxDuration moves the others in
 * the same commit — the cron covenant, applied to the model legs.
 */
export const PREOP_LLM_BUDGET_MS = 180_000;
/** Opus is paced (PREOP_NARRATIVE_MAX_PER_TICK); the cheaper extraction leg is paced too,
 *  so one sweep after a bulk PAC import cannot spend the whole box on new text. */
export const PREOP_EXTRACT_MAX_PER_TICK = 8;

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
  /** the hospital's NAME, resolved from its uid — the uid itself when the lookup failed */
  hospitalName?: string | null;
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
    hospital: src.hospitalName ?? ep.hospitalUid,
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

export interface PreopRailTally {
  /** the rail ran this tick */
  on: boolean;
  /** episodes where the rail had something to work on */
  eligible: number;
  /** MODEL CALLS ACTUALLY MADE. The number that matters: on a settled board it is 0. */
  called: number;
  /** unchanged source text ⇒ the stored reading answered and no model ran */
  reused: number;
  /** nothing to read / nothing to say */
  skippedNoText: number;
  /** the LLM box or the per-tick cap stopped the leg before it started */
  skippedBudget: number;
  failed: number;
  ms: number;
  outcomes: Record<string, number>;
}

export interface PreopCaseTrace {
  episodeKey: string;
  tier: string;
  fingerprint: string;
  rcri: [number | null, number | null];
  mfi5: [number | null, number | null];
  charlson: [number | null, number | null];
  snapshot?: PreopSnapshot;
  extraction?: PreopExtraction | null;
  narrative?: PreopNarrative | null;
  extractOutcome?: string;
}

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
  /** B5/B6 — which rails ran and what they cost. Reported on EVERY tick, dark or not. */
  rails: { requested: PreopRails; extraction: PreopRailTally; narrative: PreopRailTally };
  /** B5 — inputs the extraction rail actually resolved, by input id (accepted + above floor) */
  extractedInputs: Record<string, number>;
  /** B5 — ids flagged unstable across the whole board (gate 4 firing in public) */
  unstableInputs: string[];
  /** B7 — per-episode detail, only when the caller asks for it (the golden-set harness) */
  cases?: PreopCaseTrace[];
  ms: number;
  errors: string[];
}

const emptyTally = (on: boolean): PreopRailTally => ({
  on, eligible: 0, called: 0, reused: 0, skippedNoText: 0, skippedBudget: 0, failed: 0,
  ms: 0, outcomes: {},
});

export interface PreopSweepOptions {
  now?: Date;
  horizonDays?: number;
  dryRun?: boolean;
  /**
   * Force the rails on or off for THIS tick, regardless of the environment. Used to
   * MEASURE a rail without committing to it. The worker route only honours it on a dry
   * run; the golden-set harness uses it directly.
   */
  rails?: Partial<PreopRails>;
  /**
   * An in-memory extraction cache that stands in for the stored one. The B7 anti-flap
   * harness threads the SAME map through two consecutive runs, which is what exercises
   * the reuse path without writing a byte to production.
   */
  extractionCache?: Map<string, PreopExtraction | null>;
  /** episode keys to sweep INSTEAD of the upcoming window (the golden set) */
  onlyEpisodes?: string[];
  /** collect per-episode detail into result.cases (the validation pack's raw material) */
  collect?: boolean;
  /** the whole snapshot on each collected case — heavy; the pack's hand-check sample only */
  collectSnapshots?: boolean;
  llmBudgetMs?: number;
  /** test seams — production never passes them */
  extractCall?: ExtractCall;
  narrativeCall?: NarrativeCall;
}

/**
 * One tick. Idempotent on (episode_key, PREOP_ENGINE_VERSION): a second tick over
 * unchanged evidence recomputes the same fingerprint and lib/preop/store.ts writes
 * nothing at all — no finding row, no version row. That is the B2 gate, and B5 does not
 * weaken it: an extraction is keyed on the fingerprint of its SOURCE TEXT, so unchanged
 * text makes no call, produces the same observations, and lands on the same fingerprint.
 */
export async function runPreopSweep(opts: PreopSweepOptions = {}): Promise<PreopSweepResult> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const todayIst = istDay(now);
  const computedAt = now.toISOString();
  const errors: string[] = [];
  const rails: PreopRails = { ...preopRailsFromEnv(), ...(opts.rails ?? {}) };
  const llmBudgetMs = opts.llmBudgetMs ?? PREOP_LLM_BUDGET_MS;
  const spent = () => Date.now() - started;
  /** A leg is only STARTED if its own ceiling still fits in what is left of the box. */
  const roomFor = (legMs: number) => spent() + legMs <= llmBudgetMs;

  const episodeFetch = await fetchUpcomingEpisodes(opts.horizonDays ?? PREOP_HORIZON_DAYS);
  if (episodeFetch.error) errors.push(episodeFetch.error);
  const only = opts.onlyEpisodes?.length ? new Set(opts.onlyEpisodes) : null;
  const episodes = only ? episodeFetch.rows.filter((e) => only.has(e.docId)) : episodeFetch.rows;
  const individualUids = episodes.map((e) => e.individualUid);
  const uhids = episodes.map((e) => e.uhid).filter((u): u is string => !!u);

  const [creat, icd, pacs, hospitals] = await Promise.all([
    fetchCreatinine(individualUids),
    fetchOpdIcd(individualUids),
    fetchPacReports(uhids),
    fetchHospitalNames(),
  ]);
  // The OPD free-text leg costs a query, so a dark rail does not pay for it.
  const opdNarr = rails.extract
    ? await fetchOpdNarrative(individualUids)
    : { rows: [] as Array<{ individualUid: string; text: string }>, error: null };
  const hospitalName = new Map(hospitals.rows.map((h) => [h.uid, h.name]));
  // A source that FAULTED and a source that is genuinely empty produce the same rows and
  // must never produce the same report. Both the error line and the degraded flag ride
  // all the way out to the response and the heartbeat row.
  const degraded: string[] = [];
  for (const f of [creat, icd, pacs, hospitals, opdNarr]) if (f.error) { errors.push(f.error); degraded.push(f.error.split(':')[0]); }
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
  const narrByUid = new Map<string, string>();
  for (const r of opdNarr.rows) {
    const prev = narrByUid.get(r.individualUid);
    narrByUid.set(r.individualUid, prev ? `${prev}\n${r.text}` : r.text);
  }

  // The stored rail artefacts for exactly these episodes, in one round trip. Read BEFORE
  // any snapshot is composed — that is what makes "unchanged text ⇒ no call" hold ACROSS
  // ticks and not merely within one.
  const railStore = rails.extract || rails.narrative
    ? await readRails(episodes.map((e) => e.docId))
    : { byKey: new Map(), error: null };
  if (railStore.error) { errors.push(railStore.error); degraded.push('preop rails'); }

  const written: Record<SaveOutcome, number> = { inserted: 0, updated: 0, unchanged: 0, skipped: 0 };
  const byTier: Record<string, number> = {};
  const unmappedBookingTerms: Record<string, number> = {};
  const unmatchedIcd: Record<string, number> = {};
  const extractedInputs: Record<string, number> = {};
  const unstableInputs = new Set<string>();
  const extractTally = emptyTally(rails.extract);
  const narrativeTally = emptyTally(rails.narrative);
  const cases: PreopCaseTrace[] = [];
  let needsReview = 0, pacLinked = 0, bookingOnly = 0, withCreatinine = 0, withIcd = 0;
  let notComputable = 0, pacWorkflowCompleteWithoutReport = 0;

  for (const ep of episodes) {
    const src: EpisodeSources = {
      creatinine: creatByUid.get(ep.individualUid) ?? [],
      icd: icdByUid.get(ep.individualUid) ?? [],
      pac: pacForEpisode(ep.uhid ? (pacByUhid.get(ep.uhid) ?? []) : [], ep.surgeryDate),
      hospitalName: ep.hospitalUid ? (hospitalName.get(ep.hospitalUid) ?? null) : null,
    };
    const a = assembleEpisode(ep, src);
    const stored = railStore.byKey.get(ep.docId) ?? null;

    // ── B5 · the extraction rail ────────────────────────────────────────────────
    let extraction: PreopExtraction | null = opts.extractionCache?.get(ep.docId)
      ?? (stored?.extraction as PreopExtraction | null | undefined)
      ?? null;
    let extractOutcome: string | undefined;
    if (rails.extract) {
      const fields = preopExtractFields(a.parsedPac, narrByUid.get(ep.individualUid) ?? null);
      const t0 = Date.now();
      let r: ExtractOneResult;
      if (extractTally.called >= PREOP_EXTRACT_MAX_PER_TICK || !roomFor(PREOP_EXTRACT_BUDGET_MS)) {
        // The cap and the box are checked BEFORE the call, and a leg we decline to start
        // leaves the STORED reading in place — a budget skip must never look like a
        // retraction of an input the rail has already proposed.
        r = { outcome: 'reused', record: extraction, changed: false, moved: [], called: false, latencyMs: 0 };
        if (Object.keys(fields).length) { extractTally.skippedBudget++; extractOutcome = 'skipped_budget'; }
      } else {
        r = await extractOne({ episodeKey: ep.docId, fields, stored: extraction, now, call: opts.extractCall });
        extractOutcome = r.outcome;
      }
      extractTally.ms += Date.now() - t0;
      extractTally.outcomes[extractOutcome ?? r.outcome] = (extractTally.outcomes[extractOutcome ?? r.outcome] ?? 0) + 1;
      if (Object.keys(fields).length) extractTally.eligible++;
      if (r.called) extractTally.called++;
      if (r.outcome === 'reused') extractTally.reused++;
      if (r.outcome === 'no_text') extractTally.skippedNoText++;
      if (r.outcome === 'failed') { extractTally.failed++; if (r.error) errors.push(`${ep.docId} extract: ${r.error}`); }
      extraction = r.record;
      opts.extractionCache?.set(ep.docId, extraction);
      if (r.changed && r.record && !opts.dryRun) {
        const ok = await saveExtraction(ep.docId, r.record, r.record);
        if (!ok && written.inserted + written.updated > 0) errors.push(`${ep.docId}: extraction write failed`);
      }
      for (const id of extraction?.unstable ?? []) unstableInputs.add(id);
    }
    const extractObs = rails.extract ? extractionObservations(extraction) : [];

    const snap: PreopSnapshot = composeSnapshot({
      engineVersion: PREOP_ENGINE_VERSION,
      episode: a.facts,
      observations: [...a.observations, ...extractObs],
      pac: a.pac,
      daysToSurgery: daysBetweenDays(todayIst, ep.surgeryDate),
      reviewed: false,                       // the store re-reads the stored review state
      includeExtracted: rails.extract,
      bookingEnumerated: a.bookingEnumerated,
      notClosedBy: a.notClosedBy,
      bookingOnly: a.bookingOnly,
      computedAt,
    });
    for (const i of snap.inputs) if (i.source === 'EXTRACTED') extractedInputs[i.inputId] = (extractedInputs[i.inputId] ?? 0) + 1;

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

    let saved: SaveOutcome | null = null;
    if (!opts.dryRun) {
      const r = await saveSnapshot(snap);
      saved = r.outcome;
      written[r.outcome]++;
      if (r.error) errors.push(`${ep.docId}: ${r.error}`);
    }

    // ── B6 · the narrative rail ─────────────────────────────────────────────────
    // Regenerated ONLY when the reading has moved: the stored narrative carries the
    // fingerprint it was written for, so "a new snapshot version minted" is a string
    // comparison rather than a guess, and a settled board makes no calls at all.
    let narrative: PreopNarrative | null = (stored?.narrative as PreopNarrative | null | undefined) ?? null;
    if (rails.narrative) {
      const stale = (stored?.narrativeFingerprint ?? null) !== snap.fingerprint;
      if (!stale) { narrativeTally.reused++; narrativeTally.outcomes.reused = (narrativeTally.outcomes.reused ?? 0) + 1; }
      else {
        narrativeTally.eligible++;
        if (narrativeTally.called >= PREOP_NARRATIVE_MAX_PER_TICK || !roomFor(PREOP_NARRATIVE_BUDGET_MS)) {
          narrativeTally.skippedBudget++;
          narrativeTally.outcomes.skipped_budget = (narrativeTally.outcomes.skipped_budget ?? 0) + 1;
        } else {
          const t0 = Date.now();
          const r = await narrateOne({ snapshot: snap, now, call: opts.narrativeCall });
          narrativeTally.ms += Date.now() - t0;
          narrativeTally.called++;
          if (!r.ok || !r.narrative) {
            narrativeTally.failed++;
            narrativeTally.outcomes.failed = (narrativeTally.outcomes.failed ?? 0) + 1;
            if (r.reason) errors.push(`${ep.docId} narrative: ${r.reason}`);
          } else {
            narrative = r.narrative;
            const k = r.narrative.valid ? 'valid' : `invalid_${r.narrative.invalidReason}`;
            narrativeTally.outcomes[k] = (narrativeTally.outcomes[k] ?? 0) + 1;
            if (!opts.dryRun) await saveNarrative(ep.docId, r.narrative, r.narrative);
          }
        }
      }
    }

    if (opts.collect) {
      cases.push({
        episodeKey: ep.docId,
        tier: snap.tier.tier,
        fingerprint: snap.fingerprint,
        rcri: [snap.rcri.lo, snap.rcri.hi],
        mfi5: [snap.mfi5.lo, snap.mfi5.hi],
        charlson: [snap.charlson.lo, snap.charlson.hi],
        ...(opts.collectSnapshots ? { snapshot: snap } : {}),
        extraction, narrative, extractOutcome,
      });
    }
    void saved;
  }

  const ms = Date.now() - started;
  const result: PreopSweepResult = {
    engine: PREOP_ENGINE_VERSION, todayIst, episodes: episodes.length, written, byTier,
    needsReview, pacLinked, pacWorkflowCompleteWithoutReport, bookingOnly,
    withCreatinine, withIcd, notComputable, unmappedBookingTerms, unmatchedIcd, ms,
    degradedSources: degraded,
    rails: { requested: rails, extraction: extractTally, narrative: narrativeTally },
    extractedInputs,
    unstableInputs: [...unstableInputs].sort(),
    ...(opts.collect ? { cases } : {}),
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
