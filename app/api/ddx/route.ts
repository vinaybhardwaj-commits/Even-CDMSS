import { NextRequest } from 'next/server';
import { retrieve } from '@/lib/retrieve';
import { retrieveMultiQuery } from '@/lib/multi-query';
import { searchPlos, formatPlosForPrompt, type PlosHit } from '@/lib/plos';
import { makeNdjsonStream, ndjsonHeaders } from '@/lib/stream';
import { startTrace, finishTrace, tracedChat, logEvent, setTraceQuestionPreview, setTraceSeverity, setTraceModelSummary, setTraceFinalAnswer } from '@/lib/trace';
import { filterByDemographics } from '@/lib/ddx-constraints';
import { parseInvestigations, type ParsedInvestigations } from '@/lib/investigations';
import { generateHypotheses, gatherHypothesisEvidence, formatHypothesesForPrompt, type Hypothesis } from '@/lib/ddx-hypothesis';

export const runtime = 'nodejs';
export const maxDuration = 300;  // hypothesis-first beta adds passes; Pro allows 300s. Classic still finishes ~2min.

const DDX_MODEL = 'llama3.1:8b';            // fast pre-passes only: hypotheses + investigations parse
const DDX_DRAFT_MODEL = 'qwen2.5:14b';      // FULL reasoning pipeline: draft + critique + revise. 8b anchored/fabricated as the drafter AND (as the reviser) rewrote good 14b drafts into garbage — keep the reasoning model consistent.

const SYSTEM = `You are an expert physician generating a differential diagnosis as JSON. Use ONLY the supplied excerpts for clinical content, and reason ONLY from the patient findings stated in the presentation.

HARD RULES (a violation makes the output unsafe):
1. DEMOGRAPHICS ARE CONSTRAINTS, NOT HINTS. Never include a diagnosis anatomically or physiologically impossible for the patient's stated sex — e.g. NO ovarian/uterine/cervical/vaginal/pregnancy/eclampsia diagnoses for a male; NO testicular/prostatic/scrotal/penile diagnoses for a female. Weight every diagnosis by age and sex prevalence; exclude diagnoses with negligible prevalence at this age unless a specific stated risk factor supports them (e.g. do not list aortic dissection in a healthy 14-year-old).
2. GROUND EVERYTHING IN STATED FINDINGS. Do not invent or assume any symptom, sign, lab, or imaging result that is not explicitly given. Every why_consider/distinguishing_feature must reference only provided findings. If a finding is explicitly negative or normal (e.g. "no fever", "soft, non-tender abdomen"), use it to LOWER or exclude diagnoses that depend on it — never cite an absent finding as supporting evidence. INVESTIGATION RESULTS, when supplied, are stated findings: reconcile every diagnosis against them — an abnormal result that fits rules a diagnosis IN, a normal/negative result that would be expected to be abnormal rules it DOWN. Never invent or assume a result that is not in the supplied investigation list.
3. INTERPRET, DON'T ANCHOR. Translate lay/patient terms into clinical possibilities (e.g. "indigestion"/epigastric discomfort in an older adult with cardiac risk factors MUST include acute coronary syndrome). Consider diagnoses across ALL relevant organ systems — do not stay inside the system implied by the chief complaint's wording. Explicitly weight risk factors and red flags: age, sex, comorbidities (diabetes, hypertension), sudden onset, diaphoresis, pallor, syncope, symptoms waking the patient from sleep, failure of symptomatic therapy.
4. SPECIFIC / PATHOGNOMONIC RESULTS DOMINATE. When a supplied investigation result is characteristic of or pathognomonic for a particular diagnosis (e.g. PAS-positive macrophages on small-bowel biopsy → Whipple disease; ST-elevation + raised troponin → acute coronary syndrome; anti-CCP → rheumatoid arthritis), that diagnosis MUST be a LEADING consideration — ranked high — not a low-probability afterthought. Never let a common chief-complaint pattern (e.g. chronic diarrhoea → gluten/lactose intolerance) outrank a specific result that points elsewhere. investigation_fit MUST BE TRUTHFUL: a result may support, argue against, OR be non-specific for a diagnosis — NEVER claim a result "supports" a diagnosis when that result is actually characteristic of a DIFFERENT diagnosis.

RANKING — two INDEPENDENT axes:
- cannot_miss = ranked by CONSEQUENCE of a missed or delayed diagnosis (dangerous / time-sensitive), even when probability is LOW. Never place benign or self-limited conditions here. Worst-first. Each item's "likelihood" is its probability for THIS patient and may be low.
- most_likely = ranked by PROBABILITY for this exact presentation.

Return ONLY this JSON object, lowercase keys exactly as shown:
{"summary":"one line","missing_info":["..."],"cannot_miss":[{"diagnosis":"name","likelihood":"high|moderate|low","why_consider":"<25 words","distinguishing_features":["<12 words each"],"investigations":["<12 words each"],"investigation_fit":"","citation_ids":[1,2],"plos_citation_ids":["P1"]}],"most_likely":[...same shape...],"other":[...same shape...]}

- cannot_miss: 2-3 items (worst-first)
- most_likely: 2-3 items (by probability)
- other: 1-2 less likely but reasonable
- investigations = SUGGESTED next workup to confirm/refute this diagnosis (what to ORDER).
- investigation_fit = ONLY when INVESTIGATION RESULTS are supplied in the presentation: one TRUTHFUL clause (<14 words) on how those already-back results bear on THIS diagnosis — it may "support", "argue against", or be "non-specific" (e.g. "troponin elevated + anterior ST-elevation → supports"; "CT head normal → lowers but does not exclude"; "PAS-positive macrophages → characteristic of Whipple, not this dx"). Use "" (empty string) when no results were supplied. Do NOT restate results that were not provided, and do NOT claim a result supports this diagnosis when it is actually characteristic of a different one.
- citation_ids = 1-based numbers from the MEDICAL EXCERPTS (textbook). Cite every textbook claim.
- plos_citation_ids = strings like "P1", "P2" from PLOS ONE ABSTRACTS, if any inform the diagnosis. May be empty array []. CRITICAL: each entry MUST be a JSON string with DOUBLE QUOTES — write ["P1","P2"] not [P1,P2]. Unquoted barewords are invalid JSON and will fail parse.
- No prose, no markdown fences, lowercase keys.`;

