// n8n Cloud Code-node sandbox: no `URL`, no `require` (Date and Set are fine).
// Code node: "Compute due reminders" — runOnceForAllItems
// Port of src/prospect/reminders.due_reminders. Emits every reminder DUE today (verified,
// non-rolling deadline whose days-remaining matches an offset). Idempotency is enforced
// downstream by the "Prospect sent reminders" Data Table (rowNotExists filter, then insert),
// so this node no longer reads/writes sent keys itself.
// Key format: opportunity_id:deadline_id:version:offset (offset = days remaining).
const TZ = 'America/Mexico_City';
const ALLOWED_CHAT_ID = REPLACE_WITH_TELEGRAM_USER_ID;

// "Today" in the workflow timezone as YYYY-MM-DD (Code node has no $today/luxon).
const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
function dayNumber(ymd) { const p = String(ymd).slice(0, 10).split('-').map(Number); return Date.UTC(p[0], p[1] - 1, p[2]) / 86400000; }
const today = dayNumber(todayStr);

function text(prop) {
  const rt = (prop && prop.rich_text) || (prop && prop.title) || [];
  return rt.map(function (t) { return t.plain_text || (t.text && t.text.content) || ''; }).join('');
}

const pages = (($input.first() && $input.first().json && $input.first().json.results) || []);
const out = [];
for (const page of pages) {
  const p = page.properties || {};
  const verified = !!(p['Verified'] && p['Verified'].checkbox);
  const rolling = !!(p['Rolling'] && p['Rolling'].checkbox);
  if (!verified || rolling) continue;
  const due = p['Due'] && p['Due'].date && p['Due'].date.start;
  if (!due) continue;
  const version = (p['Version'] && typeof p['Version'].number === 'number') ? p['Version'].number : 1;
  const offsets = ((p['Reminder offsets'] && p['Reminder offsets'].multi_select) || [])
    .map(function (o) { return parseInt(o.name, 10); }).filter(function (n) { return !isNaN(n); });
  const oppId = (p['Opportunity'] && p['Opportunity'].relation && p['Opportunity'].relation[0] && p['Opportunity'].relation[0].id) || '';
  const deadlineId = page.id;
  const daysRemaining = dayNumber(due) - today;
  if (offsets.indexOf(daysRemaining) === -1) continue;
  const key = oppId + ':' + deadlineId + ':' + version + ':' + daysRemaining;
  const name = text(p['Name']) || 'a deadline';
  out.push({ json: {
    chat_id: ALLOWED_CHAT_ID,
    key: key,
    deadline_id: deadlineId,
    opportunity_id: oppId,
    version: version,
    days_remaining: daysRemaining,
    due_at: due,
    sent_at: new Date().toISOString(),
    reminder_text: '⏰ ' + daysRemaining + ' day(s) until ' + name + ' (' + String(due).slice(0, 10) + ').'
  } });
}
return out;
