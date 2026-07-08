// Due-reminder contract for the live n8n "Compute due reminders" Code node
// (n8n/code/compute-due-reminders.js).
//
// Formerly a cross-language contract against src/prospect/reminders.due_reminders. JS is
// now the single language: the strict-Python contract is RETIRED. The golden cases in
// tests/golden/reminder_cases.json remain the durable contract and are asserted directly
// against the live JS payload. The three `python: invalid` cases previously pinned a
// KNOWN divergence (the strict Python validator raised where the lenient live JS proceeds:
// missing Version defaults to 1, negative reminder offsets, date-only due values). With
// Python gone, those cases now pin the JS behavior only — their recorded `expect` output
// is what the live node produces, so any silent drift still trips the suite.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runNodeCode } = require('./js/noderun.cjs');

const CASES = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden', 'reminder_cases.json'), 'utf8')).cases;

function jsResult(c) {
  const items = runNodeCode('compute-due-reminders.js', {
    frozenNowUtc: c.frozen_now_utc,
    mocks: { $input: { first: () => ({ json: { results: c.notion_pages } }) } },
  });
  // Round-trip through JSON so the comparison is against plain test-realm objects
  // (values built inside node:vm carry the sandbox realm's prototypes).
  return JSON.parse(
    JSON.stringify(
      items.map((item) => ({
        key: item.json.key,
        opportunity_id: item.json.opportunity_id,
        deadline_id: item.json.deadline_id,
        days_remaining: item.json.days_remaining,
        due_at: item.json.due_at,
      }))
    )
  );
}

for (const c of CASES) {
  test('reminders: ' + c.name, () => {
    assert.deepEqual(jsResult(c), c.expect);
  });
}