type Body = { age?: number | string; sex?: string; cc?: string; history?: string; exam?: string; vitals?: string; investigations?: string; includePlos?: boolean; multiQuery?: boolean; selfCritique?: boolean; engine?: 'classic' | 'hypothesis' };

const DDX_CRITIQUE_SYSTEM = `You are a clinical auditor reviewing a draft differential diagnosis (DDx) JSON for a SPECIFIC patient.

Given (1) the clinical presentation (note the patient's age, sex, and any negative/normal findings), (2) the available source excerpts (textbook [n] and PLOS [P{n}]), and (3) the draft DDx JSON, identify problems.

Output ONLY a JSON object of this shape:
{
  "demographic_impossibility": ["diagnoses impossible for the patient's stated sex/age, e.g. ovarian pathology in a male, prostatitis in a female, aortic dissection in a young child without risk factors"],
  "fabricated_findings": ["findings asserted anywhere in the draft that are NOT present in the clinical presentation"],
  "ignored_negatives": ["diagnoses kept or up-ranked despite a stated negative/normal finding that argues against them"],
  "missing_cannot_miss": ["dangerous, time-sensitive diagnoses that should be in cannot_miss but aren't (include classic atypical high-risk presentations, e.g. ACS presenting as indigestion)"],
  "cannot_miss_misuse": ["benign/self-limited diagnoses wrongly placed in cannot_miss, or dangerous diagnoses mis-ranked vs likelihood"],
  "likelihood_errors": ["diagnoses with wrong/implausible likelihood for this presentation"],
  "anchoring_or_atypical_miss": ["diagnostic anchoring on the chief-complaint wording or one organ system, missing cross-system possibilities the findings support"],
  "investigation_misread": ["ONLY if investigation RESULTS were supplied: a result that is CHARACTERISTIC or PATHOGNOMONIC for a diagnosis which is MISSING or ranked too LOW (e.g. PAS-positive macrophages but Whipple disease absent or low-likelihood; ST-elevation but ACS not top); a diagnosis kept or up-ranked despite a supplied result that argues strongly against it; a supplied abnormal result not reflected anywhere in the DDx; an investigation_fit that claims a result SUPPORTS this diagnosis when the result is actually characteristic of a DIFFERENT diagnosis (fabricated support); or an investigation_fit that misstates or invents a result not in the supplied list"],
  "unsupported_claims": ["claims that aren't backed by the cited excerpt"],
  "investigation_problems": ["wrong, missing, or low-yield investigations"],
  "citation_problems": ["wrong source attributed, missing citation_ids, etc."],
  "needs_revision": true | false,
  "overall_severity": "none" | "minor" | "moderate" | "major"
}

Empty arrays are fine. Set needs_revision=true if ANY of demographic_impossibility, fabricated_findings, ignored_negatives, missing_cannot_miss, cannot_miss_misuse, or investigation_misread is non-empty, OR there are major likelihood_errors. Set overall_severity to "major" if any demographic_impossibility, fabricated_findings, missing_cannot_miss, or investigation_misread exist. Be specific and actionable. No prose outside the JSON.`;

