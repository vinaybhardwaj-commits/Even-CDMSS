import { NextRequest } from 'next/server';
import { retrieve } from '@/lib/retrieve';
import { llm } from '@/lib/llm';
import { parseLooseJson, normalizeDrugName } from '@/lib/drugs';
import { makeNdjsonStream, ndjsonHeaders } from '@/lib/stream';

export const runtime = 'nodejs';
export const maxDuration = 120;


function toStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => {
    if (typeof x === 'string') return x;
    if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      const name = String(o.name ?? o.title ?? o.indication ?? o.condition ?? o.drug ?? o.label ?? '');
      const desc = String(o.description ?? o.detail ?? o.note ?? o.value ?? o.dose ?? o.dosing ?? '');
      if (name && desc) return `${name} — ${desc}`;
      if (name) return name;
      if (desc) return desc;
      try { return JSON.stringify(o).replace(/[{}"]/g, ' ').replace(/\s+/g, ' ').trim(); } catch { return ''; }
    }
    return String(x);
  }).filter(Boolean);
}

function toStringDict(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val;
    else if (val && typeof val === 'object') {
      const o = val as Record<string, unknown>;
      const name = String(o.name ?? o.label ?? '');
      const desc = String(o.description ?? o.detail ?? o.value ?? '');
      out[k] = name && desc ? `${name} — ${desc}` : (name || desc || JSON.stringify(o));
    } else if (val != null) out[k] = String(val);
  }
  return out;
}

const FAST_MODEL = 'llama3.1:8b';
const DEEP_MODEL = 'qwen2.5:14b';

const PHASE1_SYSTEM = `You write a clinical-skeleton drug card. Use ONLY the medical excerpts provided.

Return ONLY this JSON, lowercase keys, no prose:
{"drug_normalized":"generic lowercase","class":"pharmacologic class","subclass":"finer subclass or empty","indications":["..."],"typical_dosing":["adult dosing per indication"],"renal_adjust":"one sentence or 'Not specified'","hepatic_adjust":"one sentence or 'Not specified'","contraindications":["absolute first, then relative"],"adverse_effects":["common, then serious"],"monitoring":["what to check + frequency"],"citation_ids":[1,2]}

Rules:
- Be terse on this pass — each bullet 1 line.
- citation_ids: 1-based indices from the excerpts. Cite every claim.
- If unsupported by excerpts, empty array or "Not specified". Never invent.`;

const PHASE2_SYSTEM = `You add deep pharmacology to an existing drug card. Use ONLY the medical excerpts provided.

Return ONLY this JSON, lowercase keys, no prose:
{"mechanism_of_action":"2-4 sentences — receptors, second messengers, enzymes, channels, downstream effects. Mechanistic, not symptomatic.","receptors_targets":["specific molecular targets — receptor, enzyme, channel, transporter — one per item"],"biochemistry":"1-3 sentences on the biochemical pathway / metabolic step, or empty string","pharmacokinetics":{"absorption":"route + F + food effect","distribution":"Vd + protein binding + BBB if relevant","metabolism":"CYPs, prodrug, active metabolites","excretion":"renal/biliary/fecal, % unchanged","half_life":"t½ with range","bioavailability":"F% if oral","onset":"time to onset","duration":"duration of action"},"pharmacodynamics":"dose-response + downstream physiologic effects, 1-3 sentences"}

Rules:
- BE COMPREHENSIVE — boards-level depth. Receptor subtypes, enzyme kinetics, signal transduction.
- If unsupported by excerpts, empty string or empty array. Do not fabricate.
- Use the excerpts to ground but write at a teaching level.`;

const PHASE3_SYSTEM = `You finish a drug card by adding clinical extras. Use ONLY the medical excerpts provided.

Return ONLY this JSON, lowercase keys, no prose:
{"formulations":["available formulations + strengths"],"drug_interactions_summary":["notable interaction classes — e.g. 'NSAIDs blunt antihypertensive effect', 'CYP3A4 inhibitors raise levels'"],"special_populations":{"pregnancy":"category/risk + recommendation, or 'Not specified'","pediatric":"approved/dosing/cautions","geriatric":"considerations","renal_impairment":"additional notes"},"key_pearls":["3-5 high-yield teaching points — clinical pearls, common mistakes, distinguishing features"]}

Rules:
- Concise but specific.
- If unsupported, empty array / "Not specified".`;

function buildContext(hits: Awaited<ReturnType<typeof retrieve>>['hits']): string {
  return hits.map((h, i) =>
    `--- Excerpt ${i + 1} ---\n[${i + 1}] ${h.book}${h.chapter ? ' · ' + h.chapter : ''}${h.page_start ? ' · p.' + h.page_start : ''}\n${h.text}`
  ).join('\n\n');
}

