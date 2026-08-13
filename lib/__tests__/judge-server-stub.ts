/**
 * lib/__tests__/judge-server-stub.ts — a local HTTP server standing in for the rerank judge, so
 * `rerankJudge` runs for real against a real socket.
 *
 * ⚠️ NOT A TEST FILE, AND DELIBERATELY NOT NAMED `.test.ts`. The suite glob is
 * `lib/**\/__tests__/*.test.ts`; `telemetry-db-stub.ts` is named the same way for the same reason.
 *
 * ── WHY THIS WORKS EVEN WITH `installDbStub` INSTALLED. The whole pass rests on it. ─────────────
 * `telemetry-db-stub.ts:103` replaces `globalThis.fetch`. The OpenAI SDK does not use it.
 * `node_modules/openai/core.js:144` is `this.fetch = overriddenFetch ?? index_1.fetch`, bound at
 * client CONSTRUCTION (`lib/llm.ts:41`), and the resolved shim is node-fetch@2, which uses the
 * `http` module. Verified in-process, before and after a stub-style replacement:
 *
 *     require('openai/_shims/index.js').fetch === globalThis.fetch   // false, both times
 *
 * So a judge request bypasses the database stub entirely and reaches a real socket on 127.0.0.1.
 * Nothing here ever opens a socket to any other host.
 *
 * ── HOW ONE BATCH IS TOLD FROM ANOTHER: ONLY BY PASSAGE TEXT. ──────────────────────────────────
 * Model, system prompt, temperature, max_tokens, options, keep_alive and the `QUESTION:` prefix are
 * byte-identical across batches, and `[${idx}]` at `lib/rerank.ts:431` is the LOCAL slice index, so
 * it restarts at `[0]` every batch and carries no batch identity.
 *
 * Every fixture passage therefore begins with a unique marker token, and this server scores each
 * passage by the marker it finds inside that passage's own `[idx]` segment. The reply's keys are the
 * local indices the caller used, so the same marker scores the same wherever it lands. Two
 * constraints on a fixture, from `lib/rerank.ts:430` and `:59`: the text is truncated to
 * `MAX_SNIPPET_CHARS = 600` FIRST and only then whitespace-collapsed, so a marker must sit inside
 * the first 600 characters and must survive `.replace(/\s+/g, ' ')`. A leading single-word token
 * satisfies both.
 *
 * ── WHAT THE SERVER RETURNS ────────────────────────────────────────────────────────────────────
 * HTTP 200, `content-type: application/json`. Only three fields are read, at `lib/rerank.ts:461-464`:
 * `choices[0].message.content`, `usage.prompt_tokens`, `usage.completion_tokens`. `content` is the
 * scoring object as a STRING. `usage` is omitted by default: both `typeof` guards then go false, the
 * two token counts become null, and the batch still records `outcome: 'success'` — nothing throws.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';

/**
 * Which of the three things production asks this server for.
 *
 * ⚠️ THREE CALLS REACH ONE CLIENT. `retrieve` at the production shape makes all of them through the
 * SAME OpenAI client (`lib/llm.ts:41`): the expansion chat (`lib/retrieve.ts:408` → `lib/expand.ts`),
 * the embedding (`:413` → `lib/llm.ts:600`), and the judge chats (`:589` → `lib/rerank.ts:450`).
 * Serving them all from one server is what lets case C run the production path unescaped.
 */
export type JudgeRequestKind = 'judge' | 'expansion' | 'embedding';

/** One request, as the server received it. */
export interface JudgeRequest {
  kind: JudgeRequestKind;
  url: string;
  model: string;
  system: string;
  user: string;
  temperature: number;
  maxTokens: number;
  /** The markers present in this request, in local `[idx]` order. Index i is local index i. */
  markers: string[];
  /** Embedding requests only: the exact text handed to `embedQuery`. */
  input?: string;
}