const DDX_REVISION_SYSTEM = `You are revising your earlier DDx draft based on a clinical auditor's critique.

You will receive (1) the clinical presentation, (2) source excerpts, (3) the draft JSON, (4) the auditor's critique. Output the REVISED full DDx JSON using the EXACT shape required:
{"summary":"one line","missing_info":["..."],"cannot_miss":[{"diagnosis":"name","likelihood":"high|moderate|low","why_consider":"<25 words","distinguishing_features":["<12 words each"],"investigations":["<12 words each"],"investigation_fit":"","citation_ids":[1,2],"plos_citation_ids":["P1"]}],"most_likely":[...],"other":[...]}

Apply every fix in the critique: REMOVE diagnoses impossible for the patient's sex/age, DELETE any fabricated findings (reason only from stated findings), remove or down-rank diagnoses contradicted by a stated negative/normal finding OR by a supplied investigation result, ADD missing cannot-miss diagnoses (including atypical high-risk presentations), MOVE benign/self-limited conditions out of cannot_miss, correct likelihoods, broaden across organ systems where the findings support it, replace unsupported claims, swap weak investigations, fix citations. When investigation RESULTS were supplied, set investigation_fit on every diagnosis to a true clause about how the supplied results bear on it (and never invent a result not in the supplied list); leave investigation_fit as "" if no results were supplied. Respect patient demographics as hard constraints. No prose, no markdown fences, lowercase keys only. CRITICAL: plos_citation_ids must be quoted strings — write ["P1","P2"] not [P1,P2]. Output MUST be valid JSON.`;


function buildPresentation(b: Body): { display: string; queryHint: string } {
  const parts: string[] = [];
  const agePart = b.age ? `${b.age}` : null;
  const sexPart = b.sex && b.sex !== '?' ? `${b.sex}` : null;
  const demo = [agePart, sexPart].filter(Boolean).join(' / ');
  if (demo) parts.push(`Patient: ${demo}`);
  if (b.cc) parts.push(`Chief complaint: ${b.cc.trim()}`);
  if (b.history) parts.push(`Key history: ${b.history.trim()}`);
  if (b.exam) parts.push(`Exam: ${b.exam.trim()}`);
  if (b.vitals) parts.push(`Vitals: ${b.vitals.trim()}`);
  // queryHint drives RETRIEVAL only (display drives the prompt). Keep it to the
  // clinically discriminating text — chief complaint, history, exam morphology —
  // and DROP demographics ("38 / F") and vitals ("normal"), which carry no useful
  // semantic signal and drag the embedding toward the wrong neighbourhood.
  return { display: parts.join('\n'), queryHint: [b.cc, b.history, b.exam].filter(Boolean).join('; ') };
}

