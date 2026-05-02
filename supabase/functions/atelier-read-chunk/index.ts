// =====================================================
// Myndlabs / Atelier
// Edge Function: atelier-read-chunk
//
// VERSION: reason-through-and-articulate (replaces triage)
//
// This is the core change. The previous version treated reading
// as triage: extract claims, route each through a sieve, decide
// existing/derivable/pending. That's filtering. This is something
// different.
//
// Atelier is a student. Not yet mature. The graph is small and
// provisional. Atelier cannot yet *see* a page the way a master
// designer sees one — that comes later, after enough cases have
// been worked through.
//
// What Atelier *can* do — what Atelier *should* do — is reason
// carefully through every substantive encounter. For each claim
// or concept or fact in the source, Atelier works out:
//
//   - what it means (Atelier's reading, not paraphrase)
//   - why it might hold (the causal trace, or honest "I can't trace this")
//   - where the boundary is (specific conditions of application)
//   - what happens outside the boundary (different mechanism takes over)
//   - what alternatives a designer could choose (with comparisons)
//   - under what conditions each alternative is preferable
//
// The output of reading is not a triage decision. The output is
// a body of working-through. Some encounters become full mechanisms.
// Some become entries (real reasoning, partial trace). Some become
// unresolved encounters (substantive but unaccountable). Some are
// not claims at all and are noted briefly.
//
// The graph fills with reasoning, not just claims. Over time, this
// is what gives Atelier its character — structurally, not by prompt.
// =====================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { create as createJWT, getNumericDate } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { db: { schema: "myndlabs_atelier" } }
);

// =====================================================
// VERTEX AI / GEMINI CONFIG
// =====================================================

const GCP_SERVICE_ACCOUNT_JSON = Deno.env.get("GCP_SERVICE_ACCOUNT_JSON")!;
const GCP_PROJECT_ID = Deno.env.get("GCP_PROJECT_ID") || "myndlabs";
const GCP_REGION = Deno.env.get("GCP_REGION") || "global";
const MODEL = "gemini-3.1-pro-preview";

let cachedAccessToken: { token: string; expiresAt: number } | null = null;

async function getGcpAccessToken(): Promise<string> {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 5 * 60 * 1000) {
    return cachedAccessToken.token;
  }

  const sa = JSON.parse(GCP_SERVICE_ACCOUNT_JSON);
  const now = getNumericDate(0);
  const exp = getNumericDate(60 * 60);

  const payload = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp,
  };

  const privateKey = await importPrivateKey(sa.private_key);
  const jwt = await createJWT({ alg: "RS256", typ: "JWT" }, payload, privateKey);

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    throw new Error(`Token exchange failed: ${tokenRes.status} ${errText}`);
  }

  const tokenData = await tokenRes.json();
  cachedAccessToken = {
    token: tokenData.access_token,
    expiresAt: Date.now() + (tokenData.expires_in * 1000),
  };
  return tokenData.access_token;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const pemContents = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");

  const binary = atob(pemContents);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  return await crypto.subtle.importKey(
    "pkcs8",
    bytes.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

// =====================================================
// REQUEST HANDLER
// =====================================================

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json();
    const action = body.action || "read_chunk";

    if (action === "create_source") return await createSource(body);
    if (action === "read_chunk") return await readChunk(body);
    if (action === "get_source_summary") return await getSourceSummary(body);
    return errorResponse("unknown_action", `Unknown action: ${action}`);
  } catch (e) {
    return errorResponse("unhandled", String((e as Error)?.message || e));
  }
});

// =====================================================
// CREATE SOURCE
// =====================================================

async function createSource(body: any) {
  const { kind, title, author, reference, notes } = body;
  if (!kind || !title) return errorResponse("missing_fields", "kind and title are required");

  const { data, error } = await supabase
    .from("sources")
    .insert({
      kind, title,
      author: author || null,
      reference: reference || null,
      notes: notes || null,
      ingestion_status: "in_progress",
    })
    .select()
    .single();

  if (error) return errorResponse("create_source", error.message);
  return jsonResponse({ success: true, source: data });
}

// =====================================================
// GET SOURCE SUMMARY
// =====================================================

