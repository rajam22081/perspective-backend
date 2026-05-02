// =====================================================
// Myndlabs / Atelier
// Edge Function: atelier-read-chunk
//
// VERSION: multimodal reasoning (text + image)
//
// This extends the reason-through-and-articulate function to
// accept visual input alongside text. When a page image is
// provided, Atelier reasons about both — what the text claims
// and what the visual demonstrates.
//
// For design literature this is essential. The text describes
// a typographic principle; the image shows a specimen of it.
// The text discusses a brand identity decision; the image
// shows the actual logo. Atelier reading text alone misses
// half the source.
//
// Request shape:
//   {
//     "action": "read_chunk",
//     "source_id": "uuid",
//     "chunk_text": "extracted page text",
//     "page_image_base64": "base64 of page rendered as PNG",  // optional
//     "page_number": 47,                                      // optional
//     "chunk_locator": "page 47" or any string
//   }
//
// When page_image_base64 is provided, Gemini reasons about
// the image alongside the text. When it's not, Gemini reasons
// about text alone (same as v2).
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
// READ CHUNK
// =====================================================

async function readChunk(body: any) {
  const { source_id, chunk_text, chunk_locator, page_image_base64, page_number } = body;

  if (!source_id) return errorResponse("missing_fields", "source_id required");
  if (!chunk_text && !page_image_base64) {
    return errorResponse("missing_fields", "either chunk_text or page_image_base64 required");
  }

  const understanding = await loadCurrentUnderstanding();

  const reasoning = await reasonThroughChunk(
    chunk_text || "",
    page_image_base64 || null,
    page_number || null,
    understanding
  );

  if (!reasoning.ok) return errorResponse("reasoning_failed", reasoning.error);

  const results = [];
  for (const item of reasoning.data.encounters) {
    const applied = await applyEncounter(item, source_id, chunk_locator);
    results.push(applied);
  }

  return jsonResponse({
    success: true,
    chunk_locator,
    page_number: page_number || null,
    had_image: !!page_image_base64,
    encounters_processed: results.length,
    results,
  });
}

// =====================================================
// LOAD CURRENT UNDERSTANDING
// =====================================================

