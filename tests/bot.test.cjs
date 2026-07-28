// The bot loop: gate, acknowledge, dispatch.
//
// The load-bearing property is that the acknowledgement does not wait on downstream work.
// Ingest is fire-and-forget — the handler acks and returns, and the call runs unawaited,
// delivering the approval message when it finishes. A test that only checked "the ack was
// sent eventually" would pass even if the ack were stuck behind a two-minute model call, so
// these assert the ordering explicitly.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createBot } = require('../src/bot.cjs');

const ME = 987654321;

function fakeTelegram() {
  const sent = [];
  return {
    sent,
    async sendMessage(chatId, text, options) {
      sent.push({ chatId, text, options });
      return { message_id: sent.length };
    },
    async answerCallbackQuery() {},
    async clearButtons() {},
  };
}

const urlUpdate = (url = 'https://uni.example/phd', from = ME) => ({
  update_id: 1,
  message: { message_id: 10, chat: { id: from }, from: { id: from }, text: url },
});

test('a submission is acknowledged, naming what was received', async () => {
  const telegram = fakeTelegram();
  const bot = createBot({ telegram, allowedUserId: ME, onSubmission: async () => {} });

  await bot.handleUpdate(urlUpdate());

  assert.equal(telegram.sent.length, 1);
  assert.match(telegram.sent[0].text, /uni\.example\/phd/);
  assert.equal(telegram.sent[0].chatId, ME);
});

test('the acknowledgement is sent before the submission finishes', async () => {
  const order = [];
  const telegram = {
    async sendMessage() {
      order.push('ack');
      return { message_id: 1 };
    },
  };

  const bot = createBot({
    telegram,
    allowedUserId: ME,
    onSubmission: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push('submission finished');
    },
  });

  await bot.handleUpdate(urlUpdate());
  assert.deepEqual(order, ['ack'], 'handleUpdate returned while the submission was still running');

  await bot.settle();
  assert.deepEqual(order, ['ack', 'submission finished']);
});

test('handleUpdate does not wait on a slow submission', async () => {
  const telegram = fakeTelegram();
  let release;
  const slow = new Promise((resolve) => {
    release = resolve;
  });
  const bot = createBot({ telegram, allowedUserId: ME, onSubmission: () => slow });

  // If handleUpdate awaited the submission this would hang rather than resolve.
  await bot.handleUpdate(urlUpdate());
  assert.equal(telegram.sent.length, 1);
  release();
  await bot.settle();
});

test('a submission that fails reports rather than dying quietly', async () => {
  const telegram = fakeTelegram();
  const failures = [];
  const bot = createBot({
    telegram,
    allowedUserId: ME,
    onSubmission: async () => {
      throw new Error('the page could not be read');
    },
    onError: (e) => failures.push(e.message),
  });

  await bot.handleUpdate(urlUpdate());
  await bot.settle();

  assert.deepEqual(failures, ['the page could not be read']);
});

test('a message from another user produces no reply and no submission', async () => {
  const telegram = fakeTelegram();
  const submissions = [];
  const bot = createBot({
    telegram,
    allowedUserId: ME,
    onSubmission: async (s) => submissions.push(s),
  });

  await bot.handleUpdate(urlUpdate('https://uni.example/phd', 111222333));
  await bot.settle();

  assert.deepEqual(telegram.sent, []);
  assert.deepEqual(submissions, []);
});

test('a PDF is acknowledged by name and dispatched as a document submission', async () => {
  const telegram = fakeTelegram();
  const submissions = [];
  const bot = createBot({ telegram, allowedUserId: ME, onSubmission: async (s) => submissions.push(s) });

  await bot.handleUpdate({
    update_id: 2,
    message: {
      message_id: 11,
      chat: { id: ME },
      from: { id: ME },
      document: { file_id: 'BQACAg', file_name: 'advert.pdf', mime_type: 'application/pdf' },
    },
  });
  await bot.settle();

  assert.match(telegram.sent[0].text, /advert\.pdf/);
  assert.equal(submissions[0].kind, 'document');
  assert.equal(submissions[0].fileId, 'BQACAg');
});

test('an unsupported attachment gets a clear reply and no model call', async () => {
  const telegram = fakeTelegram();
  const submissions = [];
  const bot = createBot({ telegram, allowedUserId: ME, onSubmission: async (s) => submissions.push(s) });

  await bot.handleUpdate({
    update_id: 3,
    message: {
      message_id: 12,
      chat: { id: ME },
      from: { id: ME },
      document: { file_id: 'X', file_name: 'notes.docx', mime_type: 'application/msword' },
    },
  });
  await bot.settle();

  assert.match(telegram.sent[0].text, /PDF/);
  assert.deepEqual(submissions, []);
});

test('a button press is answered immediately and routed to the callback handler', async () => {
  const answered = [];
  const telegram = { ...fakeTelegram(), async answerCallbackQuery(id) { answered.push(id); } };
  const callbacks = [];
  const bot = createBot({
    telegram,
    allowedUserId: ME,
    onSubmission: async () => {},
    onCallback: async (c) => callbacks.push(c),
  });

  await bot.handleUpdate({
    update_id: 4,
    callback_query: {
      id: 'cbq-1',
      from: { id: ME },
      data: 'approve:42',
      message: { message_id: 10, chat: { id: ME } },
    },
  });
  await bot.settle();

  assert.deepEqual(answered, ['cbq-1']);
  assert.equal(callbacks[0].action, 'approve');
  assert.equal(callbacks[0].opportunityId, 42);
});

test('plain text is routed to the text handler', async () => {
  const telegram = fakeTelegram();
  const texts = [];
  const bot = createBot({
    telegram,
    allowedUserId: ME,
    onSubmission: async () => {},
    onText: async (d) => texts.push(d.text),
  });

  await bot.handleUpdate({
    update_id: 5,
    message: { message_id: 13, chat: { id: ME }, from: { id: ME }, text: 'how many do I have?' },
  });
  await bot.settle();

  assert.deepEqual(texts, ['how many do I have?']);
});
