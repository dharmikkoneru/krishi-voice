#!/usr/bin/env python3
"""Score a filled evaluation score sheet for krishi-voice.

Usage:
    python3 evaluation/score.py evaluation/score-sheet.csv
    python3 evaluation/score.py --demo

No dependencies beyond the Python standard library. Blank arm fields mean
"not run"; rows are scored per arm only where that arm has an entry or an
unknown flag. See EVALUATION.md for the protocol and thresholds.
"""

import argparse
import csv
import statistics
import sys
from pathlib import Path

ARMS = ("A", "B")
TRUTHY = {"1", "true", "yes", "y"}
TARGET_TOP1 = 0.85
TARGET_UNKNOWN_RECALL = 0.90
MIN_ROWS_TO_DECIDE = 20
LLM_GAIN = 0.10
LLM_EXTRA_MS = 4000


def truthy(value):
    return (value or "").strip().lower() in TRUTHY


def tag_set(value):
    return {t.strip().lower() for t in (value or "").replace("|", ";").split(";") if t.strip()}


def expected_entry(row):
    return (row.get("expected_entry") or "").strip().lower()


def actual_entry(row, arm):
    entry = (row.get(f"{arm}_entry") or "").strip().lower()
    if not entry and truthy(row.get(f"{arm}_unknown")):
        return "unknown"
    return entry


def percentile(values, fraction):
    if not values:
        return 0.0
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, int(round(fraction * (len(ordered) - 1)))))
    return float(ordered[index])


def metrics(rows, arm):
    relevant = []
    for row in rows:
        if not expected_entry(row):
            continue
        if actual_entry(row, arm):
            relevant.append(row)
    if not relevant:
        return None

    total = len(relevant)
    correct = sum(actual_entry(r, arm) == expected_entry(r) for r in relevant)

    tp = fp = fn = 0
    for row in relevant:
        expected = tag_set(row.get("expected_tags"))
        actual = tag_set(row.get(f"{arm}_tags"))
        tp += len(expected & actual)
        fp += len(actual - expected)
        fn += len(expected - actual)
    precision = tp / (tp + fp) if tp + fp else 1.0
    recall = tp / (tp + fn) if tp + fn else 1.0
    tag_f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0

    expected_unknown = [r for r in relevant if expected_entry(r) == "unknown"]
    actual_unknown = [
        r for r in relevant
        if truthy(r.get(f"{arm}_unknown")) or actual_entry(r, arm) == "unknown"
    ]
    unknown_recall = (
        sum(truthy(r.get(f"{arm}_unknown")) or actual_entry(r, arm) == "unknown"
            for r in expected_unknown) / len(expected_unknown)
        if expected_unknown else 1.0
    )
    unknown_precision = (
        sum(expected_entry(r) == "unknown" for r in actual_unknown) / len(actual_unknown)
        if actual_unknown else 1.0
    )

    unsafe = sum(truthy(r.get(f"{arm}_unsafe")) for r in relevant)
    overconfident = sum(
        truthy(r.get(f"{arm}_overconfident"))
        for r in relevant
        if actual_entry(r, arm) != expected_entry(r)
    )
    latencies = []
    for row in relevant:
        raw = (row.get(f"{arm}_ms") or "").strip()
        try:
            latencies.append(float(raw))
        except ValueError:
            pass

    return {
        "n": total,
        "top1": correct / total,
        "tag_f1": tag_f1,
        "unknown_recall": unknown_recall,
        "unknown_precision": unknown_precision,
        "unsafe": unsafe,
        "overconfident": overconfident,
        "p50": percentile(latencies, 0.50),
        "p95": percentile(latencies, 0.95),
    }


def qualifies(result):
    return (
        result["n"] >= MIN_ROWS_TO_DECIDE
        and result["top1"] >= TARGET_TOP1
        and result["unsafe"] == 0
        and result["unknown_recall"] >= TARGET_UNKNOWN_RECALL
    )


def print_arm(name, result):
    if not result:
        print(f"Arm {name}: no filled results yet.")
        return
    print(
        f"Arm {name} (n={result['n']}): "
        f"top-1 {result['top1']:.1%} | tag F1 {result['tag_f1']:.2f} | "
        f"unknown recall {result['unknown_recall']:.1%} | "
        f"unknown precision {result['unknown_precision']:.1%} | "
        f"unsafe {result['unsafe']} | overconfident {result['overconfident']} | "
        f"p50 {result['p50']:.0f} ms | p95 {result['p95']:.0f} ms"
    )


