import { llm } from './llm';

// Use llama3.1:8b for speed — this runs on every retrieval, so we want it cheap.
const FAST_MODEL = 'llama3.1:8b';

const SYSTEM = `You are a medical query rewriter. Rewrite the user's clinical question into a single dense paragraph (40-80 words) that:
- Expands medical acronyms (HFrEF → heart failure with reduced ejection fraction; COPD → chronic obstructive pulmonary disease; etc.)
- Uses precise clinical terminology and likely textbook phrasing
- Includes relevant adjacent terms (pathophysiology, diagnostic criteria, first-line management)
- Reads like a textbook excerpt that would directly answer the question — NOT like a question

Return only the paragraph. No preamble, no explanation, no quotes.`;

export async function expandQuery(question: string): Promise<string> {
  try {
    const r = await llm.chat.completions.create({
      model: FAST_MODEL,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: question },
      ],
      temperature: 0.1,
      max_tokens: 200,
      // @ts-expect-error — Ollama: num_ctx + keep_alive
      keep_alive: '15m',
      options: { num_ctx: 16384 },
    } as any);
    const txt = r.choices?.[0]?.message?.content?.trim() || '';
    // Belt + suspenders: always retrieve the ORIGINAL question's terms too, so we don't lose specificity
    return txt ? `${question}\n\n${txt}` : question;
  } catch {
    return question; // fail open
  }
}
