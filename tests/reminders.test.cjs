// Golden contract for the pure reminder core.
//
// `now`, the timezone and the lead times are arguments, so story 26 ("each reminder fires
// at most once per lead time") is assertable in-process: run the core, feed its output
// back as state, run again with the same `now`, and nothing comes out.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { dueReminders, recordSent } = require('../src/core/reminders.cjs');

const CASES = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'golden', 'reminder_cases.json'), 'utf8')
).cases;

const args = (c) => ({
  opportunities: c.opportunities,
  now: new Date(c.now),
  zone: c.zone,
  leadTimes: c.lead_times,
});

for (const c of CASES) {
  test('reminder contract: ' + c.name, () => {
    assert.deepEqual(dueReminders(args(c)), c.expect);
  });
}

test('a second run with the sent lead times recorded returns nothing', () => {
  const c = CASES.find((x) => x.name === 'deadline_seven_days_out_matches_lead_time');
  const first = dueReminders(args(c));
  assert.equal(first.length, 1);

  const after = c.opportunities.map((o) => ({
    ...o,
    reminders_sent: recordSent(o.reminders_sent, first.filter((r) => r.opportunity_id === o.id)),
  }));
  assert.deepEqual(dueReminders({ ...args(c), opportunities: after }), []);
});

test('recordSent adds a lead time once and keeps the existing ones', () => {
  assert.deepEqual(recordSent([30], [{ lead_time: 7 }, { lead_time: 7 }]), [30, 7]);
});

test('dueReminders does not mutate the opportunities it is given', () => {
  const c = CASES.find((x) => x.name === 'deadline_seven_days_out_matches_lead_time');
  const before = JSON.stringify(c.opportunities);
  dueReminders(args(c));
  assert.equal(JSON.stringify(c.opportunities), before);
});
