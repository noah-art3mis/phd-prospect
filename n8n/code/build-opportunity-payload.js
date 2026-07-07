// n8n Cloud Code-node sandbox: no `URL`, no `require` (Date and Set are fine).
// Mirrors src/prospect/notion_pages.opportunity_page_payload for the Notion REST API
// (parent = data_source_id, version 2026-03-11). Runs only after explicit confirmation.
const row = $json;
const action = $('Authorize callback').item.json.action;
const DS_OPPORTUNITIES = 'REPLACE_WITH_DATA_SOURCE_OPPORTUNITIES';
const record = JSON.parse(row.candidate_json);
const f = record.findings || {};
function foundVal(name){ const fi=f[name]; if(!fi||fi.state!=='found') return ''; const v=fi.value; if(Array.isArray(v)) return v.map(function(x){return typeof x==='object'?JSON.stringify(x):String(x);}).join(', '); return v==null?'':String(v); }
function title(v){ return { title: [{ type:'text', text:{ content: String(v).slice(0,2000) } }] }; }
function richText(v){ return v ? { rich_text: [{ type:'text', text:{ content: String(v).slice(0,2000) } }] } : { rich_text: [] }; }
function evidenceSummary(){ const ev={}; for(const k of Object.keys(f)){ const e=f[k].evidence; if(e && e.length) ev[k]=e; } return JSON.stringify(ev).slice(0,2000); }
const oppStatusRaw = foundVal('opportunity_status').toLowerCase();
const oppStatus = oppStatusRaw.indexOf('open')>=0 ? 'Open' : oppStatusRaw.indexOf('closed')>=0 ? 'Closed' : oppStatusRaw.indexOf('withdrawn')>=0 ? 'Withdrawn' : 'Unknown';
const properties = {
  'Name': title(record.title),
  'Canonical URL': { url: row.canonical_url },
  'Source URL': { url: record.source_url },
  'Confirmed': { checkbox: action === 'confirm' },
  'Application stage': { select: { name: 'Inbox' } },
  'Opportunity status': { select: { name: oppStatus } },
  'Institution': richText(foundVal('institution')),
  'Department or lab': richText(foundVal('department_or_lab')),
  'Country': richText(foundVal('country')),
  'Summary': richText(foundVal('summary')),
  'Fingerprint': richText(row.fingerprint),
  'Last checked': { date: { start: new Date().toISOString() } },
  'Evidence': richText(evidenceSummary())
};
const notion_page = { parent: { type: 'data_source_id', data_source_id: DS_OPPORTUNITIES }, properties: properties };
return [{ json: { notion_page: notion_page, token: row.token, chat_id: row.chat_id, action: action, candidate_json: row.candidate_json, title: record.title } }];