function parseLooseJson(s: string): unknown {
  let t = s.trim();
  if (t.startsWith('```')) t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  // v1.7c hotfix: model sometimes emits ["plos_citation_ids":[P1, P2]] (unquoted barewords)
  // on the revision pass — JSON.parse rejects that. Coerce to ["P1","P2"] before parse.
  t = t.replace(/("plos_citation_ids"\s*:\s*\[)([^\]]*)(\])/g, (_match, open, inner, close) => {
    const items = String(inner).split(',').map((raw: string) => {
      const tr = raw.trim();
      if (!tr) return '';
      if (/^["'].*["']$/.test(tr)) return tr;                  // already quoted
      return JSON.stringify(tr.replace(/^["']|["']$/g, ''));   // wrap bareword
    }).filter(Boolean).join(',');
    return open + items + close;
  });
  // Same fix for citation_ids if model wraps numbers in strings instead of bare ints — harmless coverage
  return JSON.parse(t);
}

export async function POST(req: NextRequest) {
  let body: Body;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: 'invalid json' }), { status: 400 });
  }
  if (!body.cc || !body.cc.trim()) {
    return new Response(JSON.stringify({ error: 'chief_complaint required' }), { status: 400 });
  }
  const { display, queryHint } = buildPresentation(body);

  const { stream, emit, close } = makeNdjsonStream();
  const t0 = Date.now();
  const traceId = await startTrace('ddx', { cc: body.cc, age: body.age, sex: body.sex, history: body.history, exam: body.exam, vitals: body.vitals, investigations: body.investigations });

  // v1.7b S2: capture request + denormalize fast-access fields on traces row.
  await Promise.all([
    logEvent(traceId, 'request_received', null, { body, ua: req.headers.get('user-agent') || '', t: new Date().toISOString() }),
    setTraceQuestionPreview(traceId, display.replace(/\n+/g, ' • ')),
    setTraceModelSummary(traceId, { draft: DDX_DRAFT_MODEL, critique: DDX_DRAFT_MODEL, revise: DDX_DRAFT_MODEL, embedding: 'mxbai-embed-large' }),
  ]);

  (async () => {
    let outcome: 'success' | 'error' | 'partial' = 'success';
    let outcomeMsg: string | undefined;
    try {
      const includePlos = body.includePlos !== false;
      const useMultiQuery = body.multiQuery !== false;  // default true

      // Investigation findings: LLM-parse the free text into structured, flagged
      // findings BEFORE retrieval so abnormal terms steer recall, and inject the
      // normalised block into the reasoning presentation. Fail-open: on any parse
      // failure the verbatim text still flows in via promptBlock.
      let investigations: ParsedInvestigations | null = null;
      if (body.investigations && body.investigations.trim()) {
        emit({ type: 'progress', stage: 'expanding', msg: 'Interpreting investigation results…' });
        investigations = await parseInvestigations(body.investigations, { age: body.age, sex: body.sex, model: DDX_MODEL, traceId });
      }
      const displayForPrompt = investigations?.promptBlock ? `${display}\n\n${investigations.promptBlock}` : display;
      const investigationTerms = investigations?.abnormalTerms ?? [];

      // Hypothesis-first engine (flag-gated; default classic so production is
      // unchanged). When on, the model proposes a broad differential from clinical
      // reasoning FIRST (run in parallel with the broad retrieval below), then we
      // retrieve evidence targeted at each named candidate — so the differential's
      // breadth is no longer capped by a single semantic search.
      const useHypothesisFirst = body.engine === 'hypothesis'
        || (body.engine !== 'classic' && process.env.DDX_HYPOTHESIS_FIRST === '1');
      if (useHypothesisFirst) emit({ type: 'progress', stage: 'expanding', msg: 'Generating candidate differential from clinical reasoning…' });
      const hypothesesPromise: Promise<Hypothesis[]> = useHypothesisFirst
        ? generateHypotheses(displayForPrompt, { model: DDX_MODEL, traceId, max: 8 })
        : Promise.resolve([]);

      const plosQuery = (body.cc || queryHint || display).trim();
      emit({ type: 'progress', stage: 'expanding', msg: useMultiQuery ? 'Generating query variants…' : 'Building clinical summary, expanding query…' });

      const retrievalQuery = [queryHint || display, ...investigationTerms].filter(Boolean).join('; ');
      const bm25Query = [(body.cc || '').trim(), ...investigationTerms].filter(Boolean).join(' ');
      // Widened from 8 → 16: the differential-enumerating chunks (e.g. the
      // "nodular masses" differential tables) and key cannot-miss diagnoses
      // routinely sit at ranks 9–18, so topK=8 silently truncated the differential.
      const DDX_TOP_K = 16;
      // In hypothesis-first mode the per-candidate retrieval is the primary signal,
      // so run the broad pool as a single query (skips the variant-gen LLM call) to
      // cut Mac-Mini Ollama load. Classic keeps multi-query.
      const broadMultiQuery = useMultiQuery && !useHypothesisFirst;
      const retrievePromise = broadMultiQuery
        ? retrieveMultiQuery(retrievalQuery, { topK: DDX_TOP_K, minSimilarity: 0.4, bm25Query })
        : retrieve(retrievalQuery, { topK: DDX_TOP_K, minSimilarity: 0.4, bm25Query }).then((r) => ({ hits: r.hits, variants: [retrievalQuery], perVariantCounts: [r.hits.length] }));
      const [retrieveResult, plosHits] = await Promise.all([
        retrievePromise,
        includePlos ? searchPlos(plosQuery, { rows: 5, yearsBack: 5 }) : Promise.resolve([] as PlosHit[]),
      ]);

      // Resolve hypotheses (generated in parallel) and, when on, replace the broad
      // pool with targeted per-hypothesis evidence merged with the broad pool.
      // Fail-open: if generation produced nothing, fall back to the broad pool.
      const hypotheses = await hypothesesPromise;
      let hits = retrieveResult.hits;
      if (useHypothesisFirst && hypotheses.length) {
        emit({ type: 'progress', stage: 'retrieving', msg: `Retrieving evidence for ${Math.min(hypotheses.length, 6)} candidate diagnoses…`, ms: Date.now() - t0 });
        const ev = await gatherHypothesisEvidence(hypotheses, retrieveResult.hits, { perDxK: 2, maxTotal: 14, maxHypotheses: 6, traceId });
        if (ev.hits.length) hits = ev.hits;
      }

      // Investigation-driven retrieval leg (BOTH engines), TIGHTENED: only fire for
      // SPECIFIC findings — pathology/imaging/micro/ECG, where a named entity like
      // "PAS-positive macrophages" lives — NEVER plain labs (anemia/ESR/albumin pull
      // non-specific junk that the model then turns into spurious diagnoses). Hits are
      // relevance-gated (≥0.6) so low-similarity chunks can't leak in. Prepended so the
      // decisive evidence sits at the front of the context.
      if (investigations && investigations.findings.length) {
        const SPECIFIC_CATS = new Set(['imaging', 'pathology', 'micro', 'ecg']);
        const findingQueries = investigations.findings
          .filter((f) => f.flag !== 'normal' && f.flag !== 'indeterminate' && SPECIFIC_CATS.has(f.category))
          .map((f) => [f.test, f.value, f.note].filter(Boolean).join(' ').trim())
          .filter((q) => q.length >= 4)
          .slice(0, 4);
        if (findingQueries.length) {
          emit({ type: 'progress', stage: 'retrieving', msg: 'Retrieving evidence for the supplied investigation findings…', ms: Date.now() - t0 });
          const findingHits = (await Promise.all(
            findingQueries.map((q) => retrieve(q, { topK: 3, minSimilarity: 0.55, skipExpand: true }).then((r) => r.hits).catch(() => [])),
          )).flat().filter((h) => (h.similarity ?? 0) >= 0.6);
          if (findingHits.length) {
            const seen = new Set<number | string>();
            const merged: typeof hits = [];
            for (const h of [...findingHits, ...hits]) { if (!seen.has(h.id)) { seen.add(h.id); merged.push(h); } }
            hits = merged.slice(0, Math.max(18, hits.length));
            await logEvent(traceId, 'investigation_retrieval', 'retrieving', { finding_queries: findingQueries, finding_hit_count: findingHits.length, merged_count: hits.length });
          }
        }
      }

      // v1.7b S2: forensic capture — full chunk text + scores + PLOS abstracts
      await Promise.all([
        logEvent(traceId, 'retrieval_hydrated', 'retrieving', {
          variants: retrieveResult.variants,
          per_variant_counts: retrieveResult.perVariantCounts,
          hits: hits.map((h) => ({
            id: h.id, book: h.book, chapter: h.chapter,
            page_start: h.page_start, page_end: h.page_end,
            chunk_type: h.chunk_type,
            similarity: h.similarity,
            // @ts-expect-error v1.6 added these
            source_quality_weight: h.source_quality_weight,
            // @ts-expect-error v1.6 added these
            rerank_score: h.rerank_score,
            text: h.text,
          })),
        }),
        includePlos ? logEvent(traceId, 'plos_search', 'retrieving', {
          query: plosQuery.slice(0, 200),
          hit_count: plosHits.length,
          hits: plosHits.map((p) => ({ doi: p.doi, title: p.title, year: p.year, authors: p.authors, url: p.url, abstract: p.abstract })),
        }) : Promise.resolve(),
      ]);

      if (useMultiQuery && retrieveResult.variants.length > 1) {
        emit({ type: 'progress', stage: 'variants', msg: `Generated ${retrieveResult.variants.length - 1} query variants`, ms: Date.now() - t0 });
      }
      emit({ type: 'progress', stage: 'retrieving', msg: `Retrieved ${hits.length} textbook + ${plosHits.length} PLOS excerpts (fused from ${retrieveResult.variants.length} ${retrieveResult.variants.length === 1 ? 'query' : 'queries'})`, ms: Date.now() - t0 });
      if (hits.length === 0 && plosHits.length === 0) { emit({ type: 'error', message: 'no excerpts above threshold — presentation may be too vague' }); outcome = 'error'; outcomeMsg = 'no excerpts above threshold'; close(); return; }

      const citations = hits.map((h, i) => ({
        n: i + 1, id: h.id, book: h.book, chapter: h.chapter,
        page_start: h.page_start, page_end: h.page_end,
        item_number: h.item_number, chunk_type: h.chunk_type,
        similarity: Number(h.similarity.toFixed(3)),
        preview: h.text.slice(0, 600),
      }));
      const plosCitations = plosHits.map((p, i) => ({
        n: i + 1, kind: 'plos' as const, doi: p.doi, title: p.title,
        authors: p.authors, year: p.year, url: p.url, full_url: p.full_url,
        preview: p.abstract.slice(0, 600),
      }));
      emit({ type: 'sources', items: citations, plos: plosCitations });

      // Cap each excerpt so the widened pool (16) stays within the 16k context
      // window — overflow would silently drop the system prompt and degrade output.
      const contextBlock = hits.map((h, i) => `--- Excerpt ${i + 1} ---\n[${i + 1}] ${h.book}${h.chapter ? ' · ' + h.chapter : ''}${h.page_start ? ' · p.' + h.page_start : ''}\n${h.text.slice(0, 1800)}`).join('\n\n');
      const plosBlock = formatPlosForPrompt(plosHits);
      const sexTxt = (body.sex && body.sex !== '?') ? String(body.sex).trim() : 'not given';
      const ageTxt = body.age ? String(body.age) : 'not given';
      const constraintLine = `PATIENT CONSTRAINTS — apply as hard rules:\n- Sex: ${sexTxt} → exclude any diagnosis impossible for this sex. Age: ${ageTxt} → weight by age prevalence; drop negligible-prevalence diagnoses unless a stated risk factor supports them.\n- Reason ONLY from the findings stated below; do not invent findings; treat any stated negative/normal finding as ruling-down.${investigations ? '\n- INVESTIGATION RESULTS are supplied below — reconcile every diagnosis against them (abnormal fitting results rule a diagnosis in; normal/negative results that would be expected abnormal rule it down) and fill investigation_fit for each diagnosis. A result that is CHARACTERISTIC or PATHOGNOMONIC for a specific diagnosis makes that diagnosis a LEADING, high-ranked consideration — do NOT let the chief-complaint pattern outrank it. investigation_fit must be truthful — never claim a result supports a diagnosis it does not. Never cite a result not in the supplied list.' : ''}\n- cannot_miss = by danger if missed (even at low probability; no benign conditions). most_likely = by probability.`;
      // In hypothesis-first mode, hand the model the reasoned candidate list so it
      // EVALUATES each against the evidence + findings rather than only listing what
      // happened to be retrieved (the anchoring/omission failure mode).
      const candidatesBlock = (useHypothesisFirst && hypotheses.length)
        ? `CANDIDATE DIAGNOSES (proposed from clinical reasoning — evaluate EACH against the findings and the excerpts: keep those that fit, drop any the stated negatives/normals argue against, rank by the two axes below, and you MAY add a diagnosis the findings clearly support):\n${formatHypothesesForPrompt(hypotheses)}\n\n`
        : '';
      const userMsg = `${constraintLine}\n\nCLINICAL PRESENTATION:\n${displayForPrompt}\n\n${candidatesBlock}MEDICAL EXCERPTS:\n${contextBlock || '(none)'}\n\n${plosBlock ? 'PLOS ONE ABSTRACTS:\n' + plosBlock + '\n\n' : ''}Output ONLY the JSON object now, starting with {. No prose, no markdown fences.`;

      const useSelfCritique = body.selfCritique !== false;  // default true

      emit({ type: 'progress', stage: useSelfCritique ? 'drafting' : 'generating', msg: `${useSelfCritique ? 'Drafting' : 'Reasoning'} with the reasoning model…`, ms: Date.now() - t0 });
      const draftRes = await tracedChat(traceId, 'ddx_draft', {
        model: DDX_DRAFT_MODEL,
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: userMsg }],
        temperature: 0.2,
        max_tokens: 1500,
        ...({ options: { num_ctx: 16384 }, keep_alive: '15m' } as Record<string, unknown>),
      });
      let raw = draftRes.choices?.[0]?.message?.content ?? '';

      if (useSelfCritique) {
        emit({ type: 'progress', stage: 'reviewing', msg: 'Auditing DDx for missing cannot-miss, likelihood errors, unsupported claims…', ms: Date.now() - t0 });
        let critiqueJson: {
          demographic_impossibility?: string[]; fabricated_findings?: string[]; ignored_negatives?: string[];
          missing_cannot_miss?: string[]; cannot_miss_misuse?: string[]; likelihood_errors?: string[];
          anchoring_or_atypical_miss?: string[]; investigation_misread?: string[]; unsupported_claims?: string[];
          missing_evidence?: string[]; investigation_problems?: string[]; citation_problems?: string[];
          needs_revision?: boolean; overall_severity?: string;
        } = { needs_revision: false };
        try {
          const critRes = await tracedChat(traceId, 'ddx_critique', {
            model: DDX_DRAFT_MODEL,
            messages: [
              { role: 'system', content: DDX_CRITIQUE_SYSTEM },
              { role: 'user', content: `Clinical presentation:\n${displayForPrompt}\n\nSource excerpts:\n${contextBlock || '(none)'}\n${plosHits.length ? '\nPLOS abstracts:\n' + plosHits.map((p, i) => `[P${i+1}] ${p.title} (${p.year})`).join('\n') + '\n' : ''}\nDraft DDx JSON:\n${raw}\n\nOutput the JSON critique now.` },
            ],
            temperature: 0.1,
            max_tokens: 700,
            ...({ options: { num_ctx: 16384 }, keep_alive: '15m' } as Record<string, unknown>),
          });
          let critRaw = critRes.choices?.[0]?.message?.content?.trim() || '{}';
          if (critRaw.startsWith('```')) critRaw = critRaw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
          const a = critRaw.indexOf('{'); const b = critRaw.lastIndexOf('}');
          if (a >= 0 && b > a) critRaw = critRaw.slice(a, b + 1);
          critiqueJson = JSON.parse(critRaw);
        } catch (e) { console.warn('[ddx critique] parse failed', (e as Error).message); }

        const issueCount = (critiqueJson.demographic_impossibility?.length || 0)
          + (critiqueJson.fabricated_findings?.length || 0)
          + (critiqueJson.ignored_negatives?.length || 0)
          + (critiqueJson.missing_cannot_miss?.length || 0)
          + (critiqueJson.cannot_miss_misuse?.length || 0)
          + (critiqueJson.likelihood_errors?.length || 0)
          + (critiqueJson.anchoring_or_atypical_miss?.length || 0)
          + (critiqueJson.investigation_misread?.length || 0)
          + (critiqueJson.unsupported_claims?.length || 0)
          + (critiqueJson.missing_evidence?.length || 0)
          + (critiqueJson.investigation_problems?.length || 0)
          + (critiqueJson.citation_problems?.length || 0);
        const severity = critiqueJson.overall_severity || (issueCount > 0 ? 'minor' : 'none');

        // v1.7b S2: forensic capture of critique JSON + denormalize severity
        await Promise.all([
          logEvent(traceId, 'critique_parsed', 'reviewing', {
            issue_count: issueCount,
            severity,
            needs_revision: critiqueJson.needs_revision,
            critique: critiqueJson,
          }),
          setTraceSeverity(traceId, severity),
        ]);

        emit({ type: 'critique', severity, issue_count: issueCount, details: critiqueJson });

        // Classic always revises when flagged. Hypothesis-first only revises on a
        // MAJOR audit (the reasoned synthesis is already strong) — saves a whole
        // LLM pass on the latency-heavy beta path for minor/cosmetic issues.
        const allowRevision = !useHypothesisFirst || severity === 'major';
        if (critiqueJson.needs_revision && issueCount > 0 && allowRevision) {
          emit({ type: 'progress', stage: 'revising', msg: `Revising DDx to address ${issueCount} issue${issueCount !== 1 ? 's' : ''}…`, ms: Date.now() - t0 });
          const revRes = await tracedChat(traceId, 'ddx_revision', {
            model: DDX_DRAFT_MODEL,
            messages: [
              { role: 'system', content: DDX_REVISION_SYSTEM },
              { role: 'user', content: `Clinical presentation:\n${displayForPrompt}\n\nSource excerpts:\n${contextBlock || '(none)'}\n\nEarlier draft JSON:\n${raw}\n\nAuditor critique:\n${JSON.stringify(critiqueJson, null, 2)}\n\nOutput the revised JSON now.` },
            ],
            temperature: 0.2,
            max_tokens: 1500,
            ...({ options: { num_ctx: 16384 }, keep_alive: '15m' } as Record<string, unknown>),
          });
          raw = revRes.choices?.[0]?.message?.content ?? raw;
        }
      }

      emit({ type: 'progress', stage: 'parsing', msg: 'Parsing differential…', ms: Date.now() - t0 });

      const parsed = parseLooseJson(raw) as {
        summary?: string; missing_info?: string[];
        cannot_miss?: unknown[]; most_likely?: unknown[]; other?: unknown[];
      };
      // Hard demographic guard: deterministically drop sex-impossible diagnoses
      // (belt-and-suspenders behind the prompt rules). See lib/ddx-constraints.
      const demoFilter = filterByDemographics(parsed, body.sex);
      const ddx = demoFilter.filtered;
      if (demoFilter.removed.length) {
        await logEvent(traceId, 'demographic_filter', 'parsing', { sex: body.sex ?? null, removed: demoFilter.removed });
      }
      emit({
        type: 'result',
        data: {
          summary: ddx.summary ?? '',
          missing_info: Array.isArray(ddx.missing_info) ? ddx.missing_info : [],
          cannot_miss: Array.isArray(ddx.cannot_miss) ? ddx.cannot_miss : [],
          most_likely: Array.isArray(ddx.most_likely) ? ddx.most_likely : [],
          other: Array.isArray(ddx.other) ? ddx.other : [],
          citations,
          plos_citations: plosCitations,
          presentation: display,
          investigations: investigations ? { findings: investigations.findings, summary: investigations.summary, structured: investigations.structured } : undefined,
        },
      });
      // v1.7b S2: emit final_answer event + denormalize parsed DDx into traces.final_answer_text
      const finalAnswerText = [
        ddx.summary || '',
        ...((ddx.cannot_miss || []) as Array<{ diagnosis?: string }>).map((d) => 'Cannot-miss: ' + (d.diagnosis || '')),
        ...((ddx.most_likely || []) as Array<{ diagnosis?: string }>).map((d) => 'Likely: ' + (d.diagnosis || '')),
        ...((ddx.other || []) as Array<{ diagnosis?: string }>).map((d) => 'Other: ' + (d.diagnosis || '')),
      ].filter(Boolean).join(' | ');
      await Promise.all([
        logEvent(traceId, 'final_answer', 'done', {
          answer_text: finalAnswerText,
          parsed_full: ddx,
          demographic_removed: demoFilter.removed,
          char_count: finalAnswerText.length,
          total_ms: Date.now() - t0,
        }),
        setTraceFinalAnswer(traceId, finalAnswerText),
      ]);

      emit({ type: 'done', ms: Date.now() - t0 });
    } catch (e) {
      outcome = 'error';
      outcomeMsg = String((e as Error).message);
      emit({ type: 'error', message: outcomeMsg });
    } finally {
      await finishTrace(traceId, outcome, outcomeMsg);
      close();
    }
  })();

  const headers = ndjsonHeaders();
  headers.set('X-Trace-Id', traceId);
  return new Response(stream, { headers });
}
