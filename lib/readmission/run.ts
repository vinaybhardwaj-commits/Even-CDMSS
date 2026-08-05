/**
 * lib/readmission/run.ts — orchestrate detect → assemble → Vertex → reconcile →
 * persist for the readmission agent (PRD §5/§5a, decisions 2/4/9/13/14).
 *
 * Vertex posture (§8a): model GEMINI_MODEL (gemini-2.5-pro) in asia-northeast1 via
 * tracedChat — internals untouched, only the surface flag is new. The surface is
 * gated by GEMINI_READMIT_AUDIT=1 AND geminiConfigured(); DELIBERATELY not by
 * GEMINI_ALL, so the ship-off guarantee holds even where GEMINI_ALL is set (flagged
 * in the build report). With the flag off, readmitAuditModel() is undefined and the
 * caller no-ops — the worker never reaches Ollama. Calls run noLocalFallback: a
 * failed ladder throws, the pair stays "not audited", never a local-model verdict.
 *
 * Budget: each Vertex leg carries the audit_ipd class budget from PROVIDER_BUDGETS
 * (200 s × 1 try) — one fact, one place, same as ipdAnalyzeBudget. The worker's
 * box arithmetic is derived from these numbers (see the worker route).
 */

import { GEMINI_MODEL, TEXT_MODEL, geminiConfigured } from '../llm';
import { startTrace, finishTrace, tracedChat } from '../trace';
import { PROVIDER_BUDGETS } from '../lab-provider-core';
import { sql } from '../db';
import { detectReadmissions } from '../readmission-detect-core';
import type { DetectionResult, MappedAdtCols } from '../readmission-detect-core';
import { reconcileFinding } from '../readmission-reconcile-core';
import type { PassClaims, ReadmissionFinding } from '../readmission-reconcile-core';
import {
  buildFullReconPrompt, buildSecondAvoidablePrompt, buildConditionPassPrompt, buildOonPrompt,
  parsePassClaims,
} from '../readmission-prompts';
import { fetchAdtEncounters, fetchFormReadmissions, fetchSummaryRecord, fetchLabsForEncounter } from './db13';
import { assembleInputs, buildSummaryText } from './assemble';
import type { AssembledInputs } from './assemble';
import {
  saveDetection, saveAuditResult, recordAuditError, pairToDetectionRow, oonToDetectionRow,
  READMIT_ENGINE_VERSION,
} from './store';
import type { PendingRow } from './store';

/** The surface gate (§8a). Explicit flag only — never GEMINI_ALL (ship-off guarantee). */
export function readmitAuditModel(): string | undefined {
  if (process.env.GEMINI_READMIT_AUDIT !== '1') return undefined;
  if (!geminiConfigured()) return undefined;
  return GEMINI_MODEL;
}

/** One Vertex leg's budget, read from the table (audit_ipd: 200 s × 1 try). */
export function readmitLegBudget(): { timeoutMs: number; maxTries: number } {
  const b = PROVIDER_BUDGETS.vertex.audit_ipd;
  if (!b) throw new Error('no audit_ipd budget for vertex — cannot size a readmit leg');
  return { timeoutMs: b.perAttemptMs, maxTries: b.maxTries };
}

// ── detection sweep (Stage 1 — ₹0, no model) ────────────────────────────────────

export interface DetectSweepResult {
  detection: Pick<DetectionResult, 'laneCounts' | 'within30' | 'formStats'>;
  encounters: number;
  forms: number;
  /** The FULL resolved ADT column mapping (admission/discharge/department/doctor/
   *  encounter_id/dob/name) — surfaced so the orchestrator validates every field
   *  live; a single-field miss (the excluded:0 defect) can't hide behind counts. */
  mappedCols: MappedAdtCols;
  pairsStored: number;
  oonStored: number;
  storeSkipped: number;
}

/** Fetch ADT + forms, run the pure detector, upsert detection rows. Idempotent. */
export async function runDetectionSweep(): Promise<DetectSweepResult> {
  const [adt, forms] = await Promise.all([fetchAdtEncounters(), fetchFormReadmissions()]);
  const { encounters, mappedCols } = adt;
  const det = detectReadmissions(encounters, forms);
  let pairsStored = 0, oonStored = 0, storeSkipped = 0;
  for (const p of det.pairs) {
    const r = await saveDetection(pairToDetectionRow(p));
    if (r === 'skipped') storeSkipped++; else pairsStored++;
  }
  for (const o of det.oon) {
    const r = await saveDetection(oonToDetectionRow(o));
    if (r === 'skipped') storeSkipped++; else oonStored++;
  }
  return {
    detection: { laneCounts: det.laneCounts, within30: det.within30, formStats: det.formStats },
    encounters: encounters.length, forms: forms.length, mappedCols,
    pairsStored, oonStored, storeSkipped,
  };
}

// ── Stage 2: one finding's audit ────────────────────────────────────────────────

export interface ReadmitAuditResult {
  dedupKey: string;
  status: 'audited' | 'not_auditable' | 'failed' | 'skipped';
  reason?: string;
  promoted?: boolean;
  avoidable?: string | null;
  latencyMs?: number;
  traceId?: string | null;
}

