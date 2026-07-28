// Every failure speaks.
//
// Cross-cutting rather than a vertical slice: one discipline applied everywhere, so these
// tests walk the failure paths – ingest, validation, a scheduled job, an unhandled
// rejection – and assert each of them reaches the same channel.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { createAlerter, installTopLevelHandlers, ALERT_PREFIX } = require('../src/alerts.cjs');
const { openStore } = require('../src/store.cjs');
const { createApp } = require('../src/app.cjs');
const { loadPrompt } = require('../src/core/prompt.cjs');
const { scheduleJob } = require('../src/scheduler.cjs');

const PROMPT = loadPrompt(path.join(__dirname, '..', 'prompts', 'ingest.prompt'));
const fixture = (name) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ingest', `${name}.json`), 'utf8'));

const ME = 987654321;
const CONFIG = {
  telegramAllowedUserId: ME,
  timezone: 'America/Mexico_City',
  reminderLeadTimes: [30, 7, 1],
  reminderSendHour: 9,
};

function fakeTelegram({ failSends = false } = {}) {
  const sent = [];
  return {
    sent,
    async sendMessage(chatId, text, options) {
      if (failSends) throw new Error('Telegram is unreachable');
      sent.push({ chatId, text, options });
      return { message_id: sent.length };
    },
    async clearButtons() {},
    async answerCallbackQuery() {},
    async downloadFile() {
      return Buffer.from('%PDF-1.7');
    },
  };
}

const alerts = (telegram) => telegram.sent.filter((m) => m.text.startsWith(ALERT_PREFIX));

test('an alert is sent to the same chat, prefixed so it is not ordinary bot output', async () => {
  const telegram = fakeTelegram();
  const alerter = createAlerter({ telegram, chatId: ME, log: () => {} });

  await alerter.alert(new Error('the page could not be read'), 'ingest');

  assert.equal(telegram.sent[0].chatId, ME);
  assert.ok(telegram.sent[0].text.startsWith(ALERT_PREFIX));
  assert.match(telegram.sent[0].text, /ingest/);
  assert.match(telegram.sent[0].text, /the page could not be read/);
});

test('the alert path failing is logged rather than thrown', async () => {
  // An alert about a failed alert would recurse, and taking the process down because
  // Telegram is briefly unreachable turns a transient outage into a silent death.
  const logged = [];
  const alerter = createAlerter({ telegram: fakeTelegram({ failSends: true }), chatId: ME, log: (m) => logged.push(m) });

  await assert.doesNotReject(() => alerter.alert(new Error('boom'), 'ingest'));
  assert.ok(logged.some((line) => /could not deliver/.test(line)));
});

test('an alert carries no markup expectations – a hostile message renders literally', async () => {
  const telegram = fakeTelegram();
  const alerter = createAlerter({ telegram, chatId: ME, log: () => {} });

  await alerter.alert(new Error('*bold* [link](http://evil.example)'), 'ingest');

  assert.ok(telegram.sent[0].text.includes('*bold* [link](http://evil.example)'));
  assert.ok(!('parse_mode' in (telegram.sent[0].options ?? {})));
});

// --- every ingest failure path --------------------------------------------------------

