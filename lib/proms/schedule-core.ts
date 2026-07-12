// lib/proms/schedule-core.ts — Care-Call 0.2 PROMs pure compiler + scoring (prom-sched/0.1 +
// prom-scoring/0.1). Deterministic, DB-free, LLM-free; `now` is PASSED IN (no Date.now). Selects
// and schedules instruments over the frozen catalog and scores house responses; never writes item text.

import {
  ARCHETYPE_WINDOWS, PREM_POINTS, FAMILY_PACKS, FAMILY_REGEX, REGEX_FAMILY_PACK, SHARED_SCALES,
  instrumentById, type Archetype, type Window,
} from './catalog';

export const PROM_SCHED_VERSION = 'prom-sched/0.1' as const;
export const PROM_SCORING_VERSION = 'prom-scoring/0.1' as const;

// The surgeries.uid → family map is an unratified open item (catalog §10) — currently empty, so
// classification relies on the regex map v1 (feasibility §3: ~52% via regex). Extensible.
export const UID_FAMILY_MAP: Record<string, string> = {};

/** uid-map THEN name-regex map v1 (first match) → family | 'unknown' (Decision E). Caller applies
 *  NULLIF (empty-string-for-null); this is also defensive about ''/whitespace. */
export function classifyFamily(input: { surgeryTypeUid?: string | null; procedureName?: string | null }): string {
  const uid = input.surgeryTypeUid && String(input.surgeryTypeUid).trim() ? String(input.surgeryTypeUid).trim() : null;
  if (uid && UID_FAMILY_MAP[uid]) return UID_FAMILY_MAP[uid];
  const name = input.procedureName && String(input.procedureName).trim() ? String(input.procedureName).trim() : null;
  if (name) {
    for (const { family, re } of FAMILY_REGEX) {
      if (family === 'universal_core') break;   // the catch-all is "no specific match" → unknown
      if (re.test(name)) return family;
    }
  }
  return 'unknown';
}

/** Pack lookup → archetype; a coarse regex family bridges via REGEX_FAMILY_PACK; unknown → STANDARD. */
export function archetypeFor(family: string): Archetype {
  const pack = FAMILY_PACKS.find((p) => p.family === family);
  if (pack) return pack.archetype;
  const mapped = REGEX_FAMILY_PACK[family];
  if (mapped && mapped !== 'unknown') {
    const p2 = FAMILY_PACKS.find((p) => p.family === mapped);
    if (p2) return p2.archetype;
  }
  return 'STANDARD';   // unknown → core + PREM on STANDARD
}

/** The pack's scheduled add-on instrument id: prefer the primary; a permission-required (Pv) pack
 *  whose sweep isn't confirmed falls back to its house set (per §Pv-resolution). null → core-only. */
function packInstrumentFor(family: string): string | null {
  const pack = FAMILY_PACKS.find((p) => p.family === family) ?? (REGEX_FAMILY_PACK[family] && REGEX_FAMILY_PACK[family] !== 'unknown' ? FAMILY_PACKS.find((p) => p.family === REGEX_FAMILY_PACK[family]) : undefined);
  if (!pack) return null;
  if (pack.lic === 'Pv' && pack.fallback) return pack.fallback;   // sweep unconfirmed → house fallback
  return pack.primary;
}

// ── Window math (deterministic; days off the anchor) ──
const OFFSET: Record<Exclude<Window, 'baseline'>, number> = { d72h: 3, w2: 14, w6: 42, m3: 90, m6: 180, m12: 365 };
const BAND: Record<Exclude<Window, 'baseline'>, number> = { d72h: 2, w2: 7, w6: 14, m3: 21, m6: 30, m12: 45 };   // ± tolerance (docs silent — flagged default)
function parseDay(iso: string): number { const t = Date.parse(iso); return Number.isNaN(t) ? NaN : Math.floor(t / 86400000); }
function addDays(iso: string, n: number): string { const t = Date.parse(iso); if (Number.isNaN(t)) return iso; return new Date(t + n * 86400000).toISOString().slice(0, 10); }

export interface SeriesInput { anchorDate: string; plannedSurgeryDate?: string | null; dischargeDate?: string | null; cancelled?: boolean }
export interface DueInstrument { window: Window; instrumentId: string; status: 'due' | 'in_window' | 'out_of_window' | 'missed'; opensAt: string; closesAt: string }

function statusOf(now: string, opensAt: string, closesAt: string): DueInstrument['status'] {
  const n = parseDay(now), o = parseDay(opensAt), c = parseDay(closesAt);
  if (Number.isNaN(n) || Number.isNaN(o) || Number.isNaN(c)) return 'out_of_window';
  if (n < o) return 'out_of_window';       // upcoming — not open yet
  if (n <= c) return 'in_window';          // administer now
  return 'missed';                          // window closed, unadministered
}

/** Deterministic per-member due list: CORE + the family pack add-on at every archetype window, plus
 *  the PREM module at the archetype's PREM points. Baseline anchors pre-op; post-op windows anchor on
 *  the discharge date (absent ⇒ pre-op/baseline only). cancelled ⇒ [] (clean exit). */
