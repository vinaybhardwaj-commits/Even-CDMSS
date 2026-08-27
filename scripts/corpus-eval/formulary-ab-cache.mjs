// scripts/corpus-eval/formulary-ab-cache.mjs — FORMULARY-CLASS-RESOLUTION golden A/B, step 1.
// READ-ONLY. Builds the shared input cache both arms replay: canonical stored audit (LLM findings
// + PDQI-9) + the raw db13 note row, one JSON line per note. NOT COMMITTED (outside the contract).
//
//   node --env-file=.env.local --import tsx scripts/corpus-eval/formulary-ab-cache.mjs
import { createWriteStream, mkdirSync } from 'node:fs';
import { sql } from '../../lib/db.ts';
import { fetchOpdNotesByUids } from '../../lib/metabase.ts';
import { rowToOpdCase } from '../../lib/opd-ingest-core.ts';
import { OPD_ENGINE_VERSIONS_CURRENT } from '../../lib/opd-note-audit-core.ts';

const OUT_DIR = '.corpus-eval/formulary-ab';
const log = (...a) => console.error(...a);
const verTail = (v) => Number(String(v).match(/(\d+)$/)?.[1] ?? 0);

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const ENG = [...OPD_ENGINE_VERSIONS_CURRENT];

  // Population metadata first (no jsonb blobs — the HTTP 507 trap).
  const meta = await sql(
    `SELECT id, uid, engine_version, audited_at::text AS audited_at
       FROM opd_note_audits
      WHERE app_source = 'standalone' AND engine_version = ANY($1) AND doctor_uid IS NOT NULL
        AND excluded_reason IS NULL AND uid IS NOT NULL`, [ENG]);
  const byUid = new Map();
  for (const r of meta) {
    const prev = byUid.get(r.uid);
    if (!prev) { byUid.set(r.uid, r); continue; }
    const dv = verTail(r.engine_version) - verTail(prev.engine_version);
    if (dv > 0 || (dv === 0 && (r.audited_at > prev.audited_at
      || (r.audited_at === prev.audited_at && String(r.id) > String(prev.id))))) byUid.set(r.uid, r);
  }
  const canonical = [...byUid.values()];
  log(`[cache] ${meta.length} family rows → ${canonical.length} canonical notes`);

  // Stored audit payloads for the canonical ids, chunked.
  const audits = new Map();
  const ids = canonical.map((r) => r.id);
  for (let i = 0; i < ids.length; i += 200) {
    const rows = await sql(
      `SELECT id, uid, note_quality_index AS nqi, band, pdqi9, findings
         FROM opd_note_audits WHERE id = ANY($1::uuid[])`, [ids.slice(i, i + 200)]);
    for (const r of rows) audits.set(r.uid, r);
    if ((i / 200) % 10 === 0) log(`  audits ${Math.min(i + 200, ids.length)}/${ids.length}`);
  }

  // db13 note rows, chunked; write one JSONL line per note with everything an arm needs.
  const out = createWriteStream(`${OUT_DIR}/cache.jsonl`);
  const uids = canonical.map((r) => r.uid);
  let written = 0, missing = 0;
  for (let i = 0; i < uids.length; i += 100) {
    let rows = [];
    try { rows = await fetchOpdNotesByUids(uids.slice(i, i + 100)); } catch (e) { log('fetch err', String(e).slice(0, 80)); continue; }
    const got = new Set();
    for (const row of rows) {
      let parsed; try { parsed = rowToOpdCase(row); } catch { continue; }
      const uid = parsed.keys?.uid; if (!uid) continue;
      const a = audits.get(uid); if (!a) continue;
      got.add(uid);
      const findings = Array.isArray(a.findings) ? a.findings : JSON.parse(a.findings || '[]');
      const pdqi9rows = Array.isArray(a.pdqi9) ? a.pdqi9 : JSON.parse(a.pdqi9 || '[]');
      out.write(JSON.stringify({
        uid, storedNqi: Math.round(a.nqi), storedBand: a.band,
        llmFindings: findings.filter((f) => f && f.source === 'llm'),
        pdqi9: pdqi9rows.length ? Object.fromEntries(pdqi9rows.map((r) => [r.attr, r.value])) : null,
        row,
      }) + '\n');
      written++;
    }
    missing += uids.slice(i, i + 100).filter((u) => !got.has(u)).length;
    if ((i / 100) % 10 === 0) log(`  notes ${Math.min(i + 100, uids.length)}/${uids.length} · written ${written} · unfetchable ${missing}`);
  }
  await new Promise((res) => out.end(res));
  log(`[cache] DONE: ${written} notes cached, ${missing} unfetchable (excluded from both arms identically)`);
}
main().then(() => process.exit(0)).catch((e) => { log('FATAL', e); process.exit(1); });
