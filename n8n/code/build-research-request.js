// n8n Cloud Code-node sandbox: no `URL`, no `require` (Date and Set are fine).
// Code node: "Build research request" — runOnceForEachItem
// Builds a read-only research call bounded to the missing fields only. Like the extract call,
// the JSON contract lives in the prompt (Anthropic strict schema can't express free-form values);
// the deterministic Validate node remains the guardrail.
const env = $json;
const missing = Array.isArray(env.missing_fields) ? env.missing_fields : [];

const system = [
{{PROMPT_LINES:n8n/prompts/research.md}}
].concat([
  "Include ONLY these fields and no others: " + (missing.join(", ") || "(none)") + "."
]).join("\n");

const userText = [
  "Opportunity title: " + (env.candidate && env.candidate.title || "(unknown)"),
  "Known source URL: " + env.source_url,
  "Research ONLY these fields and return nothing else: " + (missing.join(", ") || "(none)")
].join("\n");

const anthropic_request = {
  model: "claude-sonnet-5",
  max_tokens: 8000,
  system: system,
  messages: [{ role: "user", content: userText }],
  tools: [
    { type: "web_search_20260209", name: "web_search", max_uses: 3 },
    { type: "web_fetch_20260209", name: "web_fetch", max_uses: 8 }
  ]
};

return { json: { ...env, research_request: anthropic_request } };
