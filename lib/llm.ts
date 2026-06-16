import OpenAI from 'openai';
import { getVertexAccessToken } from './gcp-auth';

const baseURL = `${process.env.OLLAMA_BASE_URL!}/v1`;

export const llm = new OpenAI({ baseURL, apiKey: 'ollama' });

// ─────────────────────────────────────────────────────────────────────────────
// Vertex AI (Gemini) — hybrid backend. The local Ollama `llm` above stays the
// default and the fallback; Gemini is used only when fully configured AND a call
// site opts in (see tracedChat's `gemini` option). All inference stays inside the
// GCP project/region pinned by GCP_LOCATION (data residency).
// ─────────────────────────────────────────────────────────────────────────────

/** Default region — override with GCP_LOCATION (e.g. asia-south1 for India residency). */
const GCP_LOCATION = process.env.GCP_LOCATION || 'asia-south1';
const GCP_PROJECT = process.env.GCP_PROJECT || '';

/** Default Gemini model (Vertex publisher-prefixed form is applied at call time). */
export const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-pro';

/** True only when every piece needed to call Vertex is present. */
export function geminiConfigured(): boolean {
  return Boolean(GCP_PROJECT && process.env.GCP_SA_KEY);
}

/** A model string targets Gemini if it names a gemini model (with or without the google/ prefix). */
export function isGeminiModel(model: string | undefined | null): boolean {
  return !!model && /(^|\/)gemini[-.]/i.test(model);
}

function vertexBaseURL(): string {
  // The "global" location uses the un-prefixed host; regional uses {loc}-aiplatform.
  const host =
    GCP_LOCATION === 'global'
      ? 'aiplatform.googleapis.com'
      : `${GCP_LOCATION}-aiplatform.googleapis.com`;
  return `https://${host}/v1beta1/projects/${GCP_PROJECT}/locations/${GCP_LOCATION}/endpoints/openapi`;
}

/** Vertex requires the publisher prefix (google/gemini-2.5-pro). */
export function vertexModelName(model: string): string {
  return model.startsWith('google/') ? model : `google/${model}`;
}

/**
 * Returns an OpenAI-SDK client bound to the Vertex OpenAI-compatible endpoint,
 * authenticated with a freshly-minted (cached) access token. Created per call so
 * the bearer is always current; the token itself is cached in gcp-auth.
 */
export async function getGeminiChatClient(): Promise<OpenAI> {
  const token = await getVertexAccessToken();
  return new OpenAI({ baseURL: vertexBaseURL(), apiKey: token });
}

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
