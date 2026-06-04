import OpenAI from 'openai';

const baseURL = `${process.env.OLLAMA_BASE_URL!}/v1`;

export const llm = new OpenAI({ baseURL, apiKey: 'ollama' });

export const TEXT_MODEL = process.env.TEXT_MODEL || 'qwen2.5:14b';
export const EMBED_MODEL = process.env.EMBED_MODEL || 'nomic-embed-text';
export const CRITIQUE_MODEL = process.env.CRITIQUE_MODEL || 'qwen2.5:7b';  // faster than 14b for audit/revise pass
export const EMBED_MODEL_V2 = process.env.EMBED_MODEL_V2 || 'mxbai-embed-large';
export const USE_EMBEDDING_V2 = false; // HOTFIX 2026-05-26: embedding_v2 column NULL for new ingestions; revert after backfill
export const TOP_K = parseInt(process.env.TOP_K || '8', 10);

export async function embedQuery(text: string): Promise<number[]> {
  const res = await llm.embeddings.create({ model: EMBED_MODEL, input: text });
  return res.data[0].embedding;
}

/** v1.6: stronger embedding (1024-dim) for the new column. */
export async function embedQueryV2(text: string): Promise<number[]> {
  const res = await llm.embeddings.create({ model: EMBED_MODEL_V2, input: text });
  return res.data[0].embedding;
}

export function vectorLiteral(v: number[]): string {
  return '[' + v.map((x) => x.toFixed(7)).join(',') + ']';
}
