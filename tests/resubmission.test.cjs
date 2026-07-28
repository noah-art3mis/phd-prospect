// Re-submitting a link that is already tracked.
//
// The check happens before the model call, so the short-circuit costs nothing. It prevents
// two problems at once: paying for a redundant call, and ending up with two rows for one
// opportunity firing duplicate reminders for the same date.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openStore } = require('../src/store.cjs');
const { createApp } = require('../src/app.cjs');
const { loadPrompt } = require('../src/core/prompt.cjs');

const PROMPT = loadPrompt(path.join(__dirname, '..', 'prompts', 'ingest.prompt'));
const fixture = (name) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ingest', `${name}.json`), 'utf8'));

const ME = 987654321;
const CONFIG = { telegramAllowedUserId: ME, timezone: 'America/Mexico_City', reminderLeadTimes: [30, 7, 1] };

async function withApp(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prospect-resub-'));
  const store = openStore(path.join(dir, 'prospect.db'));
  const sent = [];
  const telegram = {
    sent,
    async sendMessage(chatId, text, options) {
      sent.push({ chatId, text, options });
      return { message_id: sent.length };
    },
    async clearButtons() {},
    async answerCallbackQuery() {},
  };
  const requests = [];
  const anthropic = {
    requests,
    messages: {
      async create(body) {
        requests.push(body);
        return fixture('complete');
      },
    },
  };
  const errors = [];
  const app = createApp({ config: CONFIG, store, anthropic, telegram, prompt: PROMPT, onError: (e) => errors.push(e) });
  try {
    return await run({ store, telegram, anthropic, app, errors, sent, requests });
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const send = (url) => ({
  update_id: 1,
  message: { message_id: 10, chat: { id: ME }, from: { id: ME }, text: url },
});

// The fixture's opportunity, already tracked.
const TRACKED = {
  title: 'PhD in Trustworthy Artificial Intelligence',
  source_url: 'https://uni.example/phd',
  deadline_at: '2026-12-01T23:59:00.000Z',
  confirmed: true,
  findings: {},
};

test('a URL matching a tracked opportunity replies with its deadline and makes no model call', async () => {
  await withApp(async ({ store, sent, requests, app }) => {
    store.insertCandidate(TRACKED);

    await app.bot.handleUpdate(send('https://uni.example/phd'));
    await app.bot.settle();

    assert.deepEqual(requests, [], 'the model must not be called for a link already on file');
    assert.match(sent.at(-1).text, /already tracking/i);
    assert.match(sent.at(-1).text, /2026-12-01/);
    assert.equal(store.countConfirmed(), 1, 'no second row for the same opportunity');
  });
});

const SAME_PAGE = [
  ['a tracking parameter', 'https://uni.example/phd?utm_source=twitter&fbclid=abc'],
  ['a trailing slash', 'https://uni.example/phd/'],
  ['a different scheme', 'http://uni.example/phd'],
  ['different host case', 'https://UNI.EXAMPLE/phd'],
  ['a fragment', 'https://uni.example/phd#apply'],
  ['a default port', 'https://uni.example:443/phd'],
];

for (const [what, url] of SAME_PAGE) {
  test(`a URL differing only by ${what} is recognised as the same opportunity`, async () => {
    await withApp(async ({ store, sent, requests, app }) => {
      store.insertCandidate(TRACKED);

      await app.bot.handleUpdate(send(url));
      await app.bot.settle();

      assert.deepEqual(requests, [], `${url} should have short-circuited`);
      assert.match(sent.at(-1).text, /already tracking/i);
    });
  });
}

test('a URL matching only an unconfirmed row does not short-circuit', async () => {
  // A candidate still awaiting approval is not tracked work; re-sending it should run.
  await withApp(async ({ store, requests, app }) => {
    store.insertCandidate({ ...TRACKED, confirmed: false });

    await app.bot.handleUpdate(send('https://uni.example/phd'));
    await app.bot.settle();

    assert.equal(requests.length, 1, 'a pending candidate must not suppress a fresh ingest');
  });
});

test('a genuinely new URL proceeds to ingest as normal', async () => {
  await withApp(async ({ store, requests, sent, app }) => {
    store.insertCandidate(TRACKED);

    await app.bot.handleUpdate(send('https://uni.example/a-different-position'));
    await app.bot.settle();

    assert.equal(requests.length, 1);
    assert.ok(sent.at(-1).options?.replyMarkup, 'a new URL should produce an approval card');
  });
});

test('a tracked opportunity with no deadline says so rather than inventing one', async () => {
  await withApp(async ({ store, sent, app }) => {
    store.insertCandidate({ ...TRACKED, deadline_at: null });

    await app.bot.handleUpdate(send('https://uni.example/phd'));
    await app.bot.settle();

    assert.match(sent.at(-1).text, /rolling admission/i);
  });
});

test('approving a re-submitted link cannot create a duplicate that double-reminds', async () => {
  // The whole point: two rows for one opportunity would fire the same reminder twice.
  await withApp(async ({ store, telegram, app }) => {
    await app.bot.handleUpdate(send('https://uni.example/phd'));
    await app.bot.settle();
    const id = Number(telegram.sent.at(-1).options.replyMarkup.inline_keyboard[0][0].callback_data.split(':')[1]);
    await app.bot.handleUpdate({
      update_id: 2,
      callback_query: { id: 'c', from: { id: ME }, data: `approve:${id}`, message: { message_id: 11, chat: { id: ME } } },
    });
    await app.bot.settle();

    await app.bot.handleUpdate(send('https://uni.example/phd/?utm_source=again'));
    await app.bot.settle();

    assert.equal(store.countConfirmed(), 1);
  });
});
