// The tracer bullet, end to end: a link arrives on Telegram and becomes a confirmed row.
//
// Everything real except the two network edges – the store is a temporary SQLite file, and
// Telegram and Anthropic are stubs returning recorded fixtures. What this pins is the wiring
// between the pieces, which none of the per-module tests can see.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openStore } = require('../src/store.cjs');
const { createApp, createSubmissionHandler } = require('../src/app.cjs');
const { loadPrompt } = require('../src/core/prompt.cjs');

const PROMPT = loadPrompt(path.join(__dirname, '..', 'prompts', 'ingest.prompt'));
const fixture = (name) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ingest', `${name}.json`), 'utf8'));

const ME = 987654321;

const CONFIG = {
  telegramAllowedUserId: ME,
  timezone: 'America/Mexico_City',
  reminderLeadTimes: [30, 7, 1],
};

function fakeTelegram() {
  const sent = [];
  return {
    sent,
    async sendMessage(chatId, text, options) {
      sent.push({ chatId, text, options });
      return { message_id: sent.length };
    },
    async clearButtons() {},
    async answerCallbackQuery() {},
  };
}

function fakeAnthropic(responses) {
  const requests = [];
  return {
    requests,
    messages: {
      stream(body) {
        requests.push(body);
        const response = responses[Math.min(requests.length - 1, responses.length - 1)];
        return { finalMessage: async () => response };
      },
    },
  };
}

