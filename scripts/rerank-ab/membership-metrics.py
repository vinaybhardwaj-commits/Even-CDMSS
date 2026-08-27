#!/usr/bin/env python3
"""
Membership and ranking metrics for a paired judge / Cohere rerank comparison.

Purpose. Saul's ruling of 14 August requires that a backend comparison report which
candidates each backend uniquely admits and uniquely drops, not only how well the two
rankings correlate. A dropped critical source is invisible to a rank correlation.

Scope and honesty. This is the PILOT harness. It reports metrics over the returned
top-k of each arm, which is 20 through the lab seam. It does NOT observe the full
30-candidate pool, because the lab tool clamps topK at 20 and never returns the pool.
The admission study named in the ruling must archive the pool server-side and score the
identical pool twice. Numbers from this script are harness validation, not admission
evidence, and must never be cited as such.

Input format: one JSON file, a list of query records.

  [
    {
      "query": "...",
      "k_production": 8,
      "arms": {
        "judge":  [{"id": "...", "source": "...", "rerank_score": 1.0, "weight": 0.95}, ...],
        "cohere": [{"id": "...", "source": "...", "rerank_score": 0.88, "weight": 0.95}, ...]
      }
    }
  ]

Each arm list must be in final_rank order as returned.

Usage:  python3 membership-metrics.py pairs.json
"""

import json
import sys
from typing import Any


# Sources whose loss from the served set is treated as clinically material.
# Choosing Wisely statements and the hospital's own adjudicated low-value-care corpus
# are the normative anchors an audit is expected to cite.
CRITICAL_SOURCES = {"choosing-wisely", "even-lvc"}


def ids_at(arm: list[dict[str, Any]], k: int) -> list[str]:
    return [h["id"] for h in arm[:k]]


def score_spread(arm: list[dict[str, Any]]) -> dict[str, Any]:
    scores = [h["rerank_score"] for h in arm]
    distinct = sorted(set(scores), reverse=True)
    ties = {}
    for s in distinct:
        n = scores.count(s)
        if n > 1:
            ties[s] = n
    return {
        "n": len(scores),
        "distinct_values": len(distinct),
        "min": min(scores),
        "max": max(scores),
        "tie_groups": ties,
        "largest_tie_group": max(ties.values()) if ties else 1,
    }


def compare_at_k(rec: dict[str, Any], k: int) -> dict[str, Any]:
    judge = rec["arms"]["judge"]
    cohere = rec["arms"]["cohere"]

    j_ids = ids_at(judge, k)
    c_ids = ids_at(cohere, k)
    j_set, c_set = set(j_ids), set(c_ids)

    shared = j_set & c_set
    judge_only = j_set - c_set
    cohere_only = c_set - j_set
    union = j_set | c_set

    by_id = {h["id"]: h for h in judge} | {h["id"]: h for h in cohere}
    j_rank = {h["id"]: i + 1 for i, h in enumerate(judge)}
    c_rank = {h["id"]: i + 1 for i, h in enumerate(cohere)}

    def ledger(ids: set[str], admitted_by: str) -> list[dict[str, Any]]:
        rows = []
        for cid in sorted(ids, key=lambda x: (c_rank.get(x, 999), j_rank.get(x, 999))):
            h = by_id[cid]
            rows.append({
                "id": cid,
                "source": h.get("source"),
                "admitted_by": admitted_by,
                "judge_rank": j_rank.get(cid),
                "cohere_rank": c_rank.get(cid),
                "critical_source": h.get("source") in CRITICAL_SOURCES,
            })
        return rows

    j_crit = {i for i in j_set if by_id[i].get("source") in CRITICAL_SOURCES}
    c_crit = {i for i in c_set if by_id[i].get("source") in CRITICAL_SOURCES}

    return {
        "k": k,
        "shared_count": len(shared),
        "overlap_rate": round(len(shared) / k, 4),
        "jaccard": round(len(shared) / len(union), 4) if union else None,
        "churn_count": len(cohere_only),
        "churn_pct": round(100 * len(cohere_only) / k, 2),
        "judge_only_at_k": sorted(judge_only),
        "cohere_only_at_k": sorted(cohere_only),
        "critical_source_judge": sorted(j_crit),
        "critical_source_cohere": sorted(c_crit),
        "critical_source_retained": sorted(j_crit & c_crit),
        "critical_source_lost_by_cohere": sorted(j_crit - c_crit),
        "critical_source_gained_by_cohere": sorted(c_crit - j_crit),
        "unique_admit_ledger": ledger(cohere_only, "cohere"),
        "unique_drop_ledger": ledger(judge_only, "judge"),
    }


def analyse(records: list[dict[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {
        "harness": "pilot",
        "observes": "returned top-k of each arm, not the full candidate pool",
        "admissible_as_evidence": False,
        "queries": [],
    }
    agg = {"k8_overlap": [], "k20_overlap": [], "critical_lost": 0,
           "judge_largest_tie": [], "cohere_distinct": []}

    for rec in records:
        kprod = rec.get("k_production", 8)
        kfull = min(len(rec["arms"]["judge"]), len(rec["arms"]["cohere"]))

        q = {
            "query": rec["query"],
            "score_spread": {
                "judge": score_spread(rec["arms"]["judge"]),
                "cohere": score_spread(rec["arms"]["cohere"]),
            },
            "at_production_k": compare_at_k(rec, kprod),
            "at_full_k": compare_at_k(rec, kfull),
        }
        out["queries"].append(q)

        agg["k8_overlap"].append(q["at_production_k"]["overlap_rate"])
        agg["k20_overlap"].append(q["at_full_k"]["overlap_rate"])
        agg["critical_lost"] += len(q["at_production_k"]["critical_source_lost_by_cohere"])
        agg["judge_largest_tie"].append(q["score_spread"]["judge"]["largest_tie_group"])
        agg["cohere_distinct"].append(q["score_spread"]["cohere"]["distinct_values"])

    n = len(records)
    out["summary"] = {
        "queries": n,
        "mean_overlap_at_production_k": round(sum(agg["k8_overlap"]) / n, 4),
        "mean_overlap_at_full_k": round(sum(agg["k20_overlap"]) / n, 4),
        "critical_sources_lost_by_cohere_at_production_k": agg["critical_lost"],
        "judge_largest_tie_group_per_query": agg["judge_largest_tie"],
        "cohere_distinct_scores_per_query": agg["cohere_distinct"],
    }
    return out


def main() -> None:
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    with open(sys.argv[1]) as fh:
        records = json.load(fh)
    print(json.dumps(analyse(records), indent=2))


if __name__ == "__main__":
    main()
