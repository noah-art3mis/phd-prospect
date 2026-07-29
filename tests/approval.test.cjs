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

test('the card shows the deadline, the findings and where they came from', () => {
  const card = approvalCard({ id: 1, ...CANDIDATE }, { zone: ZONE });

  assert.match(card, /PhD in Trustworthy AI/);
  assert.match(card, /uni\.example\/phd/);
  assert.match(card, /1 December 2026/);
  assert.match(card, /Institution: Example University/);
  assert.match(card, /Supervisors: Dr Ada Example/);
  assert.match(card, /1 evidence items?/);
});

test('a finding that needs checking is shown with its warning, not silently presented as fact', () => {
  const card = approvalCard({ id: 1, ...CANDIDATE }, { zone: ZONE });
  assert.match(card, /Possibly fully funded\s+\(NEEDS CHECKING\)/);
});

test('an opportunity with no deadline says so, and says no reminders will fire', () => {
  const card = approvalCard({ id: 1, ...CANDIDATE, deadline_at: null }, { zone: ZONE });
  assert.match(card, /no reminders will fire/);
});

test('a finding containing markup renders literally and breaks nothing', () => {
  // The card is sent with no parse_mode; there is nothing to escape, so text from a page an
  // attacker controls must survive byte for byte.
  const hostile = '*bold* _under_ `code` [link](http://evil.example) </b>';
  const card = approvalCard(
    {
      id: 1,
      ...CANDIDATE,
      title: hostile,
      findings: { ...CANDIDATE.findings, institution: { state: 'found', value: hostile, evidence: [] } },
    },
    { zone: ZONE }
  );

  assert.ok(card.includes(`${hostile}`), 'the title was altered');
  assert.ok(card.includes(`Institution: ${hostile}`), 'the finding was altered');
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
    { zone: 'Europe/Brussels' }
  );

  assert.match(card, /pasted text/i);
  assert.ok(!card.includes('0f1e2d3c4b5a6978'), 'the internal key was shown to the user');
});
