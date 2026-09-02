/**
 * lib/ipd-episode/judge-core.ts — the PURE half of the three Opus passes (PRD §3.4, §3.5, §3.6)
 * and ALL of this engine's arithmetic.
 *
 * NO db, NO model, NO Next.
 *
 * THE RULES BELOW ARE CODE, NOT PROMPT TEXT, AND THAT IS THE POINT. Each prompt states its rule;
 * each rule is then re-applied here to whatever actually came back:
 *
 *   · TIER C (§4.2) — a finding whose evidence_basis is empty, or names only Tier C sources,
 *     cannot carry `divergent`. It is rewritten to `unassessable` and counted. A verdict is a
 *     claim about the record; a claim the record cannot support is not downgraded politely, it is
 *     replaced.
 *   · THE UNCITED CAP (§4.4) — a divergence finding measured against a checkpoint entry that
 *     carried no citation is capped at severity `minor`, verdict `context_dependent`. An
 *     expectation nothing normative backs is a reasonable expectation, not a standard. NOT applied
 *     to fidelity findings: those are measured against the record, not against an expectation.
 *   · THE A2 DOMAIN DROP (§3.5) — a fidelity finding outside the `documentation` domain is
 *     DROPPED and counted in `n_dropped_invalid`, never quietly relabelled. A2 reads the discharge
 *     summary, so a clinical verdict from it would be an outcome-aware score wearing a blind one's
 *     name.
 *   · COMMENTARY (§3.6) — an output carrying a score field, or a finding_id that does not exist,
 *     is rejected outright. The caller retries once and then stores null.
 *
 * SCORING (§6.1): penalty = 8·major + 4·moderate + 1·minor over `divergent` findings from BOTH
 * passes, and `divergence_index = max(0, 100 − penalty)`. Fidelity findings share the divergence
 * penalty by V's decision 16, with the recorded trade-off that the headline number is therefore
 * not fully outcome-blind — which is why the UI labels every A2 finding as a fidelity finding, so
 * a reader can subtract them.
 */

import { extractJsonObject } from '../lvc-value-core';
import { LVC_CATEGORIES } from '../opd-lvc-classify-core';
import {
  COMPLETENESS_SOURCES, collapseSpaces, tierForTable,
  type EpisodeEvent, type EvidenceTier,
} from './assemble-core';
import { renderEvent, type CheckpointEntryRef, type ExpectedCourse } from './checkpoint-core';

// ── enums (PRD §3.4.2) ───────────────────────────────────────────────────────────────────────

export const FINDING_TYPES = ['omission', 'commission', 'timing', 'sequencing'] as const;
export const VERDICTS = ['divergent', 'context_dependent', 'unassessable', 'concordant'] as const;
export const DOMAINS = ['diagnostics', 'therapeutics', 'monitoring', 'escalation', 'documentation', 'disposition'] as const;
export const SEVERITIES = ['minor', 'moderate', 'major'] as const;
export const EVIDENCE_TIERS = ['A', 'B', 'C'] as const;
export const PASSES = ['divergence', 'fidelity'] as const;

export type FindingType = (typeof FINDING_TYPES)[number];
export type Verdict = (typeof VERDICTS)[number];
export type Domain = (typeof DOMAINS)[number];
export type Severity = (typeof SEVERITIES)[number];
export type AuditPass = (typeof PASSES)[number];

export interface EvidenceBasisItem { source_table: string; source_record_id: string; source_timestamp: string | null }

export interface EpisodeFinding {
  finding_id: string;
  pass: AuditPass;
  finding_type: FindingType;
  verdict: Verdict;
  domain: Domain;
  day_index: number;
  checkpoint_ref: string | null;
  statement: string;
  severity: Severity;
  evidence_tier: EvidenceTier;
  evidence_basis: EvidenceBasisItem[];
  author_name: string | null;
  author_role: string | null;
  responsible_clinician_id: string | null;
  lvc_category: string | null;
  citation_ids: number[];
}

