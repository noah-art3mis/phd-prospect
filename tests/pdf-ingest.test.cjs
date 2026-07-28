// PDF ingest: a document sent to the bot follows the same path as a URL.
//
// One rule matters more than the rest and is easy to get wrong: a Telegram file URL is never
// handed to web_fetch, because the bot token is embedded in its path. Doing so would
// disclose the token to an external service, so it gets an assertion of its own rather than
// a comment.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openStore } = require('../src/store.cjs');
const { createApp, MAX_PDF_BYTES } = require('../src/app.cjs');
const { loadPrompt } = require('../src/core/prompt.cjs');

const PROMPT = loadPrompt(path.join(__dirname, '..', 'prompts', 'ingest.prompt'));
const fixture = (name) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ingest', `${name}.json`), 'utf8'));

const ME = 987654321;
const CONFIG = { telegramAllowedUserId: ME, timezone: 'America/Mexico_City', reminderLeadTimes: [30, 7, 1] };
const PDF_BYTES = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\n%%EOF\n');

async function withApp({ pdf = PDF_BYTES, response = 'complete' } = {}, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prospect-pdf-'));
  const store = openStore(path.join(dir, 'prospect.db'));

  const sent = [];
  const downloaded = [];
  const telegram = {
    sent,
    downloaded,
    async sendMessage(chatId, text, options) {
      sent.push({ chatId, text, options });
      return { message_id: sent.length };
    },
    async downloadFile(fileId) {
      downloaded.push(fileId);
      return pdf;
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
        return fixture(response);
      },
    },
  };

  const errors = [];
  const app = createApp({ config: CONFIG, store, anthropic, telegram, prompt: PROMPT, onError: (e) => errors.push(e) });
  try {
    return await run({ store, telegram, anthropic, app, errors, sent, requests, downloaded });
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const sendPdf = (overrides = {}) => ({
  update_id: 1,
  message: {
    message_id: 10,
    chat: { id: ME },
    from: { id: ME },
    document: {
      file_id: 'BQACAgQAAxk',
      file_name: 'studentship-advert.pdf',
      mime_type: 'application/pdf',
      file_size: 120000,
      ...overrides,
    },
  },
});

test('a PDF produces an approval card following the same rules as a URL', async () => {
  await withApp({}, async ({ store, sent, app }) => {
    await app.bot.handleUpdate(sendPdf());
    await app.bot.settle();

    assert.match(sent[0].text, /studentship-advert\.pdf/, 'the ack should name the file');
    const card = sent.at(-1);
    assert.match(card.text, /PhD in Trustworthy Artificial Intelligence/);
    assert.ok(card.options.replyMarkup, 'a PDF must get the same Approve/Reject gate');

    const id = Number(card.options.replyMarkup.inline_keyboard[0][0].callback_data.split(':')[1]);
    await app.bot.handleUpdate({
      update_id: 2,
      callback_query: { id: 'c', from: { id: ME }, data: `approve:${id}`, message: { message_id: 11, chat: { id: ME } } },
    });
    await app.bot.settle();

    const row = store.listConfirmed()[0];
    assert.ok(row.findings.deadline.evidence.length > 0, 'the evidence rule applies to PDFs too');
    assert.equal(row.prompt_hash, PROMPT.contentHash);
  });
});

test('the PDF is downloaded from Telegram and passed as a base64 document block', async () => {
  await withApp({}, async ({ requests, downloaded, app }) => {
    await app.bot.handleUpdate(sendPdf());
    await app.bot.settle();

    assert.deepEqual(downloaded, ['BQACAgQAAxk'], 'the file must come from Telegram, not a fetch');

    const content = requests[0].messages.at(-1).content;
    const document = content.find((block) => block.type === 'document');
    assert.equal(document.source.type, 'base64');
    assert.equal(document.source.media_type, 'application/pdf');
    assert.equal(Buffer.from(document.source.data, 'base64').toString(), PDF_BYTES.toString());
  });
});

test('nothing parses the PDF locally – the bytes go to the model untouched', async () => {
  await withApp({}, async ({ requests, app }) => {
    await app.bot.handleUpdate(sendPdf());
    await app.bot.settle();

    const document = requests[0].messages.at(-1).content.find((b) => b.type === 'document');
    assert.equal(Buffer.from(document.source.data, 'base64').byteLength, PDF_BYTES.byteLength);
  });
});

test('no Telegram file URL – and no bot token – ever reaches the model request', async () => {
  await withApp({}, async ({ requests, app }) => {
    await app.bot.handleUpdate(sendPdf());
    await app.bot.settle();

    const body = JSON.stringify(requests[0]);
    assert.ok(!body.includes('api.telegram.org'), 'a Telegram URL reached the request');
    assert.ok(!/\/bot\d+:/.test(body), 'a bot token reached the request');
    assert.ok(!body.includes('getFile'), 'a Telegram file path reached the request');
  });
});

test('a PDF too large for the request limit fails with a clear message', async () => {
  await withApp({}, async ({ store, errors, requests, app }) => {
    await app.bot.handleUpdate(sendPdf({ file_size: MAX_PDF_BYTES + 1, file_name: 'huge.pdf' }));
    await app.bot.settle();

    assert.deepEqual(requests, [], 'an oversized PDF must not reach the model');
    assert.equal(store.countConfirmed(), 0);
    assert.match(errors[0].message, /huge\.pdf is too large/);
    assert.match(errors[0].message, /20 MB/);
  });
});

test('an oversized PDF is caught even when Telegram does not report its size', async () => {
  const oversized = Buffer.alloc(MAX_PDF_BYTES + 1);
  await withApp({ pdf: oversized }, async ({ errors, requests, app }) => {
    await app.bot.handleUpdate(sendPdf({ file_size: undefined }));
    await app.bot.settle();

    assert.deepEqual(requests, [], 'the real length must be checked, not just the reported one');
    assert.match(errors[0].message, /too large/);
  });
});

test('an unreadable PDF reports a failure rather than a record of unknowns', async () => {
  await withApp({ response: 'unreadable_page' }, async ({ store, errors, app }) => {
    await app.bot.handleUpdate(sendPdf());
    await app.bot.settle();

    assert.equal(store.countConfirmed(), 0);
    assert.match(errors[0].message, /could not read/i);
  });
});

test('a non-PDF attachment is refused before anything is downloaded', async () => {
  await withApp({}, async ({ sent, downloaded, requests, app }) => {
    await app.bot.handleUpdate(sendPdf({ file_name: 'notes.docx', mime_type: 'application/msword' }));
    await app.bot.settle();

    assert.deepEqual(downloaded, []);
    assert.deepEqual(requests, []);
    assert.match(sent[0].text, /PDF/);
  });
});
