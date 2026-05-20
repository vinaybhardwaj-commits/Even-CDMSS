# Even CDMSS

Even CDMSS — Clinical Decision Making Support System for V + RMOs.

Grounded in MKSAP 19, StatPearls, and UpToDate via local LLM bridge.

## Stack
- Next.js 15.5 (App Router) on Vercel
- Neon Postgres + pgvector
- Ollama LLM bridge (Mac Mini, qwen2.5:14b text + nomic-embed-text embeddings)

## Env vars
- `DATABASE_URL` — Neon, auto-injected by Vercel-Neon integration
- `OLLAMA_BASE_URL` — Cloudflare tunnel root, e.g. `https://llm.llmvinayminihome.uk`
- `TEXT_MODEL` — default `qwen2.5:14b`
- `EMBED_MODEL` — default `nomic-embed-text`
- `TOP_K` — default `8`

## Routes
- `/ask` — RAG Q&A with citations
- `/search` — semantic search (no LLM)
- `/browse` — book/chapter navigation
- `/practice` — quiz mode
- `/topics` — LLM-mediated topic synthesis