export interface JudgeServer {
  readonly port: number;
  /** No `/v1` suffix: `lib/llm.ts:39` appends it. */
  readonly url: string;
  /** Every request body received, in arrival order, whatever its kind. */
  readonly requests: JudgeRequest[];
  /** marker → score on the judge's own 0–10 scale. */
  setScores(scores: Record<string, number>): void;
  /**
   * Replace the `content` string wholesale, for the malformed-response attacks. The callback gets
   * the markers of that request in local index order. `null` restores normal scoring.
   */
  setRawContent(fn: ((markers: string[]) => string) | null): void;
  /** Include a `usage` block. Off by default — only turn it on to assert token counts. */
  setIncludeUsage(on: boolean): void;
  /** The paragraph the expansion chat returns. Fixed, so `expandedQuery` is deterministic. */
  setExpansion(text: string): void;
  /**
   * Override the embedding vector, for the attack that returns a different vector on the second
   * call. `null` restores the deterministic per-input vector.
   */
  setEmbeddingOverride(fn: ((input: string, callIndex: number) => number[]) | null): void;
  /**
   * Send every chat to the judge responder, ignoring the system prompt. This is the "route the
   * expansion to the judge by mistake" attack, kept here so it can be run without editing the file.
   */
  setChatDiscrimination(on: boolean): void;
  close(): Promise<void>;
}

// ── The embedding vector ───────────────────────────────────────────────────────────────────────
// `EMBED_MODEL` is 'nomic-embed-text' (`lib/llm.ts:593`) and its column is the 768-dimension nomic
// space — `lib/jats-chunk.ts:9` calls it "the nomic-768 embedder", and `lib/llm.ts:604` /
// `lib/retrieve.ts:23` establish 1024 for the mxbai `embedding_v2` column by contrast. The schema
// itself declares `VECTOR` with no explicit dimension (`migrations/0019_even_ground.sql:19` says so
// in as many words), so 768 comes from the code's own statements rather than from a DDL constraint.
export const EMBED_DIMENSION = 768;

/**
 * A DETERMINISTIC vector for a given input string. Case C runs twice and both runs must produce
 * byte-identical results, so nothing here may be random: an FNV-1a hash of the input seeds a plain
 * LCG, and the same text always yields the same 768 floats.
 */
export function deterministicEmbedding(input: string, dim = EMBED_DIMENSION): number[] {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const out = new Array<number>(dim);
  let s = h || 1;
  for (let i = 0; i < dim; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = (s / 0xffffffff) * 2 - 1;   // [-1, 1)
  }
  return out;
}

/**
 * ⚠️ BASE64 FLOAT32, NOT A JSON ARRAY, AND THIS IS NOT OPTIONAL.
 * `embedQuery` calls `llm.embeddings.create({ model, input })` with no `encoding_format`, and
 * `node_modules/openai/resources/embeddings.js:44-47` therefore sends `encoding_format: 'base64'`
 * and unconditionally decodes the reply through `Core.toFloat32Array`
 * (`node_modules/openai/core.js:968-973`), which does `Buffer.from(str, 'base64')`. A plain array
 * here would be decoded as if it were base64 and produce garbage.
 */
export function encodeEmbedding(vec: number[]): string {
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
  return buf.toString('base64');
}

/** Split a user message into its `[idx] text` passage segments, in local index order. */
export function passageSegments(userMsg: string): Array<{ idx: number; text: string }> {
  const body = userMsg.split('PASSAGES:\n')[1] ?? '';
  const out: Array<{ idx: number; text: string }> = [];
  for (const m of body.matchAll(/\[(\d+)\]\s([\s\S]*?)(?=\n\n\[\d+\]\s|\n\nReturn the JSON|$)/g)) {
    out.push({ idx: Number(m[1]), text: m[2] });
  }
  return out;
}

/**
 * Start the server and apply the environment it implies.
 *
 * ⚠️ AWAIT THIS BEFORE THE DYNAMIC IMPORT OF `../rerank`. Three of these writes are read at MODULE
 * LOAD and cannot be fixed afterwards; the rest are read at run time and are set here anyway so one
 * call leaves the whole environment in a known state. The per-line reasons are in the comments.
 */
