/**
 * lib/lvc-value-core.ts — Value Analysis CORE (CW-VA).
 *
 * PURE, dependency-free (no db/llm). Importable by BOTH the server value pass
 * (lib/lvc-value.ts) and the client card/visual (appropriateness-client.tsx),
 * and unit-testable on its own. See CDMSS-CHOOSING-WISELY-LOW-VALUE-CARE-PRD-v1.2.md §14.
 *
 * Posture (V's choices): runs always; structured card + simple visual; labeled
 * LLM estimates ALLOWED but every figure is tagged and estimates are kept visibly
 * separate from evidence-cited facts. Advisory, non-directive — never gatekeeping.
 */

export type Level = 'low' | 'moderate' | 'high' | 'unclear';
export type NetValue = 'high-value' | 'context-dependent' | 'low-value' | 'uncertain';

export interface ValueDimension {
  level: Level;
  detail: string;
}

export interface ValueIntervention {
  intervention: string;
  net_value: NetValue;
  confidence: number; // 0..1
  summary: string;
  long_term_benefit: ValueDimension;
  harms_risks: ValueDimension;
  upfront_cost: ValueDimension;
  long_term_care: ValueDimension;
  alternatives: { name: string; note: string }[];
  what_would_change: string[];
  evidence: string[];     // grounded (corpus-supported) points — rendered as the "evidence" block
  estimates: string[];    // model estimates (incl. any figures) — rendered separately, clearly labeled
}

export interface ValueAnalysis {
  interventions: ValueIntervention[];
  disclaimer: string;
}

export const VALUE_DISCLAIMER =
  'Reasoned value assessment, not a validated cost-effectiveness analysis. Cost and long-term-care figures are model-generated estimates, not validated. Advisory only — it does not replace clinical judgment or shared decision-making.';

const LEVELS = new Set<Level>(['low', 'moderate', 'high', 'unclear']);
const NET_VALUES = new Set<NetValue>(['high-value', 'context-dependent', 'low-value', 'uncertain']);

/** Map a level to a 0–3 score for the simple bar visual. 'unclear' → 0 (renders as a hatched/empty bar). */
export function levelToScore(level: Level): number {
  switch (level) {
    case 'high': return 3;
    case 'moderate': return 2;
    case 'low': return 1;
    default: return 0;
  }
}

