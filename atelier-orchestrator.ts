// =====================================================
// Atelier Orchestrator
// Reads a design source file, chunks it, feeds to the
// atelier-read-chunk edge function. Pauses periodically
// for review.
//
// Usage:
//   deno run --allow-read --allow-net --allow-env atelier-orchestrator.ts \
//     --book ./bringhurst-elements.txt \
//     --title "The Elements of Typographic Style" \
//     --author "Robert Bringhurst"
// =====================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "https://kzxmlbcjbgltdrvbbsra.supabase.co";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const ENDPOINT = `${SUPABASE_URL}/functions/v1/atelier-read-chunk`;

const CHUNK_SIZE = parseInt(Deno.env.get("CHUNK_SIZE") || "4000");
const DELAY_MS = parseInt(Deno.env.get("DELAY_MS") || "2000");
const PAUSE_AFTER_CHUNKS = parseInt(Deno.env.get("PAUSE_AFTER_CHUNKS") || "5");

// =====================================================
// PARSE ARGS
// =====================================================

const args = parseArgs(Deno.args);
const bookPath = args.book;
const bookTitle = args.title;
const bookAuthor = args.author || "";
const bookKind = args.kind || "book";

if (!bookPath || !bookTitle) {
  console.error("Usage: --book <path> --title <title> [--author <author>] [--kind <kind>]");
  Deno.exit(1);
}

// =====================================================
// MAIN
// =====================================================

async function main() {
  console.log("=".repeat(60));
  console.log("Atelier Reader Orchestrator");
  console.log("=".repeat(60));
  console.log(`Source: ${bookTitle}`);
  console.log(`Author: ${bookAuthor || "(none)"}`);
  console.log(`Path: ${bookPath}`);
  console.log(`Chunk size: ${CHUNK_SIZE} chars`);
  console.log(`Delay between chunks: ${DELAY_MS}ms`);
  console.log(`Pause every ${PAUSE_AFTER_CHUNKS} chunk(s) for review`);
  console.log("=".repeat(60));

  let bookText: string;
  try {
    bookText = await Deno.readTextFile(bookPath);
  } catch (e) {
    console.error(`Failed to read ${bookPath}:`, (e as Error).message);
    Deno.exit(1);
  }
  console.log(`Loaded ${bookText.length} chars`);

  const chunks = chunkBook(bookText, CHUNK_SIZE);
  console.log(`Split into ${chunks.length} chunks`);
  console.log("");

  console.log("Creating source record...");
  const sourceId = await createSource();
  if (!sourceId) {
    console.error("Failed to create source. Aborting.");
    Deno.exit(1);
  }
  console.log(`Source created: ${sourceId}`);
  console.log("");

  for (let i = 0; i < chunks.length; i++) {
    const chunkNum = i + 1;
    const locator = `chunk ${chunkNum} of ${chunks.length}`;
    console.log(`[${chunkNum}/${chunks.length}] Reading ${locator}...`);
    console.log(`  Preview: ${chunks[i].slice(0, 120).replace(/\n/g, " ")}...`);

    const result = await readChunk(sourceId, chunks[i], locator);
    if (!result) {
      console.error(`  Chunk ${chunkNum} failed. Continuing...`);
      console.log("");
      await sleep(DELAY_MS);
      continue;
    }

    console.log(`  Claims processed: ${result.claims_processed}`);
    const counts: Record<string, number> = {};
    for (const r of result.results || []) {
      counts[r.outcome] = (counts[r.outcome] || 0) + 1;
    }
    for (const [outcome, count] of Object.entries(counts)) {
      console.log(`    ${outcome}: ${count}`);
    }

    for (const r of result.results || []) {
      const summary =
        r.outcome === "derivable_new"
          ? `+ NEW MECHANISM: ${r.mechanism_name}`
          : r.outcome === "existing_mechanism"
            ? `~ existing: ${r.mechanism_id?.slice(0, 8)}...`
            : r.outcome === "pending"
              ? `? pending: ${r.obstruction?.slice(0, 80) || ""}`
              : `! ${r.outcome}: ${r.error || ""}`;
      console.log(`    ${summary}`);
    }
    console.log("");

    if (chunkNum % PAUSE_AFTER_CHUNKS === 0 && chunkNum < chunks.length) {
      console.log(`Pausing for review. Press Enter to continue, or 'q' + Enter to quit...`);
      const input = prompt("") || "";
      if (input.trim().toLowerCase() === "q") {
        console.log("Stopping.");
        break;
      }
    } else {
      await sleep(DELAY_MS);
    }
  }

  console.log("=".repeat(60));
  console.log("Done.");
  console.log(`Source ID: ${sourceId}`);
}

// =====================================================
// CHUNKING
// =====================================================

function chunkBook(text: string, targetSize: number): string[] {
  const paragraphs = text.split(/\n\s*\n/);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > targetSize && current.length > 0) {
      chunks.push(current.trim());
      current = para;
    } else {
      current += (current ? "\n\n" : "") + para;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks;
}

// =====================================================
// API CALLS
// =====================================================

async function createSource() {
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        action: "create_source",
        kind: bookKind,
        title: bookTitle,
        author: bookAuthor,
      }),
    });
    const data = await res.json();
    if (!data.success) {
      console.error("create_source failed:", data);
      return null;
    }
    return data.source.id as string;
  } catch (e) {
    console.error("create_source error:", (e as Error).message);
    return null;
  }
}

async function readChunk(sourceId: string, chunkText: string, locator: string) {
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        action: "read_chunk",
        source_id: sourceId,
        chunk_text: chunkText,
        chunk_locator: locator,
      }),
    });
    const data = await res.json();
    if (!data.success) {
      console.error("  read_chunk failed:", data);
      return null;
    }
    return data;
  } catch (e) {
    console.error("  read_chunk error:", (e as Error).message);
    return null;
  }
}

// =====================================================
// HELPERS
// =====================================================

function parseArgs(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--") && i + 1 < args.length) {
      out[args[i].slice(2)] = args[i + 1];
      i++;
    }
  }
  return out;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await main();