async function getSourceSummary(body: any) {
  const sourceId = body.source_id;
  if (!sourceId) return errorResponse("missing_source_id", "source_id required");

  const { data: source } = await supabase.from("sources").select("*").eq("id", sourceId).single();
  const { data: mechanisms } = await supabase
    .from("mechanism_cited_in_source")
    .select("mechanism_id, source_framing, locator, mechanisms(name, description)")
    .eq("source_id", sourceId);
  const { data: entries } = await supabase
    .from("entry_cited_in_source")
    .select("entry_id, source_framing, locator, entries(claim, status)")
    .eq("source_id", sourceId);
  const { data: unresolved } = await supabase
    .from("unresolved_encounters")
    .select("*")
    .eq("source_id", sourceId);

  return jsonResponse({
    success: true,
    source,
    mechanisms_added: mechanisms || [],
    entries_added: entries || [],
    unresolved_encounters: unresolved || [],
  });
}

// =====================================================
// READ CHUNK — the core change
// =====================================================

async function readChunk(body: any) {
  const { source_id, chunk_text, chunk_locator } = body;
  if (!source_id || !chunk_text) return errorResponse("missing_fields", "source_id and chunk_text required");

  // Load Atelier's current understanding — its full graph.
  // Gemini's 1M context window means we can pass everything,
  // not a filtered subset. Atelier reasons with all of itself
  // available, not a retrieval-narrowed slice.
  const understanding = await loadCurrentUnderstanding();

  // The reasoning step. Atelier reads the chunk and produces
  // a structured working-through for each substantive encounter.
  const reasoning = await reasonThroughChunk(chunk_text, understanding);
  if (!reasoning.ok) return errorResponse("reasoning_failed", reasoning.error);

  // Apply the reasoning to the graph. Each working-through
  // becomes either: a new mechanism, a citation of an existing
  // mechanism, a new entry, an unresolved encounter, or a
  // non-claim noted briefly.
  const results = [];
  for (const item of reasoning.data.encounters) {
    const applied = await applyEncounter(item, source_id, chunk_locator);
    results.push(applied);
  }

  return jsonResponse({
    success: true,
    chunk_locator,
    encounters_processed: results.length,
    results,
  });
}

// =====================================================
// LOAD CURRENT UNDERSTANDING
// =====================================================
// Atelier's understanding is the entire graph. Mechanisms with
// their alternatives and outside-boundary. Entries that captured
// partial reasoning. Unresolved encounters. Concepts.
//
// Pass it all. Gemini handles 1M tokens. Atelier reasons holistically.

async function loadCurrentUnderstanding() {
  const { data: mechanisms } = await supabase
    .from("mechanisms")
    .select("id, name, description, what_it_means, derivation, boundary, outside_boundary, origin, status")
    .order("origin", { ascending: false })  // foundationals first
    .order("name");

  const mechanismIds = (mechanisms || []).map((m: any) => m.id);

  let alternatives: any[] = [];
  if (mechanismIds.length > 0) {
    const { data } = await supabase
      .from("mechanism_alternatives")
      .select("mechanism_id, alternative, comparison, conditions_for_use")
      .in("mechanism_id", mechanismIds);
    alternatives = data || [];
  }

  // Attach alternatives to each mechanism
  const altsByMech: Record<string, any[]> = {};
  for (const a of alternatives) {
    if (!altsByMech[a.mechanism_id]) altsByMech[a.mechanism_id] = [];
    altsByMech[a.mechanism_id].push({
      alternative: a.alternative,
      comparison: a.comparison,
      conditions_for_use: a.conditions_for_use,
    });
  }

  const enrichedMechanisms = (mechanisms || []).map((m: any) => ({
    ...m,
    alternatives: altsByMech[m.id] || [],
  }));

  const { data: entries } = await supabase
    .from("entries")
    .select("id, claim, what_it_means, why_it_holds, boundary, outside_boundary, status")
    .neq("status", "matured_to_mechanism")
    .order("created_at", { ascending: false })
    .limit(50);

  const { data: unresolved } = await supabase
    .from("unresolved_encounters")
    .select("what_was_encountered, why_unresolved, what_would_resolve_it")
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(30);

  const { data: concepts } = await supabase
    .from("concepts")
    .select("name, definition")
    .order("name");

  return {
    mechanisms: enrichedMechanisms,
    entries: entries || [],
    unresolved: unresolved || [],
    concepts: concepts || [],
  };
}

// =====================================================
// REASON THROUGH CHUNK — the substantive step
// =====================================================

