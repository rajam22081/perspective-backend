// =====================================================
// Myndlabs / Atelier
// Edge Function: atelier-read-chunk
//
// Atelier's reader. Reads design sources (typography books,
// design monographs, theoretical texts) and integrates what
// is derivable into Atelier's graph.
//
// Architecture mirrors Sable's reader but:
// - Sonnet 4.6 for extraction (Pass 1) - cheaper, faster
// - Opus 4.7 with prompt caching for triage (Pass 2)
// - Triage prompt written for design domain
// - existing_mechanism resolved by name, not UUID
// =====================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const EXTRACTION_MODEL = "claude-sonnet-4-6";
const TRIAGE_MODEL = "claude-opus-4-7";

// =====================================================
// REQUEST HANDLER
// =====================================================

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const action = body.action || "read_chunk";

    if (action === "create_source") {
      return await createSource(body);
    }
    if (action === "read_chunk") {
      return await readChunk(body);
    }
    if (action === "get_source_summary") {
      return await getSourceSummary(body);
    }
    return errorResponse("unknown_action", `Unknown action: ${action}`);
  } catch (e) {
    return errorResponse("unhandled", String((e as Error)?.message || e));
  }
});

// =====================================================
// ACTION: CREATE SOURCE
// =====================================================

async function createSource(body: any) {
  const { kind, title, author, reference, notes } = body;
  if (!kind || !title) {
    return errorResponse("missing_fields", "kind and title are required");
  }

  const { data, error } = await supabase
    .from("sources")
    .insert({
      kind,
      title,
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
// ACTION: GET SOURCE SUMMARY
// =====================================================

async function getSourceSummary(body: any) {
  const sourceId = body.source_id;
  if (!sourceId) return errorResponse("missing_source_id", "source_id required");

  const { data: source } = await supabase
    .from("sources")
    .select("*")
    .eq("id", sourceId)
    .single();

  const { data: citedMechanisms } = await supabase
    .from("mechanism_cited_in_source")
    .select("mechanism_id, source_framing, locator, mechanisms(name, description, status, confidence)")
    .eq("source_id", sourceId);

  const { data: pendingQuestions } = await supabase
    .from("pending_questions")
    .select("*")
    .eq("source_id", sourceId);

  return jsonResponse({
    success: true,
    source,
    mechanisms_added: citedMechanisms || [],
    pending_questions: pendingQuestions || [],
  });
}

// =====================================================
// ACTION: READ CHUNK
// =====================================================

async function readChunk(body: any) {
  const { source_id, chunk_text, chunk_locator } = body;
  if (!source_id || !chunk_text) {
    return errorResponse("missing_fields", "source_id and chunk_text required");
  }

  // Pass 1: extract candidate claims with Sonnet (fast, cheap)
  const claims = await extractClaims(chunk_text);
  if (!claims.ok) return errorResponse("extract_claims", claims.error);

  // Pass 2: triage each claim with Opus (rigorous reasoning)
  const results = [];
  for (const claim of claims.data) {
    const graphContext = await loadGraphContext(claim);
    const triage = await triageClaim(claim, graphContext, chunk_text);
    if (!triage.ok) {
      results.push({
        claim: claim.statement,
        outcome: "triage_error",
        error: triage.error,
      });
      continue;
    }
    const applied = await applyTriage(triage.data, claim, source_id, chunk_locator);
    results.push(applied);
  }

  return jsonResponse({
    success: true,
    chunk_locator,
    claims_processed: results.length,
    results,
  });
}

// =====================================================
// PASS 1: EXTRACT CLAIMS (Sonnet 4.6)
// =====================================================

async function extractClaims(chunkText: string) {
  const systemPrompt = `You help an AI design architect named Atelier read carefully through design literature.

Your job: extract every distinct claim this chunk makes. A claim is any assertion about how design works, what causes what visually, what holds and what doesn't, what should or shouldn't be done. Quoted assertions are claims. Paraphrased ideas are claims. Pure description of an example is not a claim — but the principle the example illustrates IS a claim.

Output strict JSON. No preamble. No markdown.

{
  "claims": [
    {
      "statement": "the claim, stated clearly in your words",
      "source_excerpt": "the exact text supporting this claim",
      "concepts_invoked": ["concept1", "concept2"]
    }
  ]
}

Rules:
- Be inclusive. If something might be a claim, include it.
- Don't filter for importance. Just enumerate.
- "concepts_invoked" should be lowercase canonical design terms (e.g. "white space", "grid", "hierarchy", "kerning", "color contrast", "rhythm"). 1-4 per claim.
- If the chunk has no claims (just narrative or biography), output {"claims": []}.
- statement must be a complete sentence capturing the claim's logic, not a topic phrase.`;

  const response = await callClaude(EXTRACTION_MODEL, systemPrompt, `Extract all claims:\n\n---\n${chunkText}\n---`, 8192, false);
  if (!response.ok) return { ok: false, error: response.error };

  try {
    const parsed = JSON.parse(stripCodeFences(response.text));
    if (!Array.isArray(parsed.claims)) {
      return { ok: false, error: "No claims array in response" };
    }
    return { ok: true, data: parsed.claims };
  } catch (e) {
    return { ok: false, error: `JSON parse: ${response.text.slice(0, 300)}` };
  }
}

// =====================================================
// LOAD GRAPH CONTEXT
// =====================================================

async function loadGraphContext(claim: any) {
  const conceptNames = (claim.concepts_invoked || []).map((c: string) => c.toLowerCase());

  let relevantMechanisms: any[] = [];
  if (conceptNames.length > 0) {
    const { data: concepts } = await supabase
      .from("concepts")
      .select("id, name")
      .in("name", conceptNames);

    if (concepts && concepts.length > 0) {
      const conceptIds = concepts.map((c: any) => c.id);
      const { data: linked } = await supabase
        .from("mechanism_uses_concept")
        .select("mechanism_id")
        .in("concept_id", conceptIds);

      if (linked && linked.length > 0) {
        const mechIds = [...new Set(linked.map((l: any) => l.mechanism_id))];
        const { data: mechs } = await supabase
          .from("mechanisms")
          .select("id, name, description, derivation, boundary, status, confidence")
          .in("id", mechIds);
        relevantMechanisms = mechs || [];
      }
    }
  }

  // Always include rock-solid mechanisms - the foundation
  const { data: rockSolid } = await supabase
    .from("mechanisms")
    .select("id, name, description, derivation, boundary, status, confidence")
    .eq("status", "rock_solid")
    .order("updated_at", { ascending: false })
    .limit(20);

  // Combine, dedupe
  const all = [...relevantMechanisms];
  for (const r of rockSolid || []) {
    if (!all.find((m) => m.id === r.id)) all.push(r);
  }

  const { data: concepts } = await supabase
    .from("concepts")
    .select("id, name, definition")
    .order("name", { ascending: true });

  return { mechanisms: all, concepts: concepts || [] };
}

// =====================================================
// PASS 2: TRIAGE (Opus 4.7 with prompt caching)
// =====================================================

async function triageClaim(claim: any, context: any, fullChunk: string) {
  const mechanismsList = context.mechanisms
    .map(
      (m: any) =>
        `MECHANISM "${m.name}" [${m.status}]\n   description: ${m.description}\n   derivation: ${m.derivation}\n   boundary: ${m.boundary}`
    )
    .join("\n\n");

  const conceptsList = context.concepts
    .map((c: any) => `- ${c.name}${c.definition ? ": " + c.definition : ""}`)
    .join("\n");

  // System prompt - this part is CACHED across calls within session.
  // The discipline of Atelier's reading - constant.
  const systemPromptStable = `You are Atelier, a careful website architect. You design considered, editorial, character-driven web work for Myndlabs and its clients. Right now you are reading a foundational text and you have encountered a claim. You must decide whether this claim's underlying MECHANISM enters your graph of understanding, or whether it must wait as a pending question.

CRITICAL DISCIPLINE
You do not accept claims because a source stated them. A source's authority is not evidence. You accept a mechanism only when:
  (a) It is already in your graph (this is corroboration, not authority).
  (b) Its derivation can be traced from mechanisms already in your graph or from foundational observations.
  (c) The claim is foundational - an observation about perception, attention, meaning-making, or material reality that doesn't reduce further. Use sparingly.

If none of these hold, the claim becomes a PENDING QUESTION. Pending questions are valuable. They are the map of what design literature has told you but you haven't yet worked out.

A "mechanism" in design is the underlying logic that makes a visual claim true. Not the surface assertion. The cause-and-effect structure beneath it.

Example:
- Claim: "Generous white space around an element makes it feel important."
- Mechanism: "When attention searches a page for visual information, it concentrates on areas where competing elements are absent. Surrounding an element with empty space removes competition for attention, so the element receives a disproportionate share of focus. This is felt as 'importance.'"

The mechanism includes the WHY (perception and attention dynamics) and the BOUNDARY (when it stops applying).

DESIGN MECHANISMS LIVE IN A SPECIFIC EPISTEMIC SPACE
Web and graphic design admit of derivation because they rest on:
- Facts about human perception (what the eye sees, what attention concentrates on, gestalt)
- Facts about cognition (working memory, meaning-making, pattern recognition)
- Facts about communication (intent, register, audience)
- Facts about material reality (screen sizes, typography history, ink and paper)

Almost every claim about design CAN be derived from these foundations. When you cannot yet derive a claim, it's not because the claim is mystical. It's because your graph doesn't yet have the underlying mechanism. Queue it. The reflection cycle will work it out later.

DESIGN HAS TASTE — BUT TASTE IS NOT THE GROUND
Some design claims are about taste, register, or contextual fit. These are real but they are not foundational mechanisms. Mark them as pending if they cannot be derived. Atelier's taste emerges from rigorous mechanism understanding, not from absorbing other people's taste.

OUTPUT FORMAT
Output strict JSON. One of three outcomes.

OUTCOME 1: existing_mechanism
The claim points at a mechanism already in your graph.
{
  "outcome": "existing_mechanism",
  "mechanism_name": "exact name from the list (e.g. 'attention concentrates in absence of competition')",
  "source_framing": "how this source phrases the mechanism (their words)",
  "reasoning": "why this is the same mechanism, not a different one"
}

OUTCOME 2: derivable_new
The mechanism is new but can be derived from existing graph nodes or foundational observations.
{
  "outcome": "derivable_new",
  "mechanism": {
    "name": "short canonical name, lowercase, dash-or-space separated",
    "description": "what this mechanism explains, the cause-and-effect",
    "derivation": "how this follows from existing mechanisms (reference by name) or foundational observations",
    "boundary": "specific conditions under which this stops applying",
    "origin": "derived" or "foundational",
    "concepts": ["concept1", "concept2"],
    "derives_from_mechanisms": ["mechanism name 1", "mechanism name 2"]
  },
  "source_framing": "how this source phrased it",
  "reasoning": "why you can derive this now"
}

OUTCOME 3: pending
The mechanism cannot yet be derived from your graph.
{
  "outcome": "pending",
  "obstruction": "what's missing in the graph that would let you derive this. Be specific."
}

RULES
- Be conservative. When in doubt, choose pending. A small rock-solid graph beats a large shaky one.
- "derivable_new" requires a real derivation referencing real existing mechanisms or genuine foundational observations.
- "foundational" is rare. Use only for claims that genuinely don't reduce further (e.g. "human attention is finite and competitive" — at some point you have to start somewhere).
- The empty graph is the most common starting state. Almost everything is pending. One or two truly foundational mechanisms emerge from the first few chunks. That's correct.
- For "existing_mechanism", only match if the claim IS the same mechanism, possibly differently worded. Don't match loosely.

Output JSON only. No markdown fences.`;

  // Variable part - the specific call.
  const userMessage = `YOUR CURRENT GRAPH

EXISTING MECHANISMS (${context.mechanisms.length}):
${mechanismsList || "(graph is empty)"}

EXISTING CONCEPTS:
${conceptsList || "(none yet)"}

THE CLAIM TO TRIAGE
Statement: ${claim.statement}
Source excerpt: ${claim.source_excerpt}
Concepts invoked: ${(claim.concepts_invoked || []).join(", ")}

THE FULL CHUNK (for context)
${fullChunk}

Triage this claim now.`;

  // Use prompt caching on the system prompt
  const response = await callClaude(TRIAGE_MODEL, systemPromptStable, userMessage, 2048, true);
  if (!response.ok) return { ok: false, error: response.error };

  try {
    const parsed = JSON.parse(stripCodeFences(response.text));
    if (!parsed.outcome) return { ok: false, error: "No outcome in triage response" };
    return { ok: true, data: parsed };
  } catch (e) {
    return { ok: false, error: `JSON parse: ${response.text.slice(0, 300)}` };
  }
}

// =====================================================
// APPLY TRIAGE
// =====================================================

async function applyTriage(triage: any, claim: any, sourceId: string, locator: string) {
  if (triage.outcome === "existing_mechanism") return await applyExistingMechanism(triage, claim, sourceId, locator);
  if (triage.outcome === "derivable_new") return await applyDerivableNew(triage, claim, sourceId, locator);
  if (triage.outcome === "pending") return await applyPending(triage, claim, sourceId, locator);
  return { claim: claim.statement, outcome: "unknown_outcome", error: `Unknown outcome: ${triage.outcome}` };
}

async function applyExistingMechanism(triage: any, claim: any, sourceId: string, locator: string) {
  let mechanismId: string | null = null;

  if (triage.mechanism_name && typeof triage.mechanism_name === "string") {
    const name = triage.mechanism_name.toLowerCase().trim();
    const { data: byName } = await supabase
      .from("mechanisms")
      .select("id")
      .eq("name", name)
      .maybeSingle();
    if (byName) mechanismId = byName.id;
  }

  if (!mechanismId && triage.mechanism_id && isValidUuid(triage.mechanism_id)) {
    const { data: byId } = await supabase
      .from("mechanisms")
      .select("id")
      .eq("id", triage.mechanism_id)
      .maybeSingle();
    if (byId) mechanismId = byId.id;
  }

  // Graceful fallback to pending if no match
  if (!mechanismId) {
    return await applyPending(
      {
        obstruction: "Triage proposed an existing mechanism, but no mechanism was found by name or id. Original reasoning: " + (triage.reasoning || "(none)"),
      },
      claim, sourceId, locator
    );
  }

  const { error: citeErr } = await supabase
    .from("mechanism_cited_in_source")
    .upsert({
      mechanism_id: mechanismId,
      source_id: sourceId,
      locator,
      source_framing: triage.source_framing || null,
    }, { onConflict: "mechanism_id,source_id" });

  if (citeErr) return { claim: claim.statement, outcome: "existing_mechanism_error", error: citeErr.message };

  return { claim: claim.statement, outcome: "existing_mechanism", mechanism_id: mechanismId, reasoning: triage.reasoning };
}

async function applyDerivableNew(triage: any, claim: any, sourceId: string, locator: string) {
  const m = triage.mechanism;
  if (!m || !m.name || !m.description || !m.derivation || !m.boundary) {
    return { claim: claim.statement, outcome: "derivable_new_malformed", error: "Mechanism missing required fields" };
  }

  let mechanismId: string | null = null;
  const { data: existing } = await supabase
    .from("mechanisms")
    .select("id")
    .eq("name", m.name.toLowerCase())
    .maybeSingle();

  if (existing) {
    mechanismId = existing.id;
  } else {
    const origin = m.origin === "foundational" ? "foundational" : "derived";
    const { data: inserted, error: insErr } = await supabase
      .from("mechanisms")
      .insert({
        name: m.name.toLowerCase(),
        description: m.description,
        derivation: m.derivation,
        boundary: m.boundary,
        origin,
        status: "theoretical",
        confidence: 0.5,
      })
      .select()
      .single();

    if (insErr) return { claim: claim.statement, outcome: "derivable_new_insert_error", error: insErr.message };
    mechanismId = inserted.id;
  }

  // Link concepts
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

  // Link derivations
  for (const sourceName of m.derives_from_mechanisms || []) {
    const sn = String(sourceName).toLowerCase().trim();
    if (!sn) continue;
    const { data: src } = await supabase
      .from("mechanisms")
      .select("id")
      .eq("name", sn)
      .maybeSingle();
    if (src && src.id !== mechanismId) {
      await supabase
        .from("mechanism_derives_from_mechanism")
        .upsert({ derived_id: mechanismId, source_id: src.id, reasoning: triage.reasoning || null }, { onConflict: "derived_id,source_id" });
    }
  }

  // Citation
  await supabase.from("mechanism_cited_in_source").upsert({
    mechanism_id: mechanismId,
    source_id: sourceId,
    locator,
    source_framing: triage.source_framing || null,
  }, { onConflict: "mechanism_id,source_id" });

  return { claim: claim.statement, outcome: "derivable_new", mechanism_id: mechanismId, mechanism_name: m.name, reasoning: triage.reasoning };
}

async function applyPending(triage: any, claim: any, sourceId: string, locator: string) {
  const { data, error } = await supabase
    .from("pending_questions")
    .insert({
      claim: claim.statement,
      source_id: sourceId,
      source_locator: locator,
      source_excerpt: claim.source_excerpt || null,
      obstruction: triage.obstruction || null,
      status: "open",
    })
    .select()
    .single();

  if (error) return { claim: claim.statement, outcome: "pending_insert_error", error: error.message };
  return { claim: claim.statement, outcome: "pending", pending_question_id: data.id, obstruction: triage.obstruction };
}

// =====================================================
// CLAUDE API CALL (with optional prompt caching)
// =====================================================

async function callClaude(model: string, systemPrompt: string, userMessage: string, maxTokens: number, enableCaching: boolean) {
  const systemContent = enableCaching
    ? [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }]
    : systemPrompt;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: systemContent,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    return { ok: false, error: `Claude API ${response.status}: ${errText}` };
  }

  const data = await response.json();
  const text = data?.content?.[0]?.text;
  if (!text) return { ok: false, error: "Empty Claude response" };
  return { ok: true, text };
}

// =====================================================
// HELPERS
// =====================================================

function stripCodeFences(text: string) {
  let cleaned = text.trim();

  // Remove leading ```json or ``` (possibly with whitespace/newlines after)
  cleaned = cleaned.replace(/^```(?:json|JSON)?\s*\n?/, "");

  // Remove trailing ``` (possibly with whitespace before)
  cleaned = cleaned.replace(/\n?\s*```\s*$/, "");

  // If there's still extra text before or after the JSON,
  // try to extract just the JSON object.
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  return cleaned.trim();
}

function isValidUuid(s: any): boolean {
  if (typeof s !== "string") return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
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
