// Runs the recheck golden cases through the verbatim live Code-node payloads
// n8n/code/diff-and-alert.js and n8n/code/prepare-opportunities.js and prints
// results as JSON. Consumed by tests/test_contract_recheck.py.
//
// diff-and-alert reads its upstream context via $('Build recheck request') and the
// raw Anthropic HTTP output via $json; prepare-opportunities reads the Notion query
// response via $input. Both get a frozen `new Date()` from the shared harness.
//
// Usage: node tests/js/run_recheck_contract.cjs <path-to-recheck_cases.json>

const fs = require('fs');
const { runNodeCode } = require('./noderun.cjs');

const casesPath = process.argv[2];
if (!casesPath) {
  console.error('usage: node run_recheck_contract.cjs <recheck_cases.json>');
  process.exit(2);
}

const cases = JSON.parse(fs.readFileSync(casesPath, 'utf8'));

const diffResults = cases.diff_and_alert.map((c) => {
  const item = runNodeCode('diff-and-alert.js', {
    frozenNowUtc: c.frozen_now_utc,
    mocks: {
      $: (nodeName) => {
        if (nodeName !== 'Build recheck request') {
          throw new Error('unexpected node lookup: ' + nodeName);
        }
        return { item: { json: c.ctx } };
      },
      $json: c.resp,
    },
  });
  const json = item.json;
  return {
    name: c.name,
    result: {
      page_id: json.page_id,
      alert: json.alert,
      new_status: json.new_status,
      alert_text: json.alert_text,
      last_checked_start: json.last_checked_body.properties['Last checked'].date.start,
    },
  };
});

const prepareResults = cases.prepare_opportunities.map((c) => {
  const items = runNodeCode('prepare-opportunities.js', {
    frozenNowUtc: c.frozen_now_utc,
    mocks: {
      $input: { first: () => ({ json: { results: c.pages } }) },
    },
  });
  return { name: c.name, result: items.map((item) => item.json) };
});

process.stdout.write(
  JSON.stringify({ diff_and_alert: diffResults, prepare_opportunities: prepareResults })
);
