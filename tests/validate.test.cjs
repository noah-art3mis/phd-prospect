// Golden contract for the deterministic validate() seam.
//
// This is the highest-value seam in the app: a candidate record goes in, an accepted
// record or an InvalidRecord comes out, with no clock, environment or network involved.
// The golden cases in tests/golden/normalize_opportunity_cases.json are the durable
// contract — every new validation rule earns a case there.

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