/** T-5 posture: record what actually SERVED, from this audit's own trace — never a
 *  constant. Null when unknown; a failed lookup must not fail the audit. */
async function servedReadmitCall(traceId: string | undefined): Promise<{ model: string | null; provider: string | null }> {
  const none = { model: null, provider: null };
  if (!traceId) return none;
  try {
    const rows = (await (sql as unknown as (q: string, p: unknown[]) => Promise<Array<{ model?: string; provider?: string }>>)(
      `SELECT payload->>'model' AS model, payload->>'provider' AS provider FROM trace_events
        WHERE trace_id = $1 AND kind = 'llm_response' AND stage LIKE 'readmit_%'
        ORDER BY seq DESC LIMIT 1`,
      [traceId],
    ));
    const r = rows?.[0];
    return {
      model: typeof r?.model === 'string' && r.model ? r.model : null,
      provider: typeof r?.provider === 'string' && r.provider ? r.provider : null,
    };
  } catch { return none; }
}

async function vertexPass(
  traceId: string, label: string, model: string,
  prompt: { system: string; user: string },
): Promise<PassClaims | null> {
  const budget = readmitLegBudget();
  // ⚠️ NO response_format here — Vertex rejects it (§8a). JSON is instructed in the
  // prompt; parsePassClaims is tolerant; null = the pair is NOT AUDITED, never guessed.
  const r = await tracedChat(traceId, label, {
    model: TEXT_MODEL,   // nominal local name — never used: gemini set + noLocalFallback
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
    temperature: 0.1,
    max_tokens: 3000,    // tracedChat adds thinking headroom on the Vertex path itself
  }, { gemini: model, timeoutMs: budget.timeoutMs, maxTries: budget.maxTries, noLocalFallback: true });
  const content: string = r?.choices?.[0]?.message?.content ?? '';
  return parsePassClaims(content);
}

interface AssembledPair {
  inputs: AssembledInputs;
  indexAdmitAt: string | null;
  indexDischargeAt: string | null;
}

/** Fetch + de-identify one finding's inputs. Null reason string = not auditable. */
async function assembleForRow(row: PendingRow): Promise<AssembledPair | { notAuditable: string }> {
  const idxSummary = await fetchSummaryRecord(row.index_encounter_id);
  if (!idxSummary) return { notAuditable: 'no index discharge-summary record in KX' };
  const oon = row.finding_class === 'out_of_network';
  const rdSummary = !oon && row.readmit_encounter_id ? await fetchSummaryRecord(row.readmit_encounter_id) : null;
  if (!oon && !rdSummary) return { notAuditable: 'no readmit discharge-summary record in KX' };

  const identity = {
    names: [idxSummary.patientName, rdSummary?.patientName],
    uhids: [row.uhid, idxSummary.uhid, rdSummary?.uhid],
  };
  const indexSummaryText = buildSummaryText(idxSummary, identity);
  if (!indexSummaryText) return { notAuditable: 'index summary record carries no clinical text' };
  const readmitSummaryText = rdSummary ? buildSummaryText(rdSummary, identity) : null;
  if (!oon && !readmitSummaryText) return { notAuditable: 'readmit summary record carries no clinical text' };

  const [indexLabs, readmitLabs] = await Promise.all([
    fetchLabsForEncounter(row.index_encounter_id),
    !oon && row.readmit_encounter_id ? fetchLabsForEncounter(row.readmit_encounter_id) : Promise.resolve([]),
  ]);

  const sameDoctor = !!row.index_doctor && !!row.readmit_doctor
    && row.index_doctor.trim().toLowerCase() === row.readmit_doctor.trim().toLowerCase();
  const structuredFacts = [
    `index stay: department ${row.index_department ?? 'unknown'}, discharged ${row.index_discharge_at ?? 'unknown'}`,
    oon
      ? `readmission reported at ANOTHER hospital around ${row.readmit_admit_at ?? 'unknown'} (patient-reported)`
      : `readmit stay: department ${row.readmit_department ?? 'unknown'}, admitted ${row.readmit_admit_at ?? 'unknown'}, gap ${row.gap_days ?? '?'} days, same treating doctor: ${sameDoctor}`,
  ];

  const indexAdmitAt = idxSummary.admitAt;
  const inputs = assembleInputs({
    indexSummaryText,
    readmitSummaryText,
    indexLabs,
    readmitLabs,
    indexAdmitAt,
    indexDischargeAt: row.index_discharge_at ?? idxSummary.dischargeAt,
    readmitAdmitAt: row.readmit_admit_at,
    cmNote: row.cm_note,
    structuredFacts,
    identity,
  });
  return { inputs, indexAdmitAt, indexDischargeAt: row.index_discharge_at ?? idxSummary.dischargeAt };
}

/**
 * Audit one pending finding. Never throws. Fail-safe: any model/parse failure
 * leaves the row 'detected' (the sweep retries); a structural gap (no summary)
 * writes 'not_auditable' with the reason so it is not swept forever.
 */
