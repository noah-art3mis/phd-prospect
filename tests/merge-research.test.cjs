// Contract for the live n8n "Merge research" Code node (n8n/code/merge-research.js).
// Research is read-only enrichment constrained to the requested (missing) fields.
//
// This pins the JS behavior that replaces the retired Python test_research.py::merge_research.
// NOTE ON A DELIBERATE DIVERGENCE: the Python spec RAISED UnexpectedResearchField when the
// model returned a field outside the requested scope. The live JS does not raise — it silently
// DROPS the unrequested field and records it in research_dropped_fields. JS is now the single
// language, so we pin that live drop-and-record behavior directly.

const test = require('node:test');
const assert = require('node:assert/strict');
const { runNodeCode } = require('./js/noderun.cjs');

function runMerge(env, resp) {
  return runNodeCode('merge-research.js', {
    frozenNowUtc: '2026-07-08T00:00:00.000Z',
    mocks: {
      $: (nodeName) => {
        if (nodeName !== 'Build research request') throw new Error('unexpected node: ' + nodeName);
        return { item: { json: env } };
      },
      $json: resp,
    },
  });
}

test('merges only requested fields and drops the rest', () => {
  const env = {
    candidate: {
      title: 'Trustworthy AI PhD',
      source_url: 'https://university.example/phd',
      findings: {
        institution: { state: 'found', value: 'Example University', evidence: [] },
        funding: { state: 'not_stated', value: null, evidence: [] },
      },
    },
    missing_fields: ['funding'],
  };
  const resp = {
    findings: {
      institution: { state: 'found', value: 'Malicious University', evidence: [] },
      funding: { state: 'found', value: 'Fully funded', evidence: [] },
    },
  };
  // Round-trip through JSON: values built inside node:vm carry the sandbox realm's prototypes.
  const out = JSON.parse(JSON.stringify(runMerge(env, resp).json));
  // Requested field is merged in.
  assert.deepEqual(out.candidate.findings.funding, { state: 'found', value: 'Fully funded', evidence: [] });
  // Unrequested field is NOT overwritten and is recorded as dropped.
  assert.equal(out.candidate.findings.institution.value, 'Example University');
  assert.deepEqual(out.research_dropped_fields, ['institution']);
});