def verdict(a, b):
    if not a:
        print("Decision: no comparable keyword-engine results yet.")
        return
    if a["n"] < MIN_ROWS_TO_DECIDE:
        print(
            f"Decision: pilot only ({a['n']} rows, need {MIN_ROWS_TO_DECIDE}). "
            "Do not decide from this; record the full set."
        )
        return

    if qualifies(a):
        print("Keyword engine meets the bar: top-1, unknown recall, and zero unsafe all pass.")
        if not b:
            print("Decision: keep the keyword engine. No LLM results to compare.")
            return
        gain = b["top1"] - a["top1"]
        gain_ok = gain >= LLM_GAIN - 1e-9
        latency_ok = b["p95"] <= a["p95"] + LLM_EXTRA_MS
        if b["unsafe"]:
            print(f"Decision: keep the keyword engine. Arm B produced {b['unsafe']} unsafe answer(s).")
        elif gain_ok and latency_ok:
            print(
                f"Decision: consider hybrid B (+{gain:.1%} top-1, p95 within budget). "
                "Review its errors and run it past a native speaker before enabling."
            )
        else:
            reasons = []
            if not gain_ok:
                reasons.append(f"gain {gain:+.1%} < {LLM_GAIN:.0%}")
            if not latency_ok:
                reasons.append("p95 latency over budget")
            print("Decision: keep the keyword engine (" + ", ".join(reasons) + ").")
        return

    print("Keyword engine misses the bar: inspect ASR errors, tags and synonyms before adding an LLM.")
    if b and b["unsafe"] == 0 and b["top1"] >= TARGET_TOP1:
        print("Hybrid B looks promising on accuracy, but fix the keyword baseline first to have a fair comparison.")
    else:
        print("Decision: do not add the LLM yet; the failure may be recognition, not extraction.")


DEMO_ROWS = [
    dict(expected_entry="thrips", expected_tags="curl;up;insect;white",
         A_entry="thrips", A_tags="curl;up;insect;white", A_ms="0",
         B_entry="thrips", B_tags="curl;up;insect;white", B_ms="1400"),
    dict(expected_entry="mites", expected_tags="curl;down;bronze",
         A_entry="mites", A_tags="curl;down;bronze", A_ms="0",
         B_entry="mites", B_tags="curl;down;bronze", B_ms="1500"),
    dict(expected_entry="virus", expected_tags="curl;yellow;stunt;white",
         A_entry="virus", A_tags="curl;yellow;stunt", A_ms="0",
         B_entry="virus", B_tags="curl;yellow;stunt;white", B_ms="1350"),
    dict(expected_entry="borer", expected_tags="hole;fruit;caterpillar",
         A_entry="anthracnose", A_tags="spots;fruit", A_ms="0",
         B_entry="borer", B_tags="hole;fruit;caterpillar", B_ms="1600"),
    dict(expected_entry="unknown", expected_tags="",
         A_entry="virus", A_tags="curl", A_ms="0",
         B_entry="", B_unknown="1", B_ms="1500"),
    dict(expected_entry="unknown", expected_tags="",
         A_entry="", A_unknown="1", A_ms="0",
         B_entry="", B_unknown="1", B_ms="1450"),
]


def load_rows(path):
    with Path(path).open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        rows = list(reader)
    missing = {"id", "expected_entry", "expected_tags", "A_entry", "B_entry"} - set(reader.fieldnames or [])
    if missing:
        raise SystemExit(f"Score sheet is missing columns: {', '.join(sorted(missing))}")
    return rows


def main():
    parser = argparse.ArgumentParser(description="Score krishi-voice evaluation results.")
    parser.add_argument("sheet", nargs="?", help="filled CSV score sheet")
    parser.add_argument("--demo", action="store_true", help="score synthetic demo rows instead")
    args = parser.parse_args()

    if args.demo:
        rows = DEMO_ROWS
        print("Synthetic demo rows (not real data).\n")
    elif args.sheet:
        rows = load_rows(args.sheet)
        print(f"Loaded {len(rows)} rows from {args.sheet}\n")
    else:
        parser.error("pass a score sheet or --demo")

    results = {arm: metrics(rows, arm) for arm in ARMS}
    for arm in ARMS:
        print_arm(arm, results[arm])
    print()
    verdict(results["A"], results["B"])


if __name__ == "__main__":
    sys.exit(main())
