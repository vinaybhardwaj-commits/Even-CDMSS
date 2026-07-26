#!/usr/bin/env node
/**
 * scripts/seed-lvc-concepts.mjs — Concept Coder Phase 1 seed loader (PRD §3, kickoff item 2).
 *
 * Loads the Research Team's LVC concept dictionary v2:
 *   concepts_assignments.csv  → lvc_concept_strings (source='seed')
 *   concept_dictionary.csv    → lvc_concepts (review_lane computed per §4)
 *
 * Usage:
 *   node scripts/seed-lvc-concepts.mjs --dir ~/Downloads --dry-run
 *   node scripts/seed-lvc-concepts.mjs --dir ~/Downloads --apply
 *
 * --dry-run (default) parses, validates and REPORTS counts + every rejected row with its reason,
 * writing nothing. --apply requires DATABASE_URL and runs the migration's tables must already exist.
 *
 * WHICH COLUMNS. The v2 assignments file carries the post-formulary-resolution chain
 * target_f → target_form → target_final → target_v2, and concept_v2 alongside the original
 * concept_id. `concept_v2` is authoritative: 215 rows differ from `concept_id`, and the differences
 * are the intended corrections (e.g. "meftal spas" resolving to its real composition, "investigations"
 * collapsing to "investigation"). PRD §7's stage order — collapse AFTER formulary resolution — is
 * already baked into these columns; this loader preserves them rather than recomputing.
 */
import { readFileSync } from 'node:fs';
import { resolve as resolvePath, join } from 'node:path';
import { homedir } from 'node:os';
import {
  normalizeConceptSubject, isConceptDirection, computeReviewLane, baseConceptId,
} from '../lib/even-concept-core.ts';

// ── args ─────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const APPLY = argv.includes('--apply');
const DIR = resolvePath((arg('--dir', join(homedir(), 'Downloads'))).replace(/^~/, homedir()));
const ASSIGNMENTS = arg('--assignments', 'concepts_assignments (1).csv');
const DICTIONARY = arg('--dictionary', 'concept_dictionary (1).csv');

// ── minimal RFC4180 CSV parser (quoted fields, embedded commas/newlines) ─────────
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;   // strip BOM
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const head = rows[0];
  return rows.slice(1).filter((r) => r.some((x) => String(x).trim() !== ''))
    .map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

const int = (v) => { const n = parseInt(String(v ?? '').trim(), 10); return Number.isFinite(n) ? n : 0; };

// ── load + validate assignments → lvc_concept_strings ───────────────────────────
export function buildStringRows(rows) {
  const out = [], rejected = [], seen = new Map();
  for (const [i, r] of rows.entries()) {
    const line = i + 2;   // 1-based + header
    const rawNorm = r.norm ?? '';
    const norm = normalizeConceptSubject(rawNorm);
    const conceptId = String(r.concept_v2 ?? r.concept_id ?? '').trim();
    if (!norm) { rejected.push({ line, norm: rawNorm, reason: 'blank norm' }); continue; }
    if (norm !== String(rawNorm)) {
      // Load-bearing: the seeded norms must already be house-normalised or lookups never hit.
      rejected.push({ line, norm: rawNorm, reason: `norm is not house-normalised (would key as "${norm}")` });
      continue;
    }
    if (!conceptId) { rejected.push({ line, norm, reason: 'blank concept_id' }); continue; }
    const base = baseConceptId(conceptId).split(':');
    if (base.length !== 3 || base.some((p) => !p)) { rejected.push({ line, norm, reason: `malformed concept_id "${conceptId}"` }); continue; }
    if (!isConceptDirection(base[0])) { rejected.push({ line, norm, reason: `direction outside closed vocabulary: "${base[0]}"` }); continue; }
    const prev = seen.get(norm);
    if (prev && prev !== conceptId) { rejected.push({ line, norm, reason: `duplicate norm with a DIFFERENT concept (${prev} vs ${conceptId})` }); continue; }
    if (prev) { rejected.push({ line, norm, reason: 'duplicate norm (identical concept) — first kept' }); continue; }
    seen.set(norm, conceptId);
    const ctx = String(r.context ?? '').trim();
    out.push({
      norm,
      concept_id: baseConceptId(conceptId),   // the id is the BASE; context is its own column
      context: ctx || null,
      confidence: String(r.conf ?? '').trim() || null,
      findings: int(r.findings),
    });
  }
  return { rows: out, rejected };
}

// ── dictionary → lvc_concepts, with review_lane computed per §4 ─────────────────
/** Volume shares come from the ASSIGNMENTS file (which carries per-string `findings` counts and the
 *  context column); the dictionary supplies direction/action/target and its own n_strings/volume. */
