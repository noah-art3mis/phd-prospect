// Identity contract for the live n8n "Validate" Code node: canonicalizeUrl and
// opportunityFingerprint (n8n/code/validate_opportunity.js), plus the SSRF guard
// validatePublicUrl.
//
// Formerly a cross-language contract against src/prospect/identity.py; JS is now the
// single language, so the golden cases in tests/golden/identity_cases.json are asserted
// directly against the JS implementation. The validatePublicUrl cases below were ported
// from the retired Python test_identity.py to keep the SSRF-rejection contract covered.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { canonicalizeUrl, opportunityFingerprint, validatePublicUrl } = require(
  path.join(__dirname, '..', 'n8n', 'code', 'validate_opportunity.js')
);

const CASES = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden', 'identity_cases.json'), 'utf8'));

for (const c of CASES.canonicalize) {
  test('canonicalize: ' + c.name, () => {
    assert.equal(canonicalizeUrl(c.input), c.expect);
  });
}

for (const c of CASES.fingerprint) {
  test('fingerprint: ' + c.name, () => {
    assert.equal(opportunityFingerprint(c.input), c.expect);
  });
}

test('validatePublicUrl rejects private-network and credentialed targets', () => {
  for (const unsafe of [
    'http://127.0.0.1/admin',
    'http://192.168.1.10/phd',
    'http://169.254.169.254/latest/meta-data',
    'http://localhost:5678/rest/credentials',
    'https://user:password@university.example/phd',
  ]) {
    assert.throws(() => validatePublicUrl(unsafe), undefined, 'accepted unsafe url: ' + unsafe);
  }
});

test('validatePublicUrl rejects malformed and non-standard ports', () => {
  for (const unsafe of [
    'https://university.example:not-a-port/phd',
    'https://university.example:8443/phd',
  ]) {
    assert.throws(() => validatePublicUrl(unsafe), undefined, 'accepted unsafe url: ' + unsafe);
  }
});

test('validatePublicUrl accepts a plain public https url', () => {
  assert.doesNotThrow(() => validatePublicUrl('https://university.example/phd'));
});
