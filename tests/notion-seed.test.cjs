// Contract for the one-time Notion → seed transform (tools/notion-to-seed.cjs).
//
// The Notion corpus predates the findings model: it has flat scalar columns and a single
// truncated `Evidence` rich_text blob per opportunity, not per-field evidence. The transform's
// job is to recover what is recoverable and mark the rest `not_stated` – never to invent a
// state it cannot support. The deadline is the only critical finding (SPEC), so it is the one
// place evidence must survive the round trip, and it does: the Deadlines database carries its
// own `Evidence excerpt` and `Evidence URL`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  parseEvidenceBlob,
  buildSeedRecords,
  collectUnlinkedContacts,
} = require(path.join(__dirname, '..', 'tools', 'notion-to-seed.cjs'));

const SNAPSHOT = path.join(__dirname, '..', 'notion-snapshot');

// The snapshot is real personal data and is gitignored, so it exists on the author's box
// and nowhere else. The cases that read it skip when it is absent rather than fail; the
// committed output of the transform (seed/) is what CI actually has to work with, and
// tests/seed-load.test.cjs asserts against that.
const withSnapshot = { skip: fs.existsSync(SNAPSHOT) ? false : 'notion-snapshot/ not present' };

test('parseEvidenceBlob splits "field: excerpt (url)" lines', () => {
  const blob = [
    'institution: Employer: NTNU (https://example.org/advert)',
    'country: content="Norway" (https://example.org/advert)',
  ].join('\n');

  assert.deepEqual(parseEvidenceBlob(blob, false), {
    institution: { excerpt: 'Employer: NTNU', url: 'https://example.org/advert' },
    country: { excerpt: 'content="Norway"', url: 'https://example.org/advert' },
  });
});

test('parseEvidenceBlob drops the final line of a truncated blob', () => {
  // Notion caps rich_text at 2000 chars, so the last line of a maxed-out blob is cut mid-value
  // and its excerpt would be a lie. Five of the seven snapshot rows are truncated this way.
  const blob = [
    'institution: Employer: NTNU (https://example.org/advert)',
    'summary: a sentence that was cut off half',
  ].join('\n');

  const parsed = parseEvidenceBlob(blob, true);
  assert.deepEqual(Object.keys(parsed), ['institution']);
});

test('parseEvidenceBlob ignores lines with no parenthesised URL', () => {
  assert.deepEqual(parseEvidenceBlob('institution: NTNU with no source', false), {});
});

test('every snapshot opportunity becomes exactly one seed record', withSnapshot, () => {
  const records = buildSeedRecords(SNAPSHOT);
  assert.equal(records.length, 7);
});

test('seed records carry the scalar columns the schema queries on', withSnapshot, () => {
  const records = buildSeedRecords(SNAPSHOT);
  for (const r of records) {
    assert.equal(typeof r.title, 'string');
    assert.ok(r.title.length > 0, 'title must not be empty');
    assert.ok(r.source_url.startsWith('http'), `bad source_url: ${r.source_url}`);
    assert.equal(typeof r.confirmed, 'boolean');
    assert.ok(r.deadline_at === null || !Number.isNaN(Date.parse(r.deadline_at)));
  }
});

test('a deadline finding is `found` only when it carries evidence', withSnapshot, () => {
  // The one invariant the app enforces at runtime, applied to seeded rows too: the deadline is
  // the sole critical finding, so `found` without evidence must be unreachable in the seed.
  const records = buildSeedRecords(SNAPSHOT);
  for (const r of records) {
    const deadline = r.findings.deadline;
    if (deadline.state === 'found') {
      assert.ok(deadline.evidence.length > 0, `${r.title}: found deadline with no evidence`);
      for (const e of deadline.evidence) {
        assert.ok(e.url.startsWith('http'));
        assert.ok(e.excerpt.length > 0);
        assert.ok(!Number.isNaN(Date.parse(e.retrieved_at)));
      }
    }
  }
});

test('deadline_at agrees with the deadline finding', withSnapshot, () => {
  const records = buildSeedRecords(SNAPSHOT);
  for (const r of records) {
    const found = r.findings.deadline.state === 'found';
    assert.equal(found, r.deadline_at !== null, `${r.title}: deadline_at disagrees with finding`);
  }
});

test('the four opportunities with a linked deadline get one', withSnapshot, () => {
  // Snapshot fact: 5 deadline rows across 4 opportunities; the rest are rolling or unknown,
  // which the scalar model represents as NULL rather than as a separate state.
  const records = buildSeedRecords(SNAPSHOT);
  assert.equal(records.filter((r) => r.deadline_at !== null).length, 4);
});

test('unpopulated Notion columns become not_stated, never invented values', withSnapshot, () => {
  const records = buildSeedRecords(SNAPSHOT);
  for (const r of records) {
    for (const [field, finding] of Object.entries(r.findings)) {
      assert.ok(
        ['found', 'not_stated'].includes(finding.state),
        `${r.title}/${field}: unexpected state ${finding.state}`
      );
      if (finding.state === 'not_stated') {
        assert.equal(finding.value, null, `${r.title}/${field}: not_stated with a value`);
        assert.deepEqual(finding.evidence, []);
      }
    }
  }
});

test('start_date is not_stated across the corpus', withSnapshot, () => {
  // Snapshot fact: Start date is 0/7 populated. Guards against a transform that silently
  // reuses the deadline as a start date, which the flat Evidence blob invites.
  const records = buildSeedRecords(SNAPSHOT);
  for (const r of records) {
    assert.equal(r.findings.start_date.state, 'not_stated');
  }
});

test('dropped Notion concepts do not appear on seed records', withSnapshot, () => {
  // application_stage, status, priority and the Activities/Documents relations were all cut.
  const records = buildSeedRecords(SNAPSHOT);
  for (const r of records) {
    for (const gone of ['application_stage', 'status', 'priority', 'activities', 'documents']) {
      assert.ok(!(gone in r), `${r.title}: ${gone} survived the transform`);
    }
  }
});

test('contacts attach only where Notion actually linked them', withSnapshot, () => {
  // Snapshot fact: all 17 contacts are orphans – none carries an Opportunity relation and no
  // opportunity links back. Contacts have no table of their own in the new model, so an
  // unlinked contact has nowhere to live on a record. The transform must not guess an owner.
  const records = buildSeedRecords(SNAPSHOT);
  for (const r of records) {
    assert.deepEqual(r.contacts, [], `${r.title}: invented a contact link`);
  }
});

test('orphan contacts are exported rather than dropped', withSnapshot, () => {
  // 17 people with names, roles and institutions are real work not to throw away, even though
  // the relation that would place them was never filled in.
  const orphans = collectUnlinkedContacts(SNAPSHOT);
  assert.equal(orphans.length, 17);
  for (const c of orphans) {
    assert.ok(typeof c.name === 'string' && c.name.length > 0);
  }
});

test('seed records are unconfirmed-safe: confirmed reflects Notion, not a default', withSnapshot, () => {
  const records = buildSeedRecords(SNAPSHOT);
  assert.ok(records.some((r) => r.confirmed), 'expected at least one confirmed row');
});
