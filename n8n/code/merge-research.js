// n8n Cloud Code-node sandbox: no `URL`, no `require` (Date and Set are fine).
// Merges researched findings into the candidate, constrained to the requested (missing) fields.
// Research is read-only enrichment: any field it returns outside the requested set is dropped.
const env = $('Build research request').item.json;
const resp = $json;
const requested = new Set(Array.isArray(env.missing_fields) ? env.missing_fields : []);

function extractStructured(r) {
  if (r && typeof r === 'object' && r.findings && !r.content) return r;
  if (r && r.output && r.output.findings) return r.output;
  const blocks = (r && Array.isArray(r.content)) ? r.content : null;
  if (blocks) {
    for (const b of blocks) { if (b && b.type === 'json' && b.json) return b.json; }
    const texts = blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
    if (texts.trim()) return JSON.parse(texts);
  }
  const raw = typeof r === 'string' ? r : (r && (r.data || r.body));
  if (typeof raw === 'string' && raw.trim()) return JSON.parse(raw);
  return { findings: {} };
}

const research = extractStructured(resp);
const researched = (research && research.findings && typeof research.findings === 'object') ? research.findings : {};

const candidate = JSON.parse(JSON.stringify(env.candidate));
if (!candidate.findings || typeof candidate.findings !== 'object') candidate.findings = {};
const dropped = [];
for (const f of Object.keys(researched)) {
  if (requested.has(f)) candidate.findings[f] = researched[f];
  else dropped.push(f);
}

return { json: { ...env, candidate: candidate, research_dropped_fields: dropped } };