type Phase = { name: string; model: string; system: string; userSuffix: string; maxTokens: number };

const PHASES: Phase[] = [
  { name: 'fast',         model: FAST_MODEL, system: PHASE1_SYSTEM, userSuffix: 'Output the clinical skeleton JSON now.',           maxTokens: 800  },
  { name: 'pharmacology', model: DEEP_MODEL, system: PHASE2_SYSTEM, userSuffix: 'Output the pharmacology JSON now.',                maxTokens: 2000},
  { name: 'extras',       model: DEEP_MODEL, system: PHASE3_SYSTEM, userSuffix: 'Output the formulations/interactions/pops/pearls JSON now.', maxTokens: 700 },
];

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

      const query = `${normalized} pharmacology — mechanism receptors pharmacokinetics indications dosing contraindications adverse effects monitoring special populations`;
      const result = await retrieve(query, { topK: 10, minSimilarity: 0.3 });
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

      const contextBlock = buildContext(hits);

      for (const phase of PHASES) {
        const phaseStart = Date.now();
        emit({ type: 'progress', stage: 'generating', msg: `Phase ${PHASES.indexOf(phase) + 1}/${PHASES.length}: ${phase.name} (${phase.model})…`, ms: Date.now() - t0 });

        // Heartbeat per phase
        const heartbeat = setInterval(() => {
          const elapsed = Math.round((Date.now() - phaseStart) / 1000);
          emit({ type: 'progress', stage: 'generating', msg: `${phase.name}: still generating with ${phase.model}… (${elapsed}s on this phase)`, ms: Date.now() - t0 });
        }, 12000);

        let raw_out = '';
        try {
          const r = await llm.chat.completions.create({
            model: phase.model,
            messages: [
              { role: 'system', content: phase.system },
              { role: 'user', content: `Drug: ${normalized}\n\nExcerpts:\n${contextBlock}\n\n${phase.userSuffix}` },
            ],
            temperature: 0.2,
            max_tokens: phase.maxTokens,
        ...({ options: { num_ctx: 16384 }, keep_alive: '15m' } as Record<string, unknown>),
      });
          raw_out = r.choices?.[0]?.message?.content ?? '';
          const parsed = parseLooseJson(raw_out) as Record<string, unknown>;

          // Coerce all string-array fields (LLMs sometimes return [{name,description}] objects)
          const stringArrayFields = [
            'indications', 'typical_dosing', 'contraindications', 'adverse_effects', 'monitoring',
            'receptors_targets', 'formulations', 'drug_interactions_summary', 'key_pearls',
          ];
          for (const f of stringArrayFields) {
            if (f in (parsed as object)) {
              (parsed as Record<string, unknown>)[f] = toStringList((parsed as Record<string, unknown>)[f]);
            }
          }
          if ('pharmacokinetics' in (parsed as object)) {
            (parsed as Record<string, unknown>).pharmacokinetics = toStringDict((parsed as Record<string, unknown>).pharmacokinetics);
          }
          if ('special_populations' in (parsed as object)) {
            (parsed as Record<string, unknown>).special_populations = toStringDict((parsed as Record<string, unknown>).special_populations);
          }
          // Strings should be strings — coerce non-string scalars too
          for (const f of ['class', 'subclass', 'mechanism_of_action', 'biochemistry', 'pharmacodynamics', 'renal_adjust', 'hepatic_adjust']) {
            const v = (parsed as Record<string, unknown>)[f];
            if (v != null && typeof v !== 'string') (parsed as Record<string, unknown>)[f] = String(v);
          }

          if (phase.name === 'fast') {
            const payload = { ...parsed, input: raw, normalized, drug_normalized: parsed.drug_normalized ?? normalized, citations };
            emit({ type: 'result', data: { phase: 'fast', ...payload } });
          } else {
            emit({ type: 'result', data: { phase: phase.name, ...parsed } });
          }
          emit({ type: 'progress', stage: 'generating', msg: `Phase ${PHASES.indexOf(phase) + 1}/${PHASES.length} ${phase.name} complete`, ms: Date.now() - t0 });
        } catch (e) {
          // Don't kill the whole pipeline if a later phase fails — emit error event and continue
          emit({ type: 'error', message: `phase ${phase.name} failed: ${String((e as Error).message)}` });
        } finally {
          clearInterval(heartbeat);
        }
      }

      emit({ type: 'done', ms: Date.now() - t0 });
    } catch (e) {
      emit({ type: 'error', message: String((e as Error).message) });
    } finally { close(); }
  })();

  return new Response(stream, { headers: ndjsonHeaders() });
}
