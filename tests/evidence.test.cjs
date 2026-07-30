// Stamping pasted-text evidence with the instant the app read it.

const test = require('node:test');
const assert = require('node:assert/strict');

const { stampRetrieval } = require('../src/core/evidence.cjs');

const REFERENCE = 'https://uni.example/phd?lang=nl';
const AT = '2026-07-30T00:01:04.480Z';

const candidateWith = (evidence) => ({
  title: 'A PhD',
  source_url: REFERENCE,
  findings: { institution: { state: 'found', value: ['Uni'], evidence } },
});

test('evidence quoting the pasted text is stamped with when the app read it', () => {
  // The model has no clock, so whatever it writes here is invented. Live, it wrote
  // "unknown (pasted text, no fetch)" – honest, and rejected by validate, which threw away
  // a complete record over a field the model could never have known.
  const stamped = stampRetrieval(
    candidateWith([{ url: REFERENCE, retrieved_at: 'unknown (pasted text, no fetch)', excerpt: 'a quote' }]),
    { reference: REFERENCE, retrievedAt: AT }
  );

  assert.equal(stamped.findings.institution.evidence[0].retrieved_at, AT);
  assert.equal(stamped.findings.institution.evidence[0].excerpt, 'a quote', 'the rest of the evidence changed');
});

test('the reference is matched as a link, not as a string', () => {
  // The model echoes the reference back in whatever shape it likes. Two spellings of one
  // address are one source, and a stamp that missed on punctuation would fail the same way.
  const stamped = stampRetrieval(
    candidateWith([{ url: 'HTTPS://Uni.example/phd/?lang=nl', retrieved_at: 'nope', excerpt: 'a quote' }]),
    { reference: REFERENCE, retrievedAt: AT }
  );

  assert.equal(stamped.findings.institution.evidence[0].retrieved_at, AT);
});

test('evidence from a page the model fetched itself keeps its own timestamp', () => {
  // That one is a real retrieval with a real instant. Overwriting it would replace a fact
  // with our own, which is the invention this whole rule exists to prevent.
  const stamped = stampRetrieval(
    candidateWith([{ url: 'https://elsewhere.example/faq', retrieved_at: '2026-07-30T00:00:21Z', excerpt: 'x' }]),
    { reference: REFERENCE, retrievedAt: AT }
  );

  assert.equal(stamped.findings.institution.evidence[0].retrieved_at, '2026-07-30T00:00:21Z');
});

test('a finding with no evidence survives the stamp', () => {
  const stamped = stampRetrieval(
    { findings: { funding: { state: 'not_stated', value: [], evidence: [] } } },
    { reference: REFERENCE, retrievedAt: AT }
  );

  assert.deepEqual(stamped.findings.funding, { state: 'not_stated', value: [], evidence: [] });
});
