// Contract for the Notion bootstrap schema (tools/bootstrap-notion.cjs databaseSpecs +
// relationUpdates). Ported from the retired Python test_notion_schema.py.

const test = require('node:test');
const assert = require('node:assert/strict');
const { databaseSpecs, relationUpdates } = require('../tools/bootstrap-notion.cjs');

test('bootstrap defines the five linked domain collections', () => {
  const specs = databaseSpecs('parent-page-id');
  assert.deepEqual(Object.keys(specs).sort(), ['activities', 'contacts', 'deadlines', 'documents', 'opportunities']);
  for (const spec of Object.values(specs)) {
    assert.deepEqual(spec.parent, { type: 'page_id', page_id: 'parent-page-id' });
    const titleProperties = Object.values(spec.initial_data_source.properties).filter((p) => 'title' in p);
    assert.deepEqual(titleProperties, [{ title: {} }]);
  }
});

test('contacts capture supervisor research topics', () => {
  const contacts = databaseSpecs('parent-page-id').contacts;
  assert.deepEqual(contacts.initial_data_source.properties['Research topics'], { rich_text: {} });
});

test('child collections link back to opportunities bidirectionally', () => {
  const updates = relationUpdates({
    opportunities: 'opportunities-id',
    deadlines: 'deadlines-id',
    contacts: 'contacts-id',
    activities: 'activities-id',
    documents: 'documents-id',
  });
  assert.deepEqual(Object.keys(updates).sort(), ['activities', 'contacts', 'deadlines', 'documents']);
  for (const update of Object.values(updates)) {
    assert.deepEqual(update, {
      properties: {
        Opportunity: { relation: { data_source_id: 'opportunities-id', dual_property: {} } },
      },
    });
  }
});
