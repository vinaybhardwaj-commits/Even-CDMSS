/**
 * Paired signed/override OPD audit: lab store only, explicit join, shared context,
 * dedupe, budget stop, and the MCP scope split.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { embedded, type Db } from '../db';
import { applyMigrations } from '../store';
import { LabError } from '../contracts';
import { SCOPES_BY_PRINCIPAL } from '../contracts';
import { visibleTools } from '../registry';
import { callTool } from '../service';
import { saveOpdAudit } from '../../opd-audit-store';
import { opdCaseText, rowToOpdCase } from '../../opd-ingest-core';
import { enterOpdLabWriteFence } from '../../opd-lab-write-guard';
import {
  PAIRED_PROMPT_VERSION, applyStructuredOverride, assessOverrideText, caseTextSections, diffFlags,
  pairedAuditConcurrency,
  flagAgreement, opdAuditPromptHash, overrideContentHash, pairedLogRecord, resolveOverride,
  sameFlagSet, signedContentHash, structureFromOverrideText, type ProjectedFinding,
} from '../paired-audit-core';
import {
  defaultPairedDeps, pairedAuditResults, pairedAuditResultsIdentifying, pairedAuditStatus,
  claimItems, pairedAuditTick, submitPairedAudit,
  type AuditOutcome, type PairedAuditDeps, type ResolveResult,
} from '../paired-audit';
import { isProductionReadSql, setSqlSpy, sql } from '../../db';
import { labV2Url } from '../db';
import type { OpdLabDependencies } from '../../opd-note-audit';

const UID = 'noteuid01';
const UID_B = 'noteuid02';

async function pairedDb(): Promise<Db> {
  const db = await embedded();
  const dir = join(process.cwd(), 'migrations', 'lab-v2');
  const files = ['0001_platform.sql', '0003_paired_audit.sql'].map((name) => {
    const sql = readFileSync(join(dir, name), 'utf8');
    return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  });
  await applyMigrations(db, files);
  return db;
}

const LAB = {
  lvcRules: [],
  specialty: 'General Practitioner',
  complexity: { band: null, inputs: null },
  suppressions: [],
  quietingConfig: { rules: [], gen: 0 },
} as unknown as OpdLabDependencies;

function noteRow(uid: string): Record<string, unknown> {
  return {
    uid,
    doctor_uid: 'doctor01',
    timestamp: '2026-09-01T10:00:00Z',
    consult_type: 'GENERAL_PRACTITIONER',
    dpipe_pc: 'signed complaint about cough',
    dpipe_pom: 'amoxicillin plan that must not leak',
    medications: [{ brand_name: 'AmoxicillinSigned', dosage: '500mg' }],
    patient_details__allergies: 'penicillin',
    prescription_url: 'https://example.invalid/signed-rx',
  };
}

function finding(subject: string, signal: string): Record<string, unknown> {
  return {
    subject, signal_type: signal, verdict: 'low-value', domain: 'prescribing',
    severity: 'high', rationale: 'test rationale', confidence: 0.8, informational: false,
  };
}

function auditOf(findings: Record<string, unknown>[], llmLegFailed = false) {
  return {
    findings,
    scorecard: { headline: 70, band: 'adequate' },
    engineVersion: 'opd-note-audit/test',
    llmLegFailed,
  };
}

function deps(opts: {
  resolve?: (uid: string) => Promise<ResolveResult>;
  audit?: PairedAuditDeps['audit'];
  onContext?: () => void;
  logs?: Record<string, unknown>[];
} = {}): PairedAuditDeps {
  return {
    resolveNote: opts.resolve ?? (async (uid) => ({ status: 'ok', row: noteRow(uid) })),
    loadContext: async () => {
      opts.onContext?.();
      return LAB;
    },
    audit: opts.audit ?? (async (row, _lab, charge) => {
      await charge();
      const override = JSON.stringify(row.medications ?? '').toLowerCase().includes('paracetamol');
      const findings = override
        ? [finding('Shared flag', 'shared'), finding('Override only', 'override_only')]
        : [finding('Shared flag', 'shared'), finding('Signed only', 'signed_only')];
      return { audit: auditOf(findings), spend_microusd: 1 } satisfies AuditOutcome;
    }),
    log: (record) => opts.logs?.push(record),
  };
}

const PARACETAMOL = {
  medications: [{ name: 'Paracetamol', dose: '500 mg', frequency: 'TDS', duration: '3 days' }],
  diagnoses: [{ name: 'Viral fever' }],
};

const SUBMIT = {
  experiment_label: 'eta-freescript',
  idempotency_key: 'batch-1',
  pairs: [{ uid: UID, override: PARACETAMOL, external_ref: 'eta-enc-1' }],
  arms: ['signed', 'freescript'] as [string, string],
  signed_repeats: 1,
  noise_uids: [] as string[],
  max_llm_calls: 8,
  max_spend_microusd: null,
  model: 'vertex:gemini-2.5-pro',
};

test('the override keeps patient context and a non-zero medication count', () => {
  const base = noteRow(UID);
  const row = {
    ...base,
    comorbidities: ['Hypertension'],
    relevant_medical_history: [{ text: 'prior asthma' }],
    reason_for_consultation: 'cough for 3 days',
    dpipe_dx: [{ diagnosis: 'Acute bronchitis', icd_code: 'J20.9' }],
    dpipe_pom: [{ management_plan: 'amoxicillin plan that must not leak' }],
    general_practitioner_prescription__presenting_complaints: [
      { symptoms: 'nested cough', diagnoses: [{ diagnosis_or_impression: 'Nested signed dx' }] },
    ],
  };
  const structured = {
    medications: [{ name: 'Paracetamol', dose: '500 mg', route: 'oral', frequency: 'TDS', duration: '3 days' }],
    diagnoses: [{ name: 'Viral fever', icd_code: 'B34.9' }],
    investigations: ['CBC'],
    procedures: ['nebulisation'],
    advice: ['rest'],
    plan: ['review if worse'],
    exam: ['throat congested'],
    follow_up: { type: 'OPD', date: '2026-09-08' },
  };
  const next = applyStructuredOverride(row, structured);
  const signed = rowToOpdCase(row).case;
  const over = rowToOpdCase(next).case;
  const signedText = opdCaseText(signed);
  const overText = opdCaseText(over);
  assert.ok(over.medications.length > 0);
  assert.match(overText, /Medications \(1\)/);
  assert.equal(overText.includes('NONE prescribed'), false);
  assert.match(overText, /Paracetamol/);
  assert.equal(overText.includes('AmoxicillinSigned'), false);
  assert.equal(overText.includes('amoxicillin plan'), false);
  assert.equal(overText.includes('Acute bronchitis'), false);
  assert.equal(overText.includes('Nested signed dx'), false);
  assert.match(overText, /Viral fever/);
  assert.deepEqual(over.comorbidities, signed.comorbidities);
  assert.deepEqual(over.history, signed.history);
  assert.equal(over.reasonForConsult, signed.reasonForConsult);
  assert.deepEqual(over.presentingComplaints, signed.presentingComplaints);
  assert.equal(over.allergies, 'penicillin');
  assert.match(overText, /Hypertension/);
  assert.match(overText, /signed complaint/);
  const signedParts = caseTextSections(signedText);
  const overParts = caseTextSections(overText);
  assert.deepEqual(overParts.kept, signedParts.kept);
  assert.deepEqual(signedParts.other, []);
  assert.deepEqual(overParts.other, []);
  assert.notEqual(overParts.prescription.join('\n'), signedParts.prescription.join('\n'));
  assert.equal(next.prescription_url, null);
  assert.equal(next.doctor_uid, 'doctor01');
  assert.equal(next.timestamp, base.timestamp);

  const textOnly = applyStructuredOverride(row, structureFromOverrideText('Freescript: paracetamol 500 mg oral TDS for 3 days'));
  const parsed = rowToOpdCase(textOnly).case;
  assert.ok(parsed.medications.length > 0);
  assert.match(opdCaseText(parsed), /Paracetamol|paracetamol/);
  assert.deepEqual(parsed.comorbidities, signed.comorbidities);
  const resolved = resolveOverride({
    override: structured,
    override_text: 'this text must not win',
  });
  assert.equal(resolved.path, 'structured');
  assert.equal(resolved.text, null);
  const fromText = resolveOverride({ override_text: 'Freescript: paracetamol 500 mg for three days' });
  assert.equal(fromText.path, 'text');
});

test('log records keep ids and drop override text', () => {
  const rec = pairedLogRecord('paired_audit_item', {
    uid: UID, status: 'succeeded', override_text: 'Freescript secret body', rationale: 'a finding',
  });
  const flat = JSON.stringify(rec);
  assert.equal(flat.includes('Freescript'), false);
  assert.equal(flat.includes('rationale'), false);
  assert.equal(rec.uid, UID);
  assert.equal(rec.status, 'succeeded');
});

test('flag diff and repeat agreement are pure set comparisons', () => {
  const shared = { subject: 'Shared', signal_type: 'shared', verdict: 'low-value', domain: null, severity: 'high', rationale: null, confidence: null, informational: false, rule_ref: null, lvc_category: null, direction: null } satisfies ProjectedFinding;
  const onlyA = { ...shared, subject: 'Only A', signal_type: 'a' };
  const onlyB = { ...shared, subject: 'Only B', signal_type: 'b' };
  const diff = diffFlags([shared, onlyA], [shared, onlyB]);
  assert.deepEqual(diff.both.map((f) => f.signal_type), ['shared']);
  assert.deepEqual(diff.only_a.map((f) => f.signal_type), ['a']);
  assert.deepEqual(diff.only_b.map((f) => f.signal_type), ['b']);
  assert.equal(sameFlagSet([[shared], [shared]]), true);
  assert.equal(sameFlagSet([[shared], [onlyA]]), false);
  const agreement = flagAgreement([[shared, onlyA], [shared]]);
  const sharedRate = agreement.find((f) => f.signal_type === 'shared');
  const onlyRate = agreement.find((f) => f.signal_type === 'a');
  assert.equal(sharedRate?.agreement, 1);
  assert.equal(onlyRate?.present_in, 1);
  assert.equal(onlyRate?.repeats, 2);
  assert.equal(onlyRate?.agreement, 0.5);
});

test('a paired run shares one context fetch, stores both arms, and does not return the override', async () => {
  const db = await pairedDb();
  let contexts = 0;
  const labs: OpdLabDependencies[] = [];
  let audits = 0;
  const logs: Record<string, unknown>[] = [];
  const submitted = await submitPairedAudit(db, 'operator', SUBMIT);
  assert.equal(submitted.deduplicated, false);
  assert.equal(submitted.counts.items, 2);
  const again = await submitPairedAudit(db, 'operator', SUBMIT);
  assert.equal(again.deduplicated, true);
  assert.equal(again.run_id, submitted.run_id);
  assert.equal(again.counts.items, 2);

  const report = await pairedAuditTick(db, deps({
    onContext: () => { contexts += 1; },
    logs,
    audit: async (row, lab, charge) => {
      audits += 1;
      labs.push(lab);
      await charge();
      const override = JSON.stringify(row.medications ?? '').toLowerCase().includes('paracetamol');
      const findings = override
        ? [finding('Shared flag', 'shared'), finding('Override only', 'override_only')]
        : [finding('Shared flag', 'shared'), finding('Signed only', 'signed_only')];
      return { audit: auditOf(findings), spend_microusd: 1 };
    },
  }), { maxGroups: 4 });
  assert.equal(contexts, 1);
  assert.equal(audits, 2);
  assert.equal(labs[0], labs[1]);
  assert.equal(report.audited, 2);
  assert.equal(JSON.stringify(logs).includes('Freescript'), false);
  assert.equal(JSON.stringify(logs).includes('paracetamol'), false);

  const stored = await db.query<{ arm: string; clinician_uid: string | null }>(
    `SELECT arm, clinician_uid FROM lab_v2.paired_audit_results ORDER BY arm`,
  );
  const byArm = Object.fromEntries(stored.map((r) => [r.arm, r.clinician_uid]));
  assert.equal(byArm.signed, 'doctor01');
  assert.equal(byArm.freescript, null);

  const stripped = await pairedAuditResults(db, submitted.run_id, 20, 0);
  const flat = JSON.stringify(stripped);
  assert.equal(flat.includes('paracetamol'), false);
  assert.equal(flat.includes('Freescript'), false);
  assert.equal(flat.includes(UID), false);
  assert.equal(flat.includes('doctor01'), false);
  assert.equal(flat.includes('eta-enc-1'), false);
  assert.equal(flat.includes('test rationale'), false);
  assert.equal(flat.includes('rationale'), false);
  const overItem = stripped.items.find((i) => i.arm === 'freescript')!;
  assert.equal(overItem.input_path, 'structured');
  assert.equal(flat.includes('Shared flag'), false);
  assert.equal(flat.includes('Signed only'), false);
  const page = await pairedAuditResultsIdentifying(db, submitted.run_id, 20, 0);
  const diff = page.diffs[0];
  assert.deepEqual(diff.only_a.map((f) => f.signal_type), ['signed_only']);
  assert.deepEqual(diff.only_b.map((f) => f.signal_type), ['override_only']);
  assert.deepEqual(diff.both.map((f) => f.signal_type), ['shared']);
  const signed = page.items.find((i) => i.arm === 'signed')!;
  const over = page.items.find((i) => i.arm === 'freescript')!;
  assert.equal(signed.clinician_uid, 'doctor01');
  assert.equal(over.clinician_uid, null);
  assert.equal(signed.uid, UID);
  assert.equal(signed.findings[0].rationale, 'test rationale');
  assert.equal(signed.findings[0].subject, 'Shared flag');
  assert.equal(signed.findings.length, 2);
  const status = await pairedAuditStatus(db, submitted.run_id);
  assert.equal(status.external_ref_unkeyed, 1);
  await db.close();
});

test('a missing or ambiguous uid is skipped and never audited', async () => {
  const db = await pairedDb();
  let audits = 0;
  await submitPairedAudit(db, 'operator', {
    ...SUBMIT,
    idempotency_key: 'missing',
    pairs: [
      { uid: UID, override: PARACETAMOL, external_ref: 'e1' },
      { uid: UID_B, override: PARACETAMOL, external_ref: 'e2' },
    ],
  });
  const report = await pairedAuditTick(db, deps({
    resolve: async (uid) => {
      if (uid === UID) return { status: 'not_found' };
      return { status: 'ambiguous', n: 2 };
    },
    audit: async (_row, _lab, charge) => {
      audits += 1;
      await charge();
      return { audit: auditOf([]), spend_microusd: 0 };
    },
  }), { maxGroups: 4 });
  assert.equal(audits, 0);
  assert.equal(report.skipped, 4);
  const reasons = await db.query<{ uid: string; skip_reason: string }>(
    `SELECT DISTINCT uid, skip_reason FROM lab_v2.paired_audit_items ORDER BY uid`,
  );
  assert.deepEqual(reasons, [
    { uid: UID, skip_reason: 'uid_not_found' },
    { uid: UID_B, skip_reason: 'uid_ambiguous' },
  ]);
  const run = await db.query<{ status: string }>(`SELECT status FROM lab_v2.paired_audit_runs`);
  assert.equal(run[0].status, 'degraded');
  await db.close();
});

test('the call budget stops the run before the next arm is billed', async () => {
  const db = await pairedDb();
  let audits = 0;
  await submitPairedAudit(db, 'operator', { ...SUBMIT, idempotency_key: 'budget', max_llm_calls: 1 });
  const report = await pairedAuditTick(db, deps({
    audit: async (_row, _lab, charge) => {
      audits += 1;
      await charge();
      return { audit: auditOf([finding('Shared flag', 'shared')]), spend_microusd: 1 };
    },
  }));
  assert.equal(audits, 1);
  assert.ok(report.stopped >= 1);
  const rows = await db.query<{ status: string; skip_reason: string | null }>(
    `SELECT status, skip_reason FROM lab_v2.paired_audit_items ORDER BY arm`,
  );
  assert.ok(rows.some((r) => r.status === 'succeeded'));
  assert.ok(rows.some((r) => r.status === 'stopped' && r.skip_reason === 'budget_exhausted'));
  const run = await db.query<{ status: string; stop_reason: string }>(
    `SELECT status, stop_reason FROM lab_v2.paired_audit_runs`,
  );
  assert.equal(run[0].status, 'stopped');
  assert.equal(run[0].stop_reason, 'budget_exhausted');
  await db.close();
});

test('a second run reuses the stored result and does not call the engine', async () => {
  const db = await pairedDb();
  let audits = 0;
  const audit: PairedAuditDeps['audit'] = async (_row, _lab, charge) => {
    audits += 1;
    await charge();
    return { audit: auditOf([finding('Shared flag', 'shared')]), spend_microusd: 1 };
  };
  await submitPairedAudit(db, 'operator', { ...SUBMIT, idempotency_key: 'first' });
  await pairedAuditTick(db, deps({ audit }), { maxGroups: 4 });
  assert.equal(audits, 2);
  await submitPairedAudit(db, 'operator', { ...SUBMIT, idempotency_key: 'second' });
  const report = await pairedAuditTick(db, deps({ audit }), { maxGroups: 4 });
  assert.equal(audits, 2);
  assert.equal(report.deduped, 2);
  assert.equal(report.audited, 0);
  await db.close();
});

test('a swallowed model failure is not deduped, so a later run can retry it', async () => {
  const db = await pairedDb();
  let audits = 0;
  const audit: PairedAuditDeps['audit'] = async () => {
    audits += 1;
    return { audit: auditOf([], true), spend_microusd: 1 };
  };
  await submitPairedAudit(db, 'operator', { ...SUBMIT, idempotency_key: 'leg-1', max_llm_calls: 4 });
  await pairedAuditTick(db, deps({ audit }), { maxGroups: 4 });
  const stored = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM lab_v2.paired_audit_results`);
  assert.equal(stored[0].n, '0');
  await submitPairedAudit(db, 'operator', { ...SUBMIT, idempotency_key: 'leg-2', max_llm_calls: 4 });
  await pairedAuditTick(db, deps({ audit }), { maxGroups: 4 });
  assert.equal(audits, 4);
  await db.close();
});

test('noise repeats stay on the signed arm and are reported per repeat', async () => {
  const db = await pairedDb();
  await submitPairedAudit(db, 'operator', {
    ...SUBMIT,
    idempotency_key: 'noise',
    signed_repeats: 2,
    noise_uids: [UID],
    max_llm_calls: 6,
  });
  await pairedAuditTick(db, deps(), { maxGroups: 4 });
  const page = await pairedAuditResults(db, (await db.query<{ id: string }>(`SELECT id FROM lab_v2.paired_audit_runs`))[0].id, 20, 0);
  const signed = page.items.filter((i) => i.arm === 'signed');
  assert.deepEqual(signed.map((i) => i.repeat_idx), [0, 1]);
  assert.equal(page.items.filter((i) => i.arm === 'freescript').length, 1);
  assert.equal(page.signed_repeats[0].repeats, 2);
  assert.equal(page.signed_repeats[0].identical_flag_sets, true);
  assert.equal(page.signed_repeats[0].flag_agreement.length > 0, true);
  assert.ok(page.signed_repeats[0].flag_agreement.every((f) => f.agreement === 1));
  await db.close();
});

test('a writer called from the audit is refused and the item is stopped', async () => {
  const db = await pairedDb();
  await submitPairedAudit(db, 'operator', { ...SUBMIT, idempotency_key: 'guard' });
  await pairedAuditTick(db, deps({
    audit: async () => {
      await enterOpdLabWriteFence(() => saveOpdAudit(undefined as never));
      return { audit: auditOf([]), spend_microusd: 0 };
    },
  }));
  const rows = await db.query<{ status: string; skip_reason: string | null }>(
    `SELECT status, skip_reason FROM lab_v2.paired_audit_items`,
  );
  assert.ok(rows.every((r) => r.status === 'stopped' || r.skip_reason === 'production_write_refused'));
  assert.ok(rows.some((r) => r.skip_reason === 'production_write_refused'));
  const results = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM lab_v2.paired_audit_results`);
  assert.equal(results[0].n, '0');
  await db.close();
});

test('an override result cannot store a clinician uid', async () => {
  const db = await pairedDb();
  await assert.rejects(() => db.query(
    `INSERT INTO lab_v2.paired_audit_results
      (id, uid, arm, engine_version, prompt_hash, model, override_hash, input_path, repeat_idx, clinician_uid, result)
     VALUES ('11111111-1111-1111-1111-111111111111', $1, 'freescript', 'e', 'p', 'vertex:gemini-2.5-pro', 'h', 'text', 0, 'doctor01', '{}'::jsonb)`,
    [UID],
  ));
  await db.close();
});

test('the runner does not name the production writer or the repair adapter', () => {
  const src = readFileSync(join(process.cwd(), 'lib/lab-v2/paired-audit.ts'), 'utf8');
  assert.equal(/\bsaveOpdAudit\s*\(/.test(src), false);
  assert.equal(src.includes('opd-audit-store'), false);
  assert.equal(src.includes('makeOpdRepairAdapter'), false);
  assert.equal(src.includes('enterOpdLabWriteFence'), true);
  assert.equal(src.includes('loadActiveSuppressionsOrThrow'), true);
  assert.equal(src.includes('loadActiveSuppressions('), false);
  const core = readFileSync(join(process.cwd(), 'lib/lab-v2/paired-audit-core.ts'), 'utf8');
  const hashFn = core.slice(core.indexOf('export function opdAuditPromptHash'), core.indexOf('export function pairedEngineVersion'));
  assert.equal(hashFn.includes('toString'), false);
  assert.equal(opdAuditPromptHash(), PAIRED_PROMPT_VERSION);
});

test('a stale claim is retried and a fresh claim is left to the tick that holds it', async () => {
  const db = await pairedDb();
  let audits = 0;
  const submitted = await submitPairedAudit(db, 'operator', { ...SUBMIT, idempotency_key: 'stale' });
  await db.query(
    `UPDATE lab_v2.paired_audit_items SET status = 'running', claimed_at = now() - interval '21 minutes' WHERE run_id = $1`,
    [submitted.run_id],
  );
  const rescued = await pairedAuditTick(db, deps({
    audit: async (_r, _l, charge) => {
      audits += 1;
      await charge();
      return { audit: auditOf([finding('Shared flag', 'shared')]), spend_microusd: 0 };
    },
  }), { maxGroups: 4, reclaimAfter: '20 minutes' });
  assert.equal(rescued.audited, 2);
  assert.equal(audits, 2);

  const live = await submitPairedAudit(db, 'operator', { ...SUBMIT, idempotency_key: 'live' });
  await db.query(
    `UPDATE lab_v2.paired_audit_items SET status = 'running', claimed_at = now() WHERE run_id = $1`,
    [live.run_id],
  );
  const held = await pairedAuditTick(db, deps({
    audit: async () => { audits += 1; return { audit: auditOf([]), spend_microusd: 0 }; },
  }), { maxGroups: 4, reclaimAfter: '20 minutes' });
  assert.equal(held.audited, 0);
  assert.equal(audits, 2);
  await db.close();
});

function withIdentifying<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.LAB_V2_IDENTIFYING_PRINCIPALS;
  process.env.LAB_V2_IDENTIFYING_PRINCIPALS = 'operator';
  return fn().finally(() => {
    if (prev === undefined) delete process.env.LAB_V2_IDENTIFYING_PRINCIPALS;
    else process.env.LAB_V2_IDENTIFYING_PRINCIPALS = prev;
  });
}

const TOOL_ARGS = {
  experiment_label: 'eta-freescript',
  idempotency_key: 'tool-1',
  pairs: [{ uid: UID, override: PARACETAMOL, external_ref: 'eta-enc-9' }],
  arms: ['signed', 'freescript'],
  max_llm_calls: 4,
};

test('reviewer can read a paired run and cannot launch one; research cannot launch one', async () => {
  const db = await pairedDb();
  const depsFor = (principal: 'operator' | 'research' | 'reviewer' | 'release') => ({
    db, principal, protocolVersion: 'test', sdkVersion: 'test',
  });
  await assert.rejects(
    () => callTool(depsFor('reviewer'), 'paired_audit_submit', TOOL_ARGS),
    (e: LabError) => e instanceof LabError && e.code === 'SCOPE_DENIED',
  );
  const savedPrincipals = process.env.LAB_V2_IDENTIFYING_PRINCIPALS;
  delete process.env.LAB_V2_IDENTIFYING_PRINCIPALS;
  try {
    await assert.rejects(
      () => callTool(depsFor('research'), 'paired_audit_submit', TOOL_ARGS),
      (e: LabError) => e instanceof LabError && e.code === 'CLASSIFICATION_REQUIRED',
    );
    await assert.rejects(
      () => callTool(depsFor('operator'), 'paired_audit_submit', TOOL_ARGS),
      (e: LabError) => e instanceof LabError && e.code === 'CLASSIFICATION_REQUIRED',
    );
  } finally {
    if (savedPrincipals === undefined) delete process.env.LAB_V2_IDENTIFYING_PRINCIPALS;
    else process.env.LAB_V2_IDENTIFYING_PRINCIPALS = savedPrincipals;
  }
  const submitted = await withIdentifying(() => callTool(depsFor('operator'), 'paired_audit_submit', TOOL_ARGS)) as {
    run_id: string; counts: { items: number };
  };
  assert.equal(submitted.counts.items, 2);
  await assert.rejects(
    () => callTool(depsFor('reviewer'), 'paired_audit_status', { run_id: '00000000-0000-0000-0000-000000000000' }),
    (e: LabError) => e instanceof LabError && e.code === 'NOT_FOUND',
  );
  const status = await callTool(depsFor('reviewer'), 'paired_audit_status', { run_id: submitted.run_id }) as {
    counts: { queued: number };
  };
  assert.equal(status.counts.queued, 2);
  await assert.rejects(
    () => withIdentifying(() => callTool(depsFor('operator'), 'paired_audit_submit', {
      ...TOOL_ARGS, idempotency_key: 'dup', pairs: [
        { uid: UID, override_text: 'a', external_ref: 'e' },
        { uid: UID, override_text: 'b', external_ref: 'e2' },
      ],
    })),
    (e: LabError) => e instanceof LabError && e.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    () => withIdentifying(() => callTool(depsFor('operator'), 'paired_audit_submit', {
      ...TOOL_ARGS, idempotency_key: 'noise-missing', signed_repeats: 2,
    })),
    (e: LabError) => e instanceof LabError && e.code === 'INVALID_INPUT',
  );
  const reviewer = visibleTools(SCOPES_BY_PRINCIPAL.reviewer).map((t) => String(t.name));
  const release = visibleTools(SCOPES_BY_PRINCIPAL.release).map((t) => String(t.name));
  assert.ok(reviewer.includes('paired_audit_status'));
  assert.ok(reviewer.includes('paired_audit_results'));
  assert.equal(reviewer.includes('paired_audit_submit'), false);
  assert.equal(reviewer.includes('paired_audit_results_identifying'), false);
  assert.equal(release.includes('paired_audit_status'), false);
  await assert.rejects(
    () => callTool(depsFor('reviewer'), 'paired_audit_results_identifying', { run_id: submitted.run_id }),
    (e: LabError) => e instanceof LabError && e.code === 'SCOPE_DENIED',
  );
  await assert.rejects(
    () => callTool(depsFor('research'), 'paired_audit_results_identifying', { run_id: submitted.run_id }),
    (e: LabError) => e instanceof LabError && e.code === 'CLASSIFICATION_REQUIRED',
  );
  await db.close();
});

test('a revised prescription or a different model is not deduped', async () => {
  const db = await pairedDb();
  let audits = 0;
  const audit: PairedAuditDeps['audit'] = async (_row, _lab, charge) => {
    audits += 1;
    await charge();
    return { audit: auditOf([finding('Shared flag', 'shared')]), spend_microusd: 1 };
  };
  await submitPairedAudit(db, 'operator', { ...SUBMIT, idempotency_key: 'hash-1' });
  await pairedAuditTick(db, deps({ audit }), { maxGroups: 4 });
  assert.equal(audits, 2);
  await submitPairedAudit(db, 'operator', {
    ...SUBMIT,
    idempotency_key: 'hash-2',
    pairs: [{
      uid: UID,
      external_ref: 'eta-enc-1',
      override: { medications: [{ name: 'Ibuprofen', dose: '400 mg', duration: '5 days' }], diagnoses: [{ name: 'Viral fever' }] },
    }],
  });
  const revised = await pairedAuditTick(db, deps({ audit }), { maxGroups: 4 });
  assert.equal(revised.audited, 1);
  assert.equal(revised.deduped, 1);
  assert.equal(audits, 3);
  await submitPairedAudit(db, 'operator', {
    ...SUBMIT,
    idempotency_key: 'hash-3',
    model: 'vertex:gemini-2.5-flash',
  });
  const otherModel = await pairedAuditTick(db, deps({ audit }), { maxGroups: 4 });
  assert.equal(otherModel.audited, 2);
  assert.equal(audits, 5);
  await db.close();
});

test('a structured override is the path that is recorded and keeps the signed comorbidity', async () => {
  const db = await pairedDb();
  await submitPairedAudit(db, 'operator', {
    ...SUBMIT,
    idempotency_key: 'structured',
    pairs: [{
      uid: UID,
      external_ref: 'eta-enc-1',
      override: {
        medications: [{ name: 'Paracetamol', dose: '500 mg', route: 'oral', frequency: 'TDS', duration: '3 days' }],
        diagnoses: [{ name: 'Viral fever' }],
      },
    }],
  });
  await pairedAuditTick(db, deps({
    resolve: async (uid) => ({
      status: 'ok',
      row: { ...noteRow(uid), comorbidities: ['Hypertension'] },
    }),
    audit: async (row, _lab, charge) => {
      await charge();
      const text = opdCaseText(rowToOpdCase(row).case);
      assert.match(text, /Hypertension/);
      if (JSON.stringify(row.medications ?? '').includes('Paracetamol')) {
        assert.match(text, /Medications \(1\)/);
        assert.equal(text.includes('NONE prescribed'), false);
        assert.equal(text.includes('AmoxicillinSigned'), false);
      }
      return { audit: auditOf([finding('Shared flag', 'shared')]), spend_microusd: 1 };
    },
  }), { maxGroups: 4 });
  const paths = await db.query<{ arm: string; input_path: string }>(
    `SELECT arm, input_path FROM lab_v2.paired_audit_items ORDER BY arm`,
  );
  assert.deepEqual(paths, [
    { arm: 'freescript', input_path: 'structured' },
    { arm: 'signed', input_path: 'signed' },
  ]);
  await db.close();
});

test('external_ref must match kx_encounter_id or consult_uid when either is present', async () => {
  const db = await pairedDb();
  let audits = 0;
  await submitPairedAudit(db, 'operator', { ...SUBMIT, idempotency_key: 'ref-miss' });
  const missed = await pairedAuditTick(db, deps({
    resolve: async (uid) => ({ status: 'ok', row: { ...noteRow(uid), kx_encounter_id: 'other-encounter' } }),
    audit: async (_row, _lab, charge) => {
      audits += 1;
      await charge();
      return { audit: auditOf([]), spend_microusd: 0 };
    },
  }), { maxGroups: 2 });
  assert.equal(audits, 0);
  assert.equal(missed.skipped, 2);
  const reason = await db.query<{ skip_reason: string }>(`SELECT DISTINCT skip_reason FROM lab_v2.paired_audit_items`);
  assert.deepEqual(reason, [{ skip_reason: 'external_ref_mismatch' }]);

  await submitPairedAudit(db, 'operator', { ...SUBMIT, idempotency_key: 'ref-hit' });
  const hit = await pairedAuditTick(db, deps({
    resolve: async (uid) => ({ status: 'ok', row: { ...noteRow(uid), consult_uid: 'eta-enc-1' } }),
    audit: async (_row, _lab, charge) => {
      audits += 1;
      await charge();
      return { audit: auditOf([finding('Shared flag', 'shared')]), spend_microusd: 0 };
    },
  }), { maxGroups: 2 });
  assert.equal(hit.audited, 2);
  assert.equal(audits, 2);
  await db.close();
});

test('a claim that has already been attempted twice is not requeued', async () => {
  const db = await pairedDb();
  let audits = 0;
  const submitted = await submitPairedAudit(db, 'operator', { ...SUBMIT, idempotency_key: 'cap' });
  await db.query(
    `UPDATE lab_v2.paired_audit_items
        SET status = 'running', attempts = 2, claimed_at = now() - interval '21 minutes'
      WHERE run_id = $1`,
    [submitted.run_id],
  );
  const report = await pairedAuditTick(db, deps({
    audit: async (_r, _l, charge) => {
      audits += 1;
      await charge();
      return { audit: auditOf([]), spend_microusd: 0 };
    },
  }), { maxGroups: 4, reclaimAfter: '20 minutes' });
  assert.equal(audits, 0);
  assert.equal(report.audited, 0);
  const rows = await db.query<{ status: string; skip_reason: string }>(
    `SELECT status, skip_reason FROM lab_v2.paired_audit_items`,
  );
  assert.ok(rows.every((r) => r.status === 'failed' && r.skip_reason === 'attempt_cap'));
  await db.close();
});

test('override repeats are stored and reported per flag', async () => {
  const db = await pairedDb();
  await submitPairedAudit(db, 'operator', {
    ...SUBMIT,
    idempotency_key: 'override-noise',
    signed_repeats: 1,
    override_repeats: 2,
    noise_uids: [UID],
    max_llm_calls: 6,
  });
  const runId = (await db.query<{ id: string }>(`SELECT id FROM lab_v2.paired_audit_runs`))[0].id;
  await pairedAuditTick(db, deps(), { maxGroups: 4 });
  const page = await pairedAuditResults(db, runId, 20, 0);
  assert.equal(page.items.filter((i) => i.arm === 'freescript').length, 2);
  assert.equal(page.items.filter((i) => i.arm === 'signed').length, 1);
  assert.equal(page.override_repeats[0].repeats, 2);
  assert.equal(page.override_repeats[0].identical_flag_sets, true);
  assert.ok(page.override_repeats[0].flag_agreement.every((f) => f.agreement === 1));
  assert.equal(JSON.stringify(page.override_repeats).includes('Shared flag'), false);
  const calls = await db.query<{ calls_used: number }>(`SELECT calls_used FROM lab_v2.paired_audit_runs`);
  assert.equal(Number(calls[0].calls_used), 3);
  await db.close();
});

const METFORMIN_ROW = (uid: string) => ({
  ...noteRow(uid),
  medications: [{ generic_name: 'Metformin', dosage: '500 mg' }],
  dpipe_dx: [{ diagnosis: 'Type 2 diabetes mellitus', icd_code: 'E11' }],
  comorbidities: ['Hypertension'],
});

test('text that does not parse, and empty meds without no_medications, do not audit', async () => {
  const proseZero = assessOverrideText('Amoxicillin TDS x5 days / Paracetamol SOS');
  assert.equal(proseZero.ok, false);
  assert.equal(proseZero.linesParsed, 0);
  assert.equal(proseZero.linesTotal, 2);
  const dropped = assessOverrideText('Tab Augmentin 625mg BD / Azithromycin OD x3 days');
  assert.equal(dropped.ok, false);
  assert.equal(dropped.linesParsed, 1);
  assert.equal(dropped.linesTotal, 2);
  const drugKey = assessOverrideText('{"medications":[{"drug":"Amoxicillin","dose":"500 mg"}]}');
  assert.equal(drugKey.ok, false);
  assert.equal(drugKey.linesParsed, 0);
  assert.equal((drugKey.structured.medications ?? []).length, 0);

  const db = await pairedDb();
  await assert.rejects(
    () => submitPairedAudit(db, 'operator', {
      ...SUBMIT,
      idempotency_key: 'empty-meds',
      pairs: [{ uid: UID, external_ref: 'eta-enc-1', override: { diagnoses: [{ name: 'T2DM' }] } }],
    }),
    (e: Error) => e instanceof LabError && e.code === 'INVALID_INPUT' && e.message === 'override_unparsed',
  );
  await assert.rejects(
    () => submitPairedAudit(db, 'operator', {
      ...SUBMIT,
      idempotency_key: 'text-closed',
      pairs: [{ uid: UID, external_ref: 'eta-enc-1', override_text: 'Amoxicillin TDS x5 days / Paracetamol SOS' }],
    }),
    (e: Error) => e instanceof LabError && e.code === 'INVALID_INPUT',
  );

  const texts = [
    { uid: 'noteuid11', text: 'Amoxicillin TDS x5 days / Paracetamol SOS', total: 2, parsed: 0 },
    { uid: 'noteuid12', text: 'Tab Augmentin 625mg BD / Azithromycin OD x3 days', total: 2, parsed: 1 },
    { uid: 'noteuid13', text: '{"medications":[{"drug":"Amoxicillin","dose":"500 mg"}]}', total: 1, parsed: 0 },
    { uid: 'noteuid14', text: '{"drug":"Metformin","dose":"500 mg"}', total: 1, parsed: 0 },
  ];
  let audits = 0;
  let sawNone = false;
  let sawMetforminOnOverride = false;
  await submitPairedAudit(db, 'operator', {
    ...SUBMIT,
    idempotency_key: 'unparsed',
    debug_text_override: true,
    max_llm_calls: 20,
    pairs: [
      ...texts.map((row) => ({ uid: row.uid, external_ref: 'eta-enc-1', override_text: row.text })),
      {
        uid: 'noteuid15',
        external_ref: 'eta-enc-1',
        override: { no_medications: true, diagnoses: [{ name: 'Type 2 diabetes mellitus' }] },
      },
    ],
  });
  await pairedAuditTick(db, deps({
    resolve: async (uid) => ({ status: 'ok', row: METFORMIN_ROW(uid) }),
    audit: async (row, _lab, charge) => {
      audits += 1;
      await charge();
      const text = opdCaseText(rowToOpdCase(row).case);
      const meds = JSON.stringify(row.medications ?? '');
      if (!meds.includes('Metformin') && !meds.includes('Paracetamol')) {
        sawNone = text.includes('NONE prescribed');
        sawMetforminOnOverride = text.includes('Metformin');
      }
      return { audit: auditOf([finding('Shared flag', 'shared')]), spend_microusd: 0 };
    },
  }), { maxGroups: 8 });
  const skipped = await db.query<{ uid: string; parse_lines_total: number | null; parse_lines_parsed: number | null }>(
    `SELECT uid, parse_lines_total, parse_lines_parsed
       FROM lab_v2.paired_audit_items
      WHERE arm = 'freescript' AND skip_reason = 'override_unparsed'
      ORDER BY uid`,
  );
  assert.deepEqual(skipped, texts.map((row) => ({
    uid: row.uid, parse_lines_total: row.total, parse_lines_parsed: row.parsed,
  })));
  assert.equal(sawNone, true);
  assert.equal(sawMetforminOnOverride, false);
  // Four text overrides are skipped. The four signed arms and both arms of the
  // no-medication encounter are the calls.
  assert.equal(audits, 6);
  const none = await db.query<{ status: string }>(
    `SELECT status FROM lab_v2.paired_audit_items WHERE uid = 'noteuid15' AND arm = 'freescript'`,
  );
  assert.equal(none[0].status, 'succeeded');
  await db.close();
});

test('content hashes include vitals, shared context, and the signed row context', () => {
  const row = METFORMIN_ROW(UID);
  const base = signedContentHash(row);
  const withVitals = signedContentHash({
    ...row, vitals_consult_uid: 'consult1', measurements__blood_pressure: '120/80',
  });
  assert.notEqual(base, withVitals);
  const gp = signedContentHash(row, { specialty: 'General Practitioner', lvcRuleIds: ['r1'] });
  const cardio = signedContentHash(row, { specialty: 'Cardiology', lvcRuleIds: ['r1'] });
  assert.notEqual(gp, cardio);
  const sameRx = { medications: [{ name: 'Paracetamol', dose: '500 mg' }] };
  const plain = overrideContentHash('structured', sameRx, null, row, { specialty: 'General Practitioner' });
  const otherContext = overrideContentHash(
    'structured', sameRx, null,
    { ...row, comorbidities: ['Asthma'] },
    { specialty: 'General Practitioner' },
  );
  assert.notEqual(plain, otherContext);
});

test('a drifted prompt hash stops the run before any audit', async () => {
  const db = await pairedDb();
  let audits = 0;
  const submitted = await submitPairedAudit(db, 'operator', { ...SUBMIT, idempotency_key: 'drift' });
  await db.query(`UPDATE lab_v2.paired_audit_runs SET prompt_hash = 'paired-opd-prompt/0' WHERE id = $1`, [submitted.run_id]);
  const report = await pairedAuditTick(db, deps({
    audit: async (_r, _l, charge) => {
      audits += 1;
      await charge();
      return { audit: auditOf([]), spend_microusd: 0 };
    },
  }), { maxGroups: 2 });
  assert.equal(audits, 0);
  assert.ok(report.stopped >= 2);
  const run = await db.query<{ stop_reason: string }>(`SELECT stop_reason FROM lab_v2.paired_audit_runs`);
  assert.equal(run[0].stop_reason, 'engine_drift');
  await db.close();
});

test('a spend budget is enforced inside the charge, before the next call', async () => {
  const db = await pairedDb();
  let audits = 0;
  await submitPairedAudit(db, 'operator', { ...SUBMIT, idempotency_key: 'spend', max_spend_microusd: 1, max_llm_calls: 8 });
  const report = await pairedAuditTick(db, deps({
    audit: async (_r, _l, charge) => {
      audits += 1;
      await charge();
      return { audit: auditOf([finding('Shared flag', 'shared')]), spend_microusd: 1 };
    },
  }), { maxGroups: 2 });
  assert.equal(audits, 1);
  assert.ok(report.stopped >= 1);
  const run = await db.query<{ stop_reason: string; spend_microusd: string }>(
    `SELECT stop_reason, spend_microusd FROM lab_v2.paired_audit_runs`,
  );
  assert.equal(run[0].stop_reason, 'budget_exhausted');
  assert.equal(Number(run[0].spend_microusd), 1);
  await db.close();
});

test('an item is not started once the deadline has passed', async () => {
  const db = await pairedDb();
  let audits = 0;
  let clock = 0;
  await submitPairedAudit(db, 'operator', { ...SUBMIT, idempotency_key: 'deadline' });
  await pairedAuditTick(db, deps({
    audit: async (_r, _l, charge) => {
      audits += 1;
      clock = 5_000;
      await charge();
      return { audit: auditOf([finding('Shared flag', 'shared')]), spend_microusd: 0 };
    },
  }), { deadlineAt: 1_000, now: () => clock, maxGroups: 2, concurrency: 1 });
  assert.equal(audits, 1);
  const rows = await db.query<{ arm: string; status: string }>(
    `SELECT arm, status FROM lab_v2.paired_audit_items ORDER BY arm`,
  );
  const queued = rows.filter((r) => r.status === 'queued');
  const done = rows.filter((r) => r.status === 'succeeded');
  assert.equal(done.length, 1);
  assert.equal(queued.length, 1);
  await db.close();
});

test('auditPairedArm halts when the engine calls saveOpdAudit, and production sql sees no write', async () => {
  const db = await pairedDb();
  const seen: { sql: string; executed: boolean }[] = [];
  setSqlSpy((statement, executed) => { seen.push({ sql: statement, executed }); });
  try {
    await submitPairedAudit(db, 'operator', { ...SUBMIT, idempotency_key: 'fence-arm' });
    await pairedAuditTick(db, defaultPairedDeps({
      resolveNote: async (uid) => ({ status: 'ok', row: noteRow(uid) }),
      loadContext: async () => LAB,
      engine: async () => {
        try { await saveOpdAudit(undefined as never); } catch { /* the engine catch */ }
        try { await sql('DELETE FROM opd_note_audits WHERE uid = $1', [UID]); } catch { /* the engine catch */ }
        return auditOf([], true);
      },
    }), { maxGroups: 2 });
    const rows = await db.query<{ status: string; skip_reason: string | null }>(
      `SELECT status, skip_reason FROM lab_v2.paired_audit_items`,
    );
    assert.ok(rows.every((r) => r.status === 'stopped' && r.skip_reason === 'production_write_refused'));
    assert.equal(seen.some((row) => row.executed && !isProductionReadSql(row.sql)), false);
    assert.ok(seen.some((row) => /delete/i.test(row.sql) && row.executed === false));
    const stored = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM lab_v2.paired_audit_results`);
    assert.equal(stored[0].n, '0');
  } finally {
    setSqlSpy(null);
    await db.close();
  }
});

test('pairedAuditConcurrency clamps the env knob', () => {
  assert.equal(pairedAuditConcurrency(undefined), 4);
  assert.equal(pairedAuditConcurrency(''), 4);
  assert.equal(pairedAuditConcurrency('nope'), 4);
  assert.equal(pairedAuditConcurrency('1'), 1);
  assert.equal(pairedAuditConcurrency('6'), 6);
  assert.equal(pairedAuditConcurrency('9'), 6);
});

test('two concurrent claims take different rows and a full cap takes none', async () => {
  const db = await pairedDb();
  const submitted = await submitPairedAudit(db, 'operator', { ...SUBMIT, idempotency_key: 'claim-race' });
  const [first, second] = await Promise.all([
    claimItems(db, submitted.run_id, 1, 2),
    claimItems(db, submitted.run_id, 1, 2),
  ]);
  const ids = [...first, ...second].map((row) => row.id);
  assert.equal(ids.length, 2);
  assert.equal(new Set(ids).size, 2);
  const held = await db.query<{ status: string; attempts: number }>(
    `SELECT status, attempts FROM lab_v2.paired_audit_items`,
  );
  assert.ok(held.every((row) => row.status === 'running' && Number(row.attempts) === 1));
  await db.query(
    `UPDATE lab_v2.paired_audit_items SET status = 'queued', claimed_at = NULL, attempts = 0 WHERE run_id = $1`,
    [submitted.run_id],
  );
  const [left, right] = await Promise.all([
    claimItems(db, submitted.run_id, 1, 1),
    claimItems(db, submitted.run_id, 1, 1),
  ]);
  assert.equal(left.length + right.length, 1);
  const running = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM lab_v2.paired_audit_items WHERE status = 'running'`,
  );
  assert.equal(running[0].n, '1');
  await db.close();
});

