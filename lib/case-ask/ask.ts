/**
 * lib/case-ask/ask.ts — the IMPURE half of the shared case Ask shell
 * (CDMSS-CASE-AGENTS-SPINE-PRD-v1.0-27-AUG-2026, P1 / §3): the case MATERIAL assembled from the
 * audit row's STORED artefacts, and ONE Opus-4.6-on-Bedrock call whose answer is checked by code
 * (caseAskVerdict) before anything is returned. Called by the two admin ask routes; never from a
 * page render.
 *
 * ⚠️ Not named in the PRD §7 P1 file list, which names `lib/case-ask/store.ts` and the routes. It
 * exists for the reason lib/readmission/ask.ts exists on the readmission side: a route should not
 * hold a model call, a trace, a cost reconciliation and a citation verdict. Everything here sits
 * inside the `lib/case-ask/` family the contract created, and it imports no readmission file (O3).
 *
 * THE FENCE (§3.1 / §3.3): no re-audit, no regeneration, no db13 / Metabase / PDF read. The material
 * is built from columns the audit already wrote, so it is de-identified by construction — this file
 * never reads a name, a UHID, an encounter id, a document id or an individual_uid, and never passes
 * one to the model.
 *
 * THIS FILE WRITES NOTHING. The turns are stored by the route through lib/case-ask/store.ts, and
 * there is no score, verdict or feedback write anywhere on this path (§3.3).
 */
import { startTrace, finishTrace, tracedChat } from '../trace';
import { modelsAgree, TEXT_MODEL } from '../llm';
import { servedCallForAudit, usageForTrace } from '../backfill-runs';
import { PRICING } from '../llm-cost';
import { costUsd } from '../llm-cost-core';
import type { AuditFinding, AuditReport } from '../doc-audit-core';
import {
  buildCaseAskPrompt, caseAskVerdict, parseAskReply,
  CASE_ASK_BUDGET_MS, CASE_ASK_MAX_TOKENS, CASE_ASK_MAX_TRIES, CASE_ASK_MODEL_ID, CASE_ASK_PROVIDER,
  CASE_ASK_TEMPERATURE,
  type CaseAskItem, type CaseAskMaterial, type CaseAskTurn, type CaseAskVerdict,
} from '../case-ask-core';

export const CASE_ASK_STAGE = 'case_ask';

/** Trim a stored string for the prompt without letting one rationale become the whole material. */
const clip = (v: unknown, n = 600): string => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// ── OPD material (§3.1 — the note audit's stored findings and its already-scored numbers) ──

/** The columns of `opd_note_audits` this shell reads. Deliberately NOT the whole row: `uid` and
 *  `doctor_uid` identify a patient and a clinician and are never assembled into model material. */
export interface OpdAuditMaterialRow {
  engine_version?: unknown;
  note_quality_index?: unknown;
  band?: unknown;
  displayed_band?: unknown;
  completeness_pct?: unknown;
  n_missing_mandatory?: unknown;
  score_documentation?: unknown;
  score_note_quality?: unknown;
  score_appropriateness?: unknown;
  score_prescribing_safety?: unknown;
  score_patient_centred?: unknown;
  excluded_reason?: unknown;
  findings?: unknown;
  suggestions?: unknown;
}

/** One stored OPD finding, as the audit wrote it. */
interface OpdFinding {
  subject?: unknown; verdict?: unknown; domain?: unknown; rationale?: unknown;
  signal_type?: unknown; informational?: unknown; quieted_by?: unknown; finding_ref?: unknown;
}

function parseJson<T>(v: unknown, fallback: T): T {
  if (v == null) return fallback;
  if (typeof v !== 'string') return (v as T) ?? fallback;
  try { return JSON.parse(v) as T; } catch { return fallback; }
}

/**
 * PURE — the OPD case's material. Findings become F1…Fn in stored order; the already-scored numbers
 * become C1…Cn. A note the engine marked not-assessed says exactly that and carries no score item:
 * S0 D5's rule (a marked row's stored values are never presented as a score) has to hold in the chat
 * box as well as on the page, or the box becomes the way around it.
 */
