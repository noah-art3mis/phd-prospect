// Contract for the two pure halves of fetching a page ourselves: deciding whether an address
// may be fetched at all, and turning the bytes that come back into something readable.
//
// The app not fetching user-submitted URLs was a deliberate property (ADR-0007). It is being
// given up narrowly – only for the exact address the user typed, only after Anthropic's own
// web_fetch has refused it – so the guard is the part that has to be exact.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { isFetchableUrl, isPrivateAddress, pageText } = require('../src/core/page-text.cjs');

const LINKEDIN = fs.readFileSync(path.join(__dirname, 'fixtures', 'linkedin-post.html'), 'utf8');

// --- what may be fetched ----------------------------------------------------------------

test('ordinary web addresses are fetchable', () => {
  for (const url of [
    'https://www.linkedin.com/posts/someone_phd-share-123/',
    'http://uni.example/phd',
    'https://uni.example:8443/phd',
  ]) {
    assert.equal(isFetchableUrl(url), true, url);
  }
});

test('anything that is not http or https is refused', () => {
  // The submitted string reaches this from a Telegram message. `file:` would read the disk
  // the app runs on and `gopher:`/`ftp:` are protocol-smuggling classics.
  for (const url of ['file:///etc/passwd', 'ftp://uni.example/x', 'gopher://uni.example/', 'data:text/html,x']) {
    assert.equal(isFetchableUrl(url), false, url);
  }
});

test('addresses that point back at the host or its network are refused', () => {
  // The reason ADR-0007 gave the fetching to someone else. The app runs on a cloud instance
  // whose metadata service answers on a link-local address and hands out credentials.
  for (const url of [
    'http://169.254.169.254/computeMetadata/v1/',
    'http://127.0.0.1:8080/',
    'http://localhost/',
    'http://[::1]/',
    'http://10.1.2.3/',
    'http://192.168.0.1/',
    'http://172.16.0.1/',
    'http://0.0.0.0/',
  ]) {
    assert.equal(isFetchableUrl(url), false, url);
  }
});

test('credentials in the address are refused', () => {
  // A URL that carries a password is not an advert, and forwarding one to a third party is
  // the kind of mistake that is only noticed afterwards.
  assert.equal(isFetchableUrl('https://user:secret@uni.example/phd'), false);
});

test('the address check works on resolved addresses too, not only on what was typed', () => {
  // A hostname that resolves to a private address defeats a check on the text alone, so the
  // fetcher re-asks this about every IP it is about to connect to.
  assert.equal(isPrivateAddress('169.254.169.254'), true);
  assert.equal(isPrivateAddress('127.0.0.1'), true);
  assert.equal(isPrivateAddress('::1'), true);
  assert.equal(isPrivateAddress('fd00::1'), true);
  assert.equal(isPrivateAddress('10.0.0.1'), true);
  assert.equal(isPrivateAddress('172.31.255.255'), true);
  assert.equal(isPrivateAddress('172.32.0.1'), false);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  assert.equal(isPrivateAddress('2606:4700::1111'), false);
});

// --- turning a page into text -----------------------------------------------------------

test('the advert text is recovered from a real LinkedIn post', () => {
  const text = pageText(LINKEDIN);

  assert.match(text, /talented PhD candidate/);
  assert.match(text, /Aalborg University/);
  assert.match(text, /three-year fully funded/i);
});

test('scripts and styles do not reach the model', () => {
  // Their content is not prose, it is the bulk of the bytes, and it is billed by the token.
  const text = pageText(LINKEDIN);

  assert.ok(!text.includes('window.__data'), 'script body survived');
  assert.ok(!text.includes('color:red'), 'stylesheet survived');
  assert.ok(!/<[a-z]/i.test(text), 'markup survived');
});

test('entities are decoded, so the excerpt rule can match what a reader sees', () => {
  // Evidence excerpts must appear verbatim in the source. If the text says `&amp;` where the
  // page says `&`, every quote drawn from it fails validation.
  assert.equal(pageText('<p>Design &amp; Creativity &#8211; 3&nbsp;years</p>').replace(/\s+/g, ' '), 'Design & Creativity – 3 years');
});

test('runs of whitespace collapse, so layout does not become tokens', () => {
  assert.equal(pageText('<div>a</div>\n\n\n   <div>b</div>'), 'a\n\nb');
});

test('the text is capped, because a page is billed by the token', () => {
  const huge = '<p>' + 'word '.repeat(50_000) + '</p>';
  const text = pageText(huge, { maxChars: 1000 });
  assert.ok(text.length <= 1000, `got ${text.length}`);
});
