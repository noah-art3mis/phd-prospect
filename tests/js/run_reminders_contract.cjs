// Runs the reminder golden cases through the verbatim live Code-node payload
// n8n/code/compute-due-reminders.js and prints results as JSON. Consumed by
// tests/test_contract_reminders.py, which asserts these match the Python spec
// (prospect.reminders.due_reminders) and the recorded expectations.
//
// Each case injects a frozen `new Date()` instant (the payload computes "today"
// itself, in its hardcoded America/Mexico_City timezone) and a Notion-shaped
// query response via the $input mock. Output is projected to the fields the
// Python spec shares: key, opportunity_id, deadline_id, days_remaining, due_at.
//
// Usage: node tests/js/run_reminders_contract.cjs <path-to-reminder_cases.json>

const fs = require('fs');
const { runNodeCode } = require('./noderun.cjs');

const casesPath = process.argv[2];
if (!casesPath) {
  console.error('usage: node run_reminders_contract.cjs <reminder_cases.json>');
  process.exit(2);
}

const { cases } = JSON.parse(fs.readFileSync(casesPath, 'utf8'));

const out = cases.map((c) => {
  const items = runNodeCode('compute-due-reminders.js', {
    frozenNowUtc: c.frozen_now_utc,
    mocks: {
      $input: { first: () => ({ json: { results: c.notion_pages } }) },
    },
  });
  const result = items.map((item) => ({
    key: item.json.key,
    opportunity_id: item.json.opportunity_id,
    deadline_id: item.json.deadline_id,
    days_remaining: item.json.days_remaining,
    due_at: item.json.due_at,
  }));
  return { name: c.name, result };
});

process.stdout.write(JSON.stringify(out));
