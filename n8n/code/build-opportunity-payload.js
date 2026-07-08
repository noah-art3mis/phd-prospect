// n8n Cloud Code-node sandbox: no `URL`, no `require` (Date and Set are fine).
// Mirrors src/prospect/notion_pages.opportunity_page_payload for the Notion REST API
// (parent = data_source_id, version 2026-03-11). Runs only after explicit confirmation.
// Pinned to the Python spec by tests/test_contract_opportunity_page.py over
// tests/golden/opportunity_page_cases.json.
const row = $json;
const action = $('Authorize callback').item.json.action;
const DS_OPPORTUNITIES = 'REPLACE_WITH_DATA_SOURCE_OPPORTUNITIES';
const record = JSON.parse(row.candidate_json);
const f = record.findings || {};
function foundVal(name){ const fi=f[name]; if(!fi||fi.state!=='found') return ''; const v=fi.value; if(Array.isArray(v)) return v.map(function(x){return typeof x==='object'?JSON.stringify(x):String(x);}).join(', '); return v==null?'':String(v); }
function title(v){ return { title: [{ type:'text', text:{ content: String(v).slice(0,2000) } }] }; }
function richText(v){ return v ? { rich_text: [{ type:'text', text:{ content: String(v).slice(0,2000) } }] } : { rich_text: [] }; }
function select(name){ return { select: { name: name } }; }
function evidenceSummary(){ const ev={}; for(const k of Object.keys(f)){ const e=f[k].evidence; if(e && e.length) ev[k]=e; } return JSON.stringify(ev).slice(0,2000); }
const oppStatusRaw = foundVal('opportunity_status').toLowerCase();
const oppStatus = oppStatusRaw.indexOf('open')>=0 ? 'Open' : oppStatusRaw.indexOf('closed')>=0 ? 'Closed' : oppStatusRaw.indexOf('withdrawn')>=0 ? 'Withdrawn' : 'Unknown';
const properties = {
  'Name': title(record.title),
  'Canonical URL': { url: row.canonical_url },
  'Source URL': { url: record.source_url },
  'Confirmed': { checkbox: action === 'confirm' },
  'Application stage': select('Inbox'),
  'Opportunity status': select(oppStatus),
  'Institution': richText(foundVal('institution')),
  'Department or lab': richText(foundVal('department_or_lab')),
  'Country': richText(foundVal('country')),
  'City': richText(foundVal('city')),
  'Programme': richText(foundVal('degree_or_programme')),
  'Duration': richText(foundVal('duration')),
  'Advert ID': richText(foundVal('advert_id')),
  'Summary': richText(foundVal('summary')),
  'Fingerprint': richText(row.fingerprint),
  'Last checked': { date: { start: new Date().toISOString() } },
  'Evidence': richText(evidenceSummary())
};
// Free-text finding values map onto Notion select options only through these
// recorded synonyms; anything unmapped stays absent (unknown stays unknown).
const FUNDING_STATUS_OPTIONS = { 'funded':'Fully funded', 'fully funded':'Fully funded', 'partially funded':'Partially funded', 'partial':'Partially funded', 'salaried':'Salaried', 'salary':'Salaried', 'self funded':'Self-funded', 'self-funded':'Self-funded', 'unclear':'Unclear', 'unknown':'Unclear' };
const TUITION_OPTIONS = { 'full':'Full', 'fully covered':'Full', 'home only':'Home only', 'home fees only':'Home only', 'partial':'Partial', 'none':'None', 'not covered':'None', 'unclear':'Unclear' };
const CURRENCIES = ['EUR','GBP','USD','CAD','AUD','CHF'];
function normOption(v){ return String(v == null ? '' : v).trim().toLowerCase().replace(/_/g, ' '); }
function isIsoDate(v){ return /^\d{4}-\d{2}-\d{2}$/.test(v); }
const oppType = foundVal('opportunity_type');
if (oppType) properties['Type'] = select(oppType.replace(/,/g, ' ').slice(0, 100));
const startDate = foundVal('start_date');
if (startDate.length >= 10 && isIsoDate(startDate.slice(0, 10))) properties['Start date'] = { date: { start: startDate.slice(0, 10) } };
const applicationUrl = foundVal('application_url');
if (applicationUrl.indexOf('http://') === 0 || applicationUrl.indexOf('https://') === 0) properties['Application URL'] = { url: applicationUrl };
const funding = f['funding'];
if (funding && funding.state === 'found' && funding.value && typeof funding.value === 'object' && !Array.isArray(funding.value)) {
  const fv = funding.value;
  const status = FUNDING_STATUS_OPTIONS[normOption(fv.status)];
  if (status) properties['Funding status'] = select(status);
  if (typeof fv.stipend === 'number' && isFinite(fv.stipend)) properties['Stipend or salary'] = { number: fv.stipend };
  const currency = String(fv.currency == null ? '' : fv.currency).trim().toUpperCase();
  if (currency) properties['Currency'] = select(CURRENCIES.indexOf(currency) >= 0 ? currency : 'Other');
  const tuition = TUITION_OPTIONS[normOption(fv.tuition_coverage)];
  if (tuition) properties['Tuition coverage'] = select(tuition);
}
const notion_page = { parent: { type: 'data_source_id', data_source_id: DS_OPPORTUNITIES }, properties: properties };
return [{ json: { notion_page: notion_page, token: row.token, chat_id: row.chat_id, action: action, candidate_json: row.candidate_json, title: record.title } }];
