// The approval flow: card, buttons, and what each press does to the database.
//
// Runs against a real temporary store and a fake Telegram, because the behaviour worth
// pinning is the state change – a confirmed row, a deleted row, an edited value that is
// what gets stored – not which methods were called.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openStore } = require('../src/store.cjs');
const { createApproval } = require('../src/approval.cjs');
const { approvalCard, parseEdit } = require('../src/core/card.cjs');

const ZONE = 'America/Mexico_City';
const CHAT = 987654321;

const CANDIDATE = {
  title: 'PhD in Trustworthy AI',
  source_url: 'https://uni.example/phd',
  institution: 'Example University',
  deadline_at: '2026-12-01T23:59:00.000Z',
  prompt_hash: 'b'.repeat(64),
  findings: {
    institution: { state: 'found', value: 'Example University', evidence: [] },
    supervisors: { state: 'found', value: ['Dr Ada Example'], evidence: [] },
    research_topics: { state: 'found', value: ['Trustworthy AI'], evidence: [] },
    start_date: { state: 'not_stated', value: null, evidence: [] },
    funding: { state: 'needs_confirmation', value: 'Possibly fully funded', evidence: [] },
    deadline: {
      state: 'found',
      value: '2026-12-01T23:59:00+00:00',
      evidence: [
        { url: 'https://uni.example/phd', retrieved_at: '2026-07-06T10:00:00+00:00', excerpt: 'Applications close 1 December 2026.' },
      ],
    },
  },
  contacts: [{ name: 'Dr Ada Example', role: 'supervisor', email: 'ada@uni.example' }],
  references: ['https://uni.example/phd#apply'],
};

function fakeTelegram() {
  const sent = [];
  const cleared = [];
  return {
    sent,
    cleared,
    async sendMessage(chatId, text, options) {
      sent.push({ chatId, text, options });
      return { message_id: sent.length };
    },
    async clearButtons(chatId, messageId) {
      cleared.push({ chatId, messageId });
    },
    async answerCallbackQuery() {},
  };
}

async function withApproval(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prospect-approval-'));
  const store = openStore(path.join(dir, 'prospect.db'));
  const telegram = fakeTelegram();
  const approval = createApproval({ store, telegram, zone: ZONE, chatId: CHAT });
  try {
    return await run({ store, telegram, approval });
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a validated candidate is presented with Approve and Reject buttons', async () => {
  await withApproval(async ({ telegram, approval }) => {
    const id = await approval.present(CANDIDATE);

    const buttons = telegram.sent[0].options.replyMarkup.inline_keyboard[0];
    assert.deepEqual(
      buttons.map((b) => b.text),
      ['Approve', 'Reject']
    );
    assert.deepEqual(
      buttons.map((b) => b.callback_data),
      [`approve:${id}`, `reject:${id}`]
    );
  });
});

test('the presented candidate is stored unconfirmed and stays out of the tracked set', async () => {
  await withApproval(async ({ store, approval }) => {
    const id = await approval.present(CANDIDATE);
    assert.equal(store.getOpportunity(id).confirmed, false);
    assert.equal(store.countConfirmed(), 0);
  });
});

test('Approve writes a confirmed row carrying its findings, evidence, contacts and references', async () => {
  await withApproval(async ({ store, approval }) => {
    const id = await approval.present(CANDIDATE);
    await approval.handleCallback({ action: 'approve', opportunityId: id, chatId: CHAT, messageId: 1 });

    const row = store.getOpportunity(id);
    assert.equal(row.confirmed, true);
    assert.deepEqual(row.findings, CANDIDATE.findings);
    assert.deepEqual(row.contacts, CANDIDATE.contacts);
    assert.deepEqual(row.references, CANDIDATE.references);
    assert.deepEqual(row.findings.supervisors.value, ['Dr Ada Example']);
    assert.deepEqual(row.findings.research_topics.value, ['Trustworthy AI']);
    assert.equal(row.findings.deadline.evidence.length, 1);
    assert.equal(store.countConfirmed(), 1);
  });
});

test('the stored record carries the hash of the prompt that produced it', async () => {
  await withApproval(async ({ store, approval }) => {
    const id = await approval.present(CANDIDATE);
    await approval.handleCallback({ action: 'approve', opportunityId: id, chatId: CHAT, messageId: 1 });
    assert.equal(store.getOpportunity(id).prompt_hash, 'b'.repeat(64));
  });
});

test('the deadline is stored as the UTC instant resolved at ingest', async () => {
  await withApproval(async ({ store, approval }) => {
    const id = await approval.present(CANDIDATE);
    await approval.handleCallback({ action: 'approve', opportunityId: id, chatId: CHAT, messageId: 1 });
    assert.equal(store.getOpportunity(id).deadline_at, '2026-12-01T23:59:00.000Z');
  });
});

