import { NextRequest } from 'next/server';
import { retrieve } from '@/lib/retrieve';
import { llm } from '@/lib/llm';
import { parseLooseJson, normalizeDrugName } from '@/lib/drugs';
import { makeNdjsonStream, ndjsonHeaders } from '@/lib/stream';

export const runtime = 'nodejs';
export const maxDuration = 120;

// Use qwen2.5:14b for richer pharmacology synthesis; UpToDate ingest is done so it's fast
const LOOKUP_MODEL = 'qwen2.5:14b';

const SYSTEM = `You write comprehensive pharmacology teaching cards for clinicians. Use ONLY the medical excerpts provided.

Return ONLY this JSON, lowercase keys, no prose, no markdown fences:
{
  "drug_normalized": "generic name lowercase",
  "class": "pharmacologic class",
  "subclass": "finer subclass or empty",
  "mechanism_of_action": "2-4 sentences explaining how the drug works pharmacologically — receptors, second messengers, enzymes, channels, downstream effects. Mechanistic, not symptomatic.",
  "receptors_targets": ["specific molecular targets: receptor, enzyme, channel, transporter — one per item"],
  "biochemistry": "biochemical pathway / metabolic step involved — 1-3 sentences if relevant, empty string if not applicable",
  "pharmacokinetics": {
    "absorption": "route, F if known, with/without food",
    "distribution": "Vd, protein binding, BBB if relevant",
    "metabolism": "primary CYP enzymes, prodrug status, active metabolites",
    "excretion": "renal/biliary/fecal, % unchanged",
    "half_life": "t½ with range",
    "bioavailability": "F% if oral",
    "onset": "time to onset of effect",
    "duration": "duration of action"
  },
  "pharmacodynamics": "dose-response relationship + downstream physiologic effects, 1-3 sentences",
  "indications": ["FDA/major-guideline approved uses + common off-label"],
  "formulations": ["available formulations + strengths"],
  "typical_dosing": ["adult dosing for each indication, include onset/peak/duration if relevant"],
  "renal_adjust": "one paragraph or 'No adjustment required' or 'Not specified in available excerpts'",
  "hepatic_adjust": "same format",
  "contraindications": ["absolute contraindications first, then relative"],
  "adverse_effects": ["organized loosely by frequency or severity — common, serious, rare-but-severe"],
  "drug_interactions_summary": ["notable interaction classes — e.g. 'NSAIDs blunt antihypertensive effect', 'CYP3A4 inhibitors raise levels'"],
  "monitoring": ["what to check + frequency"],
  "special_populations": {
    "pregnancy": "category/risk + recommendation, or 'Not specified'",
    "pediatric": "approved/dosing/cautions",
    "geriatric": "considerations",
    "renal_impairment": "additional notes if not already in renal_adjust"
  },
  "key_pearls": ["3-5 high-yield teaching points — clinical pearls, common mistakes, distinguishing features"],
  "citation_ids": [1, 2, 3]
}

Rules:
- BE COMPREHENSIVE. This is a teaching card, not a quick reference. Multi-sentence prose is fine in MoA, biochemistry, PK fields, PD.
- If a section is not supported by the excerpts, use "Not specified in available excerpts" or an empty array. Do NOT fabricate.
- "citation_ids" should cover all major claims across the card — list every excerpt you drew from.
- Stay grounded. If the excerpts cover physiology of related conditions but not the drug specifically, that's fine — explain the pharmacology to the extent supported.
- For mechanism_of_action, biochemistry, and PD: lean into the science. Receptor subtypes, enzyme kinetics, ion channels, signal transduction — write at the level a resident studying for boards expects.`;

