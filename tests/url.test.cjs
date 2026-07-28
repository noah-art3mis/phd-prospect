// Golden contract for URL canonicalization — the key the re-submission short-circuit
// looks up. Two links a person would call "the same page" must canonicalize identically.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { canonicalizeUrl } = require('../src/core/url.cjs');

const CASES = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'golden', 'canonical_url_cases.json'), 'utf8')
).cases;

for (const c of CASES) {
  test('canonicalize contract: ' + c.name, () => {
    assert.equal(canonicalizeUrl(c.input), c.expect);
  });
}

const SAME = [
  ['tracking parameters', 'https://uni.example/phd?utm_source=twitter&utm_campaign=x'],
  ['a trailing slash', 'https://uni.example/phd/'],
  ['a mixed-case host', 'https://UNI.EXAMPLE/phd'],
  ['a default port', 'https://uni.example:443/phd'],
  ['a fragment', 'https://uni.example/phd#apply'],
  ['duplicated slashes', 'https://uni.example//phd'],
  ['the scheme', 'http://uni.example/phd'],
  ['surrounding whitespace', '  https://uni.example/phd  '],
];

for (const [what, url] of SAME) {
  test(`a URL differing only by ${what} is the same opportunity`, () => {
    assert.equal(canonicalizeUrl(url), canonicalizeUrl('https://uni.example/phd'));
  });
}

test('a different path is a different opportunity', () => {
  assert.notEqual(canonicalizeUrl('https://uni.example/phd-2'), canonicalizeUrl('https://uni.example/phd'));
});

test('a meaningful query parameter is kept, and its order does not matter', () => {
  assert.equal(
    canonicalizeUrl('https://uni.example/jobs?id=42&dept=cs'),
    canonicalizeUrl('https://uni.example/jobs?dept=cs&id=42')
  );
  assert.notEqual(
    canonicalizeUrl('https://uni.example/jobs?id=42'),
    canonicalizeUrl('https://uni.example/jobs?id=43')
  );
});
