// Runs the shared identity golden cases through the JS port and prints results as JSON.
// Consumed by tests/test_contract_identity.py, which asserts these match both the Python
// spec (identity.py) and the recorded expectations. Not a standalone test.
//
// Usage: node tests/js/run_identity_contract.cjs <path-to-identity_cases.json>

const fs = require('fs');
const path = require('path');

const { canonicalizeUrl, opportunityFingerprint } = require(path.join(__dirname, '..', '..', 'n8n', 'code', 'validate_opportunity.js'));

const casesPath = process.argv[2];
if (!casesPath) {
  console.error('usage: node run_identity_contract.cjs <identity_cases.json>');
  process.exit(2);
}

const data = JSON.parse(fs.readFileSync(casesPath, 'utf8'));
const out = {
  canonicalize: data.canonicalize.map((c) => ({ name: c.name, result: canonicalizeUrl(c.input) })),
  fingerprint: data.fingerprint.map((c) => ({ name: c.name, result: opportunityFingerprint(c.input) })),
};

process.stdout.write(JSON.stringify(out));
