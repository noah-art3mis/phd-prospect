// n8n Cloud Code-node sandbox: no `URL`, no `require` (Date and Set are fine).
// Pulls the structured object out of the Anthropic response and computes research gaps.
{{INLINE_JS:n8n/code/missing_fields.js}}

const env = $('Build extract request').item.json;
const resp = $json;

function extractStructured(r) {
  if (r && typeof r === 'object' && r.candidate && r.page_kind) return r;
  if (r && r.output && typeof r.output === 'object' && r.output.candidate) return r.output;
  const blocks = (r && Array.isArray(r.content)) ? r.content : null;
  if (blocks) {
    for (const b of blocks) { if (b && b.type === 'json' && b.json) return b.json; }
    const texts = blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
    if (texts.trim()) return JSON.parse(texts);
  }
  const raw = typeof r === 'string' ? r : (r && (r.data || r.body));
  if (typeof raw === 'string' && raw.trim()) return JSON.parse(raw);
  throw new Error('Could not parse extraction response');
}

const parsed = extractStructured(resp);
const page_kind = parsed.page_kind === 'listing' ? 'listing' : 'posting';
const listings = Array.isArray(parsed.listings) ? parsed.listings : [];
const candidate = parsed.candidate || { title: '', source_url: env.source_url, findings: {} };
if (!candidate.source_url) candidate.source_url = env.source_url;
if (!candidate.findings || typeof candidate.findings !== 'object') candidate.findings = {};

const missing_fields = computeMissingFields(candidate);

return { json: { ...env, candidate: candidate, page_kind: page_kind, listings: listings, missing_fields: missing_fields } };