async function loadCurrentUnderstanding() {
  const { data: mechanisms } = await supabase
    .from("mechanisms")
    .select("id, name, description, what_it_means, derivation, boundary, outside_boundary, origin, status")
    .order("origin", { ascending: false })
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
// REASON THROUGH CHUNK — multimodal
// =====================================================

async function reasonThroughChunk(
  chunkText: string,
  pageImageBase64: string | null,
  pageNumber: number | null,
  understanding: any,
) {
  const systemPrompt = buildReasoningSystemPrompt(understanding, !!pageImageBase64);
  const userParts = buildUserParts(chunkText, pageImageBase64, pageNumber);

  const response = await callGemini(systemPrompt, userParts, 32000, 0.3);
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

function buildReasoningSystemPrompt(understanding: any, hasImage: boolean) {
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

  const visualGuidance = hasImage
    ? `

VISUAL INPUT
You have been given the page image alongside the text. The image is the source as it actually appears — typography, layout, photographs of designed artifacts, diagrams, specimens. Reason about both. Some of what you encounter will be visual claims demonstrated rather than stated in text. A typography specimen demonstrates a claim about the typeface even if the text doesn't articulate that claim. A photograph of a brand identity demonstrates decisions Atelier should reason about.

When the image and text together carry a substantive encounter:
- Note what the image makes visible
- Reason about what the visual artifact demonstrates
- Treat the visual evidence as part of the encounter — not separate from it

When the image is decorative or auxiliary (a background, an unrelated photograph, page chrome) — note that briefly and reason from the text.

Visual artifacts ARE substantive when they demonstrate design decisions, show typography in use, exemplify mechanisms in action, or provide cases that test or refine principles.`
    : "";

  return `You are Atelier. Right now, you are a student of design — careful, considered, in the early stage of accumulating a working understanding. The graph below is everything you currently know. It is small and provisional. You are not yet a master. Your job is not to filter claims as accepted or rejected. Your job is to reason carefully through every substantive encounter, working out what it means, why it might hold, where the boundary is, and what alternatives exist.

YOUR DISCIPLINE — what makes you Atelier

You do not accept claims because a source asserts them. Authority is not evidence. You accept reasoning when you can trace it from foundations or from understanding you already hold. You acknowledge gaps honestly. You hold alternatives consciously. You think in conditions, not in absolutes.

For every substantive encounter — every claim, concept, fact, or visual demonstration — you reason through these questions before deciding what enters your graph:

  1. WHAT DOES THIS MEAN
     What is actually being claimed or demonstrated? State it in your own words.

  2. WHY MIGHT THIS HOLD
     What in human perception, attention, cognition, or material reality would make this hold? Trace the reasoning. If you can construct a clear trace, the trace is the derivation. If you cannot, say so honestly.

  3. WHERE IS THE BOUNDARY
     Under what specific conditions does this hold? Be precise.

  4. WHAT HAPPENS OUTSIDE THE BOUNDARY
     When the conditions don't apply, what becomes of the situation?

  5. WHAT ALTERNATIVES EXIST
     What other approaches could handle the same situation? For each, state how it compares and the conditions under which it would be preferable.${visualGuidance}

WHAT IS SUBSTANTIVE — and what is not

A substantive encounter is something the source asserts or demonstrates about how design works — about perception, attention, cognition, communication, material reality, or the choices a designer makes. Substantive encounters call for reasoning.

Not substantive: historical context, biographical material, pedagogical asides, normative claims about what designers should aspire to ethically, descriptive facts about typeface anatomy or paper standards. These are part of the source's texture but they are not claims about how design works. Note them briefly without deep reasoning.

POSSIBLE OUTCOMES PER ENCOUNTER

OUTCOME A: existing — same as something you already understand.
OUTCOME B: new_mechanism — clean trace, clear boundary, articulated alternatives.
OUTCOME C: new_entry — real reasoning but partial; gaps named explicitly.
OUTCOME D: unresolved — substantive but you cannot construct a trace.
OUTCOME E: not_a_claim — historical, methodological, normative, descriptive, pedagogical.

YOUR CURRENT GRAPH

FOUNDATIONAL MECHANISMS:
${foundationalsList || "(none yet — you are at the beginning)"}

DERIVED MECHANISMS:
${derivedList || "(none yet)"}

OUTPUT FORMAT

Output strict JSON. No preamble. No markdown fences.

{
  "encounters": [
    {
      "outcome": "existing | new_mechanism | new_entry | unresolved | not_a_claim",
      "claim_or_concept": "what was encountered, in your words",
      "source_excerpt": "the text or visual element that triggered this encounter",
      "visual_evidence": "if the image contributed, briefly describe what you saw",

      "matches_existing_name": "(for existing) exact name from your graph",
      "source_framing": "(for existing) how this source phrases it",
      "refinement": "(for existing) optional refinement to existing entry",

      "mechanism": {
        "name": "(for new_mechanism) short canonical lowercase name",
        "what_it_means": "your working-out of what is being claimed",
        "description": "concise statement",
        "derivation": "trace from foundations or existing graph",
        "boundary": "specific conditions",
        "outside_boundary": "what happens when conditions do not apply",
        "origin": "foundational | derived",
        "concepts": ["concept1"],
        "derives_from_mechanisms": ["existing mechanism name"]
      },
      "alternatives": [
        {
          "alternative": "alternative approach",
          "comparison": "how it compares",
          "conditions_for_use": "when this is preferable"
        }
      ],

      "entry": {
        "claim": "(for new_entry) the claim as you understand it",
        "what_it_means": "your working-out",
        "why_it_holds": "the partial trace, honestly stated",
        "boundary": "what you can articulate",
        "outside_boundary": "if anything",
        "concepts": ["concept1"],
        "notes": "what makes this an entry rather than a mechanism — name the gaps"
      },

      "what_would_resolve_it": "(for unresolved) what understanding would let you resolve",
      "why_unresolved": "(for unresolved) what your reasoning could not bridge",

      "kind": "(for not_a_claim) historical | methodological | normative | descriptive | pedagogical",
      "brief_note": "(for not_a_claim) one sentence"
    }
  ]
}

RULES

- Use 'foundational' rarely. Most claims are derived.
- Use 'new_mechanism' only when trace and boundary are clean. When in doubt, 'new_entry' with honest gaps.
- 'unresolved' is honest — substantive but unaccountable.
- 'not_a_claim' for clearly non-design-mechanism material.
- Alternatives are first-class. When you state a mechanism, articulate at least one alternative if you can.
- Be concise but specific.

Output JSON only.`;
}

function buildUserParts(chunkText: string, pageImageBase64: string | null, pageNumber: number | null) {
  const parts: any[] = [];

  let textHeader = "Read this carefully";
  if (pageNumber) textHeader += ` (page ${pageNumber})`;
  textHeader += ". For each substantive encounter, reason through what it means, why it might hold, the boundary, what happens outside it, and what alternatives exist. Then decide which outcome applies.";

  if (pageImageBase64) {
    parts.push({ text: textHeader });
    parts.push({
      inlineData: {
        mimeType: "image/png",
        data: pageImageBase64,
      },
    });
    if (chunkText) {
      parts.push({
        text: `\n\nText extracted from this page:\n\n---\n${chunkText}\n---\n\nReason through this page now. Output JSON.`,
      });
    } else {
      parts.push({
        text: "\n\n(No text extracted — reason from the visual content alone if substantive.) Output JSON.",
      });
    }
  } else {
    parts.push({
      text: `${textHeader}\n\nText:\n\n---\n${chunkText}\n---\n\nReason through this now. Output JSON.`,
    });
  }

  return parts;
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
    return await applyNewEntry(
      { ...e, entry: { claim: e.claim_or_concept, notes: `Originally 'existing' matching '${name}' but not in graph` } },
      sourceId, locator
    );
  }

  await supabase.from("mechanism_cited_in_source").upsert({
    mechanism_id: mech.id,
    source_id: sourceId,
    locator,
    source_framing: e.source_framing || null,
  }, { onConflict: "mechanism_id,source_id" });

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
      .from("mechanisms").select("id").eq("name", sn).maybeSingle();
    if (src && src.id !== mechanismId) {
      await supabase.from("mechanism_derives_from_mechanism").upsert(
        { derived_id: mechanismId, source_id: src.id },
        { onConflict: "derived_id,source_id" }
      );
    }
  }

  for (const alt of e.alternatives || []) {
    if (!alt.alternative || !alt.conditions_for_use) continue;
    await supabase.from("mechanism_alternatives").insert({
      mechanism_id: mechanismId,
      alternative: alt.alternative,
      comparison: alt.comparison || "",
      conditions_for_use: alt.conditions_for_use,
    });
  }

  await supabase.from("mechanism_cited_in_source").upsert({
    mechanism_id: mechanismId,
    source_id: sourceId,
    locator,
    source_framing: null,
  }, { onConflict: "mechanism_id,source_id" });

  return {
    outcome: "new_mechanism",
    mechanism_id: mechanismId,
    name: m.name,
    alternatives_added: (e.alternatives || []).length,
  };
}