export async function POST(req: NextRequest) {
  let body: { drug?: string };
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: 'bad json' }), { status: 400 });
  }
  const raw = (body.drug || '').trim();
  if (!raw) return new Response(JSON.stringify({ error: 'drug required' }), { status: 400 });

  const { stream, emit, close } = makeNdjsonStream();
  const t0 = Date.now();

  (async () => {
    try {
      emit({ type: 'progress', stage: 'expanding', msg: `Normalizing "${raw}" to generic name…` });
      const normalized = await normalizeDrugName(raw);
      emit({ type: 'progress', stage: 'expanding', msg: `Resolved to "${normalized}"`, ms: Date.now() - t0 });

      // Comprehensive query — pulls chunks across mechanism, PK, clinical use, safety
      const query = `${normalized} pharmacology — mechanism of action receptors, pharmacokinetics absorption metabolism excretion half-life, indications dosing, contraindications adverse effects monitoring, special populations`;
      const result = await retrieve(query, { topK: 12, minSimilarity: 0.3 });
      const hits = result.hits;
      emit({ type: 'progress', stage: 'retrieving', msg: `Retrieved ${hits.length} pharmacology excerpts`, ms: Date.now() - t0 });
      if (hits.length === 0) { emit({ type: 'error', message: `no excerpts for "${raw}"` }); close(); return; }

      const citations = hits.map((h, i) => ({
        n: i + 1, id: h.id, book: h.book, chapter: h.chapter,
        page_start: h.page_start, page_end: h.page_end,
        similarity: Number(h.similarity.toFixed(3)),
        preview: h.text.slice(0, 600),
      }));
      emit({ type: 'sources', items: citations });

      const contextBlock = hits.map((h, i) =>
        `--- Excerpt ${i + 1} ---\n[${i + 1}] ${h.book}${h.chapter ? ' · ' + h.chapter : ''}${h.page_start ? ' · p.' + h.page_start : ''}\n${h.text}`
      ).join('\n\n');

      emit({ type: 'progress', stage: 'generating', msg: `Composing comprehensive pharmacology card with ${LOOKUP_MODEL}…`, ms: Date.now() - t0 });
      // Heartbeat: emit a still-generating event every 12s so the client knows we're alive.
      // The Mac Mini may be slow during UpToDate ingest (memory contention with embeddings).
      const heartbeatTimers: ReturnType<typeof setInterval>[] = [];
      const startGen = Date.now();
      const heartbeat = setInterval(() => {
        const elapsed = Math.round((Date.now() - startGen) / 1000);
        emit({ type: 'progress', stage: 'generating', msg: `Still generating with ${LOOKUP_MODEL}… (${elapsed}s elapsed; large pharmacology cards take 30-90s under ingest load)`, ms: Date.now() - t0 });
      }, 12000);
      heartbeatTimers.push(heartbeat);
      let r;
      try {
        r = await llm.chat.completions.create({
          model: LOOKUP_MODEL,
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: `Drug: ${normalized}\n\nExcerpts:\n${contextBlock}\n\nOutput the full pharmacology JSON now. Start with {.` },
          ],
          temperature: 0.2,
          max_tokens: 1800,
          // @ts-expect-error — Ollama extension: keep_alive holds the model in memory between calls
          keep_alive: '15m',
        });
      } finally {
        heartbeatTimers.forEach(clearInterval);
      }
      const llmRaw = r.choices?.[0]?.message?.content ?? '';
      emit({ type: 'progress', stage: 'parsing', msg: 'Parsing pharmacology card…', ms: Date.now() - t0 });
      const parsed = parseLooseJson(llmRaw) as Record<string, unknown>;

      const strArr = (v: unknown) => Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
      const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v)) ? v as Record<string, unknown> : {};

      emit({
        type: 'result',
        data: {
          input: raw,
          normalized,
          drug_normalized: parsed.drug_normalized ?? normalized,
          class: parsed.class ?? '',
          subclass: parsed.subclass ?? '',
          mechanism_of_action: parsed.mechanism_of_action ?? '',
          receptors_targets: strArr(parsed.receptors_targets),
          biochemistry: parsed.biochemistry ?? '',
          pharmacokinetics: obj(parsed.pharmacokinetics),
          pharmacodynamics: parsed.pharmacodynamics ?? '',
          indications: strArr(parsed.indications),
          formulations: strArr(parsed.formulations),
          typical_dosing: strArr(parsed.typical_dosing),
          renal_adjust: parsed.renal_adjust ?? '',
          hepatic_adjust: parsed.hepatic_adjust ?? '',
          contraindications: strArr(parsed.contraindications),
          adverse_effects: strArr(parsed.adverse_effects),
          drug_interactions_summary: strArr(parsed.drug_interactions_summary),
          monitoring: strArr(parsed.monitoring),
          special_populations: obj(parsed.special_populations),
          key_pearls: strArr(parsed.key_pearls),
          citations,
        },
      });
      emit({ type: 'done', ms: Date.now() - t0 });
    } catch (e) {
      emit({ type: 'error', message: String((e as Error).message) });
    } finally { close(); }
  })();

  return new Response(stream, { headers: ndjsonHeaders() });
}