function normLevel(v: unknown): Level {
  const s = String(v ?? '').toLowerCase().trim();
  return (LEVELS.has(s as Level) ? s : 'unclear') as Level;
}
function normNetValue(v: unknown): NetValue {
  const s = String(v ?? '').toLowerCase().trim().replace(/\s+/g, '-');
  return (NET_VALUES.has(s as NetValue) ? s : 'uncertain') as NetValue;
}
function asStr(v: unknown): string { return typeof v === 'string' ? v.trim() : ''; }
function asStrArray(v: unknown, cap = 8): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean).slice(0, cap);
}
function asDimension(v: unknown): ValueDimension {
  const o = (v && typeof v === 'object') ? v as Record<string, unknown> : {};
  return { level: normLevel(o.level), detail: asStr(o.detail) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt
// ─────────────────────────────────────────────────────────────────────────────

export const VALUE_SYSTEM = `You are a clinical value-of-care analyst. Given a patient and one or more PROPOSED interventions (tests, treatments, procedures), produce a balanced, structured value assessment — the value case FOR and AGAINST doing it for THIS patient.

Ground clinical claims (benefit, harms, outcomes) in the EVIDENCE EXCERPTS provided. Be specific to the patient's age, comorbidities, and severity.

Rules:
- Be balanced and NON-DIRECTIVE. This informs shared decision-making; it is NOT a recommendation to withhold care and must never read as a denial-of-care justification.
- Separate EVIDENCE-CITED facts (supported by the excerpts) from your own ESTIMATES. Put grounded points in "evidence" and anything you are estimating (especially cost and long-term-care figures) in "estimates".
- You MAY give approximate cost / long-term-care figures, but every figure goes in "estimates" and must be written as an estimate (e.g. "est. ~₹X (not validated)"). Never present an estimate as evidence.
- Rate each dimension low | moderate | high (or "unclear" if the excerpts don't support a rating).
- "long_term_care" = ongoing needs and downstream care after the intervention (revision surgery, rehab, monitoring, device replacement, complications).
- "what_would_change_this" = the factors that would change the value calculus (e.g. weight optimization, age, severity, failed conservative therapy, staging).

Return ONLY JSON, no prose:
{"interventions":[{"intervention":"<name>","net_value":"high-value|context-dependent|low-value|uncertain","confidence":0.0-1.0,"summary":"<one-line bottom line for this patient>","long_term_benefit":{"level":"low|moderate|high|unclear","detail":"..."},"harms_risks":{"level":"...","detail":"..."},"upfront_cost":{"level":"...","detail":"..."},"long_term_care":{"level":"...","detail":"..."},"alternatives":[{"name":"...","note":"..."}],"what_would_change_this":["..."],"evidence":["<corpus-supported point>"],"estimates":["<model estimate incl. any figures, marked est.>"]}]}`;

export function buildValueUser(
  ctx: { scenario: string; proposedActions?: string[]; patient?: { age?: number; sex?: string } },
  excerpts: string[],
): string {
  const pt = ctx.patient
    ? `Patient: ${ctx.patient.age != null ? `${ctx.patient.age}y` : 'age unknown'}${ctx.patient.sex ? `, ${ctx.patient.sex}` : ''}\n`
    : '';
  const orders = ctx.proposedActions && ctx.proposedActions.length
    ? `Proposed intervention(s): ${ctx.proposedActions.join('; ')}\n`
    : 'Proposed intervention(s): (infer the main one from the scenario)\n';
  const ev = excerpts.length
    ? excerpts.map((e, i) => `[${i + 1}] ${e}`).join('\n\n')
    : '(no excerpts retrieved — rate dimensions "unclear" where you lack support, and put any clinical reasoning in estimates rather than evidence)';
  return `${pt}${orders}Clinical scenario:\n${ctx.scenario.trim()}\n\nEVIDENCE EXCERPTS:\n${ev}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parser (tolerant of ```json fences / surrounding prose)
// ─────────────────────────────────────────────────────────────────────────────

export function extractJsonObject(text: string): unknown {
  let t = (text || '').trim();
  if (!t) return null;
  if (t.startsWith('```')) t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

/** Parse the value-pass response. Returns null if nothing usable (caller renders nothing). */
export function parseValueResponse(text: string): ValueAnalysis | null {
  const obj = extractJsonObject(text);
  if (!obj || typeof obj !== 'object') return null;
  const rawList = (obj as Record<string, unknown>).interventions;
  if (!Array.isArray(rawList) || rawList.length === 0) return null;

  const interventions: ValueIntervention[] = [];
  for (const r of rawList.slice(0, 4)) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const name = asStr(o.intervention);
    if (!name) continue;
    let confidence = Number(o.confidence);
    if (!Number.isFinite(confidence)) confidence = 0;
    confidence = Math.max(0, Math.min(1, confidence));
    interventions.push({
      intervention: name,
      net_value: normNetValue(o.net_value),
      confidence,
      summary: asStr(o.summary),
      long_term_benefit: asDimension(o.long_term_benefit),
      harms_risks: asDimension(o.harms_risks),
      upfront_cost: asDimension(o.upfront_cost),
      long_term_care: asDimension(o.long_term_care),
      alternatives: Array.isArray(o.alternatives)
        ? (o.alternatives as unknown[]).map((a) => {
            const ao = (a && typeof a === 'object') ? a as Record<string, unknown> : {};
            return { name: asStr(ao.name), note: asStr(ao.note) };
          }).filter((a) => a.name).slice(0, 6)
        : [],
      what_would_change: asStrArray(o.what_would_change_this ?? o.what_would_change),
      evidence: asStrArray(o.evidence),
      estimates: asStrArray(o.estimates),
    });
  }
  if (interventions.length === 0) return null;
  return { interventions, disclaimer: VALUE_DISCLAIMER };
}
