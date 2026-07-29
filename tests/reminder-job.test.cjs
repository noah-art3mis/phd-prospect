// The daily reminder job: the query, the send, the write-back, and the schedule.
//
// `now` is an argument, so idempotency is asserted by running the sweep twice with the same
// instant rather than by waiting a day.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openStore } = require('../src/store.cjs');
const { runReminderSweep } = require('../src/jobs/reminders.cjs');
const { nextRunAt } = require('../src/core/schedule.cjs');

const ZONE = 'America/Mexico_City';
const CHAT = 987654321;
const LEAD_TIMES = [30, 7, 1];
const NOW = new Date('2026-07-06T18:00:00.000Z');

function fakeTelegram({ failOn = null } = {}) {
  const sent = [];
  return {
    sent,
    async sendMessage(chatId, text) {
      if (failOn && text.includes(failOn)) throw new Error('Telegram is down');
      sent.push({ chatId, text });
      return { message_id: sent.length };
    },
  };
}

const opportunity = (overrides) => ({
  title: 'PhD in Trustworthy AI',
  source_url: `https://uni.example/${Math.random().toString(36).slice(2)}`,
  confirmed: true,
  deadline_at: '2026-07-13T23:59:00.000Z',
  findings: {},
  ...overrides,
});

async function withJob(rows, run, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prospect-reminders-'));
  const store = openStore(path.join(dir, 'prospect.db'));
  const telegram = fakeTelegram(options);
  const errors = [];
  for (const row of rows) store.insertCandidate(row);
  const sweep = (now = NOW) =>
    runReminderSweep({ store, telegram, chatId: CHAT, zone: ZONE, leadTimes: LEAD_TIMES, now, onError: (e) => errors.push(e) });
  try {
    return await run({ store, telegram, sweep, errors });
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a deadline inside the lead window produces a reminder naming it', async () => {
  await withJob([opportunity({})], async ({ telegram, sweep }) => {
    const result = await sweep();

    assert.equal(result.sent, 1);
    assert.equal(telegram.sent[0].chatId, CHAT);
    assert.match(telegram.sent[0].text, /7 days/);
    assert.match(telegram.sent[0].text, /PhD in Trustworthy AI/);
    assert.match(telegram.sent[0].text, /13 July 2026/);
  });
});

test('a deadline that has reached no lead time yet produces nothing', async () => {
  // Further out than the widest lead time. Between lead times is no longer silent - a
  // deadline five days away with nothing sent means a sweep was missed, and it warns.
  await withJob([opportunity({ deadline_at: '2027-01-11T12:00:00.000Z' })], async ({ telegram, sweep }) => {
    assert.equal((await sweep()).sent, 0);
    assert.deepEqual(telegram.sent, []);
  });
});

test('a deadline past a lead time nobody sent is caught up rather than skipped', async () => {
  // Five days out, nothing sent: the seven-day sweep did not land. One message, and it
  // closes the thirty-day mark too so that cannot fire afterwards.
  await withJob([opportunity({ deadline_at: '2026-07-11T12:00:00.000Z' })], async ({ store, telegram, sweep }) => {
    assert.equal((await sweep()).sent, 1);
    assert.match(telegram.sent[0].text, /5 days/);
    assert.deepEqual(store.listConfirmed()[0].reminders_sent, [30, 7]);
  });
});

test('running the job twice in one day sends each reminder once', async () => {
  await withJob([opportunity({})], async ({ telegram, sweep }) => {
    await sweep();
    const second = await sweep();

    assert.equal(second.sent, 0);
    assert.equal(telegram.sent.length, 1);
  });
});

test('the lead times it answered are recorded, which is what makes the second run silent', async () => {
  // Both, not just the one it was named after: the seven-day warning also answers the
  // thirty-day mark it passed, and leaving that open would send a second message saying the
  // same thing in looser words.
  await withJob([opportunity({})], async ({ store, sweep }) => {
    await sweep();
    assert.deepEqual(store.listConfirmed()[0].reminders_sent, [30, 7]);
  });
});

test('opportunities with no deadline are skipped entirely', async () => {
  await withJob([opportunity({ deadline_at: null })], async ({ telegram, sweep }) => {
    assert.equal((await sweep()).sent, 0);
    assert.deepEqual(telegram.sent, []);
  });
});

test('unconfirmed rows never produce a reminder', async () => {
  await withJob([opportunity({ confirmed: false })], async ({ telegram, sweep }) => {
    assert.equal((await sweep()).sent, 0);
    assert.deepEqual(telegram.sent, []);
  });
});

