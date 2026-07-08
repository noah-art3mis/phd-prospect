// Runs the opportunity-page golden cases through the verbatim live Code-node payload
// n8n/code/build-opportunity-payload.js and prints each case's notion_page.properties
// as JSON. Consumed by tests/test_contract_opportunity_page.py, which asserts the
// shared property projection matches the Python spec
// (prospect.notion_pages.opportunity_page_payload) and the recorded expectations.
//
// Usage: node tests/js/run_opportunity_contract.cjs <path-to-opportunity_page_cases.json>

const fs = require('fs');
const { runNodeCode } = require('./noderun.cjs');

const casesPath = process.argv[2];
if (!casesPath) {
  console.error('usage: node run_opportunity_contract.cjs <opportunity_page_cases.json>');
  process.exit(2);
}

const { cases } = JSON.parse(fs.readFileSync(casesPath, 'utf8'));

const out = cases.map((c) => {
  const row = Object.assign({}, c.row, { candidate_json: JSON.stringify(c.candidate) });
  const items = runNodeCode('build-opportunity-payload.js', {
    frozenNowUtc: '2026-07-08T00:00:00.000Z',
    mocks: {
      $json: row,
      $: () => ({ item: { json: { action: c.action } } }),
    },
  });
  return { name: c.name, properties: items[0].json.notion_page.properties };
});

process.stdout.write(JSON.stringify(out));
