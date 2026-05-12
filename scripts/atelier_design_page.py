#!/usr/bin/env python3
"""
Atelier Design Page Runner
==========================

Sends a brief to atelier-design-page, saves the HTML, and optionally
cross-references the mechanisms it cited against a specific source
(e.g. the Itten source_id) by calling atelier-read-chunk's
get_source_summary action.

Usage (brief from stdin):
    python scripts/atelier_design_page.py \\
        --output pigment-v1.html \\
        --highlight-source 56f14798-7496-4ba1-a48b-5e17f5144a90 <<'EOF'
    A landing page for Pigment, a small independent paint maker...
    EOF

Or brief from a file:
    python scripts/atelier_design_page.py \\
        --brief-file brief.md \\
        --output pigment-v1.html \\
        --highlight-source 56f14798-7496-4ba1-a48b-5e17f5144a90

Environment variables required:
    SUPABASE_URL              e.g. https://xxx.supabase.co
    SUPABASE_ANON_KEY         the anon (public) JWT
"""

import argparse
import json
import os
import sys
import time

import requests

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "")

if not SUPABASE_URL or not SUPABASE_ANON_KEY:
    print("ERROR: Set SUPABASE_URL and SUPABASE_ANON_KEY environment variables.", file=sys.stderr)
    sys.exit(1)

DESIGN_ENDPOINT = f"{SUPABASE_URL}/functions/v1/atelier-design-page"
READ_ENDPOINT = f"{SUPABASE_URL}/functions/v1/atelier-read-chunk"
HEADERS = {
    "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
    "Content-Type": "application/json",
}

RETRY_BACKOFFS = [30, 60, 120]


def _is_rate_limited(status_code: int, body: str) -> bool:
    if status_code == 429:
        return True
    if body and "RESOURCE_EXHAUSTED" in body:
        return True
    return False


def post_with_retry(url: str, payload: dict, timeout: int) -> dict:
    last = None
    for attempt in range(len(RETRY_BACKOFFS) + 1):
        try:
            r = requests.post(url, headers=HEADERS, json=payload, timeout=timeout)
            if r.ok:
                return r.json()
            body = r.text[:1500]
            last = {"success": False, "status_code": r.status_code, "body": body}
            if not _is_rate_limited(r.status_code, body):
                return last
            msg = f"HTTP {r.status_code}"
        except requests.exceptions.RequestException as e:
            last = {"success": False, "error": f"RequestException: {e}"}
            msg = f"network error: {e}"
        if attempt >= len(RETRY_BACKOFFS):
            break
        wait = RETRY_BACKOFFS[attempt]
        print(f"  ... {msg}; retry {attempt + 1}/{len(RETRY_BACKOFFS)} in {wait}s", file=sys.stderr)
        time.sleep(wait)
    return last or {"success": False, "error": "unknown failure"}


def design_page(brief: str, timeout: int = 600) -> dict:
    return post_with_retry(DESIGN_ENDPOINT, {"brief": brief}, timeout)


def get_source_summary(source_id: str, timeout: int = 60) -> dict:
    return post_with_retry(
        READ_ENDPOINT,
        {"action": "get_source_summary", "source_id": source_id},
        timeout,
    )


def main():
    parser = argparse.ArgumentParser(description="Send a brief to atelier-design-page")
    parser.add_argument("--brief-file", default=None,
                        help="Read brief from a file (otherwise read from stdin)")
    parser.add_argument("--output", required=True,
                        help="Path to write the generated HTML")
    parser.add_argument("--highlight-source", default=None,
                        help="Optional source UUID — report which cited mechanisms came from this source")
    parser.add_argument("--meta-output", default=None,
                        help="Optional path to write the full JSON response (reasoning, mechanisms_cited, etc.)")
    args = parser.parse_args()

    if args.brief_file:
        with open(args.brief_file, "r") as f:
            brief = f.read().strip()
    else:
        if sys.stdin.isatty():
            print("ERROR: provide --brief-file or pipe the brief on stdin", file=sys.stderr)
            sys.exit(1)
        brief = sys.stdin.read().strip()

    if not brief:
        print("ERROR: brief is empty", file=sys.stderr)
        sys.exit(1)

    print(f"Brief ({len(brief)} chars):")
    print("  " + brief.replace("\n", "\n  ")[:400] + ("..." if len(brief) > 400 else ""))
    print()
    print(f"POST {DESIGN_ENDPOINT}")
    print("Generating design (this can take 60-180s)... ", end="", flush=True)

    result = design_page(brief)

    if not result.get("success"):
        print("FAILED")
        print(json.dumps(result, indent=2)[:2000])
        sys.exit(1)

    html = result.get("html", "")
    mechanisms_cited = result.get("mechanisms_cited", []) or []
    taste_decisions = result.get("taste_decisions", []) or []
    open_questions = result.get("open_questions", []) or []
    reasoning_summary = result.get("reasoning_summary", "")
    graph_size = result.get("graph_size", "?")

    with open(args.output, "w") as f:
        f.write(html)
    print(f"OK  ({len(html):,} bytes HTML, {graph_size} mechanisms in graph)")
    print(f"Saved: {args.output}")

    if args.meta_output:
        with open(args.meta_output, "w") as f:
            json.dump(result, f, indent=2)
        print(f"Saved meta: {args.meta_output}")

    print()
    print("=" * 60)
    print("REASONING SUMMARY")
    print("=" * 60)
    print(reasoning_summary or "(none)")

    print()
    print("=" * 60)
    print(f"MECHANISMS CITED ({len(mechanisms_cited)})")
    print("=" * 60)
    for m in mechanisms_cited:
        print(f"  - {m}")

    print()
    print("=" * 60)
    print(f"TASTE DECISIONS ({len(taste_decisions)})")
    print("=" * 60)
    for t in taste_decisions:
        if isinstance(t, dict):
            print(f"  - {t.get('decision', '?')}")
            rat = t.get("rationale")
            if rat:
                print(f"      rationale: {rat}")
        else:
            print(f"  - {t}")

    print()
    print("=" * 60)
    print(f"OPEN QUESTIONS ({len(open_questions)})")
    print("=" * 60)
    for q in open_questions:
        print(f"  - {q}")

    if args.highlight_source:
        print()
        print("=" * 60)
        print(f"SOURCE CROSS-REFERENCE  source_id={args.highlight_source}")
        print("=" * 60)
        summary = get_source_summary(args.highlight_source)
        if not summary.get("success"):
            print("FAILED to fetch source summary:")
            print(json.dumps(summary, indent=2)[:1000])
            sys.exit(0)
        source = summary.get("source") or {}
        source_label = source.get("title") or args.highlight_source
        source_mechs = summary.get("mechanisms_added", []) or []
        source_names = set()
        for row in source_mechs:
            m = row.get("mechanisms") or {}
            name = m.get("name")
            if name:
                source_names.add(name.strip().lower())
        cited_set = set(n.strip().lower() for n in mechanisms_cited)
        matched = sorted(cited_set & source_names)
        not_matched_in_source = sorted(cited_set - source_names)
        print(f"Source: {source_label}")
        print(f"  mechanisms attached to this source: {len(source_names)}")
        print(f"  cited mechanisms also attached to this source: {len(matched)}")
        if matched:
            print()
            print("FROM THIS SOURCE (cited & attributed):")
            for m in matched:
                print(f"  ✓ {m}")
        else:
            print()
            print("None of the cited mechanisms are attached to this source.")
        if not_matched_in_source:
            print()
            print("Cited but NOT attached to this source (other sources or foundational):")
            for m in not_matched_in_source:
                print(f"  · {m}")


if __name__ == "__main__":
    main()