test('Reject deletes the row, leaving no trace', async () => {
  await withApproval(async ({ store, approval }) => {
    const id = await approval.present(CANDIDATE);
    await approval.handleCallback({ action: 'reject', opportunityId: id, chatId: CHAT, messageId: 1 });

    assert.equal(store.getOpportunity(id), null);
    assert.equal(store.countConfirmed(), 0);
  });
});

test('the buttons are removed once a card is acted on, so it cannot be pressed twice', async () => {
  await withApproval(async ({ store, telegram, approval }) => {
    const id = await approval.present(CANDIDATE);
    await approval.handleCallback({ action: 'approve', opportunityId: id, chatId: CHAT, messageId: 1 });
    assert.deepEqual(telegram.cleared, [{ chatId: CHAT, messageId: 1 }]);

    // A second press on a stale card must not double-write or crash.
    await approval.handleCallback({ action: 'approve', opportunityId: id, chatId: CHAT, messageId: 1 });
    assert.equal(store.countConfirmed(), 1);
    assert.match(telegram.sent.at(-1).text, /already tracking/i);
  });
});

test('pressing a button on a record that was already rejected says so rather than throwing', async () => {
  await withApproval(async ({ telegram, approval }) => {
    const id = await approval.present(CANDIDATE);
    await approval.handleCallback({ action: 'reject', opportunityId: id, chatId: CHAT, messageId: 1 });
    await approval.handleCallback({ action: 'approve', opportunityId: id, chatId: CHAT, messageId: 1 });
    assert.match(telegram.sent.at(-1).text, /already gone/i);
  });
});

// --- editing ----------------------------------------------------------------------------

test('a correction changes the field and the edited value is what gets stored', async () => {
  await withApproval(async ({ store, approval }) => {
    const id = await approval.present(CANDIDATE);

    const handled = await approval.handleText({ text: `${id} title = PhD in Trustworthy Artificial Intelligence` });
    assert.equal(handled, true);

    await approval.handleCallback({ action: 'approve', opportunityId: id, chatId: CHAT, messageId: 2 });
    assert.equal(store.getOpportunity(id).title, 'PhD in Trustworthy Artificial Intelligence');
  });
});

test('a corrected deadline is re-resolved into an instant, not stored as typed', async () => {
  await withApproval(async ({ store, approval }) => {
    const id = await approval.present(CANDIDATE);
    await approval.handleText({ text: `${id} deadline = 2026-11-15` });
    // 23:59 on 15 November in America/Mexico_City is 05:59Z on the 16th.
    assert.equal(store.getOpportunity(id).deadline_at, '2026-11-16T05:59:00.000Z');
  });
});

test('correcting a deadline to "none" makes it rolling rather than a placeholder date', async () => {
  await withApproval(async ({ store, approval }) => {
    const id = await approval.present(CANDIDATE);
    await approval.handleText({ text: `${id} deadline = none` });
    assert.equal(store.getOpportunity(id).deadline_at, null);
  });
});

test('a correction re-sends the card so the user sees what they changed', async () => {
  await withApproval(async ({ telegram, approval }) => {
    const id = await approval.present(CANDIDATE);
    await approval.handleText({ text: `${id} title = A corrected title` });
    assert.match(telegram.sent.at(-1).text, /A corrected title/);
    assert.ok(telegram.sent.at(-1).options.replyMarkup, 'the re-sent card still needs its buttons');
  });
});

test('a correction naming an unknown field says what can be corrected', async () => {
  await withApproval(async ({ telegram, approval }) => {
    const id = await approval.present(CANDIDATE);
    await approval.handleText({ text: `${id} vibes = good` });
    assert.match(telegram.sent.at(-1).text, /title.*institution.*deadline/);
  });
});

test('a correction to a record that is already approved is refused', async () => {
  await withApproval(async ({ store, telegram, approval }) => {
    const id = await approval.present(CANDIDATE);
    await approval.handleCallback({ action: 'approve', opportunityId: id, chatId: CHAT, messageId: 1 });
    await approval.handleText({ text: `${id} title = sneaky` });

    assert.equal(store.getOpportunity(id).title, 'PhD in Trustworthy AI');
    assert.match(telegram.sent.at(-1).text, /already approved/i);
  });
});

test('ordinary chatter is not mistaken for a correction', async () => {
  await withApproval(async ({ approval }) => {
    assert.equal(await approval.handleText({ text: 'how many do I have?' }), false);
    assert.equal(await approval.handleText({ text: 'https://uni.example/phd' }), false);
  });
});

test('a correction naming a row that does not exist says so', async () => {
  await withApproval(async ({ telegram, approval }) => {
    assert.equal(await approval.handleText({ text: '999 title = nothing' }), true);
    assert.match(telegram.sent.at(-1).text, /no record 999/i);
  });
});

test('an unparseable corrected deadline is refused rather than stored as a guess', async () => {
  await withApproval(async ({ store, telegram, approval }) => {
    const id = await approval.present(CANDIDATE);
    await approval.handleText({ text: `${id} deadline = sometime in the autumn` });

    assert.equal(store.getOpportunity(id).deadline_at, '2026-12-01T23:59:00.000Z', 'the old value must survive');
    assert.match(telegram.sent.at(-1).text, /not a date/i);
  });
});