const oneOf = <T extends string>(allowed: readonly T[], v: unknown): T | null =>
  (allowed as readonly string[]).includes(String(v)) ? (String(v) as T) : null;

/**
 * `lvc_category` validation. PRD §3.4.2 names `asCategory()` in lib/opd-lvc-classify-core.ts, but
 * that helper is module-private there and that file is on the UNTOUCHED list — so this is the same
 * one-line membership test against the same exported `LVC_CATEGORIES` constant (12 values), which
 * keeps the enum single-sourced without editing a frozen file. Flagged in the build report.
 */
export const asLvcCategory = (v: unknown): string | null =>
  (LVC_CATEGORIES as readonly string[]).includes(String(v)) ? String(v) : null;

const asText = (v: unknown, cap = 1500): string => (v == null ? '' : collapseSpaces(String(v)).slice(0, cap));
const asInt = (v: unknown, fallback = 0): number => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback; };
const objOf = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {});

function parseEvidenceBasis(v: unknown): EvidenceBasisItem[] {
  if (!Array.isArray(v)) return [];
  const out: EvidenceBasisItem[] = [];
  for (const raw of v.slice(0, 20)) {
    const o = objOf(raw);
    const table = asText(o.source_table, 120);
    const id = asText(o.source_record_id, 200);
    if (!table || !id) continue;
    out.push({ source_table: table, source_record_id: id, source_timestamp: asText(o.source_timestamp, 60) || null });
  }
  return out;
}

// ── parsing (both scoring passes share one shape) ────────────────────────────────────────────

export interface ParseFindingsOptions {
  pass: AuditPass;
  /** Uniquifies model-supplied finding ids across passes. */
  idPrefix: string;
}

/**
 * Parse a findings response into well-formed findings. A finding missing a required enum value or
 * a statement is DROPPED here — an unparseable finding is not a finding, and inventing a default
 * verdict for it would manufacture a score.
 *
 * ⚠️ THESE DROPS ARE NOT `n_dropped_invalid`, AND CONFLATING THEM HID A REAL SIGNAL. That counter
 * means exactly one thing — "A2 wrote a finding outside the documentation domain", a fence being
 * tested — and it is read as a rate of that specific misbehaviour. An unparseable finding is a
 * different fact about a different actor: the model returned something this engine could not read,
 * which is an integration problem, not a blinding one. It is reported through the pass's own
 * `unparseable` count, onto a trace event and onto the audit row's `error_detail`.
 *
 * Citation ids are left as the ORDINALS the model wrote. They are resolved against the referencing
 * checkpoint's own excerpt list by `resolveFindingCitations`, which is the only place that knows
 * which list a given ordinal was numbered against.
 */
export function parseFindings(text: string, opts: ParseFindingsOptions): { findings: EpisodeFinding[]; unparseable: number } {
  const o = extractJsonObject(text);
  const list = Array.isArray((objOf(o)).findings) ? (objOf(o).findings as unknown[]) : null;
  if (!list) return { findings: [], unparseable: 0 };

  const findings: EpisodeFinding[] = [];
  let unparseable = 0;
  list.slice(0, 120).forEach((raw, i) => {
    const f = objOf(raw);
    const finding_type = oneOf(FINDING_TYPES, f.finding_type);
    const verdict = oneOf(VERDICTS, f.verdict);
    const domain = oneOf(DOMAINS, f.domain);
    const severity = oneOf(SEVERITIES, f.severity);
    const statement = asText(f.statement);
    if (!finding_type || !verdict || !domain || !severity || !statement) { unparseable++; return; }

    const rawId = asText(f.finding_id, 80);
    // ORDINALS, unresolved. Only a positive-integer sanity filter here — the ceiling belongs to
    // whichever checkpoint this finding references, and this function does not know which that is.
    const citation_ids = Array.isArray(f.citation_ids)
      ? Array.from(new Set((f.citation_ids as unknown[]).map(Number)
          .filter((n) => Number.isInteger(n) && n >= 1))).slice(0, 16)
      : [];

    // lvc_category rides ONLY on a commission finding in therapeutics or diagnostics (§3.4.2);
    // anywhere else it is nulled whatever the model returned, and an unknown value is nulled too.
    const lvcEligible = finding_type === 'commission' && (domain === 'therapeutics' || domain === 'diagnostics');
    const lvc_category = lvcEligible ? asLvcCategory(f.lvc_category) : null;

    findings.push({
      finding_id: `${opts.idPrefix}-${rawId || String(i + 1)}`,
      pass: opts.pass,
      finding_type,
      verdict,
      domain,
      day_index: asInt(f.day_index, 0),
      checkpoint_ref: asText(f.checkpoint_ref, 120) || null,
      statement,
      severity,
      evidence_tier: oneOf(EVIDENCE_TIERS, f.evidence_tier) ?? 'C',
      evidence_basis: parseEvidenceBasis(f.evidence_basis),
      author_name: null,
      author_role: null,
      responsible_clinician_id: null,
      lvc_category,
      citation_ids,
    });
  });
  return { findings, unparseable };
}

