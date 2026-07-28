// Focused integration tests for the Telegram edge, against a stubbed fetch.
//
// This is a thin IO edge, so what is asserted is the behaviour the app depends on — no
// parse_mode on the wire, the offset advancing so an update is delivered once, and polling
// surviving a network failure — not which internal calls were made.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTelegram, pollUpdates } = require('../src/telegram.cjs');

function stubFetch(handler) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, body: options?.body ? JSON.parse(options.body) : undefined });
    const result = await handler(url, calls.length);
    if (result instanceof Error) throw result;
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result }),
      arrayBuffer: async () => result,
    };
  };
  return { fetch, calls };
}

test('sendMessage posts plain text with no parse_mode', async () => {
  const { fetch, calls } = stubFetch(() => ({ message_id: 1 }));
  const telegram = createTelegram({ token: 'T', fetch });

  await telegram.sendMessage(42, 'A *literal* [markup] `sample`');

  assert.match(calls[0].url, /\/botT\/sendMessage$/);
  assert.equal(calls[0].body.chat_id, 42);
  assert.equal(calls[0].body.text, 'A *literal* [markup] `sample`');
  assert.ok(!('parse_mode' in calls[0].body), 'parse_mode must never be sent');
});

test('inline buttons ride along without introducing markup', async () => {
  const { fetch, calls } = stubFetch(() => ({ message_id: 1 }));
  const telegram = createTelegram({ token: 'T', fetch });

  await telegram.sendMessage(42, 'Approve?', {
    replyMarkup: { inline_keyboard: [[{ text: 'Approve', callback_data: 'approve:7' }]] },
  });

  assert.deepEqual(calls[0].body.reply_markup.inline_keyboard[0][0], {
    text: 'Approve',
    callback_data: 'approve:7',
  });
  assert.ok(!('parse_mode' in calls[0].body));
});

test('a Telegram-level error is raised rather than silently swallowed', async () => {
  const fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: false, description: 'chat not found', error_code: 400 }),
  });
  const telegram = createTelegram({ token: 'T', fetch });

  await assert.rejects(() => telegram.sendMessage(42, 'hi'), /chat not found/);
});

test('a message longer than Telegram allows is split rather than rejected', async () => {
  // A findings-heavy approval card can exceed 4096 characters; losing it silently would
  // mean an ingest that cost a model call produced nothing.
  const { fetch, calls } = stubFetch(() => ({ message_id: 1 }));
  const telegram = createTelegram({ token: 'T', fetch });

  await telegram.sendMessage(42, 'x'.repeat(9000));

  assert.equal(calls.length, 3);
  assert.equal(calls.map((c) => c.body.text).join('').length, 9000);
});

test('buttons are attached to the final chunk of a split message', async () => {
  const { fetch, calls } = stubFetch(() => ({ message_id: 1 }));
  const telegram = createTelegram({ token: 'T', fetch });

  await telegram.sendMessage(42, 'x'.repeat(5000), {
    replyMarkup: { inline_keyboard: [[{ text: 'Approve', callback_data: 'approve:7' }]] },
  });

  assert.equal(calls.length, 2);
  assert.ok(!calls[0].body.reply_markup, 'buttons must not appear mid-message');
  assert.ok(calls[1].body.reply_markup, 'buttons must land on the last chunk');
});

// --- long polling -----------------------------------------------------------------------

test('polling delivers each update once and advances the offset past it', async () => {
  const { fetch, calls } = stubFetch((url, n) => {
    if (!url.includes('getUpdates')) return { message_id: 1 };
    return n === 1 ? [{ update_id: 100 }, { update_id: 101 }] : [];
  });
  const telegram = createTelegram({ token: 'T', fetch });

  const seen = [];
  await pollUpdates(telegram, {
    onUpdate: (u) => seen.push(u.update_id),
    rounds: 2,
  });

  assert.deepEqual(seen, [100, 101]);
  assert.equal(calls[1].body.offset, 102, 'the next poll must not re-deliver what was handled');
});

test('losing the network and regaining it resumes polling without intervention', async () => {
  const { fetch } = stubFetch((url, n) => {
    if (n === 1) return new Error('ECONNREFUSED');
    if (n === 2) return new Error('ETIMEDOUT');
    return [{ update_id: 200 }];
  });
  const telegram = createTelegram({ token: 'T', fetch });

  const seen = [];
  const waits = [];
  await pollUpdates(telegram, {
    onUpdate: (u) => seen.push(u.update_id),
    rounds: 3,
    sleep: async (ms) => waits.push(ms),
  });

  assert.deepEqual(seen, [200], 'the update after the outage must still arrive');
  assert.deepEqual(waits, [1000, 2000], 'backoff must grow rather than hammer a down endpoint');
});

test('backoff resets after a successful poll, so a later blip waits briefly again', async () => {
  const { fetch } = stubFetch((url, n) => {
    if (n === 1) return new Error('ECONNREFUSED');
    if (n === 2) return [];
    if (n === 3) return new Error('ECONNREFUSED');
    return [];
  });
  const telegram = createTelegram({ token: 'T', fetch });

  const waits = [];
  await pollUpdates(telegram, { onUpdate: () => {}, rounds: 4, sleep: async (ms) => waits.push(ms) });

  assert.deepEqual(waits, [1000, 1000]);
});

test('a handler that throws does not stop the loop or lose the offset', async () => {
  // One bad update must not take the bot offline — that would be a silent death, which is
  // exactly what the alerting discipline exists to prevent.
  const { fetch, calls } = stubFetch((url, n) => (n === 1 ? [{ update_id: 300 }] : []));
  const telegram = createTelegram({ token: 'T', fetch });

  const failures = [];
  await pollUpdates(telegram, {
    onUpdate: () => {
      throw new Error('handler blew up');
    },
    onError: (e) => failures.push(e.message),
    rounds: 2,
  });

  assert.deepEqual(failures, ['handler blew up']);
  assert.equal(calls[1].body.offset, 301, 'a failing update must not be retried forever');
});