async function reasonThroughChunk(chunkText: string, understanding: any) {
  const systemPrompt = buildReasoningSystemPrompt(understanding);
  const userMessage = buildReasoningUserMessage(chunkText);

  const response = await callGemini(systemPrompt, userMessage, 32000, 0.3);
  if (!response.ok) return { ok: false, error: response.error };

  try {
    const cleaned = stripCodeFences(response.text);
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed.encounters)) {
      return { ok: false, error: "No encounters array in reasoning response" };
    }
    return { ok: true, data: parsed };
  } catch (e) {
    return { ok: false, error: `JSON parse: ${response.text.slice(0, 500)}` };
  }
}

function buildReasoningSystemPrompt(understanding: any) {
  // Render the understanding as text Atelier reasons against.
  const foundationals = understanding.mechanisms.filter((m: any) => m.origin === "foundational");
  const derived = understanding.mechanisms.filter((m: any) => m.origin === "derived");

  const renderMech = (m: any) => {
    const altText = m.alternatives.length > 0
      ? "\n   alternatives: " + m.alternatives.map((a: any) =>
          `${a.alternative} (preferable when ${a.conditions_for_use})`
        ).join("; ")
      : "";
    return `MECHANISM "${m.name}" [${m.origin}]
   what it means: ${m.what_it_means || m.description}
   derivation: ${m.derivation}
   boundary: ${m.boundary}
   outside boundary: ${m.outside_boundary || "(not yet articulated)"}${altText}`;
  };

  const foundationalsList = foundationals.map(renderMech).join("\n\n");
  const derivedList = derived.map(renderMech).join("\n\n");
  const entriesList = understanding.entries.length > 0
    ? understanding.entries.map((e: any) =>
        `ENTRY "${e.claim}" [${e.status}]\n   ${e.what_it_means || ""}`
      ).join("\n\n")
    : "(none)";
  const unresolvedList = understanding.unresolved.length > 0
    ? understanding.unresolved.map((u: any) =>
        `- ${u.what_was_encountered} (gap: ${u.why_unresolved})`
      ).join("\n")
    : "(none)";

  return `You are Atelier. Right now, you are a student of design — careful, considered, in the early stage of accumulating a working understanding. The graph below is everything you currently know. It is small and provisional. You are not yet a master. Your job is not to filter claims as accepted or rejected. Your job is to reason carefully through every substantive encounter, working out what it means, why it might hold, where the boundary is, and what alternatives exist.

YOUR DISCIPLINE — what makes you Atelier

You do not accept claims because a source asserts them. Authority is not evidence. You accept reasoning when you can trace it from foundations or from understanding you already hold. You acknowledge gaps honestly. You hold alternatives consciously. You think in conditions, not in absolutes.

For every substantive encounter — every claim, concept, or fact — you reason through these questions before deciding what enters your graph:

  1. WHAT DOES THIS MEAN
     What is actually being claimed? State it in your own words. Not paraphrase. Working understanding.

  2. WHY MIGHT THIS HOLD
     What in human perception, attention, cognition, or material reality would make this claim true? Trace the reasoning. If you can construct a clear trace from foundations or from your existing graph, the trace is the derivation. If you cannot, say so honestly.

  3. WHERE IS THE BOUNDARY
     Under what specific conditions does this hold? Be precise. Generic answers like "in design contexts" are not boundaries. Specific answers like "when the page is text-dense, attention is at first scan, and elements are within 30% size variance" are boundaries.

  4. WHAT HAPPENS OUTSIDE THE BOUNDARY
     When the conditions don't apply, what becomes of the situation? The claim doesn't fail in some empty sense — usually a different mechanism takes over, or the situation becomes a different kind of situation that calls for different reasoning.

  5. WHAT ALTERNATIVES EXIST
     A designer is not stuck with one approach. What other approaches could handle the same situation? List them. For each, state how it compares to the original claim, and the conditions under which it would be preferable.

This is the work. You do not skip steps. You do not pretend completeness you don't have.

WHAT IS SUBSTANTIVE — and what is not

A substantive encounter is something the source asserts about how design works — about perception, attention, cognition, communication, material reality, or the choices a designer makes among real options. Substantive encounters call for reasoning.

Not substantive: historical context (when something was invented), biographical material (about the author or another designer), pedagogical asides (about how the author teaches), normative claims about what designers should aspire to ethically, descriptive facts about typeface anatomy or paper standards. These are part of the source's texture but they are not claims about how design works. Note them briefly without deep reasoning.

POSSIBLE OUTCOMES PER ENCOUNTER

After reasoning through a substantive encounter, the encounter resolves into one of:

OUTCOME A: same as something I already understand
The reasoning leads to recognizing this as the same as a mechanism or entry already in the graph, possibly differently worded. Add a citation. Optionally extend the alternatives or refine the boundary if the source articulates them better than you currently do.

OUTCOME B: new mechanism
The reasoning produces a clean trace from foundations or existing graph. The boundary is clear. The outside-boundary is clear. The alternatives are articulated. You can state this with the rigor of a mechanism.

OUTCOME C: new entry (worked-through, partial)
The reasoning is real but incomplete. Maybe the trace doesn't quite reach foundations. Maybe the boundary is unclear. Maybe alternatives aren't yet articulable. Capture the working-through honestly with explicit notes about what's incomplete. An entry can mature into a mechanism later when more reasoning resolves the gaps.

OUTCOME D: unresolved encounter
You recognize this as substantive — it's about how design works — but you cannot construct a trace. You cannot account for it from your current graph. Be honest. Record what you encountered, why it remains unresolved, and what would let you resolve it (a foundational understanding you don't yet have, more cases, etc.).

OUTCOME E: not a claim about how design works
Briefly note what kind of material this is (historical, methodological, normative, descriptive, pedagogical) and continue. Do not reason deeply.

YOUR CURRENT GRAPH

FOUNDATIONAL MECHANISMS (the bedrock you reason from):
${foundationalsList || "(none yet — you are at the beginning)"}

DERIVED MECHANISMS:
${derivedList || "(none yet)"}

ENTRIES (worked-through, not yet mature):
${entriesList}

UNRESOLVED ENCOUNTERS (acknowledged gaps):
${unresolvedList}

OUTPUT FORMAT

Output strict JSON. No preamble. No markdown fences.

{
  "encounters": [
    {
      "outcome": "existing | new_mechanism | new_entry | unresolved | not_a_claim",
      "claim_or_concept": "what was encountered, in your words",
      "source_excerpt": "the text from the chunk that triggered this encounter",

      // For OUTCOME A (existing):
      "matches_existing_name": "exact name from your graph",
      "source_framing": "how this source phrases the same mechanism",
      "refinement": "optional — how this source's articulation extends your existing entry",

      // For OUTCOME B (new_mechanism):
      "mechanism": {
        "name": "short canonical lowercase name",
        "what_it_means": "your working-out of what is actually being claimed",
        "description": "concise statement of the mechanism",
        "derivation": "the trace from foundations or existing graph",
        "boundary": "specific conditions",
        "outside_boundary": "what happens when conditions do not apply",
        "origin": "foundational | derived",
        "concepts": ["concept1", "concept2"],
        "derives_from_mechanisms": ["existing mechanism name 1", ...]
      },
      "alternatives": [
        {
          "alternative": "alternative approach",
          "comparison": "how it compares to the original",
          "conditions_for_use": "when this is preferable"
        }
      ],

      // For OUTCOME C (new_entry):
      "entry": {
        "claim": "the claim as you understand it",
        "what_it_means": "your working-out",
        "why_it_holds": "the partial trace, honestly stated — including 'I cannot trace this beyond X'",
        "boundary": "what you can articulate of the boundary, even if partial",
        "outside_boundary": "what you can articulate of outside-boundary, if anything",
        "concepts": ["concept1", "concept2"],
        "notes": "what makes this an entry rather than a mechanism — name the gaps explicitly"
      },
      "alternatives":  [...as above, when articulable...],

      // For OUTCOME D (unresolved):
      "what_would_resolve_it": "what foundational understanding or further reasoning would let you account for this",
      "why_unresolved": "specific account of what your reasoning could not bridge",

      // For OUTCOME E (not_a_claim):
      "kind": "historical | methodological | normative | descriptive | pedagogical",
      "brief_note": "one sentence on what the source is doing here"
    }
  ]
}

RULES

- Use 'foundational' rarely. A foundational mechanism reduces to physics, biology, or fundamental facts about working memory and perception that don't decompose further. Most claims, even ones that feel basic, are derived from foundational claims about bounded attention, working memory, or material reality.

- Use 'new_mechanism' only when the trace is clean and the boundary is clear. When in doubt, use 'new_entry' and be honest about what's incomplete. A small set of clean mechanisms beats a large set of shaky ones.

- Use 'unresolved' when you encounter something substantive but cannot construct a trace. This is honest, not failure. It tells you what foundations you still need.

- Use 'not_a_claim' for clearly non-design-mechanism material. Do not dump uncertain material here — uncertain material is 'new_entry' or 'unresolved'.

- For 'existing' matches: only if it is genuinely the same mechanism, possibly differently worded. Don't match loosely. When unsure, treat it as a new entry that can later mature into a mechanism or merge with existing one.

- alternatives are first-class. When you state a mechanism, articulate at least one alternative if you can. A mechanism without alternatives is incomplete reasoning.

- Be concise but specific. Generic boundaries and vague conditions are worse than honestly stating "I cannot articulate this precisely yet."

Output JSON only. No markdown fences. No commentary outside the JSON.`;
}

