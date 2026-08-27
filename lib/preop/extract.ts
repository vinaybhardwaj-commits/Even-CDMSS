/**
 * lib/preop/extract.ts — the extraction rail's IMPURE half (Build Plan B5): pick the
 * text, make ONE model call, read back what actually served, hand the result to the pure
 * gates in lib/preop-extract-core.ts. Every decision about what the model is allowed to
 * have said lives there; this file fetches, calls and labels.
 *
 * PROVIDER POSTURE — the ClinicalState B2 rail's, as the kickoff requires: governedChat
 * with the Gemini surface model and its Vertex→OpenRouter ladder. With ONE deliberate
 * tightening: `noLocalFallback`. A cloud failure THROWS rather than quietly running the
 * local mini, because a silent downgrade here would not produce a worse sentence — it
 * would produce a clinical INPUT, proposed by a model nobody chose, feeding an instrument.
 * A failed extraction costs coverage; a misattributed one costs trust.
 *
 * THE MODEL LABEL IS DERIVED, NEVER TYPED (house rule; two silent incidents prove it).
 * What we asked for is not written anywhere on the record: `servedCallForAudit` reads the
 * model and provider back off this call's own trace events, and a null read is stored as
 * a null label rather than backfilled with the intention.
 *
 * COST SHAPE: one call per episode whose SOURCE TEXT has changed. A steady-state sweep
 * over a board that has stopped moving makes ZERO calls — that is gate 4 in the core, and
 * it is the reason this rail can run on an hourly cron without burning money or churning
 * the versions rail.
 */

import { governedChat, startTrace, finishTrace } from '../trace';
import { servedCallForAudit } from '../backfill-runs';
import { geminiModelFor, geminiUtilityModel, TEXT_MODEL } from '../llm';
import {
  buildExtraction, buildExtractPrompt, extractionSourceFingerprint, hasExtractableText,
  parseExtractOutput, reconcileExtraction, verifyExtraction,
  EXTRACT_SOURCE_FIELDS,
  type PreopExtraction, type ReconcileResult,
} from '../preop-extract-core';
import type { ParsedPac } from '../preop-pac-map-core';

export const PREOP_EXTRACT_STAGE = 'preop_extract';
/** One try, and a ceiling well inside the worker's box (D-1 posture: the caller owns it). */
export const PREOP_EXTRACT_BUDGET_MS = 60_000;
export const PREOP_EXTRACT_MAX_TRIES = 1;

/** PREOP_EXTRACT_ENABLED (PRD §7). Ships OFF. */
export function preopExtractEnabled(): boolean {
  return process.env.PREOP_EXTRACT_ENABLED === '1';
}

/** The Gemini surface for this rail — the ClinicalState chain, with our own key first. */
export function preopExtractModel(): string | undefined {
  return geminiModelFor('preop_extract') ?? geminiModelFor('ccb') ?? geminiUtilityModel();
}

// ── the text ────────────────────────────────────────────────────────────────────

/**
 * The verbatim fields the deterministic map deliberately refuses to read. `parsedPac`
 * carries them already — lib/preop-pac-map-core.ts maps them as `verbatim` and wires them
 * to NO instrument, which is exactly the boundary this rail sits on the other side of.
 *
 * `opdNarrative` is the ClinicalState-held consult text where an episode has one; absent
 * for most of this cohort, and its absence is coverage, not an error.
 */
export function preopExtractFields(parsedPac: ParsedPac | null, opdNarrative: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of EXTRACT_SOURCE_FIELDS) {
    if (f.id === 'opd_narrative') continue;
    const v = parsedPac?.fields?.[f.id]?.text;
    if (typeof v === 'string' && v.trim()) out[f.id] = v.trim();
  }
  if (opdNarrative && opdNarrative.trim()) out.opd_narrative = opdNarrative.trim();
  return out;
}

// ── the call ────────────────────────────────────────────────────────────────────

export type ExtractCall = (prompt: { system: string; user: string }) => Promise<string>;