// ── the code-enforced rules ──────────────────────────────────────────────────────────────────

/**
 * §4.2, the grading rule. A finding whose evidence_basis is EMPTY, or whose every basis item
 * names a Tier C source, cannot carry `divergent`. Rewritten to `unassessable`.
 *
 * The tier is derived from the SOURCE TABLE, not from the model's own `evidence_tier` claim —
 * the model is being checked here, so its self-assessment is not the input.
 */
export function applyTierCRule(f: EpisodeFinding): { finding: EpisodeFinding; rewritten: boolean } {
  if (f.verdict !== 'divergent') return { finding: f, rewritten: false };
  const tiers = f.evidence_basis.map((b) => tierForTable(b.source_table));
  const onlyC = tiers.length === 0 || tiers.every((t) => t === 'C');
  if (!onlyC) return { finding: f, rewritten: false };
  return { finding: { ...f, verdict: 'unassessable' }, rewritten: true };
}

/**
 * §4.4, the uncited-entry cap. A DIVERGENCE finding is capped at severity `minor` and verdict
 * `context_dependent` unless it is measured against a checkpoint entry that actually carried a
 * citation.
 *
 * ⚠️ THREE CASES CAP, NOT ONE, AND THE TWO NEW ONES ARE THE IMPORTANT ONES. §3.4 requires every
 * A1 finding to carry a non-null `checkpoint_ref`, but a requirement in a prompt is a request. A
 * finding with a NULL ref, or one naming an entry that does not exist, is not measured against any
 * expectation this engine can produce — so it is exactly the thing the cap exists for, and leaving
 * it uncapped let the weakest findings in the set carry the heaviest penalty. Capping only the
 * resolvable-and-uncited case meant a model could evade the cap by citing nothing at all.
 *
 * Still not applied to fidelity findings: §4.4 says so outright, and the reason holds — A2 is
 * measured against the record, not against an expectation, so an expectation's citations say
 * nothing about it.
 */
export function applyUncitedCap(f: EpisodeFinding, entryRefs: Map<string, CheckpointEntryRef>): { finding: EpisodeFinding; capped: boolean } {
  if (f.pass !== 'divergence') return { finding: f, capped: false };
  const entry = f.checkpoint_ref ? entryRefs.get(f.checkpoint_ref) : undefined;
  // capped when: no ref at all · a ref naming nothing · a ref naming an entry with no citation
  const grounded = !!entry && entry.citation_ids.length > 0;
  if (grounded) return { finding: f, capped: false };
  if (f.severity === 'minor' && f.verdict === 'context_dependent') return { finding: f, capped: false };
  return { finding: { ...f, severity: 'minor', verdict: 'context_dependent' }, capped: true };
}

