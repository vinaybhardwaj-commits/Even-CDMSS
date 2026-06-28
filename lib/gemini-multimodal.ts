/**
 * lib/gemini-multimodal.ts — Vertex Gemini multimodal transport (DA.2).
 *
 * Thin wrapper over the NATIVE Vertex `:generateContent` endpoint so we can send
 * an uploaded clinical document (PDF / PNG / JPEG, base64 inlineData) straight to
 * Gemini 2.5 to read it — typed, scanned, or handwritten. Uses the SAME service-
 * account auth as the rest of CAT (getVertexAccessToken); **no new npm dependency**.
 *
 * PHI: the document only transits Vertex/Tokyo under V's BAA (same posture as the
 * OpenAI-compat chat path). Nothing is persisted here. Soft-fails to null so a
 * region/model/credential problem degrades to "couldn't read the document",
 * never a thrown request.
 */

import { getVertexAccessToken } from './gcp-auth';
import { GEMINI_MODEL, geminiConfigured } from './llm';

const GCP_LOCATION = process.env.GCP_LOCATION || 'asia-south1';
const GCP_PROJECT = process.env.GCP_PROJECT || '';

export const SUPPORTED_DOC_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'image/webp']);

export interface MultimodalOpts {
  model?: string;
  maxOutputTokens?: number;
  temperature?: number;
}

function vertexHost(): string {
  return GCP_LOCATION === 'global' ? 'aiplatform.googleapis.com' : `${GCP_LOCATION}-aiplatform.googleapis.com`;
}

/**
 * Send a system + user prompt plus one inline document to Gemini and return the
 * model's text. Returns null on any failure (caller treats null as "unreadable").
 */
export async function generateFromDocument(
  systemPrompt: string,
  userPrompt: string,
  base64: string,
  mimeType: string,
  opts: MultimodalOpts = {},
): Promise<string | null> {
  if (!geminiConfigured()) {
    console.warn('[multimodal] gemini not configured — cannot read documents');
    return null;
  }
  const model = opts.model || GEMINI_MODEL;
  // Normalise a couple of common mime variants Gemini expects.
  const mime = mimeType === 'image/jpg' ? 'image/jpeg' : mimeType;

  let token: string;
  try {
    token = await getVertexAccessToken();
  } catch (e) {
    console.warn('[multimodal] token mint failed', (e as Error).message);
    return null;
  }

  const url = `https://${vertexHost()}/v1/projects/${GCP_PROJECT}/locations/${GCP_LOCATION}/publishers/google/models/${model}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }, { inlineData: { mimeType: mime, data: base64 } }] }],
    generationConfig: {
      temperature: opts.temperature ?? 0.1,
      // 2.5-Pro is a thinking model — give it ample room so the JSON answer isn't truncated.
      maxOutputTokens: opts.maxOutputTokens ?? 8192,
    },
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.warn(`[multimodal] vertex generateContent ${res.status}: ${detail.slice(0, 300)}`);
      return null;
    }
    const j = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      promptFeedback?: { blockReason?: string };
    };
    if (j.promptFeedback?.blockReason) {
      console.warn('[multimodal] blocked:', j.promptFeedback.blockReason);
      return null;
    }
    const parts = j.candidates?.[0]?.content?.parts ?? [];
    const text = parts.map((p) => p?.text || '').join('').trim();
    return text || null;
  } catch (e) {
    console.warn('[multimodal] fetch failed', (e as Error).message);
    return null;
  }
}
