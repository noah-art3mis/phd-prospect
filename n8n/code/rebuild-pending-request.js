// n8n Cloud Code-node sandbox: no `URL`, no `require` (Date and Set are fine).
// "Research again" glue: rebuilds the research-path envelope from the stored
// pending row so the callback re-enters Build research request → Research →
// Merge research → Validate record with the same read-only bounds. Carries the
// row's token so Validate record updates the pending row instead of inserting.
{{INLINE_JS:n8n/code/missing_fields.js}}

const row = $('Load pending').first().json;
const candidate = JSON.parse(row.candidate_json);
const missing_fields = computeMissingFields(candidate);

return { json: {
  chat_id: row.chat_id,
  source_url: row.source_url,
  canonical_url: row.canonical_url,
  token: row.token,
  candidate: candidate,
  missing_fields: missing_fields
} };
