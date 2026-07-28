// Contract for deciding what an incoming Telegram update is.
//
// Pure: an update object and the allowed user id go in, a decision comes out. The single-user
// gate is the security-relevant part, so it is asserted from several directions rather than
// once – a message from another account must produce no reply and no database write, which
// here means the decision is `ignored` and carries nothing to act on.

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyUpdate, acknowledgement } = require('../src/core/router.cjs');

const ME = 987654321;
const SOMEONE_ELSE = 111222333;

const message = (overrides = {}, from = ME) => ({
  update_id: 1,
  message: { message_id: 10, chat: { id: from }, from: { id: from }, ...overrides },
});

test('a URL from the admitted user is a submission to ingest', () => {
  const decision = classifyUpdate(message({ text: 'https://uni.example/phd' }), ME);
  assert.equal(decision.kind, 'url');
  assert.equal(decision.url, 'https://uni.example/phd');
  assert.equal(decision.chatId, ME);
});

test('a URL surrounded by chatter is still found', () => {
  const decision = classifyUpdate(message({ text: 'look at this https://uni.example/phd nice one' }), ME);
  assert.equal(decision.kind, 'url');
  assert.equal(decision.url, 'https://uni.example/phd');
});

test('trailing punctuation is not part of the URL', () => {
  assert.equal(classifyUpdate(message({ text: 'see https://uni.example/phd.' }), ME).url, 'https://uni.example/phd');
  assert.equal(
    classifyUpdate(message({ text: '(https://uni.example/phd)' }), ME).url,
    'https://uni.example/phd'
  );
});

test('the first URL wins when a message carries several', () => {
  const decision = classifyUpdate(
    message({ text: 'https://uni.example/a and https://uni.example/b' }),
    ME
  );
  assert.equal(decision.url, 'https://uni.example/a');
});

test('a PDF document from the admitted user is a submission to ingest', () => {
  const decision = classifyUpdate(
    message({ document: { file_id: 'BQACAg', file_name: 'advert.pdf', mime_type: 'application/pdf', file_size: 120000 } }),
    ME
  );
  assert.equal(decision.kind, 'document');
  assert.equal(decision.fileId, 'BQACAg');
  assert.equal(decision.fileName, 'advert.pdf');
  assert.equal(decision.fileSize, 120000);
});

test('a non-PDF document is reported back, not fed to the model', () => {
  const decision = classifyUpdate(
    message({ document: { file_id: 'X', file_name: 'notes.docx', mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } }),
    ME
  );
  assert.equal(decision.kind, 'unsupported');
  assert.match(decision.reason, /PDF/);
});

test('text with no link is answered rather than ingested', () => {
  const decision = classifyUpdate(message({ text: 'how many do I have?' }), ME);
  assert.equal(decision.kind, 'text');
  assert.equal(decision.text, 'how many do I have?');
});

test('a button press is a callback carrying its action and opportunity', () => {
  const decision = classifyUpdate(
    {
      update_id: 2,
      callback_query: {
        id: 'cbq-1',
        from: { id: ME },
        data: 'approve:42',
        message: { message_id: 10, chat: { id: ME } },
      },
    },
    ME
  );
  assert.equal(decision.kind, 'callback');
  assert.equal(decision.action, 'approve');
  assert.equal(decision.opportunityId, 42);
  assert.equal(decision.callbackQueryId, 'cbq-1');
  assert.equal(decision.messageId, 10);
});

// --- the single-user gate ---------------------------------------------------------------

const FROM_STRANGERS = [
  ['a text message', message({ text: 'hello' }, SOMEONE_ELSE)],
  ['a URL', message({ text: 'https://uni.example/phd' }, SOMEONE_ELSE)],
  ['a PDF', message({ document: { file_id: 'X', mime_type: 'application/pdf' } }, SOMEONE_ELSE)],
  [
    'a button press',
    {
      update_id: 3,
      callback_query: { id: 'c', from: { id: SOMEONE_ELSE }, data: 'approve:42', message: { message_id: 1, chat: { id: SOMEONE_ELSE } } },
    },
  ],
];

for (const [what, update] of FROM_STRANGERS) {
  test(`${what} from another user is ignored`, () => {
    assert.deepEqual(classifyUpdate(update, ME), { kind: 'ignored' });
  });
}

test('a message whose chat is mine but whose sender is not is ignored', () => {
  // Guards the gate against being read off the chat rather than the sender – in a group the
  // two differ, and the chat id is the weaker of the two.
  const update = {
    update_id: 4,
    message: { message_id: 1, chat: { id: ME }, from: { id: SOMEONE_ELSE }, text: 'https://uni.example/phd' },
  };
  assert.deepEqual(classifyUpdate(update, ME), { kind: 'ignored' });
});

test('an update with no sender at all is ignored', () => {
  assert.deepEqual(classifyUpdate({ update_id: 5, channel_post: { text: 'hi' } }, ME), { kind: 'ignored' });
  assert.deepEqual(classifyUpdate({ update_id: 6 }, ME), { kind: 'ignored' });
});

test('the sender id is compared as a number, not as a string', () => {
  // Telegram sends numeric ids; a string comparison against config would silently admit
  // nobody, and the bot would look healthy while ignoring its only user.
  const update = message({ text: 'hello' });
  assert.equal(classifyUpdate(update, String(ME)).kind, 'text');
});

// --- the acknowledgement ----------------------------------------------------------------

test('the acknowledgement names what was received', () => {
  assert.match(acknowledgement({ kind: 'url', url: 'https://uni.example/phd' }), /uni\.example\/phd/);
  assert.match(acknowledgement({ kind: 'document', fileName: 'advert.pdf' }), /advert\.pdf/);
});

test('the acknowledgement says work is in progress, so silence later means something', () => {
  assert.match(acknowledgement({ kind: 'url', url: 'https://uni.example/phd' }), /minute|work|read/i);
});

test('an acknowledgement of an attacker-controlled name is plain text with nothing to escape', () => {
  // Messages carry no parse_mode anywhere in this app; markup renders literally.
  const text = acknowledgement({ kind: 'document', fileName: '*_[bold](http://evil)`.pdf' });
  assert.ok(text.includes('*_[bold](http://evil)`.pdf'), 'the filename was altered');
});