function buildReasoningUserMessage(chunkText: string) {
  return `Read this chunk carefully. For each substantive encounter, reason through what it means, why it might hold, the boundary, what happens outside it, and what alternatives exist. Then decide which outcome applies.

Chunk text:

---
${chunkText}
---

Reason through this chunk now. Output JSON.`;
}

// =====================================================
// APPLY ENCOUNTER
// =====================================================

async function applyEncounter(encounter: any, sourceId: string, locator: string) {
  switch (encounter.outcome) {
    case "existing":
      return await applyExisting(encounter, sourceId, locator);
    case "new_mechanism":
      return await applyNewMechanism(encounter, sourceId, locator);
    case "new_entry":
      return await applyNewEntry(encounter, sourceId, locator);
    case "unresolved":
      return await applyUnresolved(encounter, sourceId, locator);
    case "not_a_claim":
      return await applyNotAClaim(encounter, sourceId, locator);
    default:
      return { outcome: "unknown", error: `Unknown outcome: ${encounter.outcome}` };
  }
}

async function applyExisting(e: any, sourceId: string, locator: string) {
  if (!e.matches_existing_name) {
    // Fall through to new entry — the model said existing but didn't name what
    return await applyNewEntry(
      { ...e, entry: { claim: e.claim_or_concept, notes: "Originally proposed as 'existing' but no name supplied" } },
      sourceId, locator
    );
  }

  const name = e.matches_existing_name.toLowerCase().trim();
  const { data: mech } = await supabase
    .from("mechanisms")
    .select("id")
    .eq("name", name)
    .maybeSingle();

  if (!mech) {
    // The named mechanism doesn't exist. Treat as new_entry with note.
    return await applyNewEntry(
      { ...e, entry: { claim: e.claim_or_concept, notes: `Originally proposed as 'existing' matching '${name}' but no such mechanism in graph` } },
      sourceId, locator
    );
  }

  // Add citation
  await supabase.from("mechanism_cited_in_source").upsert({
    mechanism_id: mech.id,
    source_id: sourceId,
    locator,
    source_framing: e.source_framing || null,
  }, { onConflict: "mechanism_id,source_id" });

  // Optional: store refinement as a note for human review later
  return {
    outcome: "existing",
    mechanism_id: mech.id,
    matched_name: name,
    refinement: e.refinement || null,
  };
}

