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

// --- pasted adverts ---------------------------------------------------------------------
//
// The link is not always readable. A KU Leuven advert renders in the browser, so Anthropic's
// fetcher saw nothing and the ingest cost $0.69 to produce an empty record – while the page
// sat perfectly legible in front of the user. Pasting it is the way through, and it is a lot
// of university job boards, not one page.
//
// A paste is told apart from a correction by shape rather than by guessing: the edit grammar
// is a single anchored line, so anything spanning lines cannot be one.

const ADVERT = [
  'Finding structure in multi-modal food data with visual analytics',
  '(ref. BAP-2026-443)',
  'The PhD candidate will join the AIDA research group at KU Leuven.',
  'You can apply for this job no later than August 14, 2026 via the online application tool.',
  'Source: https://www.kuleuven.be/personeel/jobsite/jobs/60706660?hl=nl&lang=nl',
].join('\n');

test('a pasted advert with its link is a submission, not a correction', () => {
  const decision = classifyUpdate(message({ text: ADVERT }), ME);
  assert.equal(decision.kind, 'paste');
  assert.equal(decision.url, 'https://www.kuleuven.be/personeel/jobsite/jobs/60706660?hl=nl&lang=nl');
  assert.match(decision.text, /BAP-2026-443/);
});

test('a pasted advert without a link is refused, and says why', () => {
  // source_url is not decoration: it is the identity a record is stored under, what the
  // re-submission short-circuit looks up, and the only way back to the advert later. A paste
  // arrives because a link failed, so the user has the link.
  const decision = classifyUpdate(message({ text: ADVERT.replace(/^Source:.*$/m, '') }), ME);
  assert.equal(decision.kind, 'unsupported');
  assert.match(decision.reason, /link/i);
});

test('a correction is still a correction, however it is worded', () => {
  const decision = classifyUpdate(message({ text: '7 title = Finding structure in multi-modal food data' }), ME);
  assert.equal(decision.kind, 'text');
});

test('a long single-line correction is not mistaken for an advert', () => {
  // The discriminator is the edit grammar, not length: an edit is one anchored line, so a
  // wordy title correction stays an edit no matter how long it runs.
  const long = `7 title = ${'a very long corrected title '.repeat(20)}`;
  assert.ok(long.length > 400);
  assert.equal(classifyUpdate(message({ text: long }), ME).kind, 'text');
});

test('a short multi-line note is not an advert', () => {
  // An advert is a document. Two lines of chat is not, and treating it as one would spend a
  // model call on it.
  assert.equal(classifyUpdate(message({ text: 'hey\nthanks' }), ME).kind, 'text');
});

test('a bare link is still fetched rather than treated as pasted text', () => {
  const decision = classifyUpdate(message({ text: 'https://uni.example/phd' }), ME);
  assert.equal(decision.kind, 'url');
});

test('a pasted advert is acknowledged as text, not as a link to fetch', () => {
  const decision = classifyUpdate(message({ text: ADVERT }), ME);
  assert.match(acknowledgement(decision), /text/i);
});