async function withApp(response, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prospect-alerts-'));
  const store = openStore(path.join(dir, 'prospect.db'));
  const telegram = fakeTelegram();
  const alerter = createAlerter({ telegram, chatId: ME, log: () => {} });
  const anthropic = {
    messages: {
      async create() {
        if (response instanceof Error) throw response;
        return fixture(response);
      },
    },
  };
  const app = createApp({ config: CONFIG, store, anthropic, telegram, prompt: PROMPT, onError: alerter.report() });
  try {
    return await run({ store, telegram, app, alerter });
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const link = () => ({
  update_id: 1,
  message: { message_id: 10, chat: { id: ME }, from: { id: ME }, text: 'https://uni.example/phd' },
});

const INGEST_FAILURES = [
  ['an unreadable page', 'unreadable_page', /could not read/i],
  ['a truncated response', 'max_tokens', /ran out of room/i],
  ['a refusal', 'refusal', /declined/i],
  ['a model error', new Error('529 overloaded'), /overloaded/i],
];

for (const [what, response, expected] of INGEST_FAILURES) {
  test(`${what} reports to Telegram in terms the user can act on`, async () => {
    await withApp(response, async ({ telegram, app }) => {
      await app.bot.handleUpdate(link());
      await app.bot.settle();

      const reported = alerts(telegram);
      assert.equal(reported.length, 1, `${what} did not alert`);
      assert.match(reported[0].text, expected);
    });
  });
}

test('a validation rejection reports rather than silently discarding the record', async () => {
  const ungated = structuredClone(fixture('complete'));
  const record = JSON.parse(ungated.content.at(-1).text);
  record.findings.find((f) => f.field === 'deadline').evidence = [];
  ungated.content.at(-1).text = JSON.stringify(record);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prospect-alerts-'));
  const store = openStore(path.join(dir, 'prospect.db'));
  const telegram = fakeTelegram();
  const alerter = createAlerter({ telegram, chatId: ME, log: () => {} });
  const anthropic = { messages: { async create() { return ungated; } } };
  const app = createApp({ config: CONFIG, store, anthropic, telegram, prompt: PROMPT, onError: alerter.report() });

  try {
    await app.bot.handleUpdate(link());
    await app.bot.settle();

    assert.equal(store.countConfirmed(), 0);
    assert.match(alerts(telegram)[0].text, /did not pass validation/);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('alerts are visually distinguishable from the ordinary replies in the same chat', async () => {
  await withApp('complete', async ({ telegram, app }) => {
    await app.bot.handleUpdate(link());
    await app.bot.settle();

    // A successful ingest produces an ack and a card, and neither may look like an alert.
    assert.equal(alerts(telegram).length, 0);
    assert.ok(telegram.sent.every((m) => !m.text.startsWith(ALERT_PREFIX)));
  });
});

// --- scheduled jobs and top-level ------------------------------------------------------

test('a failing scheduled job alerts rather than dying quietly in a log', async () => {
  const telegram = fakeTelegram();
  const alerter = createAlerter({ telegram, chatId: ME, log: () => {} });

  let current = new Date('2026-07-06T18:00:00.000Z').getTime();
  await scheduleJob({
    name: 'reminders',
    zone: CONFIG.timezone,
    hour: 9,
    runs: 1,
    run: () => {
      throw new Error('the database is locked');
    },
    onError: alerter.report(),
    now: () => new Date(current),
    sleep: async (ms) => {
      current += ms;
    },
  });

  // The alert is detached, so let the microtask queue drain.
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(alerts(telegram).length, 1);
  assert.match(alerts(telegram)[0].text, /reminders.*the database is locked/s);
});

test('an unhandled exception anywhere at top level produces an alert', async () => {
  const telegram = fakeTelegram();
  const alerter = createAlerter({ telegram, chatId: ME, log: () => {} });
  const proc = new EventEmitter();

  installTopLevelHandlers({ alerter, process: proc });
  proc.emit('uncaughtException', new Error('something nobody caught'));
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(alerts(telegram)[0].text, /unhandled exception/);
  assert.match(alerts(telegram)[0].text, /something nobody caught/);
});

test('an unhandled rejection produces an alert, including when it rejected with a non-error', async () => {
  const telegram = fakeTelegram();
  const alerter = createAlerter({ telegram, chatId: ME, log: () => {} });
  const proc = new EventEmitter();

  installTopLevelHandlers({ alerter, process: proc });
  proc.emit('unhandledRejection', 'just a string');
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(alerts(telegram)[0].text, /unhandled rejection/);
  assert.match(alerts(telegram)[0].text, /just a string/);
});

test('a top-level handler does not rethrow, so one bad update cannot end the process', async () => {
  const proc = new EventEmitter();
  const alerter = createAlerter({ telegram: fakeTelegram({ failSends: true }), chatId: ME, log: () => {} });

  installTopLevelHandlers({ alerter, process: proc });
  assert.doesNotThrow(() => proc.emit('uncaughtException', new Error('boom')));
  await new Promise((resolve) => setImmediate(resolve));
});
