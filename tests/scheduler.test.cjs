// The scheduler loop, driven by an injected clock so a day passes in microseconds.

const test = require('node:test');
const assert = require('node:assert/strict');

const { scheduleJob, MAX_SLEEP_MS } = require('../src/scheduler.cjs');

const ZONE = 'America/Mexico_City';

// A clock that advances by exactly what the loop asks to sleep, so the test never waits.
function fakeClock(startIso) {
  let current = new Date(startIso).getTime();
  return {
    now: () => new Date(current),
    sleep: async (ms) => {
      current += ms;
    },
  };
}

test('the job runs at the configured local hour', async () => {
  const clock = fakeClock('2026-07-06T18:00:00.000Z'); // 12:00 local
  const ranAt = [];

  await scheduleJob({
    name: 'reminders',
    zone: ZONE,
    hour: 9,
    runs: 2,
    run: (due) => ranAt.push(due.toISOString()),
    ...clock,
  });

  // 09:00 local = 15:00 UTC in July, on each of the next two days.
  assert.deepEqual(ranAt, ['2026-07-07T15:00:00.000Z', '2026-07-08T15:00:00.000Z']);
});

test('a job that throws is reported and the loop keeps running', async () => {
  // A scheduled job dying quietly would take reminders offline with no signal at all.
  const clock = fakeClock('2026-07-06T18:00:00.000Z');
  const errors = [];
  let calls = 0;

  await scheduleJob({
    name: 'reminders',
    zone: ZONE,
    hour: 9,
    runs: 3,
    run: () => {
      calls += 1;
      if (calls === 1) throw new Error('Telegram is down');
    },
    onError: (e) => errors.push(e.message),
    ...clock,
  });

  assert.equal(calls, 3, 'one bad run must not end the schedule');
  assert.deepEqual(errors, ["scheduled job 'reminders' failed: Telegram is down"]);
});

test('a long wait is broken into hops that re-check the clock', async () => {
  // setTimeout overflows past ~24.8 days and drifts when the host sleeps, so a single
  // week-long timer would silently never fire.
  const clock = fakeClock('2026-07-06T18:00:00.000Z');
  const waits = [];
  const sleep = async (ms) => {
    waits.push(ms);
    await clock.sleep(ms);
  };

  await scheduleJob({ name: 'digest', zone: ZONE, hour: 9, weekday: 0, runs: 1, run: () => {}, now: clock.now, sleep });

  assert.ok(waits.length > 1, 'a multi-day wait must not be a single timer');
  assert.ok(Math.max(...waits) <= MAX_SLEEP_MS);
});

test('an aborted schedule stops rather than running the job', async () => {
  const clock = fakeClock('2026-07-06T18:00:00.000Z');
  const controller = new AbortController();
  controller.abort();
  let calls = 0;

  await scheduleJob({ name: 'reminders', zone: ZONE, hour: 9, runs: 5, run: () => (calls += 1), signal: controller.signal, ...clock });

  assert.equal(calls, 0);
});