/**
 * §3.5, in two halves that are deliberately NOT the same operation.
 *
 * DOMAIN → DROP. A fidelity finding outside `documentation` is a clinical verdict written with the
 * discharge summary in view. There is no honest way to keep it: it is the thing A2 is fenced away
 * from, and relabelling it `documentation` would launder an outcome-aware judgement into the
 * blinded set. It is dropped and counted in `n_dropped_invalid`, which means this and nothing else.
 *
 * SHAPE → NORMALISE. `finding_type` and `checkpoint_ref` are different: §3.5 FIXES them for this
 * pass — every A2 finding is a `commission` against the record with no checkpoint behind it — so a
 * model returning `omission`, or a stray ref copied from the schema, has not made a different
 * claim, it has mislabelled the one claim this pass can make. Dropping those would throw away real
 * findings over a field the spec already determines. They are set to the only values they can have.
 */
export function normalizeFidelityFindings(findings: EpisodeFinding[]): { kept: EpisodeFinding[]; dropped: number; normalized: number } {
  const kept: EpisodeFinding[] = [];
  let dropped = 0;
  let normalized = 0;
  for (const f of findings) {
    if (f.pass !== 'fidelity') { kept.push(f); continue; }
    if (f.domain !== 'documentation') { dropped++; continue; }
    if (f.finding_type !== 'commission' || f.checkpoint_ref !== null) {
      normalized++;
      kept.push({ ...f, finding_type: 'commission', checkpoint_ref: null });
      continue;
    }
    kept.push(f);
  }
  return { kept, dropped, normalized };
}

/**
 * Resolve each divergence finding's citation ORDINALS against THE CHECKPOINT IT REFERENCES, and
 * map them to that checkpoint's real `mksap_chunks` ids.
 *
 * ⚠️ WHY PER CHECKPOINT AND NOT ONE GLOBAL CEILING. Every checkpoint retrieves its own excerpts:
 * day 0 may get 8 and day 3 may get 2, and each was numbered [1]…[k] against its OWN list. Clamping
 * to the largest k across the episode let a "[6]" written against the two-excerpt checkpoint
 * survive and then resolve against nothing — or worse, be read later as a chunk id. Resolving
 * against the referencing checkpoint's own list is the only reading under which the number the
 * model wrote and the passage it meant are the same thing.
 *
 * A finding whose ref names no known checkpoint loses its citations entirely, which is correct: it
 * has nothing to have cited against. The uncited cap then catches the finding itself.
 *
 * Fidelity findings carry no citations — A2 is shown no excerpts — so they are emptied here too.
 */
export function resolveFindingCitations(
  findings: EpisodeFinding[], checkpointChunkIds: Map<string, readonly number[]>,
): EpisodeFinding[] {
  return findings.map((f) => {
    if (f.pass !== 'divergence' || !f.checkpoint_ref) return { ...f, citation_ids: [] };
    const checkpointId = f.checkpoint_ref.split('/')[0];
    const chunkIds = checkpointChunkIds.get(checkpointId);
    if (!chunkIds || !chunkIds.length) return { ...f, citation_ids: [] };
    const out: number[] = [];
    for (const ordinal of f.citation_ids) {
      if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > chunkIds.length) continue;
      const chunkId = chunkIds[ordinal - 1];
      if (Number.isFinite(chunkId) && !out.includes(chunkId)) out.push(chunkId);
    }
    return { ...f, citation_ids: out };
  });
}

// ── attribution (PRD §5) ─────────────────────────────────────────────────────────────────────

/**
 * Attach the author and the responsible clinician from the events a finding actually cites.
 * Every note-derived finding carries BOTH — which is the accountable party is a separate question,
 * answered by `attributedParty` below.
 */
export function attachAttribution(f: EpisodeFinding, events: EpisodeEvent[]): EpisodeFinding {
  const byRecord = new Map<string, EpisodeEvent>();
  for (const e of events) byRecord.set(`${e.provenance.source_table}::${e.provenance.source_record_id}`, e);
  for (const b of f.evidence_basis) {
    const e = byRecord.get(`${b.source_table}::${b.source_record_id}`);
    if (!e) continue;
    if (e.author_name || e.responsible_clinician_id) {
      return {
        ...f,
        author_name: e.author_name,
        author_role: e.author_role,
        responsible_clinician_id: e.responsible_clinician_id,
      };
    }
  }
  return f;
}

