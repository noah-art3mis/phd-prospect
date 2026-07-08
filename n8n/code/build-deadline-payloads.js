// n8n Cloud Code-node sandbox: no `URL`, no `require` (Date and Set are fine).
// Emits one item per confirmed deadline as a Notion page body, related to the new opportunity.
// Deadlines are first-class records, never a field on the opportunity.
const created = $json;
const payloadCtx = $('Build opportunity payload').item.json;
const DS_DEADLINES = 'REPLACE_WITH_DATA_SOURCE_DEADLINES';
const opportunityPageId = created.id;
const record = JSON.parse(payloadCtx.candidate_json);
const action = payloadCtx.action;
const f = record.findings || {};
const dfi = f.deadlines;
const items = [];
if (dfi && dfi.state === 'found' && Array.isArray(dfi.value)) {
  const evidence = Array.isArray(dfi.evidence) ? dfi.evidence : [];
  const ev0 = evidence[0] || {};
  for (const d of dfi.value) {
    const type = String(d.type || '').trim();
    const label = type ? (type.charAt(0).toUpperCase() + type.slice(1).replace(/_/g, ' ')) : 'Programme application';
    const rolling = d.rolling === true;
    const dueIso = d.due_at || null;
    const properties = {
      'Name': { title: [{ type: 'text', text: { content: (label + (dueIso ? ' — ' + String(dueIso).slice(0, 10) : ' — rolling')).slice(0, 2000) } }] },
      'Type': { select: { name: label } },
      'Rolling': { checkbox: rolling },
      'Verified': { checkbox: action === 'confirm' },
      'Version': { number: 1 },
      'Reminder offsets': { multi_select: [{ name: '30' }, { name: '14' }, { name: '7' }, { name: '1' }] },
      'Reminder keys sent': { rich_text: [] },
      'Timezone': d.timezone ? { rich_text: [{ type: 'text', text: { content: String(d.timezone).slice(0, 2000) } }] } : { rich_text: [] },
      'Evidence URL': { url: ev0.url || null },
      'Evidence excerpt': ev0.excerpt ? { rich_text: [{ type: 'text', text: { content: String(ev0.excerpt).slice(0, 2000) } }] } : { rich_text: [] },
      'Opportunity': { relation: [{ id: opportunityPageId }] }
    };
    if (dueIso) properties['Due'] = { date: { start: dueIso } };
    items.push({ json: { notion_page: { parent: { type: 'data_source_id', data_source_id: DS_DEADLINES }, properties: properties } } });
  }
}
return items;