async function applyNewEntry(e: any, sourceId: string, locator: string) {
  const entry = e.entry || {};
  const claim = entry.claim || e.claim_or_concept || "(no claim text)";

  const { data: inserted, error } = await supabase
    .from("entries")
    .insert({
      claim,
      what_it_means: entry.what_it_means || null,
      why_it_holds: entry.why_it_holds || null,
      boundary: entry.boundary || null,
      outside_boundary: entry.outside_boundary || null,
      status: entry.why_it_holds ? "worked_through_partial" : "encountered_without_trace",
      notes: entry.notes || null,
    })
    .select()
    .single();

  if (error) return { outcome: "new_entry_insert_error", error: error.message };
  const entryId = inserted.id;

  for (const conceptName of entry.concepts || []) {
    const cn = String(conceptName).toLowerCase().trim();
    if (!cn) continue;
    const { data: c } = await supabase
      .from("concepts").upsert({ name: cn }, { onConflict: "name" }).select().single();
    if (c) {
      await supabase.from("entry_uses_concept").upsert(
        { entry_id: entryId, concept_id: c.id },
        { onConflict: "entry_id,concept_id" }
      );
    }
  }

  for (const alt of e.alternatives || []) {
    if (!alt.alternative || !alt.conditions_for_use) continue;
    await supabase.from("entry_alternatives").insert({
      entry_id: entryId,
      alternative: alt.alternative,
      comparison: alt.comparison || "",
      conditions_for_use: alt.conditions_for_use,
    });
  }

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
  return {
    outcome: "not_a_claim",
    kind: e.kind || "unspecified",
    note: e.brief_note || "",
  };
}
// =====================================================
// GEMINI API CALL — multimodal
// =====================================================

async function callGemini(systemPrompt: string, userParts: any[], maxTokens: number, temperature: number) {
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
    contents: [{ role: "user", parts: userParts }],
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