/**
 * Who this finding is attributed to (§5): a `documentation` finding is the AUTHOR's — they wrote
 * the note or the summary — and every other domain is the RESPONSIBLE CLINICIAN's, because the
 * decision was theirs whoever typed it up. Returns null when the record does not name one; an
 * unattributed finding is reported unattributed, never assigned to the nearest name.
 */
export function attributedParty(f: EpisodeFinding): { kind: 'author' | 'responsible_clinician'; value: string } | null {
  if (f.domain === 'documentation') {
    return f.author_name ? { kind: 'author', value: f.author_name } : null;
  }
  return f.responsible_clinician_id ? { kind: 'responsible_clinician', value: f.responsible_clinician_id } : null;
}

// ── scoring (PRD §6) ─────────────────────────────────────────────────────────────────────────

export const SEVERITY_PENALTY: Record<Severity, number> = { major: 8, moderate: 4, minor: 1 };

/** §6.1. Only `divergent` findings contribute, from BOTH passes (decision 16). Floors at zero. */
export function divergenceIndex(findings: EpisodeFinding[]): number {
  let penalty = 0;
  for (const f of findings) {
    if (f.verdict !== 'divergent') continue;
    penalty += SEVERITY_PENALTY[f.severity];
  }
  return Math.max(0, 100 - penalty);
}

/** §6.2. Nine sources; the floor is 33 because selection already requires three of them. */
export function completenessPct(sourcesPresent: readonly string[]): number {
  const known = new Set<string>(COMPLETENESS_SOURCES as readonly string[]);
  const present = new Set(sourcesPresent.filter((t) => known.has(t)));
  return Math.round((100 * present.size) / COMPLETENESS_SOURCES.length);
}

export interface FindingCounters {
  n_findings: number;
  n_divergence_pass: number;
  n_fidelity_pass: number;
  n_omission: number;
  n_commission: number;
  n_timing: number;
  n_sequencing: number;
  n_divergent: number;
  n_context_dependent: number;
  n_unassessable: number;
  n_concordant: number;
  n_low_value: number;
  n_dropped_invalid: number;
}

/** `droppedInvalid` is the A2 domain-drop count and nothing else (see `parseFindings`). */
export function countFindings(findings: EpisodeFinding[], droppedInvalid: number): FindingCounters {
  const c: FindingCounters = {
    n_findings: findings.length,
    n_divergence_pass: 0, n_fidelity_pass: 0,
    n_omission: 0, n_commission: 0, n_timing: 0, n_sequencing: 0,
    n_divergent: 0, n_context_dependent: 0, n_unassessable: 0, n_concordant: 0,
    n_low_value: 0, n_dropped_invalid: droppedInvalid,
  };
  for (const f of findings) {
    if (f.pass === 'divergence') c.n_divergence_pass++; else c.n_fidelity_pass++;
    if (f.finding_type === 'omission') c.n_omission++;
    else if (f.finding_type === 'commission') c.n_commission++;
    else if (f.finding_type === 'timing') c.n_timing++;
    else c.n_sequencing++;
    if (f.verdict === 'divergent') c.n_divergent++;
    else if (f.verdict === 'context_dependent') c.n_context_dependent++;
    else if (f.verdict === 'unassessable') c.n_unassessable++;
    else c.n_concordant++;
    if (f.lvc_category) c.n_low_value++;
  }
  return c;
}

/** `evidence_tiers` for the audit row: which source tables actually appeared, by tier. */
export function evidenceTiersOf(sourcesPresent: readonly string[]): { A: string[]; B: string[]; C: string[] } {
  const out: { A: string[]; B: string[]; C: string[] } = { A: [], B: [], C: [] };
  for (const t of sourcesPresent) out[tierForTable(t)].push(t);
  return { A: out.A.sort(), B: out.B.sort(), C: out.C.sort() };
}