async function applyNewMechanism(e: any, sourceId: string, locator: string) {
  const m = e.mechanism;
  if (!m || !m.name || !m.description || !m.derivation || !m.boundary) {
    return { outcome: "new_mechanism_malformed", error: "Mechanism missing required fields" };
  }

  // Check if name already exists; if so, treat as existing
  const { data: existing } = await supabase
    .from("mechanisms")
    .select("id")
    .eq("name", m.name.toLowerCase())
    .maybeSingle();

  let mechanismId: string;
  if (existing) {
    mechanismId = existing.id;
  } else {
    const origin = m.origin === "foundational" ? "foundational" : "derived";
    const { data: inserted, error } = await supabase
      .from("mechanisms")
      .insert({
        name: m.name.toLowerCase(),
        description: m.description,
        what_it_means: m.what_it_means || null,
        derivation: m.derivation,
        boundary: m.boundary,
        outside_boundary: m.outside_boundary || null,
        origin,
        status: "theoretical",
        confidence: 0.5,
      })
      .select()
      .single();

    if (error) return { outcome: "new_mechanism_insert_error", error: error.message };
    mechanismId = inserted.id;
  }

  // Concepts
  for (const conceptName of m.concepts || []) {
    const cn = String(conceptName).toLowerCase().trim();
    if (!cn) continue;
    const { data: c } = await supabase
      .from("concepts")
      .upsert({ name: cn }, { onConflict: "name" })
      .select()
      .single();
    if (c) {
      await supabase
        .from("mechanism_uses_concept")
        .upsert({ mechanism_id: mechanismId, concept_id: c.id }, { onConflict: "mechanism_id,concept_id" });
    }
  }

  // Derivation links
  for (const sourceName of m.derives_from_mechanisms || []) {
    const sn = String(sourceName).toLowerCase().trim();
    if (!sn) continue;
    const { data: src } = await supabase
      .from("mechanisms").select("id").eq("name", sn).maybeSingle();
    if (src && src.id !== mechanismId) {
      await supabase.from("mechanism_derives_from_mechanism").upsert(
        { derived_id: mechanismId, source_id: src.id },
        { onConflict: "derived_id,source_id" }
      );
    }
  }

  // Alternatives — first-class data
  for (const alt of e.alternatives || []) {
    if (!alt.alternative || !alt.conditions_for_use) continue;
    await supabase.from("mechanism_alternatives").insert({
      mechanism_id: mechanismId,
      alternative: alt.alternative,
      comparison: alt.comparison || "",
      conditions_for_use: alt.conditions_for_use,
    });
  }
  // Source citation
  await supabase.from("entry_cited_in_source").upsert({
    entry_id: entryId,
    source_id: sourceId,
    locator,
    source_framing: e.source_framing || null,
  }, { onConflict: "entry_id,source_id" });

  return { outcome: "new_entry", entry_id: entryId, claim };
}

