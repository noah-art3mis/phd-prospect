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

const { isFetchableUrl, isPrivateAddress, pageText, plainText } = require('../src/core/page-text.cjs');

const LINKEDIN = fs.readFileSync(path.join(__dirname, 'fixtures', 'linkedin-post.html'), 'utf8');
// Both captured 27 Aug 2026 from the document behind record #10, the DSSG call. The page
// had its script and style bodies emptied – pageText discards those – so every character
// that reaches the extracted text is the one the live page served.
const DOC_PAGE = fs.readFileSync(path.join(__dirname, 'fixtures', 'google-doc-page.html'), 'utf8');
const DOC_EXPORT = fs.readFileSync(path.join(__dirname, 'fixtures', 'google-doc-export.txt'), 'utf8');

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

// --- the address itself, not how it was written -------------------------------------------
//
// Reproduced against fetchPage as shipped: `http://[::ffff:127.0.0.1]:8731/` returned the
// body of a local server while `http://127.0.0.1:8731/` was refused. The URL parser
// normalises that hostname to `[::ffff:7f00:1]` – loopback in hex – and a predicate looking
// for dotted quads walks straight past it. One address, several spellings, and the guard
// only ever knew one of them.

test('a private address is refused however the URL parser spells it', () => {
  const shouldRefuse = [
    // Loopback, wearing every hat the parser hands out.
    '127.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '[::ffff:7f00:1]',
    // The metadata service, which hands out the instance's credentials.
    '169.254.169.254',
    '::ffff:169.254.169.254',
    '::ffff:a9fe:a9fe',
    // Link-local is fe80::/10 – it does not stop at fe80.
    'fe80::1',
    'fe9f::1',
    'febf::1',
    // The parser's other way of handing you an IPv4 address: `::127.0.0.1` arrives as
    // `[::7f00:1]`. Deprecated and unroutable, which is not the same as classified.
    '::127.0.0.1',
    '::7f00:1',
    '::169.254.169.254',
    '::a9fe:a9fe',
    // Multicast, in both families rather than only the one the old predicates knew.
    'ff02::1',
    // RFC1918, unique-local, carrier-grade NAT, multicast, reserved, broadcast.
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.1',
    'fd00::1',
    'fc00::1',
    '100.64.0.1',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
    '0.0.0.0',
    'localhost',
    // A fully-qualified name for the same thing. Resolution catches it, but the synchronous
    // half of the guard is exported and called on its own.
    'localhost.',
  ];

  for (const address of shouldRefuse) {
    assert.equal(isPrivateAddress(address), true, `${address} was treated as safe to connect to`);
  }
});

test('an ordinary public address is still fetchable, in either family', () => {
  for (const address of ['8.8.8.8', '93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946', '172.32.0.1', '100.63.255.255']) {
    assert.equal(isPrivateAddress(address), false, `${address} was refused`);
  }
});

test('a hostname is not an address, so it is left for the resolver to answer', () => {
  // The literal check cannot decide a name; every address behind it is checked after lookup.
  for (const host of ['uni.example', 'www.linkedin.com', 'not-an-ip']) {
    assert.equal(isPrivateAddress(host), false);
  }
});

test('a mapped-address URL is refused by the same check the fetcher runs first', () => {
  assert.equal(isFetchableUrl('http://[::ffff:127.0.0.1]:8731/'), false);
  assert.equal(isFetchableUrl('http://[::ffff:169.254.169.254]/latest/meta-data/'), false);
  assert.equal(isFetchableUrl('http://[fe9f::1]/'), false);
  assert.equal(isFetchableUrl('http://100.64.0.1/'), false);
});

// --- a page that is a program, and a body that is already prose --------------------------

test("a Google Doc's own page yields its menu bar, and not a word of the advert", () => {
  // 417 KB of HTML in, and what comes out is the interface: the document is drawn by script
  // nothing here runs. This is what record #10 was read from, and why it was tracked with no
  // deadline one day before it closed.
  const text = pageText(DOC_PAGE);

  assert.match(text, /Compartilhar/, 'this is not the page that was captured');
  assert.doesNotMatch(text, /candidatura/i, 'the document body was in the HTML after all');
  assert.ok(text.length < 300, `the interface alone came to ${text.length} characters`);
});

test('the same document, asked for as text, arrives whole', () => {
  const text = plainText(DOC_EXPORT);

  assert.match(text, /O período de candidaturas vai estar aberto até 28 de Agosto/);
  assert.ok(text.length > 4000, `only ${text.length} characters survived`);
});

test('prose keeps the characters a markup stripper would eat', () => {
  // Constructed, because the DSSG document happens to contain no angle brackets at all –
  // which is exactly why reading it live proved nothing about this. In an advert `<` is a
  // bound and `>` is a bound, and everything between one and the next is not a tag.
  const body = [
    'Elegibilidade: idade < 30 anos.',
    'O período de candidaturas vai estar aberto até 28 de Agosto.',
    'Bolsa mensal > 1.200 EUR.',
    'Contacto: <dssg@nova.pt>',
  ].join('\n\n');

  const text = plainText(body);

  assert.match(text, /28 de Agosto/, 'the deadline was deleted as if it were inside a tag');
  assert.match(text, /idade < 30 anos/);
  assert.match(text, /1\.200 EUR/);
  assert.match(text, /dssg@nova\.pt/);
});

test('prose is capped too, because a document is billed by the token', () => {
  const text = plainText('word '.repeat(50_000), { maxChars: 1000 });
  assert.ok(text.length <= 1000, `got ${text.length}`);
  assert.ok(text.length > 900, `the cap took the document with it: ${text.length}`);
});

test('carriage returns do not survive, and do not stop blank lines collapsing', () => {
  // The Google Docs export is CRLF, and `\n{3,}` cannot match across a `\r\n` – so runs of
  // blank lines walk straight through the collapse that exists to stop layout becoming
  // tokens, and the carriage returns themselves are billed as well.
  const text = plainText(DOC_EXPORT);

  assert.doesNotMatch(text, /\r/, 'carriage returns reached the model');
  assert.doesNotMatch(text, /\n{3,}/, 'a run of blank lines survived the collapse');
});
