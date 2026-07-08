// Contract for Notion seeding (tools/seed-notion.cjs): contactPagePayload and seedContacts,
// plus resolving the contacts data-source id from a bootstrap-output file. Ported from the
// retired Python test_seed.py, test_contact_pages.py, and the seed-contacts CLI tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { contactPagePayload, seedContacts, dataSourceIdFrom } = require('../tools/seed-notion.cjs');

test('contact payload maps supervisor fields to notion properties', () => {
  const payload = contactPagePayload('contacts-source', {
    name: 'Arkaitz Zubiaga',
    role: 'Supervisor',
    institution_or_lab: 'Social Data Science Lab, Queen Mary',
    research_topics: 'Social media, disinformation, NLP',
    profile_url: 'https://www.zubiaga.org/',
    notes: 'Also Centre for Human-Centred Computing',
  });
  assert.deepEqual(payload.parent, { type: 'data_source_id', data_source_id: 'contacts-source' });
  const p = payload.properties;
  assert.equal(p.Name.title[0].text.content, 'Arkaitz Zubiaga');
  assert.deepEqual(p.Role, { select: { name: 'Supervisor' } });
  assert.equal(p['Institution or lab'].rich_text[0].text.content, 'Social Data Science Lab, Queen Mary');
  assert.equal(p['Research topics'].rich_text[0].text.content, 'Social media, disinformation, NLP');
  assert.equal(p['Profile URL'].url, 'https://www.zubiaga.org/');
  assert.deepEqual(p['Response status'], { select: { name: 'Not contacted' } });
});

test('contact payload omits absent optional fields', () => {
  const p = contactPagePayload('contacts-source', { name: 'Pepa' }).properties;
  assert.equal(p.Name.title[0].text.content, 'Pepa');
  assert.ok(!('Role' in p));
  assert.ok(!('Profile URL' in p));
  assert.deepEqual(p['Research topics'], { rich_text: [] });
  assert.deepEqual(p['Response status'], { select: { name: 'Not contacted' } });
});

test('seed_contacts posts one page per contact to the data source', async () => {
  const calls = [];
  async function request(method, pagePath, payload) {
    calls.push([method, pagePath, payload]);
    return { id: 'page-' + calls.length };
  }
  const created = await seedContacts(
    'contacts-source',
    [
      { name: 'Arkaitz Zubiaga', role: 'Supervisor' },
      { name: 'Kalina Bontcheva', role: 'Supervisor' },
    ],
    { request }
  );
  assert.deepEqual(created, ['page-1', 'page-2']);
  assert.deepEqual(calls.map((c) => c[0]), ['POST', 'POST']);
  assert.deepEqual([...new Set(calls.map((c) => c[1]))], ['/v1/pages']);
  assert.deepEqual(calls[0][2].parent, { type: 'data_source_id', data_source_id: 'contacts-source' });
  assert.equal(calls[0][2].properties.Name.title[0].text.content, 'Arkaitz Zubiaga');
});

test('seed-contacts resolves the data source id from a bootstrap-output file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-'));
  const sources = path.join(dir, 'notion-data-sources.json');
  fs.writeFileSync(sources, JSON.stringify({ contacts: 'contacts-ds-id' }));
  assert.equal(dataSourceIdFrom(sources, 'contacts'), 'contacts-ds-id');
  assert.equal(dataSourceIdFrom(null, 'contacts'), null);
  fs.writeFileSync(sources, JSON.stringify({ opportunities: 'o-1' }));
  assert.equal(dataSourceIdFrom(sources, 'contacts'), null);
});
