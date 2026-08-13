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

/** One judge request, as the server received it. */
export interface JudgeRequest {
  url: string;
  model: string;
  system: string;
  user: string;
  temperature: number;
  maxTokens: number;
  /** The markers present in this request, in local `[idx]` order. Index i is local index i. */
  markers: string[];
}

export interface JudgeServer {
  readonly port: number;
  /** No `/v1` suffix: `lib/llm.ts:39` appends it. */
  readonly url: string;
  /** Every request body received, in arrival order. */
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
  close(): Promise<void>;
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

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let body: {
        model?: string; temperature?: number; max_tokens?: number;
        messages?: Array<{ role: string; content: string }>;
      } = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* recorded below as empty */ }
      const system = body.messages?.find((m) => m.role === 'system')?.content ?? '';
      const user = body.messages?.find((m) => m.role === 'user')?.content ?? '';

      const segs = passageSegments(user);
      const known = Object.keys(scores);
      const markers = segs
        .sort((a, b) => a.idx - b.idx)
        .map((s) => known.find((k) => s.text.includes(k)) ?? '');

      requests.push({
        url: req.url ?? '', model: String(body.model ?? ''), system, user,
        temperature: Number(body.temperature), maxTokens: Number(body.max_tokens), markers,
      });

      const content = rawContent
        ? rawContent(markers)
        : JSON.stringify(Object.fromEntries(markers.map((m, i) => [String(i), scores[m] ?? 0])));

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model: String(body.model ?? 'test-judge'),
        choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
        ...(includeUsage ? { usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } } : {}),
      }));
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
    close() {
      server.closeAllConnections?.();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}
