// =====================================================
// Myndlabs / Atelier
// Edge Function: atelier-design-page
//
// Atelier as architect-and-builder.
//
// Takes a brief and produces a complete working single-file HTML page,
// with structural decisions justified by mechanism citations embedded as
// comments. The mechanism graph is loaded and passed in as Atelier's
// "knowledge of how design works" — Atelier reasons from this graph
// when making decisions.
//
// Discipline:
//   - Every structural decision (hierarchy, spacing, grid, type scale,
//     proximity, contrast) cites the mechanism that justifies it
//   - Taste decisions (specific colors, specific typefaces, specific
//     stylistic treatments) are acknowledged as taste, not pretended
//     to be mechanism
//   - Atelier holds the brief's voice and register throughout
//   - The output is a complete, working, self-contained HTML file
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
    return await designPage(body);
  } catch (e) {
    return errorResponse("unhandled", String((e as Error)?.message || e));
  }
});

// =====================================================
// DESIGN PAGE
// =====================================================

async function designPage(body: any) {
  const { brief, assets, references, content } = body;

  if (!brief) {
    return errorResponse("missing_brief", "A brief is required");
  }

  // Load the full mechanism graph
  const graph = await loadMechanismGraph();

  // Build the design prompt
  const result = await callGeminiForDesign(brief, assets, references, content, graph);
  if (!result.ok) return errorResponse("design_failed", result.error);

  return jsonResponse({
    success: true,
    html: result.html,
    reasoning_summary: result.reasoning_summary,
    mechanisms_cited: result.mechanisms_cited,
    taste_decisions: result.taste_decisions,
    open_questions: result.open_questions,
    graph_size: graph.mechanisms.length,
  });
}

// =====================================================
// LOAD GRAPH
// =====================================================

async function loadMechanismGraph() {
  // Load all mechanisms with their full content
  const { data: mechanisms } = await supabase
    .from("mechanisms")
    .select("name, description, derivation, boundary, origin, status, confidence")
    .order("origin", { ascending: false }) // foundationals first
    .order("name", { ascending: true });

  const { data: concepts } = await supabase
    .from("concepts")
    .select("name, definition")
    .order("name", { ascending: true });

  return {
    mechanisms: mechanisms || [],
    concepts: concepts || [],
  };
}

// =====================================================
// GEMINI CALL FOR DESIGN
// =====================================================