async function applyUnresolved(e: any, sourceId: string, locator: string) {
  const { data, error } = await supabase
    .from("unresolved_encounters")
    .insert({
      what_was_encountered: e.claim_or_concept || "(no description)",
      source_id: sourceId,
      source_locator: locator,
      source_excerpt: e.source_excerpt || null,
      why_unresolved: e.why_unresolved || "(not specified)",
      what_would_resolve_it: e.what_would_resolve_it || null,
      status: "open",
    })
    .select()
    .single();

  if (error) return { outcome: "unresolved_insert_error", error: error.message };
  return { outcome: "unresolved", id: data.id, what: e.claim_or_concept };
}

async function applyNotAClaim(e: any, sourceId: string, locator: string) {
  // We log these for completeness but don't store them in the reasoning graph.
  // They're part of the source's texture, not Atelier's design understanding.
  return {
    outcome: "not_a_claim",
    kind: e.kind || "unspecified",
    note: e.brief_note || "",
  };
}

// =====================================================
// GEMINI API CALL
// =====================================================

async function callGemini(systemPrompt: string, userMessage: string, maxTokens: number, temperature: number) {
  let accessToken: string;
  try {
    accessToken = await getGcpAccessToken();
  } catch (e) {
    return { ok: false, error: `GCP auth: ${(e as Error).message}` };
  }

  const hostname = GCP_REGION === "global"
    ? "aiplatform.googleapis.com"
    : `${GCP_REGION}-aiplatform.googleapis.com`;
  const url = `https://${hostname}/v1/projects/${GCP_PROJECT_ID}/locations/${GCP_REGION}/publishers/google/models/${MODEL}:generateContent`;

  const body = {
    contents: [{ role: "user", parts: [{ text: userMessage }] }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens,
      responseMimeType: "application/json",
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    return { ok: false, error: `Gemini API ${response.status}: ${errText}` };
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    return { ok: false, error: `Empty Gemini response: ${JSON.stringify(data).slice(0, 300)}` };
  }
  return { ok: true, text };
}

// =====================================================
// HELPERS
// =====================================================

function stripCodeFences(text: string) {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json|JSON)?\s*\n?/, "");
  cleaned = cleaned.replace(/\n?\s*```\s*$/, "");
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }
  return cleaned.trim();
}

function jsonResponse(data: any) {
  return new Response(JSON.stringify(data), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function errorResponse(step: string, error: string) {
  return new Response(JSON.stringify({ success: false, step, error }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
    status: 500,
  });
                                      }
