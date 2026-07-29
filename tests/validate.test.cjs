// Golden contract for the deterministic validate() seam.
//
// This is the highest-value seam in the app: a candidate record goes in, an accepted
// record or an InvalidRecord comes out, with no clock, environment or network involved.
// The golden cases in tests/golden/normalize_opportunity_cases.json are the durable
// contract – every new validation rule earns a case there.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { validate } = require('../src/core/validate.cjs');

const CASES = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'golden', 'normalize_opportunity_cases.json'), 'utf8')
).cases;

function verdict(candidate) {
  try {
    validate(candidate);
    return 'ok';
  } catch (e) {
    if (e && e.name === 'InvalidRecord') return { invalid: e.message };
    return { error: String((e && e.message) || e) };
  }
}

for (const c of CASES) {
  test('validate contract: ' + c.name, () => {
    assert.deepEqual(verdict(c.input), c.expect);
  });
}

test('validate returns a clone, so the caller cannot mutate the accepted record', () => {
  const candidate = {
    title: 'PhD position',
    source_url: 'https://uni.example/phd',
    findings: { institution: { state: 'found', value: 'Example University', evidence: [] } },
  };
  const accepted = validate(candidate);
  accepted.findings.institution.value = 'Somewhere else';
  assert.equal(candidate.findings.institution.value, 'Example University');
});

test('validate never upgrades a knowledge state', () => {
  const accepted = validate({
    title: 'PhD position',
    source_url: 'https://uni.example/phd',
    findings: {
      deadline: {
        state: 'needs_confirmation',
        value: '2026-12-01T23:59:00+01:00',
        evidence: [
          {
            url: 'https://uni.example/phd',
            retrieved_at: '2026-07-06T10:00:00+00:00',
            excerpt: 'Applications close 1 December.',
          },
        ],
      },
    },
  });
  assert.equal(accepted.findings.deadline.state, 'needs_confirmation');
});

// --- pasted adverts ---------------------------------------------------------------------

const MINIMAL = {
  title: 'PhD position',
  source_url: 'https://uni.example/phd',
  findings: { institution: { state: 'found', value: 'Example University', evidence: [] } },
};

test('a record from pasted text is filed under its paste identity', () => {
  const { pasteIdentity } = require('../src/core/url.cjs');
  const record = { ...MINIMAL, source_url: pasteIdentity('an advert') };
  assert.doesNotThrow(() => validate(record));
});

test('the pasted text is citable, so a deadline from it can be found rather than unconfirmed', () => {
  // The deadline is the field that fires reminders, and it may only be `found` with evidence.
  // With no link anywhere, an http-only evidence rule would force every pasted deadline to
  // needs_confirmation - stored, shown, and silently never acting. The excerpt rule still
  // does the real work: it has to be text that appears in what the user sent.
  const id = require('../src/core/url.cjs').pasteIdentity('an advert');
  const record = {
    ...MINIMAL,
    source_url: id,
    findings: {
      deadline: {
        state: 'found',
        value: ['2026-08-14T23:59:00+02:00'],
        evidence: [{ url: id, retrieved_at: '2026-07-29T10:00:00Z', excerpt: 'no later than August 14, 2026' }],
      },
    },
  };
  assert.doesNotThrow(() => validate(record));
});

test('a source reference is still either a web link or a paste, never anything else', () => {
  for (const bad of ['paste:', 'paste:nothex', 'file:///etc/passwd', 'javascript:alert(1)', 'ftp://x/y']) {
    assert.throws(() => validate({ ...MINIMAL, source_url: bad }), /source_url/, bad);
  }
});