test('concurrent claims stay inside the call cap and do not double-claim', async () => {
  const db = await pairedDb();
  const uids = ['noteuid21', 'noteuid22', 'noteuid23'];
  await submitPairedAudit(db, 'operator', {
    ...SUBMIT,
    idempotency_key: 'concurrent-cap',
    max_llm_calls: 3,
    pairs: uids.map((uid) => ({ uid, override: PARACETAMOL, external_ref: 'eta-enc-1' })),
  });
  let active = 0;
  let peak = 0;
  const audit: PairedAuditDeps['audit'] = async (_row, _lab, charge) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 30));
    active -= 1;
    await charge();
    return { audit: auditOf([finding('Shared flag', 'shared')]), spend_microusd: 0 };
  };
  await Promise.all([
    pairedAuditTick(db, deps({ audit }), { concurrency: 4, maxGroups: 8 }),
    pairedAuditTick(db, deps({ audit }), { concurrency: 4, maxGroups: 8 }),
  ]);
  assert.ok(peak <= 4);
  assert.ok(peak >= 2);
  const rows = await db.query<{ attempts: number; status: string }>(
    `SELECT attempts, status FROM lab_v2.paired_audit_items`,
  );
  assert.equal(rows.length, 6);
  assert.ok(rows.every((row) => row.attempts <= 1));
  const calls = await db.query<{ calls_used: number }>(`SELECT calls_used FROM lab_v2.paired_audit_runs`);
  assert.equal(Number(calls[0].calls_used), 3);
  const stored = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM lab_v2.paired_audit_results`);
  assert.equal(stored[0].n, '3');
  const succeeded = rows.filter((row) => row.status === 'succeeded');
  assert.equal(succeeded.length, 3);
  assert.ok(rows.filter((row) => row.status !== 'succeeded').every((row) => row.status === 'stopped'));
  await db.close();
});

test('lab v2 refuses a url that names the same host and database as production', () => {
  const prevLab = process.env.LAB_V2_DATABASE_URL;
  const prevProd = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://prod-user:prod-secret@ep-lab.neon.tech/cdmss?sslmode=require';
  process.env.LAB_V2_DATABASE_URL = 'postgres://lab-user:lab-secret@ep-lab.neon.tech/cdmss?sslmode=require';
  try {
    assert.throws(
      () => labV2Url(),
      (e: Error) => e instanceof LabError && e.code === 'NOT_CONFIGURED',
    );
    process.env.LAB_V2_DATABASE_URL = 'postgres://lab-user:lab-secret@ep-lab.neon.tech/cdmss_lab?sslmode=require';
    assert.equal(labV2Url().includes('cdmss_lab'), true);
  } finally {
    if (prevLab === undefined) delete process.env.LAB_V2_DATABASE_URL;
    else process.env.LAB_V2_DATABASE_URL = prevLab;
    if (prevProd === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevProd;
  }
});