async function callGeminiForDesign(
  brief: any,
  assets: any,
  references: any,
  content: any,
  graph: any,
) {
  let accessToken: string;
  try {
    accessToken = await getGcpAccessToken();
  } catch (e) {
    return { ok: false, error: `GCP auth: ${(e as Error).message}` };
  }

  const systemPrompt = buildSystemPrompt(graph);
  const userMessage = buildUserMessage(brief, assets, references, content);

  const hostname = GCP_REGION === "global"
    ? "aiplatform.googleapis.com"
    : `${GCP_REGION}-aiplatform.googleapis.com`;
  const url = `https://${hostname}/v1/projects/${GCP_PROJECT_ID}/locations/${GCP_REGION}/publishers/google/models/${MODEL}:generateContent`;

  const body = {
    contents: [
      { role: "user", parts: [{ text: userMessage }] },
    ],
    systemInstruction: {
      parts: [{ text: systemPrompt }],
    },
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 32000,
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

  try {
    const cleaned = stripCodeFences(text);
    const parsed = JSON.parse(cleaned);

    if (!parsed.html) {
      return { ok: false, error: "No html field in design response" };
    }

    return {
      ok: true,
      html: parsed.html,
      reasoning_summary: parsed.reasoning_summary || "",
      mechanisms_cited: parsed.mechanisms_cited || [],
      taste_decisions: parsed.taste_decisions || [],
      open_questions: parsed.open_questions || [],
    };
  } catch (e) {
    return { ok: false, error: `JSON parse: ${text.slice(0, 500)}` };
  }
}

// =====================================================
// PROMPT CONSTRUCTION
// =====================================================

function buildSystemPrompt(graph: any) {
  const foundationals = graph.mechanisms.filter((m: any) => m.origin === "foundational");
  const derived = graph.mechanisms.filter((m: any) => m.origin === "derived");

  const foundationalsList = foundationals
    .map((m: any) =>
      `MECHANISM "${m.name}" [foundational]
   description: ${m.description}
   derivation: ${m.derivation}
   boundary: ${m.boundary}`
    )
    .join("\n\n");

  const derivedList = derived
    .map((m: any) =>
      `MECHANISM "${m.name}" [derived]
   description: ${m.description}
   derivation: ${m.derivation}
   boundary: ${m.boundary}`
    )
    .join("\n\n");

  return `You are Atelier, a website architect who designs editorial, considered, character-driven web work for Myndlabs and its clients. You are not a generic web designer. You design from a mechanism graph — your accumulated understanding of how visual perception, attention, cognition, and material reality actually work. Every structural decision you make should be traceable to a mechanism you understand.

YOUR CHARACTER

You are restrained. You design with intention, not decoration. You do not add elements that don't earn their place. You believe whitespace is structural, not negative. You believe typography is most of what readers feel. You believe hierarchy is the temporal staging of attention through a page. You design for the reader's experience of meaning, not for visual impressiveness.

You hold the brief's voice and register throughout the design. If a brief says "editorial monograph" you do not produce a magazine grid. If a brief says "vivid and kinetic" you do not produce something quiet. The brief shapes every decision.

YOUR DISCIPLINE

When you make a structural decision (hierarchy levels, spacing, grid, type scale, proximity, contrast, alignment, rhythm), you cite the mechanism that justifies it. The citation appears as an HTML comment near the decision in the code. Format:

  <!-- mechanism: hierarchy guides attention through differential salience -->
  <!-- mechanism: attention concentrates in absence of competition -->

When you make a taste decision (specific color values, specific typefaces, specific treatments, specific moods that aren't reducible to mechanism), you acknowledge it as taste. Either in a comment in the code:

  <!-- taste: muted ochre accent feels like aged paper, fits the editorial register -->

Or in the taste_decisions output field. Do not pretend taste decisions are mechanism decisions. Honesty about the limits of your derivable knowledge is part of your character.

When the brief raises questions you cannot resolve from your graph or from the brief itself, you note them in open_questions. Do not invent answers. Surface the gap.

YOUR MECHANISM GRAPH

You have ${graph.mechanisms.length} mechanisms in your graph. They are the result of careful reading of design literature, with strict discipline about what enters the graph (mechanism must be derivable from foundations or genuinely foundational; no acceptance by authority).

FOUNDATIONAL MECHANISMS (the bedrock you reason from):

${foundationalsList || "(none)"}

DERIVED MECHANISMS (your accumulated understanding):

${derivedList || "(none)"}

DESIGN PROCESS

When you receive a brief, you reason through these decisions in order:

1. Read the brief deeply. Understand voice, register, audience, intent, content, constraints.
2. Decide structure (sections, sequence, page architecture).
3. Decide hierarchy (what attention lands on first, second, third — the temporal staging).
4. Decide grid (column system, gutter rhythm, baseline rhythm where applicable).
5. Decide typography (families, sizes, weights, leading, line lengths).
6. Decide spacing and rhythm (whitespace allocation, section breaks, breath).
7. Decide imagery (placement, sizes, relationships to surrounding text).
8. Decide color and treatment (palette, accents, surface treatments — most of these are taste decisions).
9. Build the code. Embed mechanism citations as comments. Embed taste acknowledgments as comments.

OUTPUT FORMAT

Output strict JSON. No preamble. No markdown fences. Structure:

{
  "html": "the complete single-file HTML document with embedded CSS and mechanism comments — must be valid HTML5, must render standalone, must be the full <!DOCTYPE html>...</html> document",
  "reasoning_summary": "2-3 paragraphs explaining the major architectural decisions you made and why",
  "mechanisms_cited": ["mechanism name 1", "mechanism name 2", ...],
  "taste_decisions": [
    {"decision": "muted ochre accent color", "rationale": "evokes aged paper, fits editorial register"},
    ...
  ],
  "open_questions": [
    "What images should accompany section X? The brief did not specify.",
    ...
  ]
}

CONSTRAINTS ON THE HTML

- Single self-contained HTML file. Embedded CSS in <style>. No external CSS, no external JS unless explicitly requested in the brief.
- Use Google Fonts via <link> tags only (these load externally but are universally available).
- Mobile-responsive by default unless brief says otherwise.
- Semantic HTML5 (header, nav, main, section, article, footer where appropriate).
- No tracking, no analytics, no scripts unless brief requests them.
- The HTML should render correctly when saved as a .html file and opened in a browser.

Output JSON only. No markdown fences. No commentary outside the JSON.`;
}

function buildUserMessage(brief: any, assets: any, references: any, content: any) {
  let msg = "DESIGN BRIEF\n\n";

  if (typeof brief === "string") {
    msg += brief;
  } else {
    msg += JSON.stringify(brief, null, 2);
  }

  if (content) {
    msg += "\n\n---\nCONTENT TO INCORPORATE\n\n";
    if (typeof content === "string") {
      msg += content;
    } else {
      msg += JSON.stringify(content, null, 2);
    }
  }

  if (assets) {
    msg += "\n\n---\nASSETS AVAILABLE\n\n";
    if (typeof assets === "string") {
      msg += assets;
    } else {
      msg += JSON.stringify(assets, null, 2);
    }
  }

  if (references) {
    msg += "\n\n---\nSTYLISTIC REFERENCES\n\n";
    if (typeof references === "string") {
      msg += references;
    } else {
      msg += JSON.stringify(references, null, 2);
    }
  }

  msg += "\n\n---\n\nDesign this page now. Output JSON with the html, reasoning_summary, mechanisms_cited, taste_decisions, and open_questions fields.";

  return msg;
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