async function withApp(responses, run, { fetchPage, onError } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prospect-app-'));
  const store = openStore(path.join(dir, 'prospect.db'));
  const telegram = fakeTelegram();
  const anthropic = fakeAnthropic(responses);
  const errors = [];
  const app = createApp({
    config: CONFIG,
    store,
    anthropic,
    telegram,
    prompt: PROMPT,
    trace: { record() {} },
    // Refuses by default, so a test that does not opt in cannot quietly reach the network.
    fetchPage: fetchPage ?? (async () => ({ ok: false, reason: 'no fetcher in this test' })),
    onError: (e) => {
      errors.push(e);
      if (onError) onError(e);
    },
  });
  try {
    return await run({ store, telegram, anthropic, app, errors });
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const linkFrom = (from = ME, url = 'https://uni.example/phd') => ({
  update_id: 1,
  message: { message_id: 10, chat: { id: from }, from: { id: from }, text: url },
});

const press = (action, id) => ({
  update_id: 2,
  callback_query: {
    id: 'cbq-1',
    from: { id: ME },
    data: `${action}:${id}`,
    message: { message_id: 11, chat: { id: ME } },
  },
});

test('a link becomes an approval card, and approving it writes a confirmed row', async () => {
  await withApp([fixture('complete')], async ({ store, telegram, app }) => {
    await app.bot.handleUpdate(linkFrom());
    await app.bot.settle();

    // Ack first, then the card – the ack did not wait on the model call.
    assert.equal(telegram.sent.length, 2);
    assert.match(telegram.sent[0].text, /Got it/);
    assert.match(telegram.sent[1].text, /PhD in Trustworthy Artificial Intelligence/);

    const id = Number(telegram.sent[1].options.replyMarkup.inline_keyboard[0][0].callback_data.split(':')[1]);
    assert.equal(store.countConfirmed(), 0, 'nothing is tracked before approval');

    await app.bot.handleUpdate(press('approve', id));
    await app.bot.settle();

    assert.equal(store.countConfirmed(), 1);
    const row = store.listConfirmed()[0];
    assert.equal(row.title, 'PhD in Trustworthy Artificial Intelligence');
    assert.equal(row.deadline_at, '2026-12-01T23:59:00.000Z');
    assert.equal(row.prompt_hash, PROMPT.contentHash);
    assert.ok(row.findings.deadline.evidence.length > 0);
    assert.ok(row.contacts.length > 0);
  });
});

test('rejecting leaves nothing behind', async () => {
  await withApp([fixture('complete')], async ({ store, telegram, app }) => {
    await app.bot.handleUpdate(linkFrom());
    await app.bot.settle();

    const id = Number(telegram.sent[1].options.replyMarkup.inline_keyboard[0][0].callback_data.split(':')[1]);
    await app.bot.handleUpdate(press('reject', id));
    await app.bot.settle();

    assert.equal(store.getOpportunity(id), null);
    assert.equal(store.countConfirmed(), 0);
  });
});

test('an unreadable page reports the failure instead of presenting an empty record', async () => {
  await withApp([fixture('unreadable_page')], async ({ store, telegram, app, errors }) => {
    await app.bot.handleUpdate(linkFrom());
    await app.bot.settle();

    assert.equal(store.countConfirmed(), 0);
    assert.equal(telegram.sent.length, 1, 'no card should have been sent');
    assert.equal(errors.length, 1, 'the failure must reach the alert path');
    assert.match(errors[0].message, /could not read/i);
  });
});

test('a truncated response never becomes a stored record', async () => {
  await withApp([fixture('max_tokens')], async ({ store, app, errors }) => {
    await app.bot.handleUpdate(linkFrom());
    await app.bot.settle();

    assert.equal(store.countConfirmed(), 0);
    assert.equal(store.getOpportunity(1), null);
    assert.match(errors[0].message, /ran out of room/i);
  });
});

test('a link from another user produces no reply, no model call and no row', async () => {
  await withApp([fixture('complete')], async ({ store, telegram, anthropic, app }) => {
    await app.bot.handleUpdate(linkFrom(111222333));
    await app.bot.settle();

    assert.deepEqual(telegram.sent, []);
    assert.deepEqual(anthropic.requests, []);
    assert.equal(store.countConfirmed(), 0);
  });
});

test('token usage from the ingest call is recorded for the weekly digest', async () => {
  await withApp([fixture('complete')], async ({ store, app }) => {
    await app.bot.handleUpdate(linkFrom());
    await app.bot.settle();

    const usage = store.usageSince('2000-01-01T00:00:00.000Z');
    assert.equal(usage.calls, 1);
    assert.ok(usage.input_tokens > 0);
    assert.ok(usage.output_tokens > 0);
  });
});

test('correcting a field before approving stores the corrected value', async () => {
  await withApp([fixture('complete')], async ({ store, telegram, app }) => {
    await app.bot.handleUpdate(linkFrom());
    await app.bot.settle();
    const id = Number(telegram.sent[1].options.replyMarkup.inline_keyboard[0][0].callback_data.split(':')[1]);

    await app.bot.handleUpdate({
      update_id: 3,
      message: { message_id: 12, chat: { id: ME }, from: { id: ME }, text: `${id} deadline = 2026-11-15` },
    });
    await app.bot.settle();

    await app.bot.handleUpdate(press('approve', id));
    await app.bot.settle();

    assert.equal(store.listConfirmed()[0].deadline_at, '2026-11-16T05:59:00.000Z');
  });
});

test('the approval card renders markup from the page literally', async () => {
  const hostile = structuredClone(fixture('complete'));
  const record = JSON.parse(hostile.content.at(-1).text);
  record.title = '*bold* [link](http://evil.example) `code`';
  hostile.content.at(-1).text = JSON.stringify(record);

  await withApp([hostile], async ({ telegram, app }) => {
    await app.bot.handleUpdate(linkFrom());
    await app.bot.settle();

    const card = telegram.sent[1];
    assert.ok(card.text.includes('*bold* [link](http://evil.example) `code`'));
    assert.ok(!('parse_mode' in (card.options ?? {})), 'parse_mode must never be set');
  });
});

// --- pasted adverts ---------------------------------------------------------------------

const PASTED_ADVERT = [
  'PhD in Trustworthy Artificial Intelligence',
  '(ref. BAP-2026-443)',
  'The candidate will join the research group and work on explainable AI methods.',
  'Applications close on 1 December 2026 via the online application tool.',
  'Source: https://uni.example/phd',
].join('\n');

const pasteFrom = (text = PASTED_ADVERT) => ({
  update_id: 3,
  message: { message_id: 12, chat: { id: ME }, from: { id: ME }, text },
});

test('a pasted advert becomes an approval card without anything being fetched', async () => {
  // The whole point: the page could not be read, the user could. This is the path that turns
  // a $0.69 empty record into a tracked deadline.
  await withApp([fixture('complete')], async ({ store, telegram, app, anthropic }) => {
    await app.bot.handleUpdate(pasteFrom());
    await app.bot.settle();

    assert.equal(telegram.sent.length, 2);
    assert.match(telegram.sent[0].text, /reading the text you sent/);
    assert.match(telegram.sent[1].text, /PhD in Trustworthy Artificial Intelligence/);

    // The advert reached the model as content, and the link went with it as unfetchable.
    const sent = JSON.stringify(anthropic.requests[0].messages);
    assert.match(sent, /BAP-2026-443/);
    assert.match(sent, /could not be fetched/i);

    const id = Number(telegram.sent[1].options.replyMarkup.inline_keyboard[0][0].callback_data.split(':')[1]);
    await app.bot.handleUpdate(press('approve', id));
    await app.bot.settle();

    assert.equal(store.countConfirmed(), 1);
    assert.equal(store.listConfirmed()[0].deadline_at, '2026-12-01T23:59:00.000Z');
  });
});

test('pasting an advert already on file costs nothing', async () => {
  // The short-circuit is keyed on the link, and a paste carries the same link, so the
  // expensive path is skipped whichever way the same advert arrives twice.
  await withApp([fixture('complete')], async ({ telegram, app, anthropic }) => {
    await app.bot.handleUpdate(linkFrom());
    await app.bot.settle();
    const id = Number(telegram.sent[1].options.replyMarkup.inline_keyboard[0][0].callback_data.split(':')[1]);
    await app.bot.handleUpdate(press('approve', id));
    await app.bot.settle();

    const callsBefore = anthropic.requests.length;
    await app.bot.handleUpdate(pasteFrom());
    await app.bot.settle();

    assert.equal(anthropic.requests.length, callsBefore, 'a second model call was made');
    assert.match(telegram.sent.at(-1).text, /Already tracking/);
  });
});

test('pasting the same link-less advert twice does not pay for it twice', async () => {
  // Identity comes from the text, so the short-circuit works with no address involved.
  const bare = PASTED_ADVERT.replace(/^Source:.*$/m, '').trim();
  await withApp([fixture('complete')], async ({ telegram, app, anthropic }) => {
    await app.bot.handleUpdate(pasteFrom(bare));
    await app.bot.settle();
    const id = Number(telegram.sent[1].options.replyMarkup.inline_keyboard[0][0].callback_data.split(':')[1]);
    await app.bot.handleUpdate(press('approve', id));
    await app.bot.settle();

    const callsBefore = anthropic.requests.length;
    // Re-pasted with the whitespace a second copy-paste would change.
    await app.bot.handleUpdate(pasteFrom('  ' + bare.replace(/\n/g, '\n\n') + '\n'));
    await app.bot.settle();

    assert.equal(anthropic.requests.length, callsBefore, 'the same advert was ingested twice');
    assert.match(telegram.sent.at(-1).text, /Already tracking/);
  });
});

// --- reading the page ourselves -----------------------------------------------------------
//
// Live: Anthropic's web_fetch answered `url_not_allowed` for a LinkedIn post that plain curl
// with a browser user-agent fetched at 200 with 174 KB. The refusal was the tool declining
// the address, not the site refusing us, so the advert was readable the whole time and the
// only thing missing was someone to go and read it.

test('a page web_fetch always refuses is read by the app, and the model is told not to try it', async () => {
  const fetched = [];
  const page = async (url) => {
    fetched.push(url);
    return { ok: true, text: 'PhD in creativity support in generative AI at Aalborg University.', url };
  };

  await withApp([fixture('complete')], async ({ store, telegram, app, anthropic }) => {
    await app.bot.handleUpdate(linkFrom(ME, 'https://www.linkedin.com/posts/x/'));
    await app.bot.settle();

    assert.deepEqual(fetched, ['https://www.linkedin.com/posts/x/'], 'the page was not fetched');
    assert.equal(anthropic.requests.length, 1, 'the model was asked to fetch it as well');

    // The text goes up, described as what it is. It used to be announced as something the
    // user had pasted because the address could not be fetched – a failure that had not
    // happened, about a paste nobody had made, on every submission.
    const sent = JSON.stringify(anthropic.requests[0].messages);
    assert.match(sent, /creativity support/);
    assert.match(sent, /this app fetched and read for you/i);
    assert.doesNotMatch(sent, /the user pasted/i);

    // And it ends where any successful ingest ends: a card to approve.
    assert.match(telegram.sent.at(-1).text, /PhD in Trustworthy Artificial Intelligence/);
    assert.equal(store.countConfirmed(), 0, 'nothing is tracked before approval');
  }, { fetchPage: page });
});

test('the record is still filed under the link, not under the text that was fetched', async () => {
  // The fallback changes how the advert was read, not what it is. Filing it under a paste
  // identity would make the same advert unrecognisable the next time the link is sent.
  const page = async (url) => ({ ok: true, text: 'An advert with a deadline.', url });

  await withApp([fixture('complete')], async ({ store, telegram, app }) => {
    await app.bot.handleUpdate(linkFrom(ME, 'https://www.linkedin.com/posts/x/'));
    await app.bot.settle();
    const id = Number(telegram.sent.at(-1).options.replyMarkup.inline_keyboard[0][0].callback_data.split(':')[1]);
    await app.bot.handleUpdate(press('approve', id));
    await app.bot.settle();

    assert.equal(store.listConfirmed()[0].source_url, 'https://www.linkedin.com/posts/x/');
  }, { fetchPage: page });
});

test('the fallback records when it read the page, so the record survives validation', async () => {
  // The live failure this whole path was built for, and the one it nearly threw away: the
  // app fetched the KU Leuven advert the model had been refused, the model read it and
  // quoted the Dutch deadline correctly, and every excerpt came back with
  // `retrieved_at: "unknown (pasted text, no fetch)"` – the only honest answer available to
  // something with no clock. Validation rejected the lot. The fetch instant is the app's.
  const page = async (url) => ({ ok: true, text: 'Solliciteren tot en met: 15/08/2026 23:59 CET', url });
  const link = 'https://www.kuleuven.be/personeel/jobsite/jobs/60691726?hl=nl&lang=nl';
  const errors = [];

  await withApp(
    [fixture('paste_undated_evidence')],
    async ({ store, telegram, app }) => {
      await app.bot.handleUpdate(linkFrom(ME, link));
      await app.bot.settle();

      assert.deepEqual(errors, [], 'the record was rejected instead of presented');
      const card = telegram.sent.at(-1);
      assert.match(card.text, /Human-centred Explainable Constraint Solving/);

      const id = Number(card.options.replyMarkup.inline_keyboard[0][0].callback_data.split(':')[1]);
      await app.bot.handleUpdate(press('approve', id));
      await app.bot.settle();
      assert.equal(store.listConfirmed()[0].deadline_at, '2026-08-15T22:59:00.000Z');
    },
    { fetchPage: page, onError: (e) => errors.push(e) }
  );
});

test('when the app cannot fetch it either, the original failure is what the user hears', async () => {
  // Two failures, one of them an implementation detail. Reporting "I will not fetch that
  // address" would describe the fallback rather than the advert.
  const page = async () => ({ ok: false, reason: 'that page answered 403.' });
  const errors = [];

  await withApp([fixture('fetch_blocked_linkedin')], async ({ app, anthropic }) => {
    await app.bot.handleUpdate(linkFrom(ME, 'https://www.linkedin.com/posts/x/'));
    await app.bot.settle();

    assert.equal(anthropic.requests.length, 1, 'a second ingest was paid for with no new text');
    assert.match(errors.at(-1).message, /could not fetch that page/i);
  }, { fetchPage: page, onError: (e) => errors.push(e) });
});

// --- the same advert twice ---------------------------------------------------------------

test('the same link sent twice in a row is only paid for once', async () => {
  // Back to back, neither submission has produced a row yet, so a check against the database
  // sees nothing and both calls run. The window is between the two, and only something that
  // knows what is in flight can close it.
  await withApp([fixture('complete')], async ({ telegram, anthropic, app }) => {
    await app.bot.handleUpdate(linkFrom());
    await app.bot.handleUpdate({ ...linkFrom(), update_id: 2, message: { ...linkFrom().message, message_id: 11 } });
    await app.bot.settle();

    assert.equal(anthropic.requests.length, 1, 'the same advert was ingested twice');
    assert.match(telegram.sent.map((m) => m.text).join('\n'), /already reading that one/i);
  });
});

test('a candidate still waiting for approval is not ingested again', async () => {
  // The old check looked only at confirmed rows, so an advert sitting on a card nobody had
  // pressed yet was re-read and re-billed every time the link arrived.
  await withApp([fixture('complete')], async ({ telegram, anthropic, app }) => {
    await app.bot.handleUpdate(linkFrom());
    await app.bot.settle();
    const before = anthropic.requests.length;

    await app.bot.handleUpdate({ ...linkFrom(), update_id: 3, message: { ...linkFrom().message, message_id: 12 } });
    await app.bot.settle();

    assert.equal(anthropic.requests.length, before, 'a pending candidate was ingested again');
    assert.match(telegram.sent.at(-1).text, /waiting for you/i);
  });
});

test('a failed ingest does not block the link from being tried again', async () => {
  // The in-flight guard has to release on failure, or one bad moment makes an advert
  // permanently unsubmittable until a restart.
  await withApp([fixture('max_tokens'), fixture('complete')], async ({ anthropic, app }) => {
    await app.bot.handleUpdate(linkFrom());
    await app.bot.settle();
    await app.bot.handleUpdate({ ...linkFrom(), update_id: 4, message: { ...linkFrom().message, message_id: 13 } });
    await app.bot.settle();

    assert.equal(anthropic.requests.length, 2, 'the retry after a failure was refused');
  });
});

// --- the rescue the expensive failures could not reach ------------------------------------
//
// Live, 17 Aug: a LinkedIn advert burned the whole ten-minute budget and came back as
// "that one took too long". The fallback that would have saved it was gated on the response
// reporting a refused fetch – and a run the clock cut short has no response to report one.
// The three failures that cost the most were the three that skipped the rescue.

test('the advert is read from the app\'s own fetch before a model call is paid for', async () => {
  const fetched = [];
  const seen = [];
  const presented = [];

  const handle = createSubmissionHandler({
    store: { findByUrl: () => null },
    telegram: { async sendMessage() {} },
    ingest: async (submission) => {
      seen.push(submission);
      if (submission.kind === 'paste') return { ok: true, candidate: { title: 'Read on the second try' } };
      return { ok: false, unread: true, reason: 'That one took too long - I stopped it after 10 minutes.' };
    },
    approval: { present: async (candidate) => presented.push(candidate) },
    chatId: ME,
    fetchPage: async (url) => {
      fetched.push(url);
      return { ok: true, text: 'PhD position in misinformation research.', url };
    },
    now: () => new Date('2026-08-17T12:00:00Z'),
  });

  await handle({ kind: 'url', url: 'https://www.linkedin.com/posts/roozenbeek/' });

  assert.deepEqual(fetched, ['https://www.linkedin.com/posts/roozenbeek/'], 'the app never went to read it itself');
  assert.equal(seen.length, 1, 'a model call was paid for on the address as well');
  assert.equal(seen[0].kind, 'paste');
  assert.deepEqual(presented, [{ title: 'Read on the second try' }], 'the record was never presented');
});

test('a failure the app cannot do anything about is reported without a second read', async () => {
  const fetched = [];
  let calls = 0;

  const handle = createSubmissionHandler({
    store: { findByUrl: () => null },
    telegram: { async sendMessage() {} },
    ingest: async () => {
      calls += 1;
      return { ok: false, reason: 'The record did not pass validation: deadline has no evidence.' };
    },
    approval: { present: async () => assert.fail('nothing should have been presented') },
    chatId: ME,
    fetchPage: async (url) => {
      fetched.push(url);
      return { ok: true, text: 'irrelevant', url };
    },
    now: () => new Date('2026-08-17T12:00:00Z'),
  });

  await assert.rejects(() => handle({ kind: 'url', url: 'https://uni.example/phd' }), /did not pass validation/);
  assert.deepEqual(fetched, ['https://uni.example/phd'], 'the app did not read the page itself');
  assert.equal(calls, 1, 'a second model call was paid for on a failure reading again cannot fix');
});

test('the rescue shares the submission budget instead of starting a new clock', async () => {
  // Bounds live on the ingest, not on the call, so a second ingest used to begin with a
  // full budget of its own – and the failure that reaches the rescue is exactly the one
  // that already spent a full budget getting there.
  const deadlines = [];

  const handle = createSubmissionHandler({
    store: { findByUrl: () => null },
    telegram: { async sendMessage() {} },
    // Both reads are pastes here, so the read apart is which one it is, not what it carries.
    ingest: async (_submission, options) => {
      deadlines.push(options?.deadline);
      return deadlines.length === 1
        ? { ok: false, unread: true, reason: 'That one took too long.' }
        : { ok: true, candidate: { title: 'Read on the second try' } };
    },
    approval: { present: async () => {} },
    chatId: ME,
    fetchPage: async (url) => ({ ok: true, text: 'PhD position.', url }),
    now: () => new Date('2026-08-17T12:00:00Z'),
  });

  await handle({
    kind: 'paste',
    url: 'https://www.linkedin.com/posts/x/',
    text: 'An advert whose text reached us stale.',
  });

  assert.equal(deadlines.length, 2);
  assert.ok(Number.isFinite(deadlines[0]), 'the ingest was given no deadline to share');
  assert.equal(deadlines[1], deadlines[0], 'the rescue was handed a clock of its own');
});

// --- our address, our fetch ---------------------------------------------------------------
//
// The submitted page is read here rather than by web_fetch. A page the model fetches arrives
// mid-conversation and is re-sent on every iteration after it, and the server-side loop bills
// the whole conversation each time – one live rescue ran seven iterations at ~25k tokens
// apiece. Reading it here puts the advert in the opening turn instead, and spends no round
// trip to get it. What the model chooses for itself still runs on Anthropic's side, which is
// the half of ADR-0007 that carries the security argument.

test('the submitted page is read by the app, so the model is never asked to fetch it', async () => {
  const fetched = [];
  const page = async (url) => {
    fetched.push(url);
    return { ok: true, text: 'PhD in Trustworthy Artificial Intelligence at Example University.', url };
  };

  await withApp([fixture('complete')], async ({ telegram, anthropic, app }) => {
    await app.bot.handleUpdate(linkFrom(ME, 'https://uni.example/phd'));
    await app.bot.settle();

    assert.deepEqual(fetched, ['https://uni.example/phd']);
    assert.equal(anthropic.requests.length, 1, 'the model was asked to read the page as well');

    // The advert travels as text in the opening turn, not as an address to go and get.
    const sent = JSON.stringify(anthropic.requests[0].messages);
    assert.match(sent, /Trustworthy Artificial Intelligence at Example University/);
    assert.match(telegram.sent.at(-1).text, /PhD in Trustworthy Artificial Intelligence/);
  }, { fetchPage: page });
});

test('a page the app cannot fetch is still handed to the model, which reaches some we cannot', async () => {
  const page = async () => ({ ok: false, reason: 'that page answered 403.' });

  await withApp([fixture('complete')], async ({ telegram, anthropic, app }) => {
    await app.bot.handleUpdate(linkFrom(ME, 'https://uni.example/phd'));
    await app.bot.settle();

    assert.equal(anthropic.requests.length, 1);
    const sent = JSON.stringify(anthropic.requests[0].messages);
    assert.match(sent, /uni\.example\/phd/, 'the model was not given the address to try');
    assert.match(telegram.sent.at(-1).text, /PhD in Trustworthy Artificial Intelligence/);
  }, { fetchPage: page });
});

test('a page that answered 200 with something that is not the advert still reaches the model', async () => {
  // `page.ok` only ever meant bytes arrived. A sign-in wall, a consent page or a JS shell is
  // a 200 with real text in it, so our own fetch "succeeds" and the model reads a page that
  // says nothing. Before this, the address was never offered to web_fetch at all and the
  // user got "I could not read anything from that page" – the message this whole path
  // exists to stop sending.
  const seen = [];

  const handle = createSubmissionHandler({
    store: { findByUrl: () => null },
    telegram: { async sendMessage() {} },
    ingest: async (submission) => {
      seen.push(submission.kind);
      if (submission.kind === 'url') return { ok: true, candidate: { title: 'Read from the live page' } };
      // Our sign-in wall: well-formed, and empty of advert.
      return { ok: false, unread: true, reason: 'I could not read anything from that page.' };
    },
    approval: { present: async () => {} },
    chatId: ME,
    fetchPage: async (url) => ({ ok: true, text: 'Sign in to view this post. Join now.', url }),
    now: () => new Date('2026-08-27T12:00:00Z'),
  });

  await handle({ kind: 'url', url: 'https://www.linkedin.com/posts/x/' });

  assert.deepEqual(seen, ['paste', 'url'], 'the model was never given the address to try');
});
