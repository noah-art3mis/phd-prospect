// Contract for the one-time Notion workspace bootstrap (tools/bootstrap-notion.cjs
// bootstrapWorkspace): create the five collections, then link the children back to
// opportunities. Ported from the retired Python test_notion_bootstrap.py.

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootstrapWorkspace } = require('../tools/bootstrap-notion.cjs');

test('bootstrap creates collections then links children to opportunities', async () => {
  const calls = [];
  async function request(method, path, payload) {
    calls.push([method, path, payload]);
    if (method === 'POST') {
      const key = payload.title[0].text.content.split('–').pop().trim().toLowerCase();
      return { id: key + '-database' };
    }
    if (method === 'GET') {
      const key = path.split('/').pop().replace(/-database$/, '');
      return { id: key + '-database', data_sources: [{ id: key + '-source' }] };
    }
    return { id: path.split('/').pop() };
  }

  const result = await bootstrapWorkspace('parent-page', { request });

  assert.deepEqual(result, {
    opportunities: 'opportunities-source',
    deadlines: 'deadlines-source',
    contacts: 'contacts-source',
    activities: 'activities-source',
    documents: 'documents-source',
  });
  assert.deepEqual(
    calls.slice(0, 10).map((c) => c.slice(0, 2)),
    [
      ['POST', '/v1/databases'],
      ['GET', '/v1/databases/opportunities-database'],
      ['POST', '/v1/databases'],
      ['GET', '/v1/databases/deadlines-database'],
      ['POST', '/v1/databases'],
      ['GET', '/v1/databases/contacts-database'],
      ['POST', '/v1/databases'],
      ['GET', '/v1/databases/activities-database'],
      ['POST', '/v1/databases'],
      ['GET', '/v1/databases/documents-database'],
    ]
  );
  assert.deepEqual(
    calls.slice(10).map((c) => c.slice(0, 2)),
    [
      ['PATCH', '/v1/data_sources/deadlines-source'],
      ['PATCH', '/v1/data_sources/contacts-source'],
      ['PATCH', '/v1/data_sources/activities-source'],
      ['PATCH', '/v1/data_sources/documents-source'],
    ]
  );
});
