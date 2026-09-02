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

export const CITATION_PROVENANCES = ['normative', 'literature', 'mixed'] as const;
export type CitationProvenance = (typeof CITATION_PROVENANCES)[number];

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
  /**
   * What KIND of source this finding stands on (V, 2026-09-02):
   *   normative  — every citation is a guideline/standard source
   *   literature — every citation is something else: a StatPearls chapter, a journal passage
   *   mixed      — both
   *   null       — no citations at all (every A2 finding, and any uncited A1 one)
   * Stored so the UI can show it and so the cohort can be asked, later, how much of the score
   * actually rests on guidelines rather than on literature that reads like one.
   */
  citation_provenance: CitationProvenance | null;
  /**
   * THE CAP, AUDITABLE FROM STORED DATA. `capped` is true when any cap touched this finding, and
   * the two `*_before_cap` fields hold what it said beforehand. Without these, "5 capped" is a
   * sentence in a response body that nobody can check against the row; with them a validator can
   * recount every cap from `findings` alone. `severity_before_cap` is carried as well as the
   * verdict because the literature cap moves severity WITHOUT moving the verdict, and a
   * verdict-only record would make those caps invisible.
   */
  verdict_before_cap: Verdict | null;
  severity_before_cap: Severity | null;
  capped: boolean;
}

const oneOf = <T extends string>(allowed: readonly T[], v: unknown): T | null =>
  (allowed as readonly string[]).includes(String(v)) ? (String(v) as T) : null;

/**
 * ⚠️ COERCION, NARROWLY. Measured on IP-1286: 5 of 15 A1 findings — a third of the divergence pass
 * — were discarded whole because ONE enum value was off. Throwing away a well-formed clinical
 * finding over a spelling is a worse error than the spelling, so a value that names exactly one
 * legal option is repaired. A value that names none, or more than one, is still dropped: the
 * alternative is deciding on the model's behalf what it meant, which manufactures a finding.
 *
 * Matching is deliberately dumb and total: exact, then case-insensitive, then singular/plural and
 * prefix. No fuzzy distance — "commission" and "omission" are one edit apart and mean opposite
 * things, and an edit-distance matcher would confidently swap them.
 */
function coerceEnum<T extends string>(allowed: readonly T[], v: unknown): { value: T | null; repaired: boolean } {
  const exact = oneOf(allowed, v);
  if (exact) return { value: exact, repaired: false };
  const raw = String(v ?? '').trim().toLowerCase();
  if (!raw) return { value: null, repaired: false };
  const hits = allowed.filter((a) => {
    const t = a.toLowerCase();
    if (t === raw) return true;
    // singular/plural and prefix, both directions: 'diagnostic' ↔ 'diagnostics', 'escalate' → 'escalation'
    if (t.startsWith(raw) && raw.length >= 4) return true;
    if (raw.startsWith(t) && t.length >= 4) return true;
    return false;
  });
  // exactly one legal option, or nothing — ambiguity is never resolved by guessing
  return hits.length === 1 ? { value: hits[0], repaired: true } : { value: null, repaired: false };
}

/**
 * ⚠️ `concordant` IS A VERDICT, NOT A FINDING TYPE, and confusing the two cost IP-1286 five real
 * findings — diet tolerated, vitals stable, dressing dry, glucose monitored, ambulating. Every one
 * was a correct observation that the course MET its expectation, and every one was discarded
 * because `concordant` is not in FINDING_TYPES.
 *
 * AN AUDIT THAT CANNOT RECORD WHAT WENT RIGHT IS NOT AN AUDIT. It is a defect list, and a defect
 * list read as an audit makes a well-run admission indistinguishable from an unexamined one. The
 * prompt now states the distinction outright; this repairs the responses that get it wrong anyway.
 *
 * The type is inferred from the statement, defaulting to `omission` as instructed. The inference
 * is deliberately low-stakes: a concordant finding is excluded from the four type counters
 * anyway (see countFindings), so this label decides presentation, not arithmetic.
 */
export function impliedFindingType(statement: string): FindingType {
  const t = (statement || '').toLowerCase();
  if (/\b(late|delay|delayed|overdue|promptly|on time|within \d|hours? after|days? after)\b/.test(t)) return 'timing';
  if (/\b(sequence|sequenced|order of|out of order|before starting|prior to)\b/.test(t)) return 'sequencing';
  if (/\b(given|administered|performed|started|ordered|prescribed|carried out|documented|monitored|tolerated|ambulat)\w*\b/.test(t)) return 'commission';
  return 'omission';
}

