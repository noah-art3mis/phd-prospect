// Validation contract for the live n8n "Validate" Code node
// (n8n/code/validate_opportunity.js::normalizeOpportunity).
//
// This was a cross-language contract (Python spec vs JS port) pinned by the shared
// golden cases in tests/golden/normalize_opportunity_cases.json. JS is now the single
// language: the Python mirror (src/prospect/records.py) is retired, so we assert the JS
// implementation against the recorded golden expectations directly. The golden cases
// remain the durable contract — grow them with every new validation rule.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { normalizeOpportunity } = require(path.join(__dirname, '..', 'n8n', 'code', 'validate_opportunity.js'));

const CASES = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'golden', 'normalize_opportunity_cases.json'), 'utf8')
).cases;

function jsVerdict(candidate) {
  try {
    normalizeOpportunity(candidate);
    return 'ok';
  } catch (e) {
    if (e && e.name === 'InvalidRecord') return { invalid: e.message };
    return { error: String((e && e.message) || e) };
  }
}

for (const c of CASES) {
  test('normalize contract: ' + c.name, () => {
    assert.deepEqual(jsVerdict(c.input), c.expect);
  });
}
