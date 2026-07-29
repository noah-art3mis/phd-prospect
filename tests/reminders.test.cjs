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

// --- catch-up ---------------------------------------------------------------------------
//
// The failure this closes: a reminder used to be due only on the exact day its lead time
// matched, so a send that failed - or an app that was down that morning - lost it for good.
// The job already declined to record a failed send, which bought nothing, because the
// decision could never offer it again.

const ZONE = 'America/Mexico_City';
const CLOSES = '2026-08-14T23:59:00Z';
const opp = (sent = []) => ({ id: 1, confirmed: true, title: 'Aalborg PhD', deadline_at: CLOSES, reminders_sent: sent });
const on = (day, o = opp()) =>
  dueReminders({ opportunities: [o], now: new Date(`${day}T09:00:00Z`), zone: ZONE, leadTimes: [30, 7, 1] });

test('a lead time missed on its own day is still offered the next morning', () => {
  // 08-07 is exactly seven days out. If that send failed, 08-08 must not be silent.
  assert.equal(on('2026-08-07')[0].lead_time, 7);

  const nextDay = on('2026-08-08');
  assert.equal(nextDay.length, 1, 'the missed reminder was lost');
  assert.equal(nextDay[0].lead_time, 7);
  assert.equal(nextDay[0].days_remaining, 6, 'it reports the days actually left, not the lead time');
});

test('a lead time already sent is not offered again', () => {
  assert.deepEqual(on('2026-08-08', opp([7])), []);
});

test('only the most urgent unsent lead time fires, not every one that has passed', () => {
  // Three weeks of downtime should produce one message, not a backlog of three.
  const due = on('2026-08-13', opp([]));
  assert.equal(due.length, 1);
  assert.equal(due[0].lead_time, 1);
});

test('the lead times it overtook are closed out, so they cannot fire later', () => {
  // Firing the 1-day reminder answers the 30 and the 7 as well; leaving them open would
  // send two more messages about a deadline that has already been reported.
  const due = on('2026-08-13', opp([]));
  assert.deepEqual([...due[0].closes].sort((a, b) => a - b), [1, 7, 30]);
});

test('nothing fires before the first lead time is reached', () => {
  assert.deepEqual(on('2026-06-01'), []);
});

test('a deadline that has passed does not fire', () => {
  // Chasing a closed opportunity is noise, and the row stays for the record.
  assert.deepEqual(on('2026-08-16'), []);
});

test('the day of the deadline still fires', () => {
  assert.equal(on('2026-08-14')[0].days_remaining, 0);
});
