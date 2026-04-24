import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PROJECT_ID = "76331ea7-2ceb-40e1-985c-11d5ee580dc3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const body = await safeJson(req);
  const project_id = body.project_id || PROJECT_ID;
  const userMessage =
    body.message ||
    "I want the app to ask questions when my intention is unclear instead of guessing.";

  const geminiKey = Deno.env.get("GEMINI_API_KEY");
  if (!geminiKey) return jsonError("gemini_key", "GEMINI_API_KEY is missing");

  const savedUserMessage = await insertOne("user_messages", {
    project_id,
    role: "user",
    content: userMessage,
  }, "save_user_message");

  if (!savedUserMessage.ok) return savedUserMessage.response;

  const graphResult = await supabase
    .from("graph_nodes")
    .select("id, value, node_type, layer, confidence, created_at")
    .eq("project_id", project_id)
    .order("created_at", { ascending: false })
    .limit(40);

  if (graphResult.error) return jsonError("fetch_graph_nodes", graphResult.error.message);

  const graphNodes = graphResult.data || [];
  const searchMeaning = await geminiText(geminiKey, `
Convert this user message into ONE clean search meaning.
Return plain text only.

User message:
${userMessage}
`);

  if (!searchMeaning.ok) return jsonError("extract_search_meaning", searchMeaning.error);

  const relevant = await geminiJson(geminiKey, `
You are the context retrieval layer for a personal intelligence graph.

Search meaning:
${searchMeaning.text}

Stored graph meanings:
${JSON.stringify(graphNodes.map(n => ({
  id: cleanId(n.id),
  text: n.value?.text || "",
  layer: n.layer || "",
  confidence: n.confidence || null
})), null, 2)}

Rules:
- Select only meanings that directly help answer or continue the user's current request.
- If nothing is relevant, return an empty selected_node_ids array.
- Select at most 5 nodes.
- Return valid JSON only.

Return:
{
  "selected_node_ids": ["node-id"],
  "relevance": [{"node_id":"node-id","reason":"short reason","strength":0.9}]
}
`);

  if (!relevant.ok) return jsonError("choose_relevant_context", relevant.error);

  const selectedIds = Array.isArray(relevant.json.selected_node_ids)
    ? relevant.json.selected_node_ids.map(cleanId)
    : [];

  const selectedNodes = graphNodes.filter(n => selectedIds.includes(cleanId(n.id)));

  const reply = await geminiText(geminiKey, `
You are Perspective, a personal intelligence assistant.

Use relevant graph context when useful.
Do not pretend the context says more than it says.
If the user's request is ambiguous, ask one clarifying question.
If implementation guidance is needed, give the next concrete step.

User message:
${userMessage}

Relevant graph context:
${JSON.stringify(selectedNodes.map(n => ({ id: cleanId(n.id), meaning: n.value?.text || "" })), null, 2)}

Reply rules:
- Be direct.
- Do not mention internal table names unless needed.
- Do not dump long theory.
- Plain text only.
`);

  if (!reply.ok) return jsonError("generate_reply", reply.error);

  const savedAssistantMessage = await insertOne("user_messages", {
    project_id,
    role: "assistant",
    content: reply.text,
  }, "save_assistant_message");

  if (!savedAssistantMessage.ok) return savedAssistantMessage.response;

  const mutationResult = await geminiJson(geminiKey, `
You are the mutation gate for a long-term personal intelligence graph.

Decide whether this user message should mutate long-term graph memory.

Long-term memory SHOULD store only:
preferences, requirements, constraints, decisions, corrections, goals, definitions, stable context, artifact instructions.

Long-term memory should NOT store:
casual questions, temporary one-time requests, tool errors, short acknowledgments unless they confirm a decision, duplicate statements, unclear references, vague design language without clarification.

Allowed mutation_action:
NO_MUTATION, LINK_ONLY, CANDIDATE_MUTATION, COMMIT_MUTATION

Allowed memory_type:
preference, requirement, constraint, decision, correction, goal, definition, stable_context, artifact_instruction, null

User message:
${userMessage}

Relevant existing graph context:
${JSON.stringify(selectedNodes.map(n => ({ id: cleanId(n.id), meaning: n.value?.text || "", type: n.node_type || "" })), null, 2)}

Return valid JSON only:
{
  "mutation_action": "NO_MUTATION",
  "memory_type": null,
  "meaning": null,
  "target_node_id": null,
  "confidence": 0.0,
  "risk": "low",
  "reason": "short reason",
  "clarifying_question": null
}
`);

  if (!mutationResult.ok) return jsonError("mutation_gate", mutationResult.error);

  const mutation = normalizeMutation(mutationResult.json);

  if (mutation.mutation_action === "NO_MUTATION") {
    return jsonResponse({
      success: true,
      status: "reply_created_no_mutation",
      reply: reply.text,
      mutation,
      searchMeaning: searchMeaning.text,
      selectedContext: selectedNodes,
      relevance: relevant.json.relevance || [],
      savedUserMessage: savedUserMessage.data,
      savedAssistantMessage: savedAssistantMessage.data,
      savedGraphNode: null,
      savedMessageNodeLink: null,
      savedEdge: null,
    });
  }

  if (mutation.mutation_action === "CANDIDATE_MUTATION") {
    return jsonResponse({
      success: true,
      status: "reply_created_candidate_mutation",
      reply: mutation.clarifying_question || reply.text,
      mutation,
      searchMeaning: searchMeaning.text,
      selectedContext: selectedNodes,
      relevance: relevant.json.relevance || [],
      savedUserMessage: savedUserMessage.data,
      savedAssistantMessage: savedAssistantMessage.data,
      savedGraphNode: null,
      savedMessageNodeLink: null,
      savedEdge: null,
    });
  }

  if (mutation.mutation_action === "LINK_ONLY") {
    const target = cleanId(mutation.target_node_id) || cleanId(selectedNodes[0]?.id);
    if (!target) {
      return jsonResponse({
        success: true,
        status: "reply_created_link_only_no_target",
        reply: reply.text,
        mutation,
        reason: "LINK_ONLY requested, but no target node was found.",
        savedUserMessage: savedUserMessage.data,
        savedAssistantMessage: savedAssistantMessage.data,
      });
    }

    const link = await insertOne("message_node_links", {
      project_id,
      message_id: savedUserMessage.data.id,
      node_id: target,
      reason: mutation.reason || "Mutation gate linked this message to existing memory.",
      strength: mutation.confidence || 0.8,
    }, "link_only_message");

    if (!link.ok) return link.response;

    return jsonResponse({
      success: true,
      status: "reply_created_link_only",
      reply: reply.text,
      mutation: { ...mutation, target_node_id: target },
      searchMeaning: searchMeaning.text,
      selectedContext: selectedNodes,
      relevance: relevant.json.relevance || [],
      savedUserMessage: savedUserMessage.data,
      savedAssistantMessage: savedAssistantMessage.data,
      savedGraphNode: null,
      savedMessageNodeLink: link.data,
      savedEdge: null,
    });
  }

  const meaning = mutation.meaning;
  if (!meaning) {
    return jsonResponse({
      success: true,
      status: "reply_created_commit_without_meaning",
      reply: reply.text,
      mutation,
      reason: "COMMIT_MUTATION requested but no meaning was provided.",
      savedUserMessage: savedUserMessage.data,
      savedAssistantMessage: savedAssistantMessage.data,
    });
  }

  const duplicate = await geminiJson(geminiKey, `
You are the deduplication layer for a personal intelligence graph.

New meaning:
${meaning}

Existing meanings:
${JSON.stringify(graphNodes.map(n => ({ id: cleanId(n.id), text: n.value?.text || "" })), null, 2)}

Only mark duplicate if the meaning is substantially the same.
Return valid JSON only:
{
  "is_duplicate": false,
  "target_node_id": null,
  "strength": 0,
  "reason": "short reason"
}
`);

  if (!duplicate.ok) return jsonError("check_duplicate", duplicate.error);

  const duplicateDecision = {
    is_duplicate: duplicate.json.is_duplicate === true,
    target_node_id: cleanId(duplicate.json.target_node_id),
    strength: Number(duplicate.json.strength || 0),
    reason: duplicate.json.reason || "",
  };

  if (duplicateDecision.is_duplicate && duplicateDecision.target_node_id && duplicateDecision.strength >= 0.85) {
    const dupLink = await insertOne("message_node_links", {
      project_id,
      message_id: savedUserMessage.data.id,
      node_id: duplicateDecision.target_node_id,
      reason: "Mutation gate committed meaning, but deduplication linked it to an existing node.",
      strength: duplicateDecision.strength,
    }, "link_duplicate_message");

    if (!dupLink.ok) return dupLink.response;

    return jsonResponse({
      success: true,
      status: "reply_created_commit_duplicate_linked",
      reply: reply.text,
      mutation,
      searchMeaning: searchMeaning.text,
      selectedContext: selectedNodes,
      relevance: relevant.json.relevance || [],
      extractedMeaning: meaning,
      duplicateDecision,
      savedUserMessage: savedUserMessage.data,
      savedAssistantMessage: savedAssistantMessage.data,
      savedGraphNode: null,
      savedMessageNodeLink: dupLink.data,
      savedEdge: null,
    });
  }

  const node = await insertOne("graph_nodes", {
    project_id,
    node_type: mutation.memory_type || "meaning",
    layer: "mutation_gate",
    value: {
      text: meaning,
      raw_message: userMessage,
      mutation_action: mutation.mutation_action,
      memory_type: mutation.memory_type,
      risk: mutation.risk,
      reason: mutation.reason,
    },
    confidence: mutation.confidence || 0.85,
  }, "save_graph_node");

  if (!node.ok) return node.response;

  const link = await insertOne("message_node_links", {
    project_id,
    message_id: savedUserMessage.data.id,
    node_id: node.data.id,
    reason: "Mutation gate committed this message as durable graph memory.",
    strength: mutation.confidence || 0.85,
  }, "link_message_to_node");

  if (!link.ok) return link.response;

  const edge = await geminiJson(geminiKey, `
You are the graph edge creation layer.

New meaning:
${meaning}

Existing meanings:
${JSON.stringify(graphNodes.map(n => ({ id: cleanId(n.id), text: n.value?.text || "" })), null, 2)}

Only create an edge if the relationship is clear.
relationship must be one of: refines, requires, supports, contradicts, implies.
Return valid JSON only:
{
  "should_create_edge": false,
  "target_node_id": null,
  "relationship": null,
  "strength": 0,
  "reason": "short reason"
}
`);

  if (!edge.ok) return jsonError("choose_edge", edge.error);

  const edgeDecision = {
    should_create_edge: edge.json.should_create_edge === true,
    target_node_id: cleanId(edge.json.target_node_id),
    relationship: cleanRelationship(edge.json.relationship),
    strength: Number(edge.json.strength || 0),
    reason: edge.json.reason || "",
  };

  let savedEdge = null;

  if (edgeDecision.should_create_edge && edgeDecision.target_node_id && edgeDecision.relationship && edgeDecision.strength > 0) {
    const edgeInsert = await insertOne("graph_edges", {
      project_id,
      from_node_id: node.data.id,
      to_node_id: edgeDecision.target_node_id,
      relationship: edgeDecision.relationship,
      strength: edgeDecision.strength,
    }, "save_edge");

    if (!edgeInsert.ok) return edgeInsert.response;
    savedEdge = edgeInsert.data;
  }

  return jsonResponse({
    success: true,
    status: "reply_created_commit_new_node",
    reply: reply.text,
    mutation,
    searchMeaning: searchMeaning.text,
    selectedContext: selectedNodes,
    relevance: relevant.json.relevance || [],
    extractedMeaning: meaning,
    duplicateDecision,
    edgeDecision,
    savedUserMessage: savedUserMessage.data,
    savedAssistantMessage: savedAssistantMessage.data,
    savedGraphNode: node.data,
    savedMessageNodeLink: link.data,
    savedEdge,
  });
});

