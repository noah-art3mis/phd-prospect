// Contract for the live n8n "Build opportunity payload" Code node
// (n8n/code/build-opportunity-payload.js), which maps a validated extraction candidate
// to a Notion page. Formerly a cross-language contract against
// src/prospect/notion_pages.opportunity_page_payload; JS is now the single language, so
// the golden cases in tests/golden/opportunity_page_cases.json are asserted directly.
//
// Each case names the properties that must match AND the properties that must stay ABSENT
// (unknown stays unknown — a finding that is missing, non-found, or unmappable must not
// invent a column value).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runNodeCode } = require('./js/noderun.cjs');

const CASES = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden', 'opportunity_page_cases.json'), 'utf8')).cases;

function jsProperties(c) {
  const row = Object.assign({}, c.row, { candidate_json: JSON.stringify(c.candidate) });
  const items = runNodeCode('build-opportunity-payload.js', {
    frozenNowUtc: '2026-07-08T00:00:00.000Z',
    mocks: {
      $json: row,
      $: () => ({ item: { json: { action: c.action } } }),
    },
  });
  // Round-trip through JSON: values built inside node:vm carry the sandbox realm's prototypes.
  return JSON.parse(JSON.stringify(items[0].json.notion_page.properties));
}

for (const c of CASES) {
  test('opportunity page: ' + c.name, () => {
    const properties = jsProperties(c);
    for (const [name, expected] of Object.entries(c.expected_properties)) {
      assert.deepEqual(properties[name], expected, 'property ' + name + ' diverged');
    }
    for (const name of c.absent_properties || []) {
      assert.ok(!(name in properties), 'JS invented a value for ' + name);
    }
  });
}