test('a send failure does not record the reminder as sent', async () => {
  // Being nagged twice is a nuisance; being silently skipped for a deadline is the outcome
  // this project exists to prevent.
  await withJob(
    [opportunity({})],
    async ({ store, sweep, errors, telegram }) => {
      const result = await sweep();

      assert.equal(result.sent, 0);
      assert.equal(result.failed.length, 1);
      assert.equal(errors.length, 1);
      assert.deepEqual(store.listConfirmed()[0].reminders_sent, [], 'a failed send must stay unrecorded');

      // And the next run tries again.
      telegram.sendMessage = async (chatId, text) => {
        telegram.sent.push({ chatId, text });
        return { message_id: 1 };
      };
      assert.equal((await sweep()).sent, 1);
    },
    { failOn: 'PhD in Trustworthy AI' }
  );
});

test('one opportunity failing does not stop the others from being reminded', async () => {
  await withJob(
    [opportunity({ title: 'Broken one' }), opportunity({ title: 'Fine one' })],
    async ({ store, sweep, telegram }) => {
      const result = await sweep();

      assert.equal(result.sent, 1);
      assert.deepEqual(
        telegram.sent.map((m) => m.text.includes('Fine one')),
        [true]
      );
      const rows = store.listConfirmed();
      assert.deepEqual(rows.find((r) => r.title === 'Broken one').reminders_sent, []);
      assert.deepEqual(rows.find((r) => r.title === 'Fine one').reminders_sent, [30, 7]);
    },
    { failOn: 'Broken one' }
  );
});

test('several reminders arrive soonest-first', async () => {
  await withJob(
    [
      opportunity({ title: 'Further out', deadline_at: '2026-08-05T23:59:00.000Z' }),
      opportunity({ title: 'Sooner', deadline_at: '2026-07-13T23:59:00.000Z' }),
    ],
    async ({ telegram, sweep }) => {
      await sweep();
      assert.match(telegram.sent[0].text, /Sooner/);
      assert.match(telegram.sent[1].text, /Further out/);
    }
  );
});

test('a deadline that has passed stops being due', async () => {
  await withJob([opportunity({ deadline_at: '2026-06-29T23:59:00.000Z' })], async ({ telegram, sweep }) => {
    assert.equal((await sweep()).sent, 0);
    assert.deepEqual(telegram.sent, []);
  });
});

// --- the schedule -----------------------------------------------------------------------

test('the job fires at the configured hour in the local zone, not in UTC', () => {
  // 09:00 in America/Mexico_City (UTC-6 in July) is 15:00 UTC. A scheduler that treated the
  // hour as UTC would fire at 3am local.
  const next = nextRunAt({ now: new Date('2026-07-06T18:00:00.000Z'), zone: ZONE, hour: 9 });
  assert.equal(next.toISOString(), '2026-07-07T15:00:00.000Z');
});

test('a run time still ahead today is used rather than skipping to tomorrow', () => {
  const next = nextRunAt({ now: new Date('2026-07-06T12:00:00.000Z'), zone: ZONE, hour: 9 });
  assert.equal(next.toISOString(), '2026-07-06T15:00:00.000Z');
});

test('the next run is strictly in the future, so a job cannot immediately re-run', () => {
  const now = new Date('2026-07-06T15:00:00.000Z'); // exactly 09:00 local
  assert.ok(nextRunAt({ now, zone: ZONE, hour: 9 }).getTime() > now.getTime());
});

test('the local hour holds across a daylight-saving change', () => {
  // London is UTC+1 in July and UTC+0 in January; a fixed offset would drift by an hour.
  assert.equal(
    nextRunAt({ now: new Date('2026-07-06T00:00:00.000Z'), zone: 'Europe/London', hour: 9 }).toISOString(),
    '2026-07-06T08:00:00.000Z'
  );
  assert.equal(
    nextRunAt({ now: new Date('2026-01-06T00:00:00.000Z'), zone: 'Europe/London', hour: 9 }).toISOString(),
    '2026-01-06T09:00:00.000Z'
  );
});

test('a weekly schedule lands on the requested local weekday', () => {
  // Sunday morning, in local terms.
  const next = nextRunAt({ now: new Date('2026-07-06T18:00:00.000Z'), zone: ZONE, hour: 9, weekday: 0 });
  const local = new Intl.DateTimeFormat('en-US', { timeZone: ZONE, weekday: 'short', hour: '2-digit', hourCycle: 'h23' }).format(next);
  assert.match(local, /Sun/);
  assert.match(local, /09/);
});
