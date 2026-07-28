// The weekly digest.
//
// The load-bearing test is the boring one: it sends even when there is nothing to report.
// That is the whole mechanism – its absence is the alarm, so a "nothing due, skip it" branch
// would make silence ambiguous again.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openStore } = require('../src/store.cjs');
const { runWeeklyDigest } = require('../src/jobs/digest.cjs');
const { approximateSpend, upcomingDeadlines } = require('../src/core/digest.cjs');
const { nextRunAt } = require('../src/core/schedule.cjs');

const ZONE = 'America/Mexico_City';
const CHAT = 987654321;
const NOW = new Date('2026-07-06T18:00:00.000Z');

const opportunity = (overrides) => ({
  title: 'PhD in Trustworthy AI',
  source_url: `https://uni.example/${Math.random().toString(36).slice(2)}`,
  confirmed: true,
  deadline_at: null,
  findings: {},
  ...overrides,
});

async function withDigest(setup, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prospect-digest-'));
  const store = openStore(path.join(dir, 'prospect.db'));
  const sent = [];
  const telegram = {
    sent,
    async sendMessage(chatId, text) {
      sent.push({ chatId, text });
      return { message_id: sent.length };
    },
  };
  setup?.(store);
  const digest = (now = NOW) => runWeeklyDigest({ store, telegram, chatId: CHAT, zone: ZONE, now });
  try {
    return await run({ store, telegram, sent, digest });
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the digest sends even when nothing is due – that is the point', async () => {
  await withDigest(null, async ({ sent, digest }) => {
    await digest();

    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, CHAT);
    assert.match(sent[0].text, /Tracking 0 opportunities/);
    assert.match(sent[0].text, /No deadlines in the next 30 days/);
  });
});

test('it reports the tracked count, excluding pending candidates', async () => {
  await withDigest(
    (store) => {
      store.insertCandidate(opportunity({}));
      store.insertCandidate(opportunity({}));
      store.insertCandidate(opportunity({ confirmed: false }));
    },
    async ({ sent, digest }) => {
      await digest();
      assert.match(sent[0].text, /Tracking 2 opportunities/);
    }
  );
});

test('it lists deadlines inside thirty days, soonest first, and omits the rest', async () => {
  await withDigest(
    (store) => {
      store.insertCandidate(opportunity({ title: 'Later this month', deadline_at: '2026-07-28T23:59:00.000Z' }));
      store.insertCandidate(opportunity({ title: 'Very soon', deadline_at: '2026-07-09T23:59:00.000Z' }));
      store.insertCandidate(opportunity({ title: 'Months away', deadline_at: '2026-11-01T23:59:00.000Z' }));
      store.insertCandidate(opportunity({ title: 'Already passed', deadline_at: '2026-06-01T23:59:00.000Z' }));
      store.insertCandidate(opportunity({ title: 'Rolling', deadline_at: null }));
    },
    async ({ sent, digest }) => {
      await digest();
      const text = sent[0].text;

      const soon = text.indexOf('Very soon');
      const later = text.indexOf('Later this month');
      assert.ok(soon > -1 && later > soon, 'deadlines must be listed soonest first');
      assert.ok(!text.includes('Months away'));
      assert.ok(!text.includes('Already passed'));
      assert.ok(!text.includes('Rolling'));
    }
  );
});

test('it reports the age of the last successful backup', async () => {
  await withDigest(
    (store) => {
      store.recordBackup({ succeeded: true, destination: 'gs://prospect-backups/x.db' });
    },
    async ({ sent, digest }) => {
      await digest(new Date(Date.now() + 3600000));
      assert.match(sent[0].text, /Backup: \d+ hours ago, ok/);
    }
  );
});

test('a stale backup is visible in the digest, not only in the alert that fired at the time', async () => {
  await withDigest(
    (store) => {
      store.recordBackup({ succeeded: true, destination: 'gs://b/old.db' });
    },
    async ({ sent, digest }) => {
      // Five days after the last good backup.
      await digest(new Date(Date.now() + 5 * 86400000));
      assert.match(sent[0].text, /Backup: STALE/);
      assert.match(sent[0].text, /5 days ago/);
    }
  );
});

test('a failed backup does not count as a recent one', async () => {
  await withDigest(
    (store) => {
      store.recordBackup({ succeeded: false, detail: 'permission denied' });
    },
    async ({ sent, digest }) => {
      await digest();
      assert.match(sent[0].text, /Backup: none on record/);
    }
  );
});

test('it reports approximate spend for the week from recorded token usage', async () => {
  await withDigest(
    (store) => {
      store.recordUsage({ model: 'claude-sonnet-5', inputTokens: 1_000_000, outputTokens: 100_000 });
    },
    async ({ sent, digest }) => {
      await digest(new Date());
      // 1M input at $3 + 100k output at $15/M = $3.00 + $1.50.
      assert.match(sent[0].text, /about \$4\.50 over 1 model calls/);
    }
  );
});

test('usage older than the week is not counted', async () => {
  await withDigest(null, async ({ store, sent, digest }) => {
    store.recordUsage({ model: 'claude-sonnet-5', inputTokens: 1_000_000, outputTokens: 1_000_000 });
    // Ten days later: last week's calls are not this week's spend.
    await digest(new Date(Date.now() + 10 * 86400000));
    assert.match(sent[0].text, /about \$0\.00 over 0 model calls/);
  });
});

test('spend is computed at list price, so the estimate errs high rather than low', () => {
  assert.equal(approximateSpend({ input_tokens: 1e6, output_tokens: 0 }).toFixed(2), '3.00');
  assert.equal(approximateSpend({ input_tokens: 0, output_tokens: 1e6 }).toFixed(2), '15.00');
});

test('upcomingDeadlines takes the horizon as an argument rather than assuming thirty days', () => {
  const rows = [
    { title: 'a', deadline_at: '2026-07-09T00:00:00.000Z' },
    { title: 'b', deadline_at: '2026-07-20T00:00:00.000Z' },
  ];
  assert.equal(upcomingDeadlines(rows, NOW, 7).length, 1);
  assert.equal(upcomingDeadlines(rows, NOW, 30).length, 2);
});

test('the digest arrives Sunday morning in the local zone', () => {
  const next = nextRunAt({ now: NOW, zone: ZONE, hour: 9, weekday: 0 });
  const local = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONE,
    weekday: 'long',
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(next);

  assert.match(local, /Sunday/);
  assert.match(local, /09/);
});