/** An unreadable severity becomes `moderate`: the middle of the scale, so a repair can neither
 *  inflate a finding to the 8-point band nor bury it in the 1-point one. */
const SEVERITY_FALLBACK: Severity = 'moderate';

/** An unreadable verdict becomes `unassessable`, NEVER a scoring one. A verdict IS the claim, and
 *  the honest reading of "we could not parse the claim" is that the record did not answer —
 *  which scores nothing. Coercing to `divergent` would manufacture a penalty out of a typo. */
const VERDICT_FALLBACK: Verdict = 'unassessable';

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

/** What was discarded and why. Persisted (`raw_judge_error`) and traced — see run.ts. */
export interface ParseFailure {
  /** The offending fragment, truncated. Enough to see what the model actually sent. */
  fragment: string;
  error: string;
}

export interface ParseFindingsResult {
  findings: EpisodeFinding[];
  /** Findings discarded outright, after the repair pass had its chance. */
  unparseable: number;
  /** Findings kept only because a coercion repaired them. */
  repaired: number;
  failures: ParseFailure[];
}

export const PARSE_FRAGMENT_CHARS = 1000;

/** One discarded fragment, capped. JSON so an object survives readably; never the whole response. */
function fragmentOf(raw: unknown): string {
  try {
    return (typeof raw === 'string' ? raw : JSON.stringify(raw) ?? '').slice(0, PARSE_FRAGMENT_CHARS);
  } catch {
    return String(raw).slice(0, PARSE_FRAGMENT_CHARS);
  }
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
export function parseFindings(text: string, opts: ParseFindingsOptions): ParseFindingsResult {
  const o = extractJsonObject(text);
  const list = Array.isArray((objOf(o)).findings) ? (objOf(o).findings as unknown[]) : null;
  if (!list) {
    return {
      findings: [], unparseable: 0, repaired: 0,
      failures: text.trim() ? [{ fragment: fragmentOf(text), error: 'the response carried no findings array' }] : [],
    };
  }

  const findings: EpisodeFinding[] = [];
  const failures: ParseFailure[] = [];
  let unparseable = 0;
  let repaired = 0;
  list.slice(0, 120).forEach((raw, i) => {
    const f = objOf(raw);
    const statement = asText(f.statement);

    // A statement is the finding. There is nothing to repair a missing one into.
    if (!statement) {
      unparseable++;
      failures.push({ fragment: fragmentOf(raw), error: 'no statement — a finding without one is not a finding' });
      return;
    }

    // A finding_type naming a VERDICT is a category slip, not an unreadable value: the model put
    // the right word in the wrong field. Move it to the verdict and infer the type, rather than
    // discarding a finding whose content is fine.
    const rawType = String(f.finding_type ?? '').trim().toLowerCase();
    const typeIsVerdict = (VERDICTS as readonly string[]).includes(rawType);
    const typeRes = typeIsVerdict
      ? { value: impliedFindingType(statement), repaired: true }
      : coerceEnum(FINDING_TYPES, f.finding_type);
    const domainRes = coerceEnum(DOMAINS, f.domain);
    const sevRes = coerceEnum(SEVERITIES, f.severity);
    // when the type carried the verdict, THAT is the verdict — a `concordant` in the type field is
    // the model telling us the course matched, whatever it left in the verdict field
    const verdictRes = typeIsVerdict
      ? { value: rawType as Verdict, repaired: true }
      : coerceEnum(VERDICTS, f.verdict);

    // severity and verdict have safe fallbacks (see the consts): an unreadable severity lands
    // mid-scale, an unreadable verdict lands on `unassessable`, which scores nothing.
    const severity: Severity = sevRes.value ?? SEVERITY_FALLBACK;
    const verdict: Verdict = verdictRes.value ?? VERDICT_FALLBACK;
    const severityFallback = sevRes.value == null;
    const verdictFallback = verdictRes.value == null;

    // finding_type and domain have NO safe fallback — both change what the finding is about, and
    // domain decides whether A2's fence caught it. Ambiguous or absent ⇒ drop.
    if (!typeRes.value || !domainRes.value) {
      unparseable++;
      failures.push({
        fragment: fragmentOf(raw),
        error: !typeRes.value
          ? `finding_type ${JSON.stringify(f.finding_type)} matches no legal value unambiguously`
          : `domain ${JSON.stringify(f.domain)} matches no legal value unambiguously`,
      });
      return;
    }
    const finding_type = typeRes.value;
    const domain = domainRes.value;

    if (typeRes.repaired || domainRes.repaired || sevRes.repaired || verdictRes.repaired
        || severityFallback || verdictFallback) {
      repaired++;
    }

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
      // filled by classifyCitationProvenance once the chunk→source map is known (run.ts)
      citation_provenance: null,
      verdict_before_cap: verdict,
      severity_before_cap: severity,
      capped: false,
    });
  });
  return { findings, unparseable, repaired, failures };
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
 * §4.4, the uncited cap. ONE RULE, and this is it:
 *
 *   A DIVERGENCE finding is capped to severity `minor` and verdict `context_dependent` unless
 *   BOTH the finding itself AND the checkpoint entry it is measured against carry a citation.
 *   SEVERITY IS NOT AN EXEMPTION. A `major` finding is capped on exactly the same terms as a
 *   `minor` one.
 *
 * ⚠️ WHAT WAS INCONSISTENT, AND WHY IT WAS NOT ABOUT SEVERITY. On IP-1286 ten uncited findings
 * were capped and one — the major VTE-prophylaxis finding, with zero citations of its own — was
 * not, and it supplied 8 of the run's 12 penalty points. The cap read the ENTRY's `citation_ids`
 * while `citation_provenance` and the literature cap read the FINDING's, so a finding that cited
 * nothing could still count as grounded because the expectation behind it happened to be cited.
 * Two notions of "grounded" in one pipeline is how the loudest finding in a run ended up the least
 * evidenced. There is now one notion, and it requires both halves.
 *
 * NO SEVERITY EXEMPTION, deliberately. Exempting `major` would mean the findings that move the
 * score most are the ones held to the weakest evidential standard — precisely backwards, and it
 * would have preserved the exact defect being fixed. A major finding that genuinely stands on
 * evidence keeps its weight by citing it.
 *
 * Still not applied to fidelity findings: §4.4 says so outright, and the reason holds — A2 is shown
 * no excerpts at all, so an expectation's citations say nothing about it and capping every A2
 * finding would silently zero the fidelity pass.
 */
