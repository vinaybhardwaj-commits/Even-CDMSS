import { NextRequest } from 'next/server';
import { retrieve } from '@/lib/retrieve';
import { retrieveMultiQuery } from '@/lib/multi-query';
import { searchPlos, formatPlosForPrompt, type PlosHit } from '@/lib/plos';
import { makeNdjsonStream, ndjsonHeaders } from '@/lib/stream';
import { startTrace, finishTrace, tracedChat, logEvent, setTraceQuestionPreview, setTraceSeverity, setTraceModelSummary, setTraceFinalAnswer } from '@/lib/trace';

export const runtime = 'nodejs';
export const maxDuration = 180;

const DDX_MODEL = 'llama3.1:8b';

const SYSTEM = `You generate a differential diagnosis as JSON. Use ONLY the excerpts below for clinical content.

Return ONLY this JSON object, lowercase keys exactly as shown:
{"summary":"one line","missing_info":["..."],"cannot_miss":[{"diagnosis":"name","likelihood":"high|moderate|low","why_consider":"<25 words","distinguishing_features":["<12 words each"],"investigations":["<12 words each"],"citation_ids":[1,2],"plos_citation_ids":["P1"]}],"most_likely":[...same shape...],"other":[...same shape...]}

- cannot_miss: 2-3 dangerous/time-sensitive (worst-first)
- most_likely: 2-3 by probability
- other: 1-2 less likely
- citation_ids = 1-based numbers from the MEDICAL EXCERPTS (textbook). Cite every textbook claim.
- plos_citation_ids = strings like "P1", "P2" from PLOS ONE ABSTRACTS, if any inform the diagnosis. May be empty array []. CRITICAL: each entry MUST be a JSON string with DOUBLE QUOTES — write ["P1","P2"] not [P1,P2]. Unquoted barewords are invalid JSON and will fail parse.
- No prose, no markdown fences, lowercase keys.`;

type Body = { age?: number | string; sex?: string; cc?: string; history?: string; exam?: string; vitals?: string; includePlos?: boolean; multiQuery?: boolean; selfCritique?: boolean };

const DDX_CRITIQUE_SYSTEM = `You are a clinical auditor reviewing a draft differential diagnosis (DDx) JSON.

Given (1) the clinical presentation, (2) the available source excerpts (textbook [n] and PLOS [P{n}]), and (3) the draft DDx JSON, identify problems.

Output ONLY a JSON object of this shape:
{
  "missing_cannot_miss": ["dangerous diagnoses that should be in cannot_miss but aren't"],
  "likelihood_errors": ["diagnoses with wrong/implausible likelihood"],
  "unsupported_claims": ["claims that aren't backed by the cited excerpt"],
  "missing_evidence": ["important excerpts the draft ignored"],
  "investigation_problems": ["wrong, missing, or low-yield investigations"],
  "citation_problems": ["wrong source attributed, missing citation_ids, etc."],
  "needs_revision": true | false,
  "overall_severity": "none" | "minor" | "moderate" | "major"
}

Empty arrays are fine. Set needs_revision=true if ANY missing_cannot_miss OR any major likelihood_errors OR any clinical_errors. If the draft is solid, return needs_revision=false. Be specific and actionable. No prose outside the JSON.`;

const DDX_REVISION_SYSTEM = `You are revising your earlier DDx draft based on a clinical auditor's critique.

You will receive (1) the clinical presentation, (2) source excerpts, (3) the draft JSON, (4) the auditor's critique. Output the REVISED full DDx JSON using the EXACT shape required:
{"summary":"one line","missing_info":["..."],"cannot_miss":[{"diagnosis":"name","likelihood":"high|moderate|low","why_consider":"<25 words","distinguishing_features":["<12 words each"],"investigations":["<12 words each"],"citation_ids":[1,2],"plos_citation_ids":["P1"]}],"most_likely":[...],"other":[...]}

Apply every fix in the critique: add missing cannot-miss diagnoses, correct likelihood, replace unsupported claims, swap weak investigations, fix citations. No prose, no markdown fences, lowercase keys only. CRITICAL: plos_citation_ids must be quoted strings — write ["P1","P2"] not [P1,P2]. Output MUST be valid JSON.`;


