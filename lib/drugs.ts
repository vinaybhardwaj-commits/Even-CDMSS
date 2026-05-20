import { llm } from './llm';

export const DRUGS_MODEL = 'llama3.1:8b';

export function parseLooseJson(s: string): unknown {
  let t = s.trim();
  if (t.startsWith('```')) t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  try {
    return JSON.parse(t);
  } catch (firstErr) {
    // Recovery: model output was truncated. Walk back to the last well-formed comma boundary
    // and close all open braces/brackets. We give up on the truncated trailing value/key.
    const repaired = repairTruncatedJson(t);
    if (repaired !== null) {
      try { return JSON.parse(repaired); } catch {}
    }
    throw firstErr;
  }
}

function repairTruncatedJson(t: string): string | null {
  // Walk forward, tracking stack of { [ and string state, until we hit truncation.
  // Then trim to last complete key:value pair and close.
  const stack: string[] = [];
  let inString = false;
  let escape = false;
  let lastSafePos = -1; // index AFTER last successfully-completed value at depth>=1
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') stack.pop();
    if (c === ',' && stack.length >= 1) lastSafePos = i; // valid trim point at depth >=1
  }
  if (lastSafePos === -1) return null;
  // Truncate to lastSafePos (drop trailing partial), then close all open structures
  let head = t.slice(0, lastSafePos);
  // Re-walk to reconstruct unclosed stack
  const closeStack: string[] = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < head.length; i++) {
    const c = head[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') closeStack.push('}');
    else if (c === '[') closeStack.push(']');
    else if (c === '}' || c === ']') closeStack.pop();
  }
  return head + closeStack.reverse().join('');
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
      keep_alive: '15m',
      options: { num_ctx: 16384 },
    } as any);
    const out = (r.choices?.[0]?.message?.content ?? '').trim().toLowerCase();
    // Sanity: must be alphanumeric+hyphen+space, <50 chars
    if (out && /^[a-z][a-z0-9\s\-]{0,49}$/.test(out)) return out;
    return trimmed;
  } catch {
    return trimmed;
  }
}
