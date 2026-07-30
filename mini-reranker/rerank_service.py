"""
CDMSS deterministic cross-encoder reranker — self-hosted on the Mac Mini.

Why this exists: R-10. The LLM-judge reranker (llama3.1 via ollama) is batch-relative
and non-deterministic; ollama cannot serve a cross-encoder (bge returns token soup,
/api/rerank 404s); OpenRouter's Cohere rerank went 403. This is the ₹0, no-external-
dependency, deterministic ruler.

It mimics the OpenRouter/Cohere /rerank contract so the app side reuses the existing
`rerankCohere` fetch path with only a URL (and a 'local' backend label) change:

  POST /rerank
  { "model": "bge-reranker-v2-m3", "query": "<q>", "documents": ["<d0>", "<d1>", ...] }
  -> { "results": [ { "index": i, "relevance_score": float in [0,1] }, ... ],
       "usage": { "search_units": 1 } }

Determinism: model in eval() + torch.no_grad(); no sampling anywhere. Same (query, docs)
in -> byte-identical scores out. relevance_score = sigmoid(logit) so it lands in [0,1]
exactly like Cohere's score (the app must NOT sigmoid again).

Run (see README.md): uvicorn on 0.0.0.0:8712, then expose that port to Vercel the same
way OLLAMA_BASE_URL already is (same tunnel, new port/route).
"""
from __future__ import annotations

import os
from contextlib import asynccontextmanager

import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from sentence_transformers import CrossEncoder

MODEL_NAME = os.environ.get("RERANK_MODEL", "BAAI/bge-reranker-v2-m3")
MAX_SNIPPET_CHARS = int(os.environ.get("RERANK_MAX_CHARS", "600"))  # mirror the app's cap
# fp16 by default to halve the resident footprint (~24GB Mini budget). Set RERANK_DTYPE=fp32
# if any MPS half-precision op errors on your torch version.
DTYPE = os.environ.get("RERANK_DTYPE", "fp16").lower()
_MODEL: CrossEncoder | None = None


def _device() -> str:
    if torch.backends.mps.is_available():   # Apple Silicon Mini
        return "mps"
    return "cpu"


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global _MODEL
    torch.manual_seed(0)  # belt-and-braces; a cross-encoder forward pass is already deterministic
    _MODEL = CrossEncoder(MODEL_NAME, device=_device(), max_length=512)
    if DTYPE in ("fp16", "float16", "half"):
        try:
            _MODEL.model.half()   # ~halves resident memory; fine for a forward-only cross-encoder
        except Exception as e:
            print(f"[reranker] fp16 cast failed ({e}); staying fp32")
    _MODEL.model.eval()
    yield


app = FastAPI(title="CDMSS local reranker", lifespan=lifespan)


class RerankRequest(BaseModel):
    query: str
    documents: list[str]
    model: str | None = Field(default=None)  # accepted + ignored (contract compatibility)


@app.get("/health")
def health() -> dict:
    # Discrimination self-check on the canonical pair the app's probe also uses.
    q = "lumbar imaging for acute low back pain"
    rel = "Routine lumbar imaging is not recommended for acute nonspecific low back pain without red flags."
    irr = "Montelukast is a leukotriene receptor antagonist used for asthma and allergic rhinitis."
    s = _score(q, [rel, irr])
    return {"ok": True, "model": MODEL_NAME, "device": _device(),
            "probe": {"relevant": s[0], "irrelevant": s[1], "margin": round(s[0] - s[1], 4)}}


def _score(query: str, documents: list[str]) -> list[float]:
    if _MODEL is None:
        raise RuntimeError("model not loaded")
    pairs = [[query, (d or "")[:MAX_SNIPPET_CHARS]] for d in documents]
    with torch.no_grad():
        logits = _MODEL.predict(pairs, convert_to_numpy=True, show_progress_bar=False)
    # bge-reranker returns a relevance logit; sigmoid -> [0,1] to match Cohere's scale.
    return [float(1.0 / (1.0 + torch.exp(torch.tensor(-float(x))))) for x in logits]


@app.post("/rerank")
def rerank(req: RerankRequest) -> dict:
    if not req.documents:
        return {"results": [], "usage": {"search_units": 0}}
    try:
        scores = _score(req.query, req.documents)
    except Exception as e:  # never partial — the app's typed-error path expects a clean failure
        raise HTTPException(status_code=500, detail=f"rerank failed: {e}")
    results = [{"index": i, "relevance_score": scores[i]} for i in range(len(req.documents))]
    results.sort(key=lambda r: r["relevance_score"], reverse=True)
    return {"results": results, "usage": {"search_units": 1}}
