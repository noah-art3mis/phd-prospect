// n8n Cloud Code-node sandbox: no `URL`, no `require` (Date and Set are fine).
// Code node: "Prepare opportunities" — runOnceForAllItems
// One item per active confirmed opportunity to recheck, carrying its canonical URL and stored status.
function text(prop) { const rt = (prop && prop.rich_text) || (prop && prop.title) || []; return rt.map(function (t) { return t.plain_text || (t.text && t.text.content) || ''; }).join(''); }
const pages = (($input.first() && $input.first().json && $input.first().json.results) || []);
const out = [];
for (const page of pages) {
  const p = page.properties || {};
  out.push({ json: {
    page_id: page.id,
    canonical_url: (p['Canonical URL'] && p['Canonical URL'].url) || (p['Source URL'] && p['Source URL'].url) || '',
    title: text(p['Name']) || '(untitled)',
    stored_status: (p['Opportunity status'] && p['Opportunity status'].select && p['Opportunity status'].select.name) || 'Unknown'
  } });
}
return out;
