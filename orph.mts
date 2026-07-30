import { sql } from './lib/db';
import { OPD_ENGINE_VERSIONS_CURRENT } from './lib/opd-note-audit-core';
const run = sql as unknown as (t: string, p?: unknown[]) => Promise<Record<string, unknown>[]>;
const FAM = [...OPD_ENGINE_VERSIONS_CURRENT];
const r = await run(
  `SELECT count(*)::int findings, count(DISTINCT a.uid)::int uids
   FROM opd_note_audits a JOIN even_concept_state s ON s.uid=a.uid,
     LATERAL jsonb_array_elements(a.findings) f
   WHERE a.app_source='standalone' AND a.excluded_reason IS NULL AND a.engine_version = ANY($1)
     AND f->>'verdict'='low-value' AND (f->>'informational') IS DISTINCT FROM 'true'
     AND f->>'concept_id' IS NULL`, [FAM]);
const cand = await run(
  `SELECT count(*)::int n FROM opd_note_audits a
     LEFT JOIN even_concept_state s ON s.uid=a.uid AND s.engine_version=a.engine_version
   WHERE a.app_source='standalone' AND a.excluded_reason IS NULL
     AND a.findings @> '[{"verdict":"low-value"}]' AND s.uid IS NULL`, []);
const famRows = await run(
  `SELECT count(*)::int n FROM opd_note_audits a
     LEFT JOIN even_concept_state s ON s.uid=a.uid AND s.engine_version=a.engine_version
   WHERE a.app_source='standalone' AND a.excluded_reason IS NULL AND a.engine_version = ANY($1)
     AND a.findings @> '[{"verdict":"low-value"}]' AND s.uid IS NULL`, [FAM]);
const wm = await run(`SELECT count(*)::int total, count(*) FILTER (WHERE in_family IS NOT NULL)::int labelled FROM even_concept_state`, []);
const t = await run(`SELECT to_char(ts,'HH24:MI:SS') ts, stamped, extracted, rejected FROM even_concept_ticks ORDER BY ts DESC LIMIT 1`, []);
const w = wm[0] as any, tk = (t[0] ?? {}) as any;
console.log(`${new Date().toISOString().slice(11,19)}Z  orphans=${(r[0] as any).findings}f/${(r[0] as any).uids}u  unwatermarked_rows(all/in-fam)=${(cand[0] as any).n}/${(famRows[0] as any).n}  in_family_labelled=${w.labelled}/${w.total}  lastTick=${tk.ts} stamped=${tk.stamped} ext=${tk.extracted} rej=${tk.rejected}`);