export async function startJudgeServer(initialScores: Record<string, number> = {}): Promise<JudgeServer> {
  const requests: JudgeRequest[] = [];
  let scores: Record<string, number> = { ...initialScores };
  let rawContent: ((markers: string[]) => string) | null = null;
  let includeUsage = false;
  let expansionText = 'expanded clinical paragraph, fixed so the expanded query is deterministic';
  let embeddingOverride: ((input: string, callIndex: number) => number[]) | null = null;
  let discriminateChat = true;
  let embeddingCalls = 0;

  const json = (res: ServerResponse, payload: unknown) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let body: {
        model?: string; temperature?: number; max_tokens?: number; input?: string;
        messages?: Array<{ role: string; content: string }>;
      } = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* recorded below as empty */ }
      const url = req.url ?? '';

      // ── EMBEDDINGS ──────────────────────────────────────────────────────────────────────────
      if (url.includes('/embeddings')) {
        const input = String(body.input ?? '');
        const vec = embeddingOverride ? embeddingOverride(input, embeddingCalls) : deterministicEmbedding(input);
        embeddingCalls += 1;
        requests.push({
          kind: 'embedding', url, model: String(body.model ?? ''), system: '', user: '',
          temperature: NaN, maxTokens: NaN, markers: [], input,
        });
        json(res, {
          object: 'list',
          model: String(body.model ?? 'nomic-embed-text'),
          data: [{ object: 'embedding', index: 0, embedding: encodeEmbedding(vec) }],
          usage: { prompt_tokens: 1, total_tokens: 1 },
        });
        return;
      }

      // ── CHAT: expansion or judge ────────────────────────────────────────────────────────────
      const system = body.messages?.find((m) => m.role === 'system')?.content ?? '';
      const user = body.messages?.find((m) => m.role === 'user')?.content ?? '';

      // ⚠️ KEYED ON THE SYSTEM PROMPT, NOT ON "every chat is a judge call". The expansion prompt
      // opens "You are a medical query rewriter" (`lib/expand.ts`) and the judge's opens "You are a
      // clinical relevance judge" (`lib/rerank.ts:365`). Model would also separate them, but only
      // because this harness sets RERANK_JUDGE_MODEL; the prompt is the property of the code.
      const isExpansion = discriminateChat && /medical query rewriter/i.test(system);

      const segs = passageSegments(user);
      const known = Object.keys(scores);
      const markers = segs
        .sort((a, b) => a.idx - b.idx)
        .map((s) => known.find((k) => s.text.includes(k)) ?? '');

      requests.push({
        kind: isExpansion ? 'expansion' : 'judge',
        url, model: String(body.model ?? ''), system, user,
        temperature: Number(body.temperature), maxTokens: Number(body.max_tokens), markers,
      });

      const content = isExpansion
        ? expansionText
        : rawContent
          ? rawContent(markers)
          : JSON.stringify(Object.fromEntries(markers.map((m, i) => [String(i), scores[m] ?? 0])));

      json(res, {
        model: String(body.model ?? 'test-judge'),
        choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
        ...(includeUsage ? { usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } } : {}),
      });
    });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;

  // ── READ AT MODULE LOAD. These must be set before `../rerank` (and through it `../llm`) loads. ──
  process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${port}`;  // lib/llm.ts:39 appends '/v1' itself
  delete process.env.GCP_PROJECT;                            // lib/llm.ts:52 → geminiConfigured() false
  process.env.RERANK_JUDGE_MODEL = 'test-judge';             // lib/rerank.ts:57

  // ── READ AT RUN TIME. Order does not matter; set anyway so the state is known. ─────────────────
  process.env.LLM_PIPELINE = 'mini';        // lib/llm.ts:95 → geminiUtilityModel() undefined
  delete process.env.GEMINI_ALL;            // lib/llm.ts:311
  delete process.env.GEMINI_UTILITY;        // lib/llm.ts:311
  delete process.env.GCP_SA_KEY;            // lib/llm.ts:82
  delete process.env.GEMINI_VIA_OPENROUTER; // lib/llm.ts:133

  // ── AND THESE TWO, WHICH CAN OPEN A REAL OUTBOUND SOCKET. ──────────────────────────────────────
  // `cohereRelevanceScores` (lib/rerank.ts:118) reads OPENROUTER_API_KEY directly and posts to
  // https://openrouter.ai/api/v1/rerank. It has NO miniPipeline() gate, so LLM_PIPELINE='mini' does
  // not stop it. With RERANK_BACKEND=cohere exported in the shell, `rerank()` would take the
  // env-default cohere arm and make that call for real.
  delete process.env.RERANK_BACKEND;
  delete process.env.OPENROUTER_API_KEY;

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    setScores(next) { scores = { ...next }; },
    setRawContent(fn) { rawContent = fn; },
    setIncludeUsage(on) { includeUsage = on; },
    setExpansion(text) { expansionText = text; },
    setEmbeddingOverride(fn) { embeddingOverride = fn; },
    setChatDiscrimination(on) { discriminateChat = on; },
    close() {
      server.closeAllConnections?.();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}