export function instrumentsDue(family: string, series: SeriesInput, now: string): DueInstrument[] {
  if (series.cancelled) return [];
  const archetype = archetypeFor(family);
  const windows = ARCHETYPE_WINDOWS[archetype];
  const packInstr = packInstrumentFor(family);
  const coreIds = ['whodas12', 'pain_nrs', 'hs-return-to-function', ...(packInstr ? [packInstr] : [])];
  const out: DueInstrument[] = [];

  const bounds = (w: Window): { opensAt: string; closesAt: string } | null => {
    if (w === 'baseline') {
      const close = series.plannedSurgeryDate && String(series.plannedSurgeryDate).trim() ? String(series.plannedSurgeryDate).slice(0, 10) : series.anchorDate.slice(0, 10);
      return { opensAt: series.anchorDate.slice(0, 10), closesAt: close };
    }
    if (!series.dischargeDate || !String(series.dischargeDate).trim()) return null;   // no discharge → post-op not anchored
    const anchor = String(series.dischargeDate).slice(0, 10);
    return { opensAt: addDays(anchor, OFFSET[w] - BAND[w]), closesAt: addDays(anchor, OFFSET[w] + BAND[w]) };
  };

  for (const w of windows) {
    const b = bounds(w);
    if (!b) continue;
    for (const id of coreIds) out.push({ window: w, instrumentId: id, status: statusOf(now, b.opensAt, b.closesAt), opensAt: b.opensAt, closesAt: b.closesAt });
  }
  for (const w of PREM_POINTS[archetype]) {
    const b = bounds(w);
    if (!b) continue;
    out.push({ window: w, instrumentId: 'prem', status: statusOf(now, b.opensAt, b.closesAt), opensAt: b.opensAt, closesAt: b.closesAt });
  }
  return out;
}

// ── Scoring (deterministic; house = simple sum by option index; validated = ref rule, not encoded here) ──
export interface ItemResponse { itemId: string; value: string }

function optionIndex(scale: string, value: string): number | null {
  const opts = SHARED_SCALES[scale as keyof typeof SHARED_SCALES];
  if (scale === 'NRS-11') { const n = parseInt(value, 10); return Number.isFinite(n) ? n : null; }
  if (!opts) return null;
  const i = opts.indexOf(value.trim());
  return i >= 0 ? i : null;
}
/** Does this item's response trigger its ⚠ escalation? (deterministic; positive/severe by scale.) */
function triggers(scale: string, value: string): boolean {
  const v = value.trim();
  switch (scale) {
    case 'YN': return v === 'yes';
    case 'NRS-11': { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 8; }
    case 'S5-SEV': case 'S5-FRQ': { const i = optionIndex(scale, v); return i != null && i >= 3; }
    case 'S5-CMP': return v === 'worse' || v === 'much worse';
    case 'DIET4': return v === 'liquids only' || v === 'barely';
    case 'SUPPORT3': return v === 'struggling';
    default: { const i = optionIndex(scale, v); return i != null && i >= 3; }
  }
}

// WHODAS 2.0 (12-item, interviewer version) response scale — None/Mild/Moderate/Severe/Extreme
// (-or-cannot-do). Anchors given VERBATIM in the wired PRD §7 (not invented). The item TEXT is
// WHO-copyrighted and entered separately at 0.2a-2 from the official source — this is scoring only.
const WHODAS_SCALE = ['none', 'mild', 'moderate', 'severe', 'extreme'];
function whodasIndex(value: string): number {
  const v = String(value ?? '').trim().toLowerCase();
  const exact = WHODAS_SCALE.indexOf(v);
  if (exact >= 0) return exact;
  return WHODAS_SCALE.findIndex((a) => v.startsWith(a));   // tolerate "extreme or cannot do"
}

export function scoreInstrument(instrumentId: string, responses: ItemResponse[]): { score: number | null; scale: string; version: string; escalations: string[] } {
  const def = instrumentById(instrumentId);
  const byId = new Map((responses || []).map((r) => [r.itemId, r.value]));
  // WHODAS-12 SIMPLE scoring (WHO): sum of the 12 item scores (each 0..4 on the None…Extreme scale).
  // Complete set (all 12 mapped) required → else honest null. Item text stays WHO-sourced/pending.
  if (instrumentId === 'whodas12') {
    const scores = (responses || []).map((r) => whodasIndex(r.value)).filter((i) => i >= 0);
    const complete = scores.length === 12;
    return { score: complete ? scores.reduce((a, b) => a + b, 0) : null, scale: 'WHODAS-12 simple sum', version: PROM_SCORING_VERSION, escalations: [] };
  }
  if (!def || def.kind === 'validated') {
    // validated scoring rule is entered with the item text at 0.2a-2 → honest null now.
    return { score: null, scale: def ? def.scale : 'unknown', version: PROM_SCORING_VERSION, escalations: [] };
  }
  // house: simple sum of option indices; partial (any item unanswered) → honest null.
  let sum = 0; let answered = 0;
  const escalations: string[] = [];
  for (const it of def.items) {
    const v = byId.get(it.id);
    if (v == null) continue;
    answered++;
    const idx = optionIndex(it.scale, v);
    if (idx != null) sum += idx;
    if (it.escalation && triggers(it.scale, v)) {
      if (it.escalation === 'always') escalations.push('E5');
      else if (it.escalation === 'E2-with-item-3') { const fever = def.items.find((x) => x.scale === 'YN' && /fever/i.test(x.text || '')); if (fever && (byId.get(fever.id) || '').trim() === 'yes') escalations.push('E2'); }
      else escalations.push(it.escalation);
    }
  }
  const complete = def.items.every((it) => byId.has(it.id));
  return { score: complete ? sum : null, scale: 'house', version: PROM_SCORING_VERSION, escalations: Array.from(new Set(escalations)) };
}
