/**
 * lib/reasoning/registry-core.ts — pure load/validate/merge for the prompt registry
 * (Reasoning Observability Stage 0). Joins the GENERATED registry facts
 * (data/reasoning-registry/prompts.generated.json, written by scripts/reasoning-registry-gen.mjs)
 * with the hand-authored sidecar metadata (./manifest.ts) into the research-export payload.
 *
 * RESEARCH-ONLY CONTRACT: the export contains prompt/rubric/metadata fields ONLY — no clinical
 * data, no patient text, no trace/run content, no PHI. renderRegistryExport() enforces this
 * structurally (per-section key allowlists; an unexpected key is a hard throw), and
 * lib/__tests__/reasoning-registry.test.ts additionally scans every key against a forbidden
 * pattern. Pure module: no db, no fetch, no env.
 */

import GENERATED from '../../data/reasoning-registry/prompts.generated.json';
import { PROMPT_MANIFESTS, type Maturity } from './manifest';

export interface GeneratedPrompt {
  id: string;
  const: string;
  feature: string;
  group: string;
  file: string;
  kind: string;
  version_hint: string;
  sha256: string;
  sha12: string;
  chars: number;
  lines: number;
  text: string;
}

export interface RegistryPrompt extends GeneratedPrompt {
  maturity: Maturity;
  owner: string | null;             // honest blank until assigned in the manifest
  clinicianApprover: string | null;
  rubricId: string | null;
  schemaId: string | null;
}

export interface GeneratedRubric {
  id: string;
  kind: string;
  version: string;
  source?: string;
  feature?: string;
  sha256?: string;
  keys?: string[];
  meta?: unknown;
  embedded_in?: string;
  text?: string | null;
}

export interface RegistryBuilder { fn: string; file: string; feature: string }

export interface RegistryExport {
  export: string;
  schema: string;
  source_repo: string;
  scope_note: string;
  coverage_note: string;
  counts: { prompts: number; rubrics: number; user_message_builders: number; features: number };
  prompts: RegistryPrompt[];
  rubrics: GeneratedRubric[];
  user_message_builders: RegistryBuilder[];
}

/** Sidecar lookup. Unknown/unlisted id → 'unregistered' metadata — NEVER a throw (PRD §6). */
export function manifestFor(id: string): Pick<RegistryPrompt, 'maturity' | 'owner' | 'clinicianApprover' | 'rubricId' | 'schemaId'> {
  const m = PROMPT_MANIFESTS.find((p) => p.id === id);
  if (!m) return { maturity: 'unregistered', owner: null, clinicianApprover: null, rubricId: null, schemaId: null };
  return {
    maturity: m.maturity,
    owner: m.owner ?? null,
    clinicianApprover: m.clinicianApprover ?? null,
    rubricId: m.rubricId ?? null,
    schemaId: m.schemaId ?? null,
  };
}

// ── research-only key allowlists (structural enforcement) ───────────────────────────────────────
const PROMPT_KEYS = new Set(['id', 'const', 'feature', 'group', 'file', 'kind', 'version_hint',
  'sha256', 'sha12', 'chars', 'lines', 'text', 'maturity', 'owner', 'clinicianApprover', 'rubricId', 'schemaId']);
const RUBRIC_KEYS = new Set(['id', 'kind', 'version', 'source', 'feature', 'sha256', 'keys', 'meta', 'embedded_in', 'text']);
const BUILDER_KEYS = new Set(['fn', 'file', 'feature']);
const TOP_KEYS = new Set(['export', 'schema', 'source_repo', 'scope_note', 'coverage_note',
  'counts', 'prompts', 'rubrics', 'user_message_builders']);

function assertKeys(obj: object, allowed: Set<string>, what: string): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) throw new Error(`registry export: unexpected ${what} key "${k}" — research export carries prompt/rubric/metadata fields only`);
  }
}

/**
 * The research-export payload: generated facts + sidecar metadata, nothing else.
 * Deterministic (a pure projection of two committed files).
 */
