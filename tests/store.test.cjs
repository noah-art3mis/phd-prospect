// Contract for the SQLite store and the seed load.
//
// The store is a thin IO edge, so these are focused integration tests against a real
// (temporary) database rather than assertions about which statements were prepared. What
// they pin is the behaviour the rest of the app depends on: the confirmed predicate, the
// JSON round trip, canonical-URL lookup, and the seed being subject to the same evidence
// gate as live ingest.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openStore } = require('../src/store.cjs');
const { loadSeed } = require('../src/seed.cjs');

function withStore(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prospect-store-'));
  const store = openStore(path.join(dir, 'prospect.db'));
  try {
    return run(store, dir);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const CANDIDATE = {
  title: 'PhD in Trustworthy AI',
  source_url: 'https://uni.example/phd?utm_source=telegram',
  deadline_at: '2026-12-01T22:59:00.000Z',
  institution: 'Example University',
  prompt_hash: 'a'.repeat(64),
  findings: {
    institution: { state: 'found', value: 'Example University', evidence: [] },
    deadline: {
      state: 'found',
      value: '2026-12-01T23:59:00+01:00',
      evidence: [
        {
          url: 'https://uni.example/phd',
          retrieved_at: '2026-07-06T10:00:00+00:00',
          excerpt: 'Applications close 23:59 CET on 1 December 2026.',
        },
      ],
    },
  },
  contacts: [{ name: 'Dr Ada Example', role: 'supervisor' }],
  references: ['https://uni.example/phd#apply'],
};

test('a saved candidate comes back with its lists intact', () => {
  withStore((store) => {
    const id = store.insertCandidate(CANDIDATE);
    const row = store.getOpportunity(id);

    assert.equal(row.title, 'PhD in Trustworthy AI');
    assert.equal(row.institution, 'Example University');
    assert.deepEqual(row.findings, CANDIDATE.findings);
    assert.deepEqual(row.contacts, CANDIDATE.contacts);
    assert.deepEqual(row.references, CANDIDATE.references);
    assert.deepEqual(row.reminders_sent, []);
    assert.equal(row.prompt_hash, 'a'.repeat(64));
  });
});

test('a candidate is unconfirmed until it is approved', () => {
  withStore((store) => {
    const id = store.insertCandidate(CANDIDATE);
    assert.equal(store.getOpportunity(id).confirmed, false);

    store.confirmOpportunity(id);
    assert.equal(store.getOpportunity(id).confirmed, true);
  });
});

test('an unconfirmed row is excluded from listings and counts', () => {
  withStore((store) => {
    const pending = store.insertCandidate(CANDIDATE);
    const tracked = store.insertCandidate({ ...CANDIDATE, source_url: 'https://uni.example/other' });
    store.confirmOpportunity(tracked);

    assert.equal(store.countConfirmed(), 1);
    assert.deepEqual(
      store.listConfirmed().map((o) => o.id),
      [tracked]
    );
    assert.ok(store.getOpportunity(pending), 'the pending row still exists, it is just not tracked');
  });
});

test('rejecting deletes the row, leaving no trace', () => {
  withStore((store) => {
    const id = store.insertCandidate(CANDIDATE);
    store.deleteOpportunity(id);
    assert.equal(store.getOpportunity(id), null);
    assert.equal(store.countConfirmed(), 0);
  });
});

test('the canonical url is stored, so a re-submission can be looked up', () => {
  withStore((store) => {
    const id = store.insertCandidate(CANDIDATE);
    store.confirmOpportunity(id);

    // Same page, different link: tracking parameter, scheme, trailing slash.
    const found = store.findConfirmedByUrl('http://uni.example/phd/?utm_campaign=x');
    assert.equal(found.id, id);
  });
});

test('an unconfirmed row is not found by the re-submission lookup', () => {
  withStore((store) => {
    store.insertCandidate(CANDIDATE);
    assert.equal(store.findConfirmedByUrl('https://uni.example/phd'), null);
  });
});

test('reminders_sent round-trips as a list of lead times', () => {
  withStore((store) => {
    const id = store.insertCandidate(CANDIDATE);
    store.recordRemindersSent(id, [30, 7]);
    assert.deepEqual(store.getOpportunity(id).reminders_sent, [30, 7]);
  });
});

test('editing a field before approval changes what gets stored', () => {
  withStore((store) => {
    const id = store.insertCandidate(CANDIDATE);
    store.updateOpportunity(id, { title: 'PhD in Trustworthy Artificial Intelligence' });
    store.confirmOpportunity(id);
    assert.equal(store.getOpportunity(id).title, 'PhD in Trustworthy Artificial Intelligence');
  });
});

test('updateOpportunity refuses a column it does not own', () => {
  // A column name is an identifier, so it cannot be a bound parameter and has to be
  // interpolated into the statement. The set of things that can appear there is therefore
  // closed here rather than checked by the caller – today's only caller happens to constrain
  // its fields, but that is its invariant, not this one's.
  withStore((store) => {
    const id = store.insertCandidate(CANDIDATE);

    assert.throws(() => store.updateOpportunity(id, { confirmed: 1 }), /not an updatable column/);
    assert.throws(() => store.updateOpportunity(id, { 'title" = "owned': 'x' }), /not an updatable column/);
    assert.equal(store.getOpportunity(id).confirmed, false, 'the rejected write must not have landed');
  });
});

test('a rolling opportunity stores a null deadline rather than a placeholder date', () => {
  withStore((store) => {
    const id = store.insertCandidate({ ...CANDIDATE, deadline_at: null });
    assert.equal(store.getOpportunity(id).deadline_at, null);
  });
});

test('the store survives being reopened – the schema is created if absent, not each boot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prospect-store-'));
  const file = path.join(dir, 'prospect.db');
  try {
    const first = openStore(file);
    const id = first.insertCandidate(CANDIDATE);
    first.confirmOpportunity(id);
    first.close();

    const second = openStore(file);
    assert.equal(second.countConfirmed(), 1);
    second.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- seed load -------------------------------------------------------------------------

const SEED_RECORDS = [
  {
    title: 'Seeded opportunity with a deadline',
    source_url: 'https://uni.example/seeded-1',
    canonical_url: 'https://uni.example/seeded-1',
    institution: 'Example University',
    deadline_at: '2026-09-01',
    confirmed: true,
    findings: {
      deadline: {
        state: 'found',
        value: '2026-09-01',
        evidence: [
          {
            url: 'https://uni.example/seeded-1',
            retrieved_at: '2026-07-19T09:06:00.000+00:00',
            excerpt: 'Application deadline: 1 September 2026',
          },
        ],
      },
    },
    contacts: [],
    references: [],
  },
  {
    title: 'Seeded rolling opportunity',
    source_url: 'https://uni.example/seeded-2',
    canonical_url: 'https://uni.example/seeded-2',
    institution: 'Example University',
    deadline_at: null,
    confirmed: true,
    findings: { deadline: { state: 'not_stated', value: null, evidence: [] } },
    contacts: [],
    references: [],
  },
];

test('seeding loads the records and marks them tracked', () => {
  withStore((store) => {
    const result = loadSeed(store, SEED_RECORDS);
    assert.equal(result.inserted, 2);
    assert.equal(store.countConfirmed(), 2);
    assert.equal(store.listConfirmed().filter((o) => o.deadline_at !== null).length, 1);
  });
});

test('re-running the seed on an already-seeded database does not duplicate rows', () => {
  withStore((store) => {
    loadSeed(store, SEED_RECORDS);
    const again = loadSeed(store, SEED_RECORDS);
    assert.equal(again.inserted, 0);
    assert.equal(again.skipped, 2);
    assert.equal(store.countConfirmed(), 2);
  });
});

test('a seed row that fails the deadline evidence rule is rejected rather than written', () => {
  // The seed is not a back door: it crosses the same validate() seam as live ingest.
  withStore((store) => {
    const ungated = {
      ...SEED_RECORDS[0],
      source_url: 'https://uni.example/ungated',
      canonical_url: 'https://uni.example/ungated',
      findings: { deadline: { state: 'found', value: '2026-09-01', evidence: [] } },
    };
    assert.throws(() => loadSeed(store, [ungated]), /critical finding 'deadline' requires evidence/);
    assert.equal(store.countConfirmed(), 0);
  });
});

test('the committed seed file loads and yields seven opportunities, four with a deadline', () => {
  const records = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'seed', 'opportunities.json'), 'utf8')
  );
  withStore((store) => {
    loadSeed(store, records);
    assert.equal(store.countConfirmed(), 7);
    assert.equal(store.listConfirmed().filter((o) => o.deadline_at !== null).length, 4);
  });
});