export function opdAskMaterial(row: OpdAuditMaterialRow, engineVersion: string): CaseAskMaterial {
  const findings = parseJson<OpdFinding[]>(row.findings, []) ?? [];
  const suggestions = parseJson<Array<{ priority?: unknown; text?: unknown }>>(row.suggestions, []) ?? [];
  const notAssessed = String(row.excluded_reason ?? '') === 'llm_leg_failed';
  const items: CaseAskItem[] = [];

  findings.forEach((f, i) => {
    const bits = [
      f.verdict ? `verdict ${clip(f.verdict, 40)}` : '',
      f.domain ? `domain ${clip(f.domain, 40)}` : '',
      f.informational === true ? 'informational — it does not move the score' : '',
      f.quieted_by ? 'quieted — shown but not counted' : '',
    ].filter(Boolean).join(' · ');
    items.push({
      id: `F${i + 1}`,
      kind: 'finding',
      label: clip(f.subject, 160) || `finding ${i + 1}`,
      text: [bits, clip(f.rationale)].filter(Boolean).join('. '),
    });
  });

  let c = 0;
  const addScore = (label: string, text: string) => { if (text) items.push({ id: `C${++c}`, kind: 'score', label, text }); };
  if (notAssessed) {
    addScore('Note quality index', 'not assessed — the judged leg of this audit failed, so this note carries no score');
  } else {
    const band = String(row.displayed_band ?? '') || String(row.band ?? '');
    addScore('Note quality index', row.note_quality_index == null ? '' : `${Number(row.note_quality_index)}${band ? ` · band ${band}` : ''}`);
    addScore('Documentation', row.score_documentation == null ? '' : String(Number(row.score_documentation)));
    addScore('Note quality', row.score_note_quality == null ? '' : String(Number(row.score_note_quality)));
    addScore('Appropriateness', row.score_appropriateness == null ? '' : String(Number(row.score_appropriateness)));
    addScore('Prescribing safety', row.score_prescribing_safety == null ? '' : String(Number(row.score_prescribing_safety)));
    addScore('Patient-centred', row.score_patient_centred == null ? '' : String(Number(row.score_patient_centred)));
  }
  addScore('Documentation completeness', row.completeness_pct == null ? '' : `${Number(row.completeness_pct)}%`);

  suggestions
    .slice()
    .sort((a, b) => Number(a.priority ?? 99) - Number(b.priority ?? 99))
    .forEach((sg, i) => {
      const text = clip(sg.text, 300);
      if (text) items.push({ id: `S${i + 1}`, kind: 'suggestion the audit wrote', label: `suggestion ${i + 1}`, text });
    });

  const gaps: string[] = [];
  const missing = Number(row.n_missing_mandatory ?? 0);
  if (Number.isFinite(missing) && missing > 0) gaps.push(`${missing} mandatory documentation field(s) missing from the note`);
  if (!findings.length) gaps.push('no findings were written for this note — that is an absence of findings, not a clean note');

  return { caseType: 'opd', engineVersion, items, gaps };
}

// ── IPD material (§3.1 — the discharge-summary audit's findings and its scored CVI) ────────

/** The columns of `ipd_discharge_audits` this shell reads. `ip_uid` and `document_id` identify a
 *  stay and a file; neither is assembled into model material. */
export interface IpdAuditMaterialRow {
  engine_version?: unknown;
  care_value_index?: unknown;
  band?: unknown;
  completeness_pct?: unknown;
  findings?: unknown;
}

/**
 * PURE — the IPD case's material. Same shape as the OPD one; the numbers differ (CVI + band +
 * completeness rather than NQI + the five domain scores) and the gaps come from the report's
 * `completeness.missingMandatory`, which is the audit's own honest list of what the summary omitted.
 */
export function ipdAskMaterial(row: IpdAuditMaterialRow, report: AuditReport | null, engineVersion: string): CaseAskMaterial {
  const findings: AuditFinding[] = (report?.findings ?? parseJson<AuditFinding[]>(row.findings, []) ?? []) as AuditFinding[];
  const items: CaseAskItem[] = [];

  findings.forEach((f, i) => {
    items.push({
      id: `F${i + 1}`,
      kind: 'finding',
      label: clip(f?.subject, 160) || `finding ${i + 1}`,
      text: [f?.verdict ? `verdict ${clip(f.verdict, 40)}` : '', f?.domain ? `domain ${clip(f.domain, 40)}` : '', clip(f?.rationale)].filter(Boolean).join('. '),
    });
  });

  let c = 0;
  const addScore = (label: string, text: string) => { if (text) items.push({ id: `C${++c}`, kind: 'score', label, text }); };
  addScore(
    'Care-Value Index',
    row.care_value_index == null ? '' : `${Number(row.care_value_index)}${row.band ? ` · band ${clip(row.band, 20)}` : ''} — a single-run estimate carrying about one band of noise`,
  );
  addScore('Documentation completeness', row.completeness_pct == null ? '' : `${Number(row.completeness_pct)}%`);

  (report?.suggestions ?? []).slice().sort((a, b) => Number(a?.priority ?? 99) - Number(b?.priority ?? 99)).forEach((sg, i) => {
    const text = clip(sg?.text, 300);
    if (text) items.push({ id: `S${i + 1}`, kind: 'suggestion the audit wrote', label: `suggestion ${i + 1}`, text });
  });

  const gaps: string[] = [];
  for (const m of report?.completeness?.missingMandatory ?? []) {
    const t = clip(m, 120);
    if (t) gaps.push(`the discharge summary does not document ${t}`);
  }
  if (!findings.length) gaps.push('no findings were written for this stay — that is an absence of findings, not a clean stay');
  // §5 / D13 — P1 reads the discharge summary and nothing else. Saying so is what stops the model
  // from reading "no operative finding" as "no operation": the OT note is simply not here yet.
  gaps.push('this audit read the discharge summary only — operative, pre-anaesthetic and progress notes were not available to it');

  return { caseType: 'ipd', engineVersion, items, gaps };
}