async function safeJson(req: Request) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

async function insertOne(table: string, row: any, step: string) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) return { ok: false, response: jsonError(step, error.message) };
  return { ok: true, data };
}

async function geminiText(key: string, prompt: string) {
  const result = await callGemini(key, prompt);
  if (!result.ok) return result;
  return { ok: true, text: result.text.trim() };
}

async function geminiJson(key: string, prompt: string) {
  const result = await callGemini(key, prompt);
  if (!result.ok) return result;
  try {
    return { ok: true, json: JSON.parse(cleanJson(result.text)) };
  } catch {
    return { ok: false, error: "Gemini returned invalid JSON: " + result.text };
  }
}

async function callGemini(key: string, prompt: string) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    }
  );

  const json = await response.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) return { ok: false, error: "Gemini returned no text: " + JSON.stringify(json) };
  return { ok: true, text };
}

function normalizeMutation(d: any) {
  const actions = ["NO_MUTATION", "LINK_ONLY", "CANDIDATE_MUTATION", "COMMIT_MUTATION"];
  const types = ["preference", "requirement", "constraint", "decision", "correction", "goal", "definition", "stable_context", "artifact_instruction"];
  const action = String(d?.mutation_action || "NO_MUTATION").replace(/[“”"']/g, "").trim().toUpperCase();
  const type = String(d?.memory_type || "").replace(/[“”"']/g, "").trim().toLowerCase();
  const risk = String(d?.risk || "medium").replace(/[“”"']/g, "").trim().toLowerCase();
  const confidence = Number(d?.confidence || 0);

  return {
    mutation_action: actions.includes(action) ? action : "NO_MUTATION",
    memory_type: types.includes(type) ? type : null,
    meaning: d?.meaning ? String(d.meaning).trim() : null,
    target_node_id: cleanId(d?.target_node_id),
    confidence: Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 ? confidence : 0,
    risk: ["low", "medium", "high"].includes(risk) ? risk : "medium",
    reason: d?.reason ? String(d.reason).trim() : "",
    clarifying_question: d?.clarifying_question ? String(d.clarifying_question).trim() : null,
  };
}

function cleanJson(text: string) {
  return String(text || "").replace(/```json/g, "").replace(/```/g, "").trim();
}

function cleanId(id: any) {
  const cleaned = String(id || "").replace(/[“”"']/g, "").replace(/`/g, "").trim();
  if (!cleaned || ["null", "undefined", "none"].includes(cleaned.toLowerCase())) return null;
  return cleaned;
}

function cleanRelationship(value: any) {
  const allowed = ["refines", "requires", "supports", "contradicts", "implies"];
  const cleaned = String(value || "").replace(/[“”"']/g, "").replace(/`/g, "").trim().toLowerCase();
  return allowed.includes(cleaned) ? cleaned : null;
}

function jsonResponse(data: any) {
  return new Response(JSON.stringify(data), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function jsonError(step: string, error: string) {
  return new Response(JSON.stringify({ success: false, step, error }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
    status: 500,
  });
}
