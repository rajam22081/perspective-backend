#!/usr/bin/env python3
"""
Atelier Recovery Orchestrator
=============================

Re-reads only the pages listed under `failed_pages` in a progress JSON
written by `atelier_pdf_orchestrator.py`. Uses the same source_id from
the progress file so encounters land on the existing source.

Usage:
    python atelier_recover_failed_pages.py \\
        --pdf path/to/book.pdf \\
        --progress progress.json

Optional flags:
    --image-dpi 110           Image render DPI
    --max-image-dimension 2000
    --pause-after 5           Pause after every N pages
    --pause-seconds 15        How long to pause
    --text-only               Skip image rendering, send text only

Environment variables required:
    SUPABASE_URL              e.g. https://xxx.supabase.co
    SUPABASE_ANON_KEY         the anon (public) JWT
"""

import argparse
import base64
import io
import json
import os
import sys
import time
from typing import Optional

import fitz  # PyMuPDF
import requests
from PIL import Image


# --------------------------------------------------------
# Configuration
# --------------------------------------------------------

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "")

if not SUPABASE_URL or not SUPABASE_ANON_KEY:
    print("ERROR: Set SUPABASE_URL and SUPABASE_ANON_KEY environment variables.", file=sys.stderr)
    sys.exit(1)

ENDPOINT = f"{SUPABASE_URL}/functions/v1/atelier-read-chunk"
HEADERS = {
    "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
    "Content-Type": "application/json",
}

RETRY_BACKOFFS = [30, 60, 120, 240, 480]


# --------------------------------------------------------
# PDF processing (mirrors atelier_pdf_orchestrator.py)
# --------------------------------------------------------

