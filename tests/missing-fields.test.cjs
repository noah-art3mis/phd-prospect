// Contract for the shared missing-fields module (n8n/code/missing_fields.js), inlined into
// "Parse extraction" and "Rebuild pending request". A critical field is complete only in the
// `found` / `not_applicable` states; every other state — and an absent finding — keeps it on
// the research list.
//
// Absorbs the retired Python test_research.py::research_gaps case: the same
// missing-or-uncertain-required-field selection is exactly what computeMissingFields does.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { computeMissingFields, REQUIRED_FIELDS } = require(
  path.join(__dirname, '..', 'n8n', 'code', 'missing_fields.js')
);

const finding = (state) => ({ state, value: null, evidence: [] });

test('complete states are not missing', () => {
  const missing = computeMissingFields({
    title: 'x',
    findings: { institution: finding('found'), start_date: finding('not_applicable') },
  });
  assert.ok(!missing.includes('institution'));
  assert.ok(!missing.includes('start_date'));
});

test('incomplete states and absent findings are missing', () => {
  const missing = computeMissingFields({
    title: 'x',
    findings: {
      funding: finding('not_stated'),
      eligibility: finding('needs_confirmation'),
      deadlines: finding('conflicting_sources'),
    },
  });
  for (const f of ['funding', 'eligibility', 'deadlines']) assert.ok(missing.includes(f));
  assert.ok(missing.includes('required_documents'));
  assert.ok(missing.includes('supervisors'));
});

test('empty candidate reports every required field, deterministically ordered', () => {
  const missing = computeMissingFields({});
  assert.deepEqual(missing, computeMissingFields({ findings: {} }));
  assert.equal(missing.length, 13);
  assert.equal(missing.length, REQUIRED_FIELDS.length);
  assert.equal(missing[0], 'institution');
});

test('research targets only missing or uncertain required fields (research_gaps parity)', () => {
  // Ported from the retired Python test_research.py: found/not_applicable are complete,
  // not_stated/needs_confirmation and absent fields are gaps.
  const candidate = {
    title: 'Trustworthy AI PhD',
    findings: {
      institution: { state: 'found', value: 'Example University', evidence: [] },
      funding: { state: 'not_stated', value: null, evidence: [] },
      eligibility: { state: 'needs_confirmation', value: null, evidence: [] },
      start_date: { state: 'not_applicable', value: null, evidence: [] },
    },
  };
  const missing = computeMissingFields(candidate);
  assert.ok(!missing.includes('institution'));
  assert.ok(!missing.includes('start_date'));
  assert.ok(missing.includes('funding'));
  assert.ok(missing.includes('eligibility'));
  assert.ok(missing.includes('deadlines'));
});