function buildPresentation(b: Body): { display: string; queryHint: string } {
  const parts: string[] = [];
  const agePart = b.age ? `${b.age}` : null;
  const sexPart = b.sex && b.sex !== '?' ? `${b.sex}` : null;
  const demo = [agePart, sexPart].filter(Boolean).join(' / ');
  if (demo) parts.push(demo);
  if (b.cc) parts.push(`Chief complaint: ${b.cc.trim()}`);
  if (b.history) parts.push(`Key history: ${b.history.trim()}`);
  if (b.exam) parts.push(`Exam: ${b.exam.trim()}`);
  if (b.vitals) parts.push(`Vitals: ${b.vitals.trim()}`);
  return { display: parts.join('\n'), queryHint: [demo, b.cc, b.history, b.exam, b.vitals].filter(Boolean).join('; ') };
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
  const traceId = await startTrace('ddx', { cc: body.cc, age: body.age, sex: body.sex, history: body.history, exam: body.exam, vitals: body.vitals });

  // v1.7b S2: capture request + denormalize fast-access fields on traces row.
  await Promise.all([
    logEvent(traceId, 'request_received', null, { body, ua: req.headers.get('user-agent') || '', t: new Date().toISOString() }),
    setTraceQuestionPreview(traceId, display.replace(/\n+/g, ' • ')),
    setTraceModelSummary(traceId, { draft: DDX_MODEL, critique: DDX_MODEL, revise: DDX_MODEL, embedding: 'mxbai-embed-large' }),
  ]);

  (async () => {
    let outcome: 'success' | 'error' | 'partial' = 'success';
    let outcomeMsg: string | undefined;
    try {
      const includePlos = body.includePlos !== false;
      const useMultiQuery = body.multiQuery !== false;  // default true
      const plosQuery = (body.cc || queryHint || display).trim();
      emit({ type: 'progress', stage: 'expanding', msg: useMultiQuery ? 'Generating query variants…' : 'Building clinical summary, expanding query…' });

      const retrievalQuery = queryHint || display;
      const retrievePromise = useMultiQuery
        ? retrieveMultiQuery(retrievalQuery, { topK: 8, minSimilarity: 0.4, bm25Query: (body.cc || '').trim() })
        : retrieve(retrievalQuery, { topK: 8, minSimilarity: 0.4, bm25Query: (body.cc || '').trim() }).then((r) => ({ hits: r.hits, variants: [retrievalQuery], perVariantCounts: [r.hits.length] }));
      const [retrieveResult, plosHits] = await Promise.all([
        retrievePromise,
        includePlos ? searchPlos(plosQuery, { rows: 5, yearsBack: 5 }) : Promise.resolve([] as PlosHit[]),
      ]);
      const hits = retrieveResult.hits;

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

      const contextBlock = hits.map((h, i) => `--- Excerpt ${i + 1} ---\n[${i + 1}] ${h.book}${h.chapter ? ' · ' + h.chapter : ''}${h.page_start ? ' · p.' + h.page_start : ''}\n${h.text}`).join('\n\n');
      const plosBlock = formatPlosForPrompt(plosHits);
      const userMsg = `CLINICAL PRESENTATION:\n${display}\n\nMEDICAL EXCERPTS:\n${contextBlock || '(none)'}\n\n${plosBlock ? 'PLOS ONE ABSTRACTS:\n' + plosBlock + '\n\n' : ''}Output ONLY the JSON object now, starting with {. No prose, no markdown fences.`;

      const useSelfCritique = body.selfCritique !== false;  // default true

      emit({ type: 'progress', stage: useSelfCritique ? 'drafting' : 'generating', msg: `${useSelfCritique ? 'Drafting' : 'Reasoning'} with the reasoning model…`, ms: Date.now() - t0 });
      const draftRes = await tracedChat(traceId, 'ddx_draft', {
        model: DDX_MODEL,
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: userMsg }],
        temperature: 0.2,
        max_tokens: 1500,
        ...({ options: { num_ctx: 16384 }, keep_alive: '15m' } as Record<string, unknown>),
      });
      let raw = draftRes.choices?.[0]?.message?.content ?? '';

      if (useSelfCritique) {
        emit({ type: 'progress', stage: 'reviewing', msg: 'Auditing DDx for missing cannot-miss, likelihood errors, unsupported claims…', ms: Date.now() - t0 });
        let critiqueJson: {
          missing_cannot_miss?: string[]; likelihood_errors?: string[]; unsupported_claims?: string[];
          missing_evidence?: string[]; investigation_problems?: string[]; citation_problems?: string[];
          needs_revision?: boolean; overall_severity?: string;
        } = { needs_revision: false };
        try {
          const critRes = await tracedChat(traceId, 'ddx_critique', {
            model: DDX_MODEL,
            messages: [
              { role: 'system', content: DDX_CRITIQUE_SYSTEM },
              { role: 'user', content: `Clinical presentation:\n${display}\n\nSource excerpts:\n${contextBlock || '(none)'}\n${plosHits.length ? '\nPLOS abstracts:\n' + plosHits.map((p, i) => `[P${i+1}] ${p.title} (${p.year})`).join('\n') + '\n' : ''}\nDraft DDx JSON:\n${raw}\n\nOutput the JSON critique now.` },
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

        const issueCount = (critiqueJson.missing_cannot_miss?.length || 0)
          + (critiqueJson.likelihood_errors?.length || 0)
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

        if (critiqueJson.needs_revision && issueCount > 0) {
          emit({ type: 'progress', stage: 'revising', msg: `Revising DDx to address ${issueCount} issue${issueCount !== 1 ? 's' : ''}…`, ms: Date.now() - t0 });
          const revRes = await tracedChat(traceId, 'ddx_revision', {
            model: DDX_MODEL,
            messages: [
              { role: 'system', content: DDX_REVISION_SYSTEM },
              { role: 'user', content: `Clinical presentation:\n${display}\n\nSource excerpts:\n${contextBlock || '(none)'}\n\nEarlier draft JSON:\n${raw}\n\nAuditor critique:\n${JSON.stringify(critiqueJson, null, 2)}\n\nOutput the revised JSON now.` },
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
      emit({
        type: 'result',
        data: {
          summary: parsed.summary ?? '',
          missing_info: Array.isArray(parsed.missing_info) ? parsed.missing_info : [],
          cannot_miss: Array.isArray(parsed.cannot_miss) ? parsed.cannot_miss : [],
          most_likely: Array.isArray(parsed.most_likely) ? parsed.most_likely : [],
          other: Array.isArray(parsed.other) ? parsed.other : [],
          citations,
          plos_citations: plosCitations,
          presentation: display,
        },
      });
      // v1.7b S2: emit final_answer event + denormalize parsed DDx into traces.final_answer_text
      const finalAnswerText = [
        parsed.summary || '',
        ...((parsed.cannot_miss || []) as Array<{ diagnosis?: string }>).map((d) => 'Cannot-miss: ' + (d.diagnosis || '')),
        ...((parsed.most_likely || []) as Array<{ diagnosis?: string }>).map((d) => 'Likely: ' + (d.diagnosis || '')),
        ...((parsed.other || []) as Array<{ diagnosis?: string }>).map((d) => 'Other: ' + (d.diagnosis || '')),
      ].filter(Boolean).join(' | ');
      await Promise.all([
        logEvent(traceId, 'final_answer', 'done', {
          answer_text: finalAnswerText,
          parsed_full: parsed,
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
