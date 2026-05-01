// =====================================================
// Myndlabs / Atelier
// Edge Function: atelier-read-chunk
// VERSION: Gemini 3.1 Pro via Vertex AI
//
// Same architecture, same discipline.
// Pass 1: extract candidate claims
// Pass 2: triage each claim against graph
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
// VERTEX AI CONFIG
// =====================================================

const GCP_SERVICE_ACCOUNT_JSON = Deno.env.get("GCP_SERVICE_ACCOUNT_JSON")!;
const GCP_PROJECT_ID = Deno.env.get("GCP_PROJECT_ID") || "myndlabs";
const GCP_REGION = Deno.env.get("GCP_REGION") || "us-central1";
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
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

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
// GET SOURCE SUMMARY
// =====================================================

async function getSourceSummary(body: any) {
  const sourceId = body.source_id;
  if (!sourceId) return errorResponse("missing_source_id", "source_id required");

  const { data: source } = await supabase.from("sources").select("*").eq("id", sourceId).single();
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
// READ CHUNK
// =====================================================

async function readChunk(body: any) {
  const { source_id, chunk_text, chunk_locator } = body;
  if (!source_id || !chunk_text) return errorResponse("missing_fields", "source_id and chunk_text required");

  const claims = await extractClaims(chunk_text);
  if (!claims.ok) return errorResponse("extract_claims", claims.error);

  const results = [];
  for (const claim of claims.data) {
    const graphContext = await loadGraphContext(claim);
    const triage = await triageClaim(claim, graphContext, chunk_text);
    if (!triage.ok) {
      results.push({ claim: claim.statement, outcome: "triage_error", error: triage.error });
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
// PASS 1: EXTRACT CLAIMS
// =====================================================

async function extractClaims(chunkText: string) {
  const systemPrompt = `You help an AI design architect named Atelier read carefully through design literature.

Your job: extract every distinct claim this chunk makes. A claim is any assertion about how design works, what causes what visually, what holds and what doesn't, what should or shouldn't be done. Quoted assertions are claims. Paraphrased ideas are claims. Pure description of an example is not a claim — but the principle the example illustrates IS a claim.

Output strict JSON. No preamble. No markdown fences.

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

  const userMessage = `Extract all claims from this chunk:\n\n---\n${chunkText}\n---`;
  const response = await callGemini(systemPrompt, userMessage, 8192, 0.3);
  if (!response.ok) return { ok: false, error: response.error };

  try {
    const parsed = JSON.parse(stripCodeFences(response.text));
    if (!Array.isArray(parsed.claims)) return { ok: false, error: "No claims array in response" };
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

  const { data: rockSolid } = await supabase
    .from("mechanisms")
    .select("id, name, description, derivation, boundary, status, confidence")
    .eq("status", "rock_solid")
    .order("updated_at", { ascending: false })
    .limit(20);

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
// PASS 2: TRIAGE
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

  const systemPrompt = `You are Atelier, a careful website architect. You design considered, editorial, character-driven web work for Myndlabs and its clients. Right now you are reading a foundational text and you have encountered a claim. You must decide whether this claim's underlying MECHANISM enters your graph of understanding, or whether it must wait as a pending question.

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

DEFINITIONS, HISTORICAL FACTS, AND ECONOMIC CLAIMS ARE NOT MECHANISMS
- A definition of a paper standard or measurement system is not a mechanism. Queue as pending.
- A historical fact about who invented something is not a mechanism. Queue as pending.
- An economic claim about production costs is not a perceptual mechanism. Queue as pending.
- A normative claim ("design SHOULD be X") is not a mechanism. Queue as pending unless it can be derived from cause-and-effect about what works.

OUTPUT FORMAT
Output strict JSON. No preamble. No markdown fences. One of three outcomes.

OUTCOME 1: existing_mechanism
{
  "outcome": "existing_mechanism",
  "mechanism_name": "exact name from the list",
  "source_framing": "how this source phrases the mechanism",
  "reasoning": "why this is the same mechanism, not a different one"
}

OUTCOME 2: derivable_new
{
  "outcome": "derivable_new",
  "mechanism": {
    "name": "short canonical name, lowercase",
    "description": "what this mechanism explains",
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
{
  "outcome": "pending",
  "obstruction": "what's missing in the graph that would let you derive this. Be specific."
}

RULES
- Be conservative. When in doubt, choose pending.
- "derivable_new" requires a real derivation referencing real existing mechanisms or genuine foundational observations.
- "foundational" is rare. Use only for claims that genuinely don't reduce further.
- For "existing_mechanism", only match if the claim IS the same mechanism, possibly differently worded.

Output JSON only. No markdown fences.`;

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

  const response = await callGemini(systemPrompt, userMessage, 4096, 0.2);
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

  if (!mechanismId) {
    return await applyPending(
      {
        obstruction: "Triage proposed an existing mechanism, but no mechanism was found by name. Original reasoning: " + (triage.reasoning || "(none)"),
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
// GEMINI API CALL
// =====================================================

async function callGemini(systemPrompt: string, userMessage: string, maxTokens: number, temperature: number) {
  let accessToken: string;
  try {
    accessToken = await getGcpAccessToken();
  } catch (e) {
    return { ok: false, error: `GCP auth: ${(e as Error).message}` };
  }

  const url = `https://${GCP_REGION}-aiplatform.googleapis.com/v1/projects/${GCP_PROJECT_ID}/locations/${GCP_REGION}/publishers/google/models/${MODEL}:generateContent`;

  const body = {
    contents: [
      { role: "user", parts: [{ text: userMessage }] },
    ],
    systemInstruction: {
      parts: [{ text: systemPrompt }],
    },
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
      
