// n8n Cloud Code-node sandbox: no `URL`, no `require` (Date and Set are fine).
// Code node: "Diff and alert" — runOnceForEachItem
// Compares the recheck against the stored status and flags changes/closure/disappearance.
// It ONLY produces alerts and a Last-checked timestamp — it never rewrites confirmed critical values.
const ctx = $('Build recheck request').item.json;
const resp = $json;
const ALLOWED_CHAT_ID = REPLACE_WITH_TELEGRAM_USER_ID;

function parseJsonLoose(text) {
  const s = String(text).trim();
  try { return JSON.parse(s); } catch (e) { /* fall through */ }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first !== -1 && last > first) { try { return JSON.parse(s.slice(first, last + 1)); } catch (e) { /* fall through */ } }
  return {};
}
function extract(r) {
  if (r && typeof r === 'object' && (r.opportunity_status || r.still_accepting_applications !== undefined)) return r;
  const blocks = (r && Array.isArray(r.content)) ? r.content : null;
  if (blocks) {
    const texts = blocks.filter(function (b) { return b && b.type === 'text' && typeof b.text === 'string'; }).map(function (b) { return b.text; }).join('');
    if (texts.trim()) return parseJsonLoose(texts);
  }
  const raw = typeof r === 'string' ? r : (r && (r.data || r.body));
  if (typeof raw === 'string' && raw.trim()) return parseJsonLoose(raw);
  return {};
}

const alerts = [];
const fetchFailed = !!ctx.fetch_error || (ctx.content_len || 0) === 0;
let newStatus = '';
if (fetchFailed) {
  alerts.push('the source could not be fetched (' + (ctx.fetch_error || 'empty response') + ') — the page may have moved or been removed');
} else {
  const extracted = extract(resp);
  newStatus = String(extracted.opportunity_status || '').toLowerCase();
  const stored = String(ctx.stored_status || '').toLowerCase();
  if (newStatus === 'closed' || newStatus === 'withdrawn') {
    alerts.push('the opportunity now appears ' + newStatus + ' at the source');
  } else if (newStatus && stored && stored !== 'unknown' && newStatus !== stored) {
    alerts.push('status may have changed: Notion has "' + ctx.stored_status + '", the source reads "' + newStatus + '"');
  }
  if (extracted.still_accepting_applications === false && newStatus !== 'closed' && newStatus !== 'withdrawn') {
    alerts.push('the source indicates it is no longer accepting applications');
  }
}

const alert = alerts.length > 0;
return { json: {
  page_id: ctx.page_id,
  title: ctx.title,
  chat_id: ALLOWED_CHAT_ID,
  alert: alert,
  new_status: newStatus,
  alert_text: '🔁 Recheck — ' + ctx.title + '\n' + ctx.canonical_url + '\n- ' + alerts.join('\n- ') + '\n\nNo confirmed values were changed. Review and update in Notion if needed.',
  last_checked_body: { properties: { 'Last checked': { date: { start: new Date().toISOString() } } } }
} };
