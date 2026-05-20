import { llm } from './llm';

export const DRUGS_MODEL = 'llama3.1:8b';

export function parseLooseJson(s: string): unknown {
  let t = s.trim();
  if (t.startsWith('```')) t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return JSON.parse(t);
}

// Normalize a free-text drug name into a canonical lookup string via fast LLM
export async function normalizeDrugName(input: string): Promise<string> {
  const trimmed = input.trim();
  if (trimmed.length === 0) return '';
  if (trimmed.length > 50) return trimmed; // Too long, skip normalization
  try {
    const r = await llm.chat.completions.create({
      model: DRUGS_MODEL,
      messages: [
        { role: 'system', content: 'Return the generic (INN) name of the drug, lowercase, one word or hyphenated. If a brand is given, return the generic. If misspelled, correct it. If not a drug, return the input unchanged. Output ONLY the name, no quotes, no explanation.' },
        { role: 'user', content: trimmed },
      ],
      temperature: 0,
      max_tokens: 20,
    });
    const out = (r.choices?.[0]?.message?.content ?? '').trim().toLowerCase();
    // Sanity: must be alphanumeric+hyphen+space, <50 chars
    if (out && /^[a-z][a-z0-9\s\-]{0,49}$/.test(out)) return out;
    return trimmed;
  } catch {
    return trimmed;
  }
}
