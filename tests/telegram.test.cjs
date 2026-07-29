// Focused integration tests for the Telegram edge, against a stubbed fetch.
//
// This is a thin IO edge, so what is asserted is the behaviour the app depends on – no
// parse_mode on the wire, the offset advancing so an update is delivered once, and polling
// surviving a network failure – not which internal calls were made.

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

test('splitting never cuts a character in half', async () => {
  // A lone surrogate has no UTF-8 encoding and is serialised as U+FFFD, so a naive slice
  // does not split the emoji across two messages – it destroys it. The text being split
  // comes verbatim from pages this app does not control.
  const { fetch, calls } = stubFetch(() => ({ message_id: 1 }));
  const telegram = createTelegram({ token: 'T', fetch });

  // Land a surrogate pair exactly on the 4096 boundary.
  const text = 'x'.repeat(4095) + '😀' + 'y'.repeat(200);
  await telegram.sendMessage(42, text);

  const parts = calls.map((c) => c.body.text);
  assert.equal(parts.join(''), text, 'the message must survive the round trip unchanged');
  for (const part of parts) {
    assert.ok(!/[\uD800-\uDBFF]$/.test(part), 'a chunk ends on a lone high surrogate');
    assert.ok(!/^[\uDC00-\uDFFF]/.test(part), 'a chunk starts on a lone low surrogate');
    assert.equal(Buffer.from(part, 'utf8').toString('utf8'), part, 'the chunk does not survive UTF-8');
  }
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
  // One bad update must not take the bot offline – that would be a silent death, which is
  // exactly what the alerting discipline exists to prevent.
  const { fetch, calls } = stubFetch((url, n) => (n === 1 ? [{ update_id: 300 }] : []));
  const telegram = createTelegram({ token: 'T', fetch });

  const alerted = [];
  const logged = [];
  await pollUpdates(telegram, {
    onUpdate: () => {
      throw new Error('handler blew up');
    },
    // Two channels, deliberately separate: a failed poll is the network being down and
    // recovers on its own; a failed handler is a bug and has to speak.
    onUpdateError: (e) => alerted.push(e.message),
    onPollError: (e) => logged.push(e.message),
    rounds: 2,
  });

  assert.deepEqual(alerted, ['handler blew up'], 'a handler failure must reach the alert channel');
  assert.deepEqual(logged, [], 'a handler failure is not a poll failure');
  assert.equal(calls[1].body.offset, 301, 'a failing update must not be retried forever');
});

test('link previews are never requested – the record matters, not the page', () => {
  // The approval card carries the source URL and the acknowledgement names the page. Telegram
  // renders a preview card for each, which pushes the record itself down the screen and, for a
  // link nothing has read yet, shows a picture nobody has checked.
  const { fetch, calls } = stubFetch(() => ({ message_id: 1 }));
  const telegram = createTelegram({ token: 'T', fetch });

  return telegram.sendMessage(42, 'Got it – reading https://uni.example/phd').then(() => {
    assert.deepEqual(calls[0].body.link_preview_options, { is_disabled: true });
  });
});

// --- retrying a send --------------------------------------------------------------------
//
// Live: an ingest ran, cost money, produced a good record and wrote a row - and one
// transient `fetch failed` on the approval card discarded the only notification of it. The
// polling loop already retried; every write was one-shot.

test('a send that fails on the network is retried', async () => {
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    if (calls < 3) throw new TypeError('fetch failed');
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  const telegram = createTelegram({ token: 'T', fetch, sleep: async () => {} });

  await telegram.sendMessage(42, 'the card');
  assert.equal(calls, 3);
});

test('a send Telegram itself rejects is not retried', async () => {
  // "bot was blocked by the user" will say the same thing every time. Retrying it delays
  // every later message behind a wait that cannot help.
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    return { ok: false, status: 403, json: async () => ({ ok: false, description: 'Forbidden: bot was blocked by the user' }) };
  };
  const telegram = createTelegram({ token: 'T', fetch, sleep: async () => {} });

  await assert.rejects(telegram.sendMessage(42, 'hello'), /blocked/);
  assert.equal(calls, 1);
});

test('a server error at Telegram is retried', async () => {
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    if (calls < 2) return { ok: false, status: 502, json: async () => ({ ok: false, description: 'Bad Gateway' }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  const telegram = createTelegram({ token: 'T', fetch, sleep: async () => {} });

  await telegram.sendMessage(42, 'hello');
  assert.equal(calls, 2);
});
