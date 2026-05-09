# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository shape

Backend for three Myndlabs products that share a Supabase project:

- **Sable** (`supabase/functions/sable-read-chunk/`, schema `myndlabs_sable`) — software-architecture knowledge graph; reads books via Anthropic Claude.
- **Atelier** (`supabase/functions/atelier-read-chunk/` and `atelier-design-page/`, schema `myndlabs_atelier`) — web-design knowledge graph + HTML page generator; reads multimodally (text + page image) via Vertex AI Gemini.
- **Perspective** (`supabase/functions/perspective-chat-v3/`, default Postgres `public` schema) — personal-intelligence graph chat using Gemini 2.5 Flash, with a "mutation gate" that decides whether each user message becomes a durable graph node.

Edge Functions are Deno/TypeScript. Migrations are SQL. Two orchestrators (`atelier-orchestrator.ts`, `scripts/atelier_pdf_orchestrator.py`) run **locally** and call the deployed functions over HTTPS — they are not deployed.

There is no `package.json`, no `requirements.txt`, no test suite, and no linter config. Type checking happens at deploy time via the Supabase CLI / Deno.

## Deployment

All deploys are triggered by `push` to `main` with path filters:

- `.github/workflows/deploy-functions.yml` — deploys `perspective-chat-v3` (JWT-verified) and `sable-read-chunk` (`--no-verify-jwt`).
- `.github/workflows/deploy-atelier.yml` — deploys `atelier-read-chunk` and `atelier-design-page` (both `--no-verify-jwt`). Triggered by changes under either function's directory.
- `.github/workflows/deploy-migrations.yml` — runs `supabase db push --include-all` on changes under `supabase/migrations/**`.

Manual equivalents:

```bash
# Deploy a single function (replace <name>)
supabase functions deploy <name> --project-ref "$SUPABASE_PROJECT_ID" [--no-verify-jwt]

# Push migrations
supabase link --project-ref "$SUPABASE_PROJECT_ID" --password "$SUPABASE_DB_PASSWORD"
supabase db push --include-all --password "$SUPABASE_DB_PASSWORD"
```

CI secrets: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_ID`, `SUPABASE_DB_PASSWORD`. Function runtime secrets (set in Supabase, not GitHub): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY` (sable), `GEMINI_API_KEY` (perspective), `GCP_SERVICE_ACCOUNT_JSON` / `GCP_PROJECT_ID` / `GCP_REGION` (atelier).

## Running orchestrators locally

```bash
# Plain-text books → Atelier
deno run --allow-read --allow-net --allow-env atelier-orchestrator.ts \
  --book ./book.txt --title "..." --author "..."
# Optional env: CHUNK_SIZE, DELAY_MS, PAUSE_AFTER_CHUNKS, SUPABASE_URL, SUPABASE_ANON_KEY

# PDFs → Atelier (multimodal: each page rendered to PNG + text extracted)
python scripts/atelier_pdf_orchestrator.py \
  --pdf book.pdf --title "..." --author "..." [--start-page N] [--end-page N] [--text-only]
# Requires: PyMuPDF (fitz), Pillow, requests
# Required env: SUPABASE_URL, SUPABASE_ANON_KEY
```

Both orchestrators POST to `${SUPABASE_URL}/functions/v1/atelier-read-chunk` with `action: "create_source"` once, then `action: "read_chunk"` per chunk. Use `--save-progress progress.json` (Python) or the Enter/q prompt every N chunks (Deno) for long runs.

## The shared epistemic architecture (Sable + Atelier)

This is the load-bearing concept and reading multiple files won't make it obvious. Both knowledge-graph products encode the same discipline in their schema and prompts:

- A **mechanism** is the underlying cause-and-effect logic, with explicit `derivation`, `boundary`, and (Atelier) `outside_boundary` + `alternatives`. It is *not* a paraphrase of a source's claim.
- Source authority is not evidence. A claim from a book does not enter the graph as a mechanism until its derivation can be traced from existing mechanisms — or, rarely, marked `foundational` because it doesn't reduce further.
- Claims that can't be derived are queued: `pending_questions` (Sable) or `unresolved_encounters` (Atelier). These are first-class — they are the map of "told but not understood."
- When a chunk is read, the function loads the **entire current graph** (or a curated slice) into the LLM prompt as "what you already understand," so triage decisions stay coherent across chunks.

`sable-read-chunk` does this in **two passes** (extract candidate claims → triage each). `atelier-read-chunk` does it in **one multimodal pass** with five outcomes: `existing`, `new_mechanism`, `new_entry` (partial reasoning, gaps named), `unresolved`, `not_a_claim`. The "entry" tier is Atelier-specific — it's how partial working-through gets persisted without inflating the mechanism graph.

When editing prompts in these functions, preserve this structure: the schema (alternatives, outside_boundary, entries vs mechanisms vs unresolved) exists *because* of the prompt's outcome categories. Changing one without the other breaks `applyEncounter` / `applyTriage`.

## Cross-cutting conventions

- **Schema isolation**: each product's edge function pins its schema in the Supabase client (`{ db: { schema: "myndlabs_atelier" } }`). Don't query across schemas from one function.
- **Mechanism resolution by name, not UUID**: triage prompts ask the model to return canonical lowercase mechanism names; the function resolves to UUID. UUID-by-model is unreliable. Names are unique.
- **Graceful degradation, not silent failure**: when the model says "existing" but the named mechanism isn't in the graph, code falls back to `pending` rather than dropping the encounter. Preserve this pattern.
- **Vertex AI auth (Atelier)**: service-account JSON → JWT → OAuth token, cached in module scope until 5 min before expiry. Both atelier functions duplicate this code — if you change one, change both.
- **Migration ordering**: timestamps in `supabase/migrations/` are the canonical order. The Sable schema is `drop schema cascade`'d and rebuilt in `20260427110000_sable_mechanisms.sql` — that migration assumed the graph was empty. Don't replicate that pattern once data exists.