export async function runReadmissionAudit(row: PendingRow): Promise<ReadmitAuditResult> {
  const t0 = Date.now();
  const model = readmitAuditModel();
  if (!model) return { dedupKey: row.dedup_key, status: 'skipped', reason: 'GEMINI_READMIT_AUDIT off — Vertex surface disabled, no-op (never Ollama)' };

  try {
    const assembled = await assembleForRow(row);
    if ('notAuditable' in assembled) {
      await saveAuditResult({ dedupKey: row.dedup_key, status: 'not_auditable', notAuditableReason: assembled.notAuditable });
      return { dedupKey: row.dedup_key, status: 'not_auditable', reason: assembled.notAuditable, latencyMs: Date.now() - t0 };
    }
    const { inputs } = assembled;
    const oon = row.finding_class === 'out_of_network';
    const laneD = row.lane === 'other';
    const gapDays = Number(row.gap_days ?? 0);

    const traceId = await startTrace('readmit_audit', {
      dedupKey: row.dedup_key, lane: row.lane, findingClass: row.finding_class, engine: READMIT_ENGINE_VERSION,
    });

    let finding: ReadmissionFinding | null = null;
    let promoted = false;
    try {
      if (oon) {
        // Decision 13: index side only, no avoidable verdict on the other hospital.
        const passA = await vertexPass(traceId, 'readmit_oon', model,
          buildOonPrompt(inputs.catalog, { reportedReadmitDate: row.readmit_admit_at, labProfile: inputs.labProfile }));
        if (!passA) throw new Error('OON pass unparseable or model unavailable');
        finding = reconcileFinding({
          findingClass: 'out_of_network', catalog: inputs.catalog, labProfile: inputs.labProfile,
          indexDischargeAt: assembled.indexDischargeAt, passA, passB: null,
          formFlags: { isPlanned: row.form_is_planned, sameCondition: row.form_same_condition },
        });
      } else {
        let doFull = !laneD;
        if (laneD) {
          // Decision 9: lane D gets the condition pass only…
          const cond = await vertexPass(traceId, 'readmit_condition', model,
            buildConditionPassPrompt(inputs.catalog, { gapDays }));
          if (!cond) throw new Error('condition pass unparseable or model unavailable');
          const condFinding = reconcileFinding({
            findingClass: 'even_even', catalog: inputs.catalog, labProfile: inputs.labProfile,
            indexDischargeAt: assembled.indexDischargeAt, passA: cond, passB: null, conditionOnly: true,
          });
          // …decision 14: SAME condition auto-promotes to the full reconciliation.
          if (condFinding.promoteToFull) { doFull = true; promoted = true; }
          else finding = condFinding;
        }
        if (doFull) {
          const facts = {
            gapDays, lane: row.lane,
            indexDepartment: row.index_department, readmitDepartment: row.readmit_department,
            sameDoctor: !!row.index_doctor && !!row.readmit_doctor
              && row.index_doctor.trim().toLowerCase() === row.readmit_doctor.trim().toLowerCase(),
            labProfile: inputs.labProfile,
          };
          const passA = await vertexPass(traceId, 'readmit_recon_a', model, buildFullReconPrompt(inputs.catalog, facts));
          if (!passA) throw new Error('recon pass A unparseable or model unavailable');
          // The money verdict is produced TWICE, with different prompts (§5 two-pass rule).
          const passB = await vertexPass(traceId, 'readmit_recon_b', model,
            buildSecondAvoidablePrompt(inputs.catalog, { gapDays, labProfile: inputs.labProfile }));
          if (!passB) throw new Error('recon pass B unparseable or model unavailable');
          finding = reconcileFinding({
            findingClass: 'even_even', catalog: inputs.catalog, labProfile: inputs.labProfile,
            indexDischargeAt: assembled.indexDischargeAt, passA, passB,
          });
        }
      }

      if (!finding) throw new Error('no finding assembled');
      const served = await servedReadmitCall(traceId);
      const ok = await saveAuditResult({
        dedupKey: row.dedup_key, status: 'audited', finding,
        model: served.model, provider: served.provider, traceId, promoted,
      });
      await finishTrace(traceId, ok ? 'success' : 'partial');
      if (!ok) {
        await recordAuditError(row.dedup_key, 'audit produced a finding but the store write failed');
        return { dedupKey: row.dedup_key, status: 'failed', reason: 'store write failed', traceId, latencyMs: Date.now() - t0 };
      }
      return {
        dedupKey: row.dedup_key, status: 'audited', promoted,
        avoidable: finding.avoidable?.verdict ?? null, traceId, latencyMs: Date.now() - t0,
      };
    } catch (e) {
      // Transient (model/parse) failure: row stays 'detected' → the sweep IS the retry.
      const msg = String((e as Error).message);
      await recordAuditError(row.dedup_key, msg);
      await finishTrace(traceId, 'error', msg);
      return { dedupKey: row.dedup_key, status: 'failed', reason: msg, traceId, latencyMs: Date.now() - t0 };
    }
  } catch (e) {
    const msg = String((e as Error).message);
    await recordAuditError(row.dedup_key, msg);
    return { dedupKey: row.dedup_key, status: 'failed', reason: msg, latencyMs: Date.now() - t0 };
  }
}