def render_page_to_png_base64(page, dpi: int = 110, max_dimension: int = 2000) -> str:
    matrix = fitz.Matrix(dpi / 72, dpi / 72)
    pix = page.get_pixmap(matrix=matrix, alpha=False)
    img = Image.open(io.BytesIO(pix.tobytes("png")))
    if max(img.size) > max_dimension:
        ratio = max_dimension / max(img.size)
        new_size = (int(img.size[0] * ratio), int(img.size[1] * ratio))
        img = img.resize(new_size, Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def extract_page_text(page) -> str:
    text = page.get_text()
    lines = [line.rstrip() for line in text.split("\n")]
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(lines)


# --------------------------------------------------------
# API call with retry
# --------------------------------------------------------

def _is_rate_limited(status_code: int, body: str) -> bool:
    if status_code == 429:
        return True
    if body and "RESOURCE_EXHAUSTED" in body:
        return True
    return False


def read_chunk(source_id: str, chunk_text: str, page_image_b64: str,
               page_number: int, chunk_locator: str,
               timeout: int = 240) -> dict:
    payload = {
        "action": "read_chunk",
        "source_id": source_id,
        "chunk_text": chunk_text,
        "page_image_base64": page_image_b64,
        "page_number": page_number,
        "chunk_locator": chunk_locator,
    }

    last_result = None
    for attempt in range(len(RETRY_BACKOFFS) + 1):
        try:
            r = requests.post(ENDPOINT, headers=HEADERS, json=payload, timeout=timeout)
            if r.ok:
                return r.json()
            body = r.text[:1000]
            last_result = {"success": False, "status_code": r.status_code, "body": body}
            if not _is_rate_limited(r.status_code, body):
                return last_result
            transient_msg = f"HTTP {r.status_code} (rate limited)"
        except requests.exceptions.RequestException as e:
            last_result = {"success": False, "error": f"RequestException: {e}"}
            transient_msg = f"network error: {e}"

        if attempt >= len(RETRY_BACKOFFS):
            break
        wait = RETRY_BACKOFFS[attempt]
        print(f"      ... {transient_msg}; retry {attempt + 1}/{len(RETRY_BACKOFFS)} in {wait}s")
        time.sleep(wait)

    return last_result or {"success": False, "error": "unknown failure"}


# --------------------------------------------------------
# Main
# --------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Re-read failed pages from a progress JSON")
    parser.add_argument("--pdf", required=True, help="Path to PDF file")
    parser.add_argument("--progress", required=True,
                        help="Path to progress JSON produced by atelier_pdf_orchestrator.py")
    parser.add_argument("--image-dpi", type=int, default=110)
    parser.add_argument("--max-image-dimension", type=int, default=2000)
    parser.add_argument("--pause-after", type=int, default=5)
    parser.add_argument("--pause-seconds", type=int, default=15)
    parser.add_argument("--text-only", action="store_true",
                        help="Skip image rendering, send text only")
    args = parser.parse_args()

    if not os.path.exists(args.pdf):
        print(f"ERROR: PDF not found: {args.pdf}", file=sys.stderr)
        sys.exit(1)
    if not os.path.exists(args.progress):
        print(f"ERROR: progress file not found: {args.progress}", file=sys.stderr)
        sys.exit(1)

    with open(args.progress, "r") as f:
        progress = json.load(f)

    source_id = progress.get("source_id")
    if not source_id:
        print("ERROR: progress file missing source_id", file=sys.stderr)
        sys.exit(1)

    failed_pages = list(progress.get("failed_pages", []))
    if not failed_pages:
        print("No failed pages to recover. Nothing to do.")
        return

    # De-duplicate while preserving order, then sort for predictable runs
    failed_pages = sorted(set(failed_pages))
    print(f"Source ID: {source_id}")
    print(f"Re-reading {len(failed_pages)} failed pages: {failed_pages}")

    progress.setdefault("completed_pages", [])
    progress.setdefault("results", {})
    completed_set = set(progress["completed_pages"])

    doc = fitz.open(args.pdf)
    total_pages = len(doc)

    still_failed = []
    recovered = []
    pages_processed = 0

    for page_num in failed_pages:
        if page_num < 1 or page_num > total_pages:
            print(f"[{page_num}] OUT OF RANGE (pdf has {total_pages} pages) — skipped")
            still_failed.append(page_num)
            continue

        page = doc[page_num - 1]
        text = extract_page_text(page)
        text_preview = text[:120].replace("\n", " ")

        if args.text_only:
            page_image_b64 = ""
        else:
            try:
                page_image_b64 = render_page_to_png_base64(
                    page, dpi=args.image_dpi, max_dimension=args.max_image_dimension
                )
            except Exception as e:
                print(f"[{page_num}] ERROR rendering image: {e}")
                still_failed.append(page_num)
                continue

        if not text and not page_image_b64:
            print(f"[{page_num}] EMPTY (no text, no image) — skipped")
            continue

        print(f"[{page_num}] Re-reading... ", end="", flush=True)
        if text_preview:
            print(f'preview: "{text_preview}..."')
        else:
            print("(visual-only page)")

        result = read_chunk(
            source_id=source_id,
            chunk_text=text,
            page_image_b64=page_image_b64,
            page_number=page_num,
            chunk_locator=f"page {page_num}",
        )

        if result.get("success"):
            encounters = result.get("encounters_processed", 0)
            results_list = result.get("results", [])
            outcome_counts = {}
            for r in results_list:
                k = r.get("outcome", "?")
                outcome_counts[k] = outcome_counts.get(k, 0) + 1
            outcome_str = ", ".join(f"{v} {k}" for k, v in outcome_counts.items())
            print(f"   → {encounters} encounters: {outcome_str}")
            recovered.append(page_num)
            if page_num not in completed_set:
                progress["completed_pages"].append(page_num)
                completed_set.add(page_num)
            progress["results"][str(page_num)] = {
                "encounters_processed": encounters,
                "outcome_counts": outcome_counts,
            }
        else:
            err = result.get("error") or result.get("body") or str(result)
            print(f"   → FAILED: {str(err)[:300]}")
            still_failed.append(page_num)

        # Update failed_pages on disk after each page so progress reflects truth
        progress["failed_pages"] = sorted(set(still_failed) | (set(failed_pages) - set(recovered) - set(still_failed)))
        with open(args.progress, "w") as f:
            json.dump(progress, f, indent=2)

        pages_processed += 1
        if args.pause_after > 0 and pages_processed % args.pause_after == 0:
            print(f"   ... pausing {args.pause_seconds}s ...")
            time.sleep(args.pause_seconds)

    # Final write: failed_pages = only what still failed
    progress["failed_pages"] = sorted(set(still_failed))
    with open(args.progress, "w") as f:
        json.dump(progress, f, indent=2)

    print()
    print("=" * 60)
    print("RECOVERY COMPLETE")
    print("=" * 60)
    print(f"Source ID: {source_id}")
    print(f"Recovered: {len(recovered)} pages")
    print(f"Still failed: {len(still_failed)} pages")
    if still_failed:
        print(f"Still-failed pages: {still_failed}")


if __name__ == "__main__":
    main()