/**
 * The whole post-model pipeline for one episode's findings, in the order the PRD specifies:
 * drop invalid A2 domains, apply the Tier C rewrite, apply the uncited cap, attach attribution,
 * then count and score. One function so the order cannot drift between callers.
 */
export interface FinalizeResult {
  findings: EpisodeFinding[];
  counters: FindingCounters;
  divergence_index: number;
  n_tier_c_rewritten: number;
  n_uncited_capped: number;
  n_fidelity_normalized: number;
}

/**
 * `n_dropped_invalid` is passed ONE number and it means ONE thing: A2 findings written outside the
 * documentation domain. Unparseable findings are counted by the caller and reported separately —
 * see the note on `parseFindings`.
 */
export function finalizeFindings(
  raw: EpisodeFinding[], entryRefs: Map<string, CheckpointEntryRef>, events: EpisodeEvent[],
): FinalizeResult {
  const { kept, dropped, normalized } = normalizeFidelityFindings(raw);
  let rewritten = 0;
  let capped = 0;
  const findings = kept.map((f0) => {
    // Cap BEFORE the Tier C rewrite: the cap can move a divergent finding to context_dependent,
    // at which point the Tier C rule no longer applies to it — which is correct, since the rule
    // exists to stop an unsupported DIVERGENT claim, and a capped finding no longer makes one.
    const capRes = applyUncitedCap(f0, entryRefs);
    if (capRes.capped) capped++;
    const tierRes = applyTierCRule(capRes.finding);
    if (tierRes.rewritten) rewritten++;
    return attachAttribution(tierRes.finding, events);
  });
  return {
    findings,
    counters: countFindings(findings, dropped),
    divergence_index: divergenceIndex(findings),
    n_tier_c_rewritten: rewritten,
    n_uncited_capped: capped,
    n_fidelity_normalized: normalized,
  };
}

// ── commentary (PRD §3.6) ────────────────────────────────────────────────────────────────────

export interface Commentary {
  narrative: string;
  outcome_context: string;
  findings_context: { finding_id: string; note: string }[];
}

/**
 * Any key that would make commentary a SCORE. Pass B is the only pass that knows the outcome, so
 * a number from it would be an outcome-aware grade sitting beside blind ones with nothing to tell
 * them apart. Checked over the whole object graph, not just the top level.
 */
export const COMMENTARY_FORBIDDEN_KEYS = [
  'score', 'scores', 'severity', 'verdict', 'verdicts', 'divergence_index', 'index', 'band',
  'grade', 'rating', 'rank', 'penalty', 'points', 'completeness_pct', 'care_value_index',
] as const;

function hasForbiddenKey(v: unknown, depth = 0): string | null {
  if (depth > 6 || !v || typeof v !== 'object') return null;
  if (Array.isArray(v)) {
    for (const e of v) { const hit = hasForbiddenKey(e, depth + 1); if (hit) return hit; }
    return null;
  }
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if ((COMMENTARY_FORBIDDEN_KEYS as readonly string[]).includes(k.toLowerCase())) return k;
    const hit = hasForbiddenKey(val, depth + 1);
    if (hit) return hit;
  }
  return null;
}

export type CommentaryRejection = { ok: false; reason: string };
export type CommentaryAccepted = { ok: true; commentary: Commentary };

/**
 * Validate a commentary response against the known finding ids. REJECTS — never repairs — on a
 * score field or a finding_id that does not exist. The caller retries once and then stores null,
 * because commentary that invents a finding to annotate is worse than no commentary.
 */