// --- the card ---------------------------------------------------------------------------

const NOW = new Date('2026-11-15T12:00:00Z');
const card = (overrides = {}) => approvalCard({ id: 1, ...CANDIDATE, ...overrides }, { zone: ZONE, now: NOW });

test('the card shows the deadline, the findings and where they came from', () => {
  const text = card();

  assert.match(text, /PhD in Trustworthy AI/);
  assert.match(text, /uni\.example\/phd/);
  assert.match(text, /1 December 2026/);
  assert.match(text, /Dr Ada Example/);
  assert.match(text, /1 evidence item\b/);
});

test('the header carries institution and place, so they are not four more fields to read', () => {
  const text = card({
    findings: {
      ...CANDIDATE.findings,
      city: { state: 'found', value: 'Exampleton', evidence: [] },
      country: { state: 'found', value: 'Belgium', evidence: [] },
    },
  });

  assert.match(text.split('\n')[1], /Example University · Exampleton, Belgium/);
  assert.ok(!/^Institution:/m.test(text), 'institution was repeated as a field');
});

test('the deadline says how long is left, which is the number the decision turns on', () => {
  // 15 November to 1 December, counted in local days: a date alone means working it out on
  // the spot, every time the card is read.
  assert.match(card(), /1 December 2026 — in 16 days/);
});

test('a deadline today or already gone is named as such, not given as a negative count', () => {
  assert.match(card({ deadline_at: '2026-11-15T23:59:00.000Z' }), /— today/);
  assert.match(card({ deadline_at: '2026-11-13T23:59:00.000Z' }), /— 2 days ago/);
});

test('a list finding is broken into lines rather than joined into a paragraph', () => {
  // The wall of text this layout exists to remove: research_topics and eligibility arrive as
  // arrays and used to be comma-joined into one unreadable run.
  const text = card({
    findings: {
      ...CANDIDATE.findings,
      research_topics: { state: 'found', value: ['Trustworthy AI', 'Model evaluation', 'Alignment'], evidence: [] },
    },
  });

  assert.match(text, /TOPICS\n• Trustworthy AI\n• Model evaluation\n• Alignment/);
});

test('a labelled field with several values keeps its label above the bullets', () => {
  // Bulleting a labelled field without repeating the label leaves the list floating under
  // the section heading, attached to whatever line happened to come before it.
  const text = card({
    findings: {
      ...CANDIDATE.findings,
      supervisors: { state: 'found', value: ['Dr Ada Example', 'Prof Grace Example'], evidence: [] },
    },
  });

  assert.match(text, /Supervisors:\n• Dr Ada Example\n• Prof Grace Example/);
});

test('fields that need checking are collected at the end, not buried mid-card', () => {
  // Inline, the warning sat beside a value halfway down and was read as part of it. The
  // question it answers – what in here should I not trust? – is asked about the record as a
  // whole, so it is answered in one place.
  const text = card();

  assert.match(text, /Check before trusting: Funding/);
  assert.match(text, /Possibly fully funded/);
});

test('the fields nobody stated are named, not just counted', () => {
  // A count says how much is missing; the names say whether what is missing matters. The
  // user asked for this after reading "2 fields not stated" and having to guess which two.
  const text = card();

  assert.match(text, /Not stated: .*\bStarts\b/);
});

test('an opportunity with no deadline says so, and says no reminders will fire', () => {
  assert.match(card({ deadline_at: null }), /no reminders will fire/);
});

test('a finding containing markup renders literally and breaks nothing', () => {
  // The card is sent with no parse_mode; there is nothing to escape, so text from a page an
  // attacker controls must survive byte for byte.
  const hostile = '*bold* _under_ `code` [link](http://evil.example) </b>';
  const text = card({
    title: hostile,
    findings: { ...CANDIDATE.findings, institution: { state: 'found', value: hostile, evidence: [] } },
  });

  assert.ok(text.includes(hostile), 'the title was altered');
  assert.equal(text.split('\n').filter((line) => line.includes(hostile)).length, 2, 'the finding was altered');
});

test('parseEdit ignores text that is not a correction', () => {
  assert.equal(parseEdit('hello there', { zone: ZONE }), null);
  assert.equal(parseEdit('7 = something', { zone: ZONE }), null);
});

test('a record with no source page says so rather than showing its internal key', () => {
  // source_url is a paste reference when the advert arrived as text. Printing it raw shows
  // the user a hash where they expect a link.
  const card = approvalCard(
    {
      id: 1,
      title: 'PhD in food data',
      source_url: 'paste:0f1e2d3c4b5a6978',
      deadline_at: null,
      findings: {},
    },
    { zone: 'Europe/Brussels', now: NOW }
  );

  assert.match(card, /pasted text/i);
  assert.ok(!card.includes('0f1e2d3c4b5a6978'), 'the internal key was shown to the user');
});