// ── the one model call ─────────────────────────────────────────────────────────────────────

export interface CaseAskAnswer {
  outcome: 'answered' | 'withheld';
  verdict: CaseAskVerdict | null;
  reason?: string;
  answerable?: boolean;
  cost: { tokensIn: number; tokensOut: number; usd: number; model: string; provider: string } | null;
  traceId: string;
  latencyMs: number;
  /** Test / dry-run seam: the prompt as sent. */
  prompt?: { system: string; user: string };
}

/**
 * ONE question → ONE Opus call → CODE DECIDES. Never throws: a model fault is a withheld answer, so
 * the auditor sees the honest copy and his question is still on the thread. `call` is a test seam
 * (production never passes it).
 *
 * The Bedrock target is pinned and there is no ladder beneath it (F11): if Opus is unserved the
 * answer is withheld, never quietly served by another model. The DEC-2 check below turns that from a
 * claim into a verified fact per call — the trace's SERVED model must agree with the pin, or the
 * answer is withheld even though the model replied.
 */
export async function answerCaseAsk(a: {
  caseKey: string;
  material: CaseAskMaterial;
  history: readonly CaseAskTurn[];
  question: string;
  call?: (prompt: { system: string; user: string }) => Promise<string>;
}): Promise<CaseAskAnswer> {
  const t0 = Date.now();
  const knownIds = a.material.items.map((i) => i.id);
  const prompt = buildCaseAskPrompt(a.material, a.history, a.question);
  const traceId = a.call
    ? 'test-trace'
    : await startTrace(CASE_ASK_STAGE, { caseType: a.material.caseType, caseKey: a.caseKey, model: `bedrock:${CASE_ASK_MODEL_ID}`, turns: a.history.length });
  let text = '';
  try {
    if (a.call) text = await a.call(prompt);
    else {
      const res = await tracedChat(traceId, CASE_ASK_STAGE, {
        model: TEXT_MODEL,   // nominal — the bedrock target outranks it and has no ladder
        messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
        temperature: CASE_ASK_TEMPERATURE,
        max_tokens: CASE_ASK_MAX_TOKENS,
      }, { bedrock: CASE_ASK_MODEL_ID, timeoutMs: CASE_ASK_BUDGET_MS, maxTries: CASE_ASK_MAX_TRIES });
      text = String(res?.choices?.[0]?.message?.content ?? '');
    }
  } catch (e) {
    if (!a.call) await finishTrace(traceId, 'error', String((e as Error).message).slice(0, 300)).catch(() => {});
    return { outcome: 'withheld', verdict: null, reason: 'model_unavailable', cost: null, traceId, latencyMs: Date.now() - t0, ...(a.call ? { prompt } : {}) };
  }

  let cost: CaseAskAnswer['cost'] = null;
  if (!a.call) {
    const served = await servedCallForAudit(traceId, CASE_ASK_STAGE);
    if (served.model && !modelsAgree(served.model, CASE_ASK_MODEL_ID)) {
      await finishTrace(traceId, 'error', 'DEC-2 model disagreement').catch(() => {});
      return { outcome: 'withheld', verdict: null, reason: 'model_disagreement', cost: null, traceId, latencyMs: Date.now() - t0 };
    }
    const usage = await usageForTrace(traceId, CASE_ASK_STAGE);
    cost = {
      tokensIn: usage.tokensIn, tokensOut: usage.tokensOut,
      usd: Number(costUsd(served.model ?? CASE_ASK_MODEL_ID, usage.tokensIn, usage.tokensOut, false, PRICING).toFixed(4)),
      model: served.model ?? CASE_ASK_MODEL_ID, provider: served.provider ?? CASE_ASK_PROVIDER,
    };
  }

  const parsed = parseAskReply(text);
  const verdict = caseAskVerdict(parsed, knownIds);
  if (!a.call) await finishTrace(traceId, verdict.ok ? 'success' : 'partial', verdict.ok ? undefined : `answer withheld: ${verdict.reason}`).catch(() => {});
  if (!verdict.ok) return { outcome: 'withheld', verdict, reason: verdict.reason ?? 'unresolved', cost, traceId, latencyMs: Date.now() - t0, ...(a.call ? { prompt } : {}) };
  return { outcome: 'answered', verdict, answerable: parsed?.answerable !== false, cost, traceId, latencyMs: Date.now() - t0, ...(a.call ? { prompt } : {}) };
}