export function buildConceptRows(dictRows, stringRows) {
  const totalVol = new Map(), ctxFreeVol = new Map(), nStrings = new Map();
  for (const s of stringRows) {
    const b = s.concept_id;
    totalVol.set(b, (totalVol.get(b) ?? 0) + s.findings);
    if (!s.context) ctxFreeVol.set(b, (ctxFreeVol.get(b) ?? 0) + s.findings);
    nStrings.set(b, (nStrings.get(b) ?? 0) + 1);
  }
  const out = [], rejected = [], seen = new Set();
  for (const [i, r] of dictRows.entries()) {
    const line = i + 2;
    const raw = String(r.concept_id ?? '').trim();
    if (!raw) { rejected.push({ line, concept_id: raw, reason: 'blank concept_id' }); continue; }
    const base = baseConceptId(raw);
    const parts = base.split(':');
    if (parts.length !== 3 || parts.some((p) => !p)) { rejected.push({ line, concept_id: raw, reason: `malformed concept_id "${raw}"` }); continue; }
    const direction = String(r.direction ?? parts[0]).trim();
    if (!isConceptDirection(direction)) { rejected.push({ line, concept_id: raw, reason: `direction outside closed vocabulary: "${direction}"` }); continue; }
    if (seen.has(base)) continue;   // context-qualified dictionary rows fold onto their base concept
    seen.add(base);
    const tv = totalVol.get(base) ?? int(r.volume);
    const cf = ctxFreeVol.get(base) ?? 0;
    out.push({
      concept_id: base, direction, action: parts[1], target: parts[2],
      n_strings: nStrings.get(base) ?? int(r.n_strings),
      volume: tv,
      review_lane: computeReviewLane(tv, cf),
    });
  }
  return { rows: out, rejected };
}

// ── main ─────────────────────────────────────────────────────────────────────────
async function main() {
  const aPath = join(DIR, ASSIGNMENTS), dPath = join(DIR, DICTIONARY);
  console.log(`seed-lvc-concepts — ${APPLY ? 'APPLY' : 'DRY RUN'}`);
  console.log(`  assignments: ${aPath}`);
  console.log(`  dictionary:  ${dPath}\n`);

  const aRaw = parseCsv(readFileSync(aPath, 'utf8'));
  const dRaw = parseCsv(readFileSync(dPath, 'utf8'));
  const S = buildStringRows(aRaw);
  const C = buildConceptRows(dRaw, S.rows);

  console.log(`lvc_concept_strings  parsed ${aRaw.length}  accepted ${S.rows.length}  rejected ${S.rejected.length}`);
  console.log(`lvc_concepts         parsed ${dRaw.length}  accepted ${C.rows.length}  rejected ${C.rejected.length}`);
  const lanes = C.rows.reduce((m, r) => (m[r.review_lane] = (m[r.review_lane] ?? 0) + 1, m), {});
  console.log(`review_lane          ${JSON.stringify(lanes)}`);
  const dirs = S.rows.reduce((m, r) => (m[r.concept_id.split(':')[0]] = (m[r.concept_id.split(':')[0]] ?? 0) + 1, m), {});
  console.log(`direction (strings)  ${JSON.stringify(dirs)}\n`);

  for (const [name, list] of [['strings', S.rejected], ['concepts', C.rejected]]) {
    if (!list.length) { console.log(`no ${name} rejected.`); continue; }
    console.log(`REJECTED ${name} (${list.length}):`);
    const by = list.reduce((m, r) => (m[r.reason.replace(/"[^"]*"/g, '"…"')] = (m[r.reason.replace(/"[^"]*"/g, '"…"')] ?? 0) + 1, m), {});
    for (const [reason, n] of Object.entries(by)) console.log(`   ${n.toString().padStart(5)}  ${reason}`);
    for (const r of list.slice(0, 10)) console.log(`      line ${r.line}: ${r.reason} — ${JSON.stringify(r.norm ?? r.concept_id).slice(0, 80)}`);
  }

  if (!APPLY) { console.log('\n(dry run — nothing written; re-run with --apply)'); return; }

  const { sql } = await import('../lib/db.ts');
  const run = sql;
  let ins = 0;
  for (const c of C.rows) {
    await run(
      `INSERT INTO lvc_concepts (concept_id, direction, action, target, n_strings, volume, review_lane)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (concept_id) DO UPDATE SET n_strings=EXCLUDED.n_strings, volume=EXCLUDED.volume,
         review_lane=EXCLUDED.review_lane, last_seen=now()`,
      [c.concept_id, c.direction, c.action, c.target, c.n_strings, c.volume, c.review_lane]);
    ins++;
  }
  console.log(`lvc_concepts upserted: ${ins}`);
  let sIns = 0;
  for (const s of S.rows) {
    await run(
      `INSERT INTO lvc_concept_strings (norm, concept_id, context, confidence, source, model)
       VALUES ($1,$2,$3,$4,'seed',NULL) ON CONFLICT (norm) DO NOTHING`,
      [s.norm, s.concept_id, s.context, s.confidence]);
    sIns++;
  }
  console.log(`lvc_concept_strings inserted (ON CONFLICT DO NOTHING): ${sIns}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
