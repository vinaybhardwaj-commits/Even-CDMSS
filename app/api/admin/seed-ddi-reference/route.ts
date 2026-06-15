import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import type { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { norm } from '@/lib/ddi-reference';

export const runtime = 'nodejs';
export const maxDuration = 300;

// Ingests the DDInter 2.0 dataset (CC BY-NC-SA 4.0 — ddinter.scbdd.com) into
// `ddi_reference`, server-side. Filters to drug pairs where BOTH drugs are in the
// EHRC formulary, and severity-gates to Major/Moderate (drops Minor/Unknown — the
// alert-fatigue noise). Idempotent: TRUNCATEs and reloads each run.
//
// Attribution: interaction data © DDInter 2.0 (Tianjin/Central South University),
// CC BY-NC-SA 4.0. NonCommercial — confirm licensing before production use.

const CSV_BASE = 'https://ddinter.scbdd.com/static/media/download/ddinter_downloads_code_';
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const KEEP = new Set(['Major', 'Moderate']);
const SPLIT = /\s*[+/&,]\s*|\band\b/;
const STOP = new Set(['acid', 'sodium', 'potassium', 'chloride', 'sulphate', 'sulfate', 'hydrochloride', 'hcl', 'human', 'calcium', 'magnesium', 'citrate', 'phosphate', 'bicarbonate', 'succinate', 'besylate', 'mesylate', 'maleate', 'tartrate', 'base', 'oil', 'gel']);

async function fetchText(url: string, ms: number): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    return r.ok ? await r.text() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req); if (denied) return denied;
  try {
    await sql`CREATE TABLE IF NOT EXISTS ddi_reference (
      id BIGSERIAL PRIMARY KEY, drug_a TEXT NOT NULL, drug_b TEXT NOT NULL,
      severity TEXT NOT NULL, source TEXT NOT NULL, mechanism TEXT, management TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`;
    await sql`CREATE INDEX IF NOT EXISTS ddi_reference_a_idx ON ddi_reference (drug_a)`;
    await sql`CREATE INDEX IF NOT EXISTS ddi_reference_b_idx ON ddi_reference (drug_b)`;

    // EHRC formulary ingredient token set (split combination products).
    const frows = (await sql`SELECT generic_canon FROM formulary WHERE generic_canon <> ''`) as { generic_canon: string }[];
    const formTokens = new Set<string>();
    for (const r of frows) {
      for (const tok of norm(r.generic_canon).split(SPLIT)) {
        const t = tok.trim();
        if (t.length > 3 && !STOP.has(t)) formTokens.add(t);
      }
    }

    // Fetch all DDInter CSVs in parallel; keep only formulary-matched Major/Moderate pairs.
    const pairs = new Map<string, { a: string; b: string; sev: string }>();
    let scanned = 0, filesOk = 0;
    await Promise.all(LETTERS.map(async (L) => {
      const text = await fetchText(`${CSV_BASE}${L}.csv`, 25000);
      if (!text) return;
      filesOk++;
      const lines = text.split(/\r?\n/);
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        const c = line.split(',');
        if (c.length !== 5) continue;            // skip rows with commas in names
        scanned++;
        const level = c[4].trim();
        if (!KEEP.has(level)) continue;
        const na = norm(c[1]); const nb = norm(c[3]);
        if (!na || !nb || na === nb) continue;
        if (!formTokens.has(na) || !formTokens.has(nb)) continue;
        const key = na < nb ? `${na}|${nb}` : `${nb}|${na}`;
        if (!pairs.has(key)) pairs.set(key, { a: na, b: nb, sev: level.toLowerCase() });
      }
    }));

    await sql`TRUNCATE ddi_reference RESTART IDENTITY`;
    const arr = [...pairs.values()];
    const B = 500; let inserted = 0;
    for (let i = 0; i < arr.length; i += B) {
      const c = arr.slice(i, i + B);
      await sql`
        INSERT INTO ddi_reference (drug_a, drug_b, severity, source)
        SELECT * FROM UNNEST(
          ${c.map((p) => p.a)}::text[], ${c.map((p) => p.b)}::text[],
          ${c.map((p) => p.sev)}::text[], ${c.map(() => 'DDInter')}::text[]
        )`;
      inserted += c.length;
    }
    const covered = new Set<string>();
    arr.forEach((p) => { covered.add(p.a); covered.add(p.b); });

    return NextResponse.json({
      ok: true, files_fetched: filesOk, rows_scanned: scanned,
      formulary_pairs: arr.length, inserted, distinct_formulary_drugs_covered: covered.size,
      source: 'DDInter 2.0 (CC BY-NC-SA 4.0)', gate: 'Major + Moderate only',
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