export function applyUncitedCap(f: EpisodeFinding, entryRefs: Map<string, CheckpointEntryRef>): { finding: EpisodeFinding; capped: boolean } {
  if (f.pass !== 'divergence') return { finding: f, capped: false };
  const entry = f.checkpoint_ref ? entryRefs.get(f.checkpoint_ref) : undefined;
  const entryGrounded = !!entry && entry.citation_ids.length > 0;
  const findingGrounded = f.citation_ids.length > 0;
  if (entryGrounded && findingGrounded) return { finding: f, capped: false };
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

    // ⚠️ A CONCORDANT FINDING IS NOT A COMMISSION. §3.5 fixes finding_type for this pass because
    // every A2 finding is a claim the record does not support — but a `concordant` A2 finding says
    // the opposite: the summary's claim IS supported, and it was worth recording that. Forcing it
    // to `commission` asserted an unsupported claim that the same row denies, and inflated
    // n_commission with confirmations. Its checkpoint_ref is still normalised — A2 has no
    // checkpoints either way.
    const wantsCommission = f.verdict !== 'concordant';
    const typeWrong = wantsCommission && f.finding_type !== 'commission';
    if (typeWrong || f.checkpoint_ref !== null) {
      normalized++;
      kept.push({ ...f, finding_type: wantsCommission ? 'commission' : f.finding_type, checkpoint_ref: null });
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

/**
 * Classify a finding's citations by the KIND of source they stand on, and cap what literature
 * alone may claim.
 *
 * ⚠️ WHY THIS EXISTS AT ALL. V widened retrieval on 2026-09-02: this engine may now cite anything
 * the corpus returns, not only the normative allowlist. That is a real gain — most of what a
 * physician would call the standard of care for a given admission is not in Choosing Wisely — but
 * it changes what a citation MEANS. A guideline says "this is what should be done". A StatPearls
 * chapter or a journal passage says "this is what is known", which is evidence for an expectation
 * and not the same thing as a standard against which a clinician can be found to have diverged.
 *
 * So the difference is recorded per finding, and priced: a finding standing ONLY on literature may
 * still be `divergent` — the record can genuinely show the course left the expected one — but it
 * cannot be `major`, because major asserts plausible serious harm against a standard, and
 * literature is not one. A single normative citation lifts the cap; that is what `mixed` is for.
 */
export function classifyCitationProvenance(
  citationIds: readonly number[], sourceById: Map<number, string>, normativeSources: readonly string[],
): CitationProvenance | null {
  if (!citationIds.length) return null;
  const normative = new Set(normativeSources.map((x) => x.trim()).filter(Boolean));
  let n = 0;
  let lit = 0;
  for (const id of citationIds) {
    const src = (sourceById.get(id) ?? '').trim();
    // An id whose source we never recorded counts as literature: the conservative reading, since
    // treating an unknown source as normative would lift a cap on no evidence at all.
    if (src && normative.has(src)) n++; else lit++;
  }
  if (n > 0 && lit > 0) return 'mixed';
  return n > 0 ? 'normative' : 'literature';
}

/** The literature cap: `major` becomes `moderate` when nothing normative backs the finding.
 *  Verdict is untouched — this bounds how loudly a finding may speak, not whether it may. */
export function applyLiteratureCap(f: EpisodeFinding): { finding: EpisodeFinding; capped: boolean } {
  if (f.citation_provenance !== 'literature') return { finding: f, capped: false };
  if (f.severity !== 'major') return { finding: f, capped: false };
  return { finding: { ...f, severity: 'moderate' }, capped: true };
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
  /** EVERY discarded finding: A2 domain drops PLUS parse failures. No discard leaves it at 0. */
  n_dropped_invalid: number;
  /** The parse-failure half of the above, kept separately so the two causes stay distinguishable. */
  n_parse_failed: number;
}

/**
 * `domainDropped` is the A2 domain-drop count; `parseFailed` is the number of findings the parser
 * discarded after its repair pass. BOTH land in `n_dropped_invalid` (item 5: no discard may leave
 * every counter at 0), and `n_parse_failed` keeps the second cause separately readable.
 *
 * ⚠️ THIS REVERSES round 2's item 7, deliberately and on the orchestrator's instruction. That round
 * separated them so `n_dropped_invalid` would mean only "A2 broke its fence"; IP-1286 then lost 5
 * findings with every counter reading 0, which is the worse failure. Two columns give both
 * readings: the total discard rate, and its breakdown.
 */
export function countFindings(findings: EpisodeFinding[], domainDropped: number, parseFailed = 0): FindingCounters {
  const c: FindingCounters = {
    n_findings: findings.length,
    n_divergence_pass: 0, n_fidelity_pass: 0,
    n_omission: 0, n_commission: 0, n_timing: 0, n_sequencing: 0,
    n_divergent: 0, n_context_dependent: 0, n_unassessable: 0, n_concordant: 0,
    n_low_value: 0,
    n_dropped_invalid: domainDropped + parseFailed,
    n_parse_failed: parseFailed,
  };
  for (const f of findings) {
    if (f.pass === 'divergence') c.n_divergence_pass++; else c.n_fidelity_pass++;
    // ⚠️ THE TYPE COUNTERS EXCLUDE `concordant` FINDINGS (item 6). A concordant finding records
    // that expectation and course AGREE — it is not an omission, a commission, a timing error or a
    // sequencing error, and counting it as one inflated n_commission with confirmations. So
    // n_omission + n_commission + n_timing + n_sequencing = n_findings − n_concordant, by design.
    if (f.verdict !== 'concordant') {
      if (f.finding_type === 'omission') c.n_omission++;
      else if (f.finding_type === 'commission') c.n_commission++;
      else if (f.finding_type === 'timing') c.n_timing++;
      else c.n_sequencing++;
    }
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
  /** Findings whose severity was cut from major because only literature backed them. */
  n_literature_capped: number;
  /** Ids of findings that ANY cap touched — the input to `scoringStatusFor`, and the source of
   *  `capped_count` on the audit row. */
  capped_finding_ids: Set<string>;
  /** How the surviving findings' citations break down — the measurement V asked for. */
  provenance_counts: Record<string, number>;
}

/** `parseFailed` is the count of findings the parser discarded; it joins the A2 domain drops in
 *  `n_dropped_invalid` and is also reported alone in `n_parse_failed`. */
export function finalizeFindings(
  raw: EpisodeFinding[], entryRefs: Map<string, CheckpointEntryRef>, events: EpisodeEvent[],
  parseFailed = 0,
  sourceById: Map<number, string> = new Map(),
  normativeSources: readonly string[] = [],
): FinalizeResult {
  const { kept, dropped, normalized } = normalizeFidelityFindings(raw);
  let rewritten = 0;
  let capped = 0;
  let litCapped = 0;
  const capped_finding_ids = new Set<string>();
  const provenance_counts: Record<string, number> = { normative: 0, literature: 0, mixed: 0, none: 0 };
  const findings = kept.map((f0) => {
    // Cap BEFORE the Tier C rewrite: the cap can move a divergent finding to context_dependent,
    // at which point the Tier C rule no longer applies to it — which is correct, since the rule
    // exists to stop an unsupported DIVERGENT claim, and a capped finding no longer makes one.
    const capRes = applyUncitedCap(f0, entryRefs);
    if (capRes.capped) { capped++; capped_finding_ids.add(f0.finding_id); }
    // Provenance is classified BEFORE the literature cap, because the cap reads it.
    const provenance = classifyCitationProvenance(capRes.finding.citation_ids, sourceById, normativeSources);
    const withProv: EpisodeFinding = { ...capRes.finding, citation_provenance: provenance };
    provenance_counts[provenance ?? 'none']++;

    const litRes = applyLiteratureCap(withProv);
    if (litRes.capped) { litCapped++; capped_finding_ids.add(withProv.finding_id); }

    const tierRes = applyTierCRule(litRes.finding);
    if (tierRes.rewritten) rewritten++;

    // Stamp the audit trail from what the MODEL said, before any of the three rules ran, so the
    // caps can be recounted from the stored row rather than trusted from a log line.
    const stamped: EpisodeFinding = {
      ...tierRes.finding,
      verdict_before_cap: f0.verdict,
      severity_before_cap: f0.severity,
      capped: capRes.capped || litRes.capped,
    };
    return attachAttribution(stamped, events);
  });
  return {
    findings,
    counters: countFindings(findings, dropped, parseFailed),
    divergence_index: divergenceIndex(findings),
    n_tier_c_rewritten: rewritten,
    n_uncited_capped: capped,
    n_fidelity_normalized: normalized,
    n_literature_capped: litCapped,
    capped_finding_ids,
    provenance_counts,
  };
}

// ── scoring status (item 5) ──────────────────────────────────────────────────────────────────

export const SCORING_STATUSES = ['ok', 'no_expectations', 'all_capped'] as const;
export type ScoringStatus = (typeof SCORING_STATUSES)[number];

/**
 * ⚠️ THE MOST DANGEROUS OUTPUT THIS ENGINE CAN PRODUCE IS A CONFIDENT 100.
 *
 * `divergence_index` starts at 100 and subtracts penalties. That arithmetic cannot distinguish
 * "this admission ran exactly as expected" from "no expectation was ever formed, so nothing could
 * be found to diverge from" — and IP-1286 produced the second while looking like the first. An
 * episode with real omissions displaying a perfect score is worse than an episode displaying
 * nothing, because a number invites a clinician to trust it.
 *
 *   no_expectations — no checkpoint produced a single entry. There was no standard to measure
 *                     against, so there is no score. `divergence_index` is stored NULL and the UI
 *                     says "not scorable" rather than rendering a number.
 *   all_capped      — findings exist, and EVERY one of them was capped (uncited expectation, or
 *                     literature-only evidence). The arithmetic still yields a high number, but
 *                     nothing in it survived at full weight, so the number means less than it
 *                     looks. Recorded so the UI can say so.
 *   ok              — a real score.
 */
export function scoringStatusFor(a: {
  totalExpectedEntries: number;
  findings: readonly EpisodeFinding[];
  cappedFindingIds: ReadonlySet<string>;
}): ScoringStatus {
  if (a.totalExpectedEntries === 0) return 'no_expectations';
  if (a.findings.length > 0 && a.findings.every((f) => a.cappedFindingIds.has(f.finding_id))) return 'all_capped';
  return 'ok';
}

/** The score to STORE. Null under `no_expectations` — an absent standard yields no number, and a
 *  null is the only honest way to say that in an integer column. */
export function storedDivergenceIndex(index: number, status: ScoringStatus): number | null {
  return status === 'no_expectations' ? null : index;
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