test('recorded usage keeps the token classes apart across the round trip', () => {
  // Summing them in the column would lose the distinction just as surely as summing them in
  // the reader: the digest prices each class at its own rate, and it reads these columns.
  withStore((store) => {
    store.recordUsage({
      model: 'claude-sonnet-5',
      inputTokens: 100,
      cacheReadTokens: 200,
      cacheWriteTokens: 30,
      outputTokens: 4,
    });

    const totals = store.usageSince('1970-01-01T00:00:00.000Z');
    assert.equal(totals.input_tokens, 100);
    assert.equal(totals.cache_read_tokens, 200);
    assert.equal(totals.cache_write_tokens, 30);
    assert.equal(totals.output_tokens, 4);
    assert.equal(totals.calls, 1);
  });
});

test('a database written before the cache columns existed gains them on open', () => {
  // The columns are added to a table that already exists, so an upgrade in place does not
  // start by throwing on every insert. CREATE TABLE IF NOT EXISTS is silent about the
  // difference, which is the failure this pins.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prospect-store-old-'));
  const dbPath = path.join(dir, 'prospect.db');
  try {
    const { DatabaseSync } = require('node:sqlite');
    const old = new DatabaseSync(dbPath);
    old.exec(`CREATE TABLE usage_event (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0
    )`);
    old.exec(`INSERT INTO usage_event (occurred_at, model, input_tokens, output_tokens)
              VALUES ('2026-07-28T00:00:00.000Z', 'claude-sonnet-5', 10, 1)`);
    old.close();

    const store = openStore(dbPath);
    store.recordUsage({ model: 'claude-sonnet-5', inputTokens: 5, cacheReadTokens: 7 });
    const totals = store.usageSince('1970-01-01T00:00:00.000Z');
    store.close();

    assert.equal(totals.calls, 2);
    assert.equal(totals.input_tokens, 15);
    // The pre-existing row predates caching, so it reads as zero rather than as unknown.
    assert.equal(totals.cache_read_tokens, 7);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