export function renderRegistryExport(): RegistryExport {
  const gen = GENERATED as unknown as {
    export: string; schema: string; source_repo: string; scope_note: string; coverage_note: string;
    counts: RegistryExport['counts'];
    prompts: GeneratedPrompt[]; rubrics: GeneratedRubric[]; user_message_builders: RegistryBuilder[];
  };
  const payload: RegistryExport = {
    export: gen.export,
    schema: gen.schema,
    source_repo: gen.source_repo,
    scope_note: gen.scope_note,
    coverage_note: gen.coverage_note,
    counts: gen.counts,
    prompts: gen.prompts.map((p) => ({ ...p, ...manifestFor(p.id) })),
    rubrics: gen.rubrics,
    user_message_builders: gen.user_message_builders,
  };
  assertKeys(payload, TOP_KEYS, 'top-level');
  for (const p of payload.prompts) assertKeys(p, PROMPT_KEYS, 'prompt');
  for (const r of payload.rubrics) assertKeys(r, RUBRIC_KEYS, 'rubric');
  for (const b of payload.user_message_builders) assertKeys(b, BUILDER_KEYS, 'builder');
  return payload;
}

// ── HTML rendering for ?format=html (pure string; self-contained, no scripts) ──────────────────
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderRegistryHtml(x: RegistryExport): string {
  const promptRows = x.prompts.map((p) => `
    <tr><td><code>${esc(p.id)}</code></td><td>${esc(p.feature)}</td><td>${esc(p.maturity)}</td>
    <td>${esc(p.rubricId ?? '—')}</td><td>${esc(p.version_hint)}</td><td><code>${esc(p.sha12)}</code></td>
    <td class="n">${p.chars}</td></tr>
    <tr class="text"><td colspan="7"><details><summary>prompt text (${p.lines} lines)</summary><pre>${esc(p.text)}</pre></details></td></tr>`).join('');
  const rubricRows = x.rubrics.map((r) => `
    <tr><td><code>${esc(r.id)}</code></td><td>${esc(r.kind)}</td><td>${esc(r.embedded_in ?? r.source ?? '—')}</td><td>${esc(r.version)}</td></tr>`).join('');
  const builderRows = x.user_message_builders.map((b) => `
    <tr><td><code>${esc(b.fn)}</code></td><td>${esc(b.file)}</td><td>${esc(b.feature)}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>CDMSS reasoning registry</title>
<style>
body{font:14px/1.5 -apple-system,system-ui,sans-serif;color:#0f172a;margin:2rem auto;max-width:64rem;padding:0 1rem}
table{border-collapse:collapse;width:100%;margin:0 0 2rem}th,td{border:1px solid #e2e8f0;padding:4px 8px;text-align:left;vertical-align:top}
th{background:#f8fafc}code{font-size:12px}pre{white-space:pre-wrap;font-size:12px;background:#f8fafc;padding:8px;border-radius:4px}
.n{text-align:right}.note{color:#64748b;font-size:13px;max-width:56rem}tr.text td{border-top:none}
</style></head><body>
<h1>CDMSS reasoning registry</h1>
<p class="note">${esc(x.scope_note)}</p>
<p class="note">${esc(x.coverage_note)}</p>
<p><b>${x.counts.prompts}</b> prompts · <b>${x.counts.rubrics}</b> rubrics · <b>${x.counts.user_message_builders}</b> user-message builders · <b>${x.counts.features}</b> features · schema <code>${esc(x.schema)}</code></p>
<h2>Prompts</h2>
<table><thead><tr><th>id</th><th>feature</th><th>maturity</th><th>rubric</th><th>version hint</th><th>sha12</th><th>chars</th></tr></thead><tbody>${promptRows}</tbody></table>
<h2>Rubrics</h2>
<table><thead><tr><th>id</th><th>kind</th><th>where</th><th>version</th></tr></thead><tbody>${rubricRows}</tbody></table>
<h2>User-message builders</h2>
<table><thead><tr><th>fn</th><th>file</th><th>feature</th></tr></thead><tbody>${builderRows}</tbody></table>
</body></html>`;
}
