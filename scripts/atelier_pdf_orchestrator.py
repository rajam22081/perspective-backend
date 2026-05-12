#!/usr/bin/env python3
"""
Atelier PDF Reading Orchestrator
=================================

Reads a PDF page by page. For each page:
  - extracts the text
  - renders the page as a PNG image
  - sends both to Atelier's read_chunk Edge Function

Atelier reasons about each page multimodally — text and image together —
and applies the result to its graph.

Usage:
    python atelier_pdf_orchestrator.py \\
        --pdf path/to/book.pdf \\
        --title "Designing Brand Identity" \\
        --author "Alina Wheeler" \\
        --kind book

Optional flags:
    --start-page 1            Start from this page (1-indexed)
    --end-page 0              Stop at this page (0 = read to end)
    --image-dpi 110           Image render DPI (lower = smaller, faster)
    --pause-after 5           Pause briefly after every N pages
    --pause-seconds 15        How long to pause
    --skip-pages 1,2,3        Pages to skip entirely (comma-separated)
    --resume-source <id>      Continue an existing source instead of creating new

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
from typing import Optional, List

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


# --------------------------------------------------------
# PDF processing
# --------------------------------------------------------

def render_page_to_png_base64(page, dpi: int = 110, max_dimension: int = 2000) -> str:
    """Render a PDF page to PNG, base64-encode it.

    DPI of 110 gives roughly 850x1100 pixels for an 8.5x11 page —
    enough for Gemini to read typography clearly without sending
    huge files. We also enforce a max dimension to keep payload
    sizes reasonable.
    """
    matrix = fitz.Matrix(dpi / 72, dpi / 72)
    pix = page.get_pixmap(matrix=matrix, alpha=False)

    # Convert to PIL Image for potential resizing
    img = Image.open(io.BytesIO(pix.tobytes("png")))

    # Constrain max dimension
    if max(img.size) > max_dimension:
        ratio = max_dimension / max(img.size)
        new_size = (int(img.size[0] * ratio), int(img.size[1] * ratio))
        img = img.resize(new_size, Image.LANCZOS)

    # Encode to PNG bytes, then base64
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    png_bytes = buf.getvalue()
    return base64.b64encode(png_bytes).decode("ascii")


def extract_page_text(page) -> str:
    """Extract text from a page, clean it up minimally."""
    text = page.get_text()
    # Collapse runs of whitespace but preserve paragraph breaks
    lines = [line.rstrip() for line in text.split("\n")]
    # Remove empty lines at start/end
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(lines)


# --------------------------------------------------------
# API calls
# --------------------------------------------------------

def create_source(kind: str, title: str, author: Optional[str], reference: Optional[str]) -> str:
    """Create a source record. Returns source_id."""
    payload = {
        "action": "create_source",
        "kind": kind,
        "title": title,
        "author": author,
        "reference": reference,
    }
    r = requests.post(ENDPOINT, headers=HEADERS, json=payload, timeout=30)
    r.raise_for_status()
    data = r.json()
    if not data.get("success"):
        raise RuntimeError(f"create_source failed: {data}")
    return data["source"]["id"]


RETRY_BACKOFFS = [30, 60, 120, 240, 480]


def _is_rate_limited(status_code: int, body: str) -> bool:
    if status_code == 429:
        return True
    if body and "RESOURCE_EXHAUSTED" in body:
        return True
    return False


def read_chunk(source_id: str, chunk_text: str, page_image_b64: str,
               page_number: int, chunk_locator: str,
               timeout: int = 240) -> dict:
    """Send one page (text + image) to Atelier, retrying on rate limits / network errors."""
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

def parse_skip_pages(s: str) -> set:
    if not s:
        return set()
    return set(int(x.strip()) for x in s.split(",") if x.strip())


def main():
    parser = argparse.ArgumentParser(description="Atelier PDF reading orchestrator")
    parser.add_argument("--pdf", required=True, help="Path to PDF file")
    parser.add_argument("--title", required=True)
    parser.add_argument("--author", default=None)
    parser.add_argument("--kind", default="book")
    parser.add_argument("--reference", default=None)
    parser.add_argument("--start-page", type=int, default=1, help="1-indexed")
    parser.add_argument("--end-page", type=int, default=0, help="0 = read to end")
    parser.add_argument("--image-dpi", type=int, default=110)
    parser.add_argument("--max-image-dimension", type=int, default=2000)
    parser.add_argument("--pause-after", type=int, default=5, help="Pause after every N pages")
    parser.add_argument("--pause-seconds", type=int, default=15)
    parser.add_argument("--skip-pages", default="", help="Comma-separated list of 1-indexed pages to skip")
    parser.add_argument("--resume-source", default=None, help="Continue an existing source by id")
    parser.add_argument("--save-progress", default=None,
                        help="Path to JSON file to track progress (resumable)")
    parser.add_argument("--text-only", action="store_true",
                        help="Skip image rendering, send text only")
    args = parser.parse_args()

    if not os.path.exists(args.pdf):
        print(f"ERROR: PDF not found: {args.pdf}", file=sys.stderr)
        sys.exit(1)

    skip_pages = parse_skip_pages(args.skip_pages)

    # Open PDF
    print(f"Opening PDF: {args.pdf}")
    doc = fitz.open(args.pdf)
    total_pages = len(doc)
    print(f"Total pages: {total_pages}")

    # Determine source
    if args.resume_source:
        source_id = args.resume_source
        print(f"Resuming with source_id: {source_id}")
    else:
        print(f"Creating source: {args.title} by {args.author or 'unknown'}")
        source_id = create_source(args.kind, args.title, args.author, args.reference)
        print(f"Created source_id: {source_id}")

    # Determine page range
    start_page = max(1, args.start_page)
    end_page = total_pages if args.end_page <= 0 else min(args.end_page, total_pages)

    print(f"Reading pages {start_page} to {end_page} ({end_page - start_page + 1} pages)")
    if skip_pages:
        print(f"Skipping pages: {sorted(skip_pages)}")

    # Progress file
    progress = {"source_id": source_id, "completed_pages": [], "failed_pages": [], "results": {}}
    if args.save_progress and os.path.exists(args.save_progress):
        with open(args.save_progress, "r") as f:
            progress = json.load(f)
        print(f"Loaded progress from {args.save_progress}: {len(progress['completed_pages'])} pages completed")

    completed_set = set(progress["completed_pages"])

    # Process pages
    pages_processed = 0
    for page_num in range(start_page, end_page + 1):
        if page_num in skip_pages:
            print(f"[{page_num}/{end_page}] SKIPPED (in skip list)")
            continue
        if page_num in completed_set:
            print(f"[{page_num}/{end_page}] SKIPPED (already in progress file)")
            continue

        page = doc[page_num - 1]  # 0-indexed
        text = extract_page_text(page)
        text_preview = text[:120].replace("\n", " ")

        # If text-only mode, skip image rendering
        if args.text_only:
            page_image_b64 = ""
        else:
            try:
                page_image_b64 = render_page_to_png_base64(
                    page, dpi=args.image_dpi, max_dimension=args.max_image_dimension
                )
            except Exception as e:
                print(f"[{page_num}/{end_page}] ERROR rendering image: {e}")
                progress["failed_pages"].append(page_num)
                continue

        # If no text and no image (rare), skip
        if not text and not page_image_b64:
            print(f"[{page_num}/{end_page}] EMPTY (no text, no image) — skipped")
            continue

        print(f"[{page_num}/{end_page}] Reading... ", end="", flush=True)
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
            progress["completed_pages"].append(page_num)
            progress["results"][str(page_num)] = {
                "encounters_processed": encounters,
                "outcome_counts": outcome_counts,
            }
        else:
            err = result.get("error") or result.get("body") or str(result)
            print(f"   → FAILED: {err[:300]}")
            progress["failed_pages"].append(page_num)

        # Save progress
        if args.save_progress:
            with open(args.save_progress, "w") as f:
                json.dump(progress, f, indent=2)

        pages_processed += 1

        # Pause after N pages
        if args.pause_after > 0 and pages_processed % args.pause_after == 0:
            print(f"   ... pausing {args.pause_seconds}s ...")
            time.sleep(args.pause_seconds)

    # Summary
    print()
    print("=" * 60)
    print("READING COMPLETE")
    print("=" * 60)
    print(f"Source ID: {source_id}")
    print(f"Pages completed: {len(progress['completed_pages'])}")
    print(f"Pages failed: {len(progress['failed_pages'])}")
    if progress["failed_pages"]:
        print(f"Failed pages: {progress['failed_pages']}")

    # Aggregate outcomes
    total_outcomes = {}
    for page_str, page_result in progress["results"].items():
        for k, v in page_result.get("outcome_counts", {}).items():
            total_outcomes[k] = total_outcomes.get(k, 0) + v
    if total_outcomes:
        print()
        print("Aggregate outcomes:")
        for k, v in sorted(total_outcomes.items(), key=lambda x: -x[1]):
            print(f"   {k}: {v}")


if __name__ == "__main__":
    main()
  
