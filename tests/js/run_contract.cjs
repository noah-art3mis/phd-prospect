// Runs every shared golden case through the JS port and prints a verdict array as JSON.
// Consumed by tests/test_contract_normalize.py, which asserts these verdicts match both the
// Python spec and the recorded expectations. Not a standalone test — it has no assertions.
//
// Usage: node tests/js/run_contract.cjs <path-to-cases.json>

const fs = require('fs');
const path = require('path');

const { normalizeOpportunity } = require(path.join(__dirname, '..', '..', 'n8n', 'code', 'validate_opportunity.js'));

const casesPath = process.argv[2];
if (!casesPath) {
  console.error('usage: node run_contract.cjs <cases.json>');
  process.exit(2);
}

const data = JSON.parse(fs.readFileSync(casesPath, 'utf8'));
const verdicts = data.cases.map((c) => {
  try {
    normalizeOpportunity(c.input);
    return { name: c.name, verdict: 'ok' };
  } catch (e) {
    if (e && e.name === 'InvalidRecord') {
      return { name: c.name, verdict: { invalid: e.message } };
    }
    // A non-InvalidRecord error is a port bug (e.g. a crash), not a rejection — surface it.
    return { name: c.name, verdict: { error: String((e && e.message) || e) } };
  }
});

process.stdout.write(JSON.stringify(verdicts));
