// n8n Cloud Code-node sandbox: no `URL`, no `require` (Date and Set are fine).
// Enumerates postings found on an index page. Stateless: the user re-sends one URL to ingest it.
const env = $json;
const listings = Array.isArray(env.listings) ? env.listings : [];
const lines = ['This link is a listing with ' + listings.length + ' postings. Send me one of these URLs to ingest it:', ''];
for (const p of listings.slice(0, 30)) {
  lines.push('• ' + String(p.title || '(untitled)').slice(0, 160));
  lines.push(String(p.url || ''));
}
if (listings.length === 0) lines.push('(No individual postings could be extracted.)');
return { json: { chat_id: env.chat_id, listing_text: lines.join('\n') } };