async function geminiCall(traceId: string, prompt: { system: string; user: string }): Promise<string> {
  const r = await governedChat(traceId, PREOP_EXTRACT_STAGE, {
    model: TEXT_MODEL,                 // nominal — the gemini target below outranks it
    messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
    temperature: 0,                    // the anti-flap rail wants the least creative setting there is
    max_tokens: 1600,
  }, {
    gemini: preopExtractModel(),
    promptRef: 'preop-extract/EXTRACT_SYSTEM',
    timeoutMs: PREOP_EXTRACT_BUDGET_MS,
    maxTries: PREOP_EXTRACT_MAX_TRIES,
    noLocalFallback: true,
  });
  return String(r?.choices?.[0]?.message?.content ?? '');
}

export interface ExtractOneArgs {
  episodeKey: string;
  fields: Record<string, string>;
  /** whatever is already stored for this episode; null on the first pass */
  stored: PreopExtraction | null;
  now: Date;
  /** test seam — production never passes it */
  call?: ExtractCall;
}

export interface ExtractOneResult {
  /** 'reused' means NO MODEL RAN — the stored reading answered for unchanged source text */
  outcome: 'reused' | 'no_text' | 'first' | 'resource_changed' | 'stable' | 'unstable' | 'failed';
  record: PreopExtraction | null;
  /** the record must be written back */
  changed: boolean;
  /** ids whose reading moved on UNCHANGED text (gate 4) */
  moved: string[];
  called: boolean;
  latencyMs: number;
  error?: string;
}

/**
 * One episode's extraction, gates and all.
 *
 * The order is the point. The fingerprint is compared BEFORE anything is called, so the
 * common case — a PAC that landed last week and has not changed since — costs one string
 * comparison and no tokens at all.
 */
export async function extractOne(a: ExtractOneArgs): Promise<ExtractOneResult> {
  const t0 = Date.now();
  const none = { record: a.stored, changed: false, moved: [], called: false };
  if (!hasExtractableText(a.fields)) {
    return { outcome: 'no_text', ...none, latencyMs: 0 };
  }
  const fp = extractionSourceFingerprint(a.fields);
  if (a.stored && a.stored.sourceFingerprint === fp) {
    // GATE 4, the cheap half: unchanged text ⇒ the stored reading IS the reading.
    return { outcome: 'reused', ...none, latencyMs: 0 };
  }

  const prompt = buildExtractPrompt(a.fields);
  const traceId = await startTrace('preop_extract', { episodeKey: a.episodeKey, fields: Object.keys(a.fields) });
  let raw: string;
  try {
    raw = await (a.call ? a.call(prompt) : geminiCall(traceId, prompt));
  } catch (e) {
    await finishTrace(traceId, 'error', String((e as Error).message).slice(0, 300));
    return { outcome: 'failed', ...none, called: true, latencyMs: Date.now() - t0, error: String((e as Error).message).slice(0, 300) };
  }

  let proposals;
  try { proposals = parseExtractOutput(raw); }
  catch (e) {
    await finishTrace(traceId, 'partial', 'unparseable extraction reply');
    return { outcome: 'failed', ...none, called: true, latencyMs: Date.now() - t0, error: `unparseable reply: ${String((e as Error).message).slice(0, 200)}` };
  }

  // What actually served, read back off this call's own trace — never what we asked for.
  const served = a.call ? { model: null, provider: null } : await servedCallForAudit(traceId, PREOP_EXTRACT_STAGE);
  const fresh = buildExtraction({
    fields: a.fields,
    verified: verifyExtraction(proposals, a.fields),
    extractedAt: a.now.toISOString(),
    model: served.model, provider: served.provider, traceId,
  });
  await finishTrace(traceId, 'success');

  const rec: ReconcileResult = reconcileExtraction(a.stored, fresh);
  return {
    outcome: rec.outcome, record: rec.record, changed: rec.changed,
    moved: rec.moved, called: true, latencyMs: Date.now() - t0,
  };
}