export function validateCommentary(text: string, knownFindingIds: readonly string[]): CommentaryAccepted | CommentaryRejection {
  const o = extractJsonObject(text);
  if (!o || typeof o !== 'object') return { ok: false, reason: 'no JSON object in the response' };
  const forbidden = hasForbiddenKey(o);
  if (forbidden) return { ok: false, reason: `commentary carried a scoring field '${forbidden}'` };

  const r = o as Record<string, unknown>;
  const narrative = asText(r.narrative, 8000);
  const outcome_context = asText(r.outcome_context, 4000);
  if (!narrative && !outcome_context) return { ok: false, reason: 'commentary carried no prose' };

  const known = new Set(knownFindingIds);
  const ctxRaw = Array.isArray(r.findings_context) ? r.findings_context.slice(0, 80) : [];
  const findings_context: { finding_id: string; note: string }[] = [];
  for (const raw of ctxRaw) {
    const e = objOf(raw);
    const id = asText(e.finding_id, 80);
    const note = asText(e.note, 2000);
    if (!id && !note) continue;
    if (!known.has(id)) return { ok: false, reason: `commentary annotated an unknown finding_id '${id}'` };
    findings_context.push({ finding_id: id, note });
  }
  return { ok: true, commentary: { narrative, outcome_context, findings_context } };
}

// ── user messages for the three Opus passes ──────────────────────────────────────────────────

export interface DiffUserInput {
  admissionContext: string;
  /** ALREADY filtered by diffPassEvents — no discharge event reaches here. */
  events: EpisodeEvent[];
  /** Rendered checkpoints, entry-referenced. */
  checkpointBlocks: string[];
}

export function buildDiffUser(input: DiffUserInput): string {
  return `ADMISSION CONTEXT
${input.admissionContext}

THE REAL COURSE (${input.events.length} event${input.events.length === 1 ? '' : 's'}; the discharge event is deliberately absent)
${input.events.length ? input.events.map(renderEvent).join('\n') : '(no events were assembled)'}

THE CHECKPOINTS
${input.checkpointBlocks.length ? input.checkpointBlocks.join('\n\n') : '(no checkpoint produced an expected course)'}

Report the divergences as the JSON object described in your instructions.`;
}

export interface FidelityUserInput {
  admissionContext: string;
  /** ALREADY filtered by fidelityPassEvents — the discharge event IS present here. */
  events: EpisodeEvent[];
  extractedCase: unknown;
  extractionVersion: string | null;
}

export function buildFidelityUser(input: FidelityUserInput): string {
  return `ADMISSION CONTEXT
${input.admissionContext}

THE REAL COURSE (${input.events.length} event${input.events.length === 1 ? '' : 's'}, including the discharge event)
${input.events.length ? input.events.map(renderEvent).join('\n') : '(no events were assembled)'}

THE EXTRACTED DISCHARGE SUMMARY (${input.extractionVersion ?? 'version not recorded'})
${JSON.stringify(input.extractedCase ?? null, null, 1).slice(0, 60000)}

Report the unsupported claims as the JSON object described in your instructions.`;
}

export interface CommentaryUserInput {
  admissionContext: string;
  events: EpisodeEvent[];
  findings: EpisodeFinding[];
  outcomeLine: string;
  expectedCourses: string[];
}

export function buildCommentaryUser(input: CommentaryUserInput): string {
  return `ADMISSION CONTEXT
${input.admissionContext}

HOW THIS ADMISSION ENDED
${input.outcomeLine}

THE REAL COURSE (${input.events.length} event${input.events.length === 1 ? '' : 's'})
${input.events.length ? input.events.map(renderEvent).join('\n') : '(no events were assembled)'}

THE CHECKPOINTS
${input.expectedCourses.length ? input.expectedCourses.join('\n\n') : '(no checkpoint produced an expected course)'}

THE FINDINGS (annotate by finding_id; you may not add to this list)
${input.findings.length
    ? input.findings.map((f) => `- ${f.finding_id} · ${f.pass} · ${f.finding_type} · ${f.domain} · day ${f.day_index} · ${f.severity} · ${f.verdict} · ${f.statement}`).join('\n')
    : '(no findings were produced)'}

Write the commentary as the JSON object described in your instructions.`;
}

/** Re-export so the checkpoint type travels with the findings pipeline that consumes it. */
export type { ExpectedCourse };
