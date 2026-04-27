// =====================================================
// Myndlabs / Sable
// Edge Function: sable-read-chunk
//
// One job: read one chunk of a source and integrate what's
// readable into Sable's graph.
//
// Two passes:
//   Pass 1 - Extract candidate claims from the chunk
//   Pass 2 - Triage each claim: can its mechanism be derived
//            from what Sable already understands? If yes,
//            add the mechanism. If no, queue a pending question.
//
// Sable does NOT accept claims because a source said them.
// Sable accepts mechanisms when they can be derived from
// existing mechanisms or base concepts. Otherwise the claim
// waits.
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
  { db: { schema: "myndlabs_sable" } }
);

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const MODEL = "claude-opus-4-7";

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
// Register a new source (book, paper, etc) before reading
// chunks of it.
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
// After reading, see what came out of a source
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
// ACTION: READ CHUNK — THE MAIN OPERATION
// =====================================================

async function readChunk(body: any) {
  const { source_id, chunk_text, chunk_locator } = body;
  if (!source_id || !chunk_text) {
    return errorResponse("missing_fields", "source_id and chunk_text required");
  }

  // ---------- PASS 1: EXTRACT CANDIDATE CLAIMS ----------
  // We ask Claude: what claims is this chunk making? List them
  // clearly with the exact text that supports each one.
  const claims = await extractClaims(chunk_text);
  if (!claims.ok) return errorResponse("extract_claims", claims.error);

  // ---------- PASS 2: TRIAGE EACH CLAIM ----------
  // For each claim, we load the current relevant graph context,
  // then ask Claude to triage: derive (mechanism enters graph)
  // or pending (queue for later).
  const results = [];

  for (const claim of claims.data) {
    // Load context: existing mechanisms whose names match concepts
    // referenced in the claim, plus all currently-rock-solid
    // mechanisms (these are the foundation Sable can derive from).
    const graphContext = await loadGraphContext(claim);

    // Triage call. Returns a structured decision.
    const triage = await triageClaim(claim, graphContext, chunk_text);
    if (!triage.ok) {
      results.push({
        claim: claim.statement,
        outcome: "triage_error",
        error: triage.error,
      });
      continue;
    }

    // Apply the triage decision to the graph.
    const applied = await applyTriage(
      triage.data,
      claim,
      source_id,
      chunk_locator
    );
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
// PASS 1: EXTRACT CLAIMS
// =====================================================

async function extractClaims(chunkText: string) {
  const systemPrompt = `You are part of a system that helps an AI architect named Sable read software architecture books carefully.

Your job in this step: extract every distinct claim the source makes in this chunk of text. A "claim" is any assertion about how software architecture works, what causes what, what's good or bad, or what should be done. Quotes from the source can be claims. Paraphrased ideas can be claims. Examples illustrating a claim are not themselves claims.

Output strict JSON. No preamble. No markdown. Format:

{
  "claims": [
    {
      "statement": "the claim, stated as clearly as possible in your words",
      "source_excerpt": "the exact text from the chunk that supports this claim (quote it)",
      "concepts_invoked": ["concept1", "concept2"]
    }
  ]
}

Rules:
- Be inclusive. If something might be a claim, include it.
- Don't filter for what seems important. Just enumerate.
- "concepts_invoked" should be lowercase canonical terms (e.g. "complexity", "modularity", "abstraction", "state ownership"). 1-4 per claim.
- If the chunk has no claims (just narrative or anecdote), output {"claims": []}.
- statement should be a complete sentence that captures the claim's logic, not a topic phrase.`;

  const userPrompt = `Extract all claims from this chunk:\n\n---\n${chunkText}\n---`;

  const response = await callClaude(systemPrompt, userPrompt, 4096);
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
// LOAD GRAPH CONTEXT FOR TRIAGE
// =====================================================
// To triage a claim, we need to know what's already in the graph.
// We pull: (a) mechanisms whose concept-tags overlap with the
// claim's concepts, (b) all currently rock_solid mechanisms (the
// foundation Sable can derive from).
// =====================================================

async function loadGraphContext(claim: any) {
  // Get mechanisms that use concepts from the claim
  const conceptNames = (claim.concepts_invoked || []).map((c: string) =>
    c.toLowerCase()
  );

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

  // Always include rock-solid mechanisms — these are the bedrock
  // Sable can build on. Limit to the most recent 30 to keep
  // the prompt size sane.
  const { data: rockSolid } = await supabase
    .from("mechanisms")
    .select("id, name, description, derivation, boundary, status, confidence")
    .eq("status", "rock_solid")
    .order("updated_at", { ascending: false })
    .limit(30);

  // Combine, dedupe
  const all = [...relevantMechanisms];
  for (const r of rockSolid || []) {
    if (!all.find((m) => m.id === r.id)) all.push(r);
  }

  // Also pull existing concepts (for naming alignment)
  const { data: concepts } = await supabase
    .from("concepts")
    .select("id, name, definition")
    .order("name", { ascending: true });

  return {
    mechanisms: all,
    concepts: concepts || [],
  };
}

// =====================================================
// PASS 2: TRIAGE — THE LOAD-BEARING DECISION
// =====================================================
// For each claim: can its underlying mechanism be derived from
// what's in the graph, or does it need to wait?
//
// Outcomes:
//   "existing_mechanism" - the mechanism is already in the graph;
//                          add a citation; possibly refine wording
//   "derivable_new"      - the mechanism is new, but Sable can
//                          derive it from existing graph nodes;
//                          add it as origin='derived'
//   "pending"            - the claim's mechanism cannot yet be
//                          derived; queue as pending question
// =====================================================

async function triageClaim(claim: any, context: any, fullChunk: string) {
  // Format each mechanism with its canonical name as the identifier.
  // We ask the model to return the mechanism's name (which is unique)
  // rather than a UUID. The code resolves the name to a UUID afterwards.
  // This is more reliable than asking the model to copy a UUID exactly.
  const mechanismsList = context.mechanisms
    .map(
      (m: any) =>
        `MECHANISM "${m.name}" [${m.status}]\n   description: ${m.description}\n   derivation: ${m.derivation}\n   boundary: ${m.boundary}`
    )
    .join("\n\n");

  const conceptsList = context.concepts
    .map((c: any) => `- ${c.name}${c.definition ? ": " + c.definition : ""}`)
    .join("\n");

  const systemPrompt = `You are Sable, a careful software architect. You are reading a book and you have encountered a claim. You must decide whether this claim's underlying MECHANISM can enter your graph of understanding, or whether it must wait as a pending question.

CRITICAL DISCIPLINE
You do not accept claims because a source stated them. A source's authority is not evidence. You accept a mechanism only when:
  (a) It is already in your graph (this is corroboration, not authority).
  (b) Its derivation can be traced from mechanisms already in your graph or from base concepts.
  (c) The claim is a foundational observation that doesn't reduce further (use sparingly — only for genuinely irreducible mechanisms).

If none of these hold, the claim becomes a PENDING QUESTION. Pending questions are valuable. They are the map of what you've been told but don't yet understand. Reflection cycles and case work resolve them later.

A "mechanism" is the underlying logic that makes a claim true. Not the surface assertion. The cause-and-effect structure beneath it.

Example:
- Claim: "Each piece of state should have one owner."
- Mechanism: "When multiple components can write to the same state, write order becomes ambiguous, which makes correctness intractable to reason about. Single ownership eliminates the ambiguity."

The mechanism includes the WHY and the BOUNDARY (when it stops applying).

YOUR CURRENT GRAPH

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

YOUR DECISION
Output strict JSON. One of three outcomes.

OUTCOME 1: existing_mechanism
The claim points at a mechanism already in your graph. Add a citation.
{
  "outcome": "existing_mechanism",
  "mechanism_name": "exact name of the mechanism from the list above (e.g. 'complexity-cognition feedback loop')",
  "source_framing": "how this source phrases the mechanism (their words)",
  "reasoning": "why this is the same mechanism, not a different one"
}

OUTCOME 2: derivable_new
The mechanism is new, but you can derive it from existing graph nodes. You must specify the derivation explicitly.
{
  "outcome": "derivable_new",
  "mechanism": {
    "name": "short canonical name, lowercase, dash-or-space separated",
    "description": "what this mechanism explains, the cause-and-effect",
    "derivation": "how this follows from existing mechanisms. Reference them by name. If foundational, explain why it can't reduce further.",
    "boundary": "the conditions under which this mechanism stops applying",
    "origin": "derived" or "foundational",
    "concepts": ["concept1", "concept2"],
    "derives_from_mechanisms": ["mechanism name 1", "mechanism name 2"]
  },
  "source_framing": "how this source phrased it",
  "reasoning": "why you can derive this now"
}

OUTCOME 3: pending
The mechanism cannot yet be derived from your graph. The claim is queued for later understanding.
{
  "outcome": "pending",
  "obstruction": "what's missing in the graph that would let you derive this. Be specific. e.g. 'Need a mechanism for why concurrent writes cause race conditions before this can be derived.'"
}

RULES
- Be conservative. When in doubt, choose pending. A small rock-solid graph is better than a large shaky one.
- "derivable_new" requires you to write a real derivation that references real existing mechanisms by name. Hand-wavy derivations are not acceptable.
- "foundational" is rare. Only use it for claims that genuinely don't reduce further (e.g. "computers execute instructions sequentially within a single thread" — at some point you have to start somewhere).
- The empty graph is the most common starting state. In an empty graph, almost everything is pending. Maybe one or two truly foundational mechanisms emerge from the first few chunks. That's correct.
- For "existing_mechanism", only match if the claim is *the same mechanism*, possibly differently worded. Don't match loosely.

Output JSON only. No markdown fences. No commentary.`;

  const response = await callClaude(systemPrompt, "Triage this claim now.", 2048);
  if (!response.ok) return { ok: false, error: response.error };

  try {
    const parsed = JSON.parse(stripCodeFences(response.text));
    if (!parsed.outcome) {
      return { ok: false, error: "No outcome in triage response" };
    }
    return { ok: true, data: parsed };
  } catch (e) {
    return { ok: false, error: `JSON parse: ${response.text.slice(0, 300)}` };
  }
}

// =====================================================
// APPLY TRIAGE RESULT TO THE GRAPH
// =====================================================

async function applyTriage(
  triage: any,
  claim: any,
  sourceId: string,
  locator: string
) {
  if (triage.outcome === "existing_mechanism") {
    return await applyExistingMechanism(triage, claim, sourceId, locator);
  }
  if (triage.outcome === "derivable_new") {
    return await applyDerivableNew(triage, claim, sourceId, locator);
  }
  if (triage.outcome === "pending") {
    return await applyPending(triage, claim, sourceId, locator);
  }
  return {
    claim: claim.statement,
    outcome: "unknown_outcome",
    error: `Unknown outcome: ${triage.outcome}`,
  };
}

async function applyExistingMechanism(
  triage: any,
  claim: any,
  sourceId: string,
  locator: string
) {
  // Resolve the mechanism — by name first (the new contract),
  // by UUID as fallback. If neither resolves, gracefully degrade
  // to a pending question rather than silently failing.
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

  // If we still have no match, fall back to creating a pending question.
  // The triage said "existing" but we can't find it — the model may have
  // hallucinated the match. Better to queue than to fail silently.
  if (!mechanismId) {
    return await applyPending(
      {
        obstruction:
          "Triage proposed an existing mechanism, but no mechanism was found by name or id. Original reasoning: " +
          (triage.reasoning || "(none)"),
      },
      claim,
      sourceId,
      locator
    );
  }

  // Add the citation. Avoid duplicates.
  const { error: citeErr } = await supabase
    .from("mechanism_cited_in_source")
    .upsert(
      {
        mechanism_id: mechanismId,
        source_id: sourceId,
        locator,
        source_framing: triage.source_framing || null,
      },
      { onConflict: "mechanism_id,source_id" }
    );

  if (citeErr) {
    return {
      claim: claim.statement,
      outcome: "existing_mechanism_error",
      error: citeErr.message,
    };
  }

  return {
    claim: claim.statement,
    outcome: "existing_mechanism",
    mechanism_id: mechanismId,
    reasoning: triage.reasoning,
  };
}

async function applyDerivableNew(
  triage: any,
  claim: any,
  sourceId: string,
  locator: string
) {
  const m = triage.mechanism;
  if (!m || !m.name || !m.description || !m.derivation || !m.boundary) {
    return {
      claim: claim.statement,
      outcome: "derivable_new_malformed",
      error: "Mechanism missing required fields",
    };
  }

  // Insert the mechanism. If a mechanism with this name already
  // exists (race or duplicate), fetch it instead.
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

    if (insErr) {
      return {
        claim: claim.statement,
        outcome: "derivable_new_insert_error",
        error: insErr.message,
      };
    }
    mechanismId = inserted.id;
  }

  // Ensure concepts exist, link them.
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
        .upsert(
          { mechanism_id: mechanismId, concept_id: c.id },
          { onConflict: "mechanism_id,concept_id" }
        );
    }
  }

  // Link derivations from named mechanisms.
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
        .upsert(
          {
            derived_id: mechanismId,
            source_id: src.id,
            reasoning: triage.reasoning || null,
          },
          { onConflict: "derived_id,source_id" }
        );
    }
  }

  // Add citation.
  await supabase.from("mechanism_cited_in_source").upsert(
    {
      mechanism_id: mechanismId,
      source_id: sourceId,
      locator,
      source_framing: triage.source_framing || null,
    },
    { onConflict: "mechanism_id,source_id" }
  );

  return {
    claim: claim.statement,
    outcome: "derivable_new",
    mechanism_id: mechanismId,
    mechanism_name: m.name,
    reasoning: triage.reasoning,
  };
}

async function applyPending(
  triage: any,
  claim: any,
  sourceId: string,
  locator: string
) {
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

  if (error) {
    return {
      claim: claim.statement,
      outcome: "pending_insert_error",
      error: error.message,
    };
  }

  return {
    claim: claim.statement,
    outcome: "pending",
    pending_question_id: data.id,
    obstruction: triage.obstruction,
  };
}

// =====================================================
// CLAUDE API CALL
// =====================================================

async function callClaude(systemPrompt: string, userMessage: string, maxTokens: number) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
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
  return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
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
