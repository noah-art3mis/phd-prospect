// Contract for the fallback fetch – the one place this app connects to an address a person
// gave it. Everything here runs against a stub fetch; nothing reaches the network.

const test = require('node:test');
const assert = require('node:assert/strict');

const { fetchPage, MAX_PAGE_BYTES, FETCH_TIMEOUT_MS } = require('../src/fetch-page.cjs');

const html = (body) => `<html><body><p>${body}</p></body></html>`;

function stub({ status = 200, body = html('An advert'), headers = {}, url } = {}) {
  const calls = [];
  const fetch = async (target, options) => {
    calls.push({ target, options });
    return {
      ok: status >= 200 && status < 300,
      status,
      url: url ?? target,
      headers: { get: (name) => headers[name.toLowerCase()] ?? null },
      text: async () => body,
    };
  };
  return { fetch, calls };
}

// A resolver that answers whatever the test says the hostname resolves to.
const resolves = (address) => async () => [address];

test('a page is fetched and returned as text', async () => {
  const { fetch } = stub({ body: html('PhD in creativity support at Aalborg University') });
  const result = await fetchPage('https://www.linkedin.com/posts/x/', { fetch, resolve: resolves('8.8.8.8') });

  assert.equal(result.ok, true);
  assert.match(result.text, /Aalborg University/);
});

test('it asks like a browser, because that is the difference that made it work', async () => {
  // The same URL that Anthropic's web_fetch refused returns 174 KB to an ordinary client.
  const { fetch, calls } = stub();
  await fetchPage('https://uni.example/phd', { fetch, resolve: resolves('8.8.8.8') });

  assert.match(calls[0].options.headers['user-agent'], /Mozilla/);
  assert.ok(calls[0].options.signal instanceof AbortSignal, 'the fetch was unbounded');
});

test('no credentials are ever sent', async () => {
  // This connects to a stranger's server on the operator's behalf. Nothing of the app's goes
  // with it - no cookies, no authorization, no bot token.
  const { fetch, calls } = stub();
  await fetchPage('https://uni.example/phd', { fetch, resolve: resolves('8.8.8.8') });

  const names = Object.keys(calls[0].options.headers).map((n) => n.toLowerCase());
  for (const forbidden of ['authorization', 'cookie']) {
    assert.ok(!names.includes(forbidden), `${forbidden} was sent`);
  }
  assert.equal(calls[0].options.credentials, 'omit');
});

test('an address the guard refuses is never connected to', async () => {
  const { fetch, calls } = stub();
  const result = await fetchPage('http://169.254.169.254/computeMetadata/v1/', { fetch, resolve: resolves('169.254.169.254') });

  assert.equal(result.ok, false);
  assert.equal(calls.length, 0, 'the request was made anyway');
  assert.match(result.reason, /address/i);
});

test('a public hostname that resolves somewhere private is refused', async () => {
  // The guard on the text alone cannot see this: the name is ordinary and the answer is not.
  const { fetch, calls } = stub();
  const result = await fetchPage('https://evil.example/phd', { fetch, resolve: resolves('169.254.169.254') });

  assert.equal(result.ok, false);
  assert.equal(calls.length, 0, 'the request was made anyway');
});

test('redirects are followed by hand, so every hop is checked', async () => {
  // Left to the fetch implementation, a redirect walks straight past the guard: the first
  // address is public and the second one is the metadata service.
  const seen = [];
  const fetch = async (target) => {
    seen.push(target);
    if (seen.length === 1) {
      return { ok: false, status: 302, url: target, headers: { get: (n) => (n.toLowerCase() === 'location' ? 'http://169.254.169.254/' : null) }, text: async () => '' };
    }
    return { ok: true, status: 200, url: target, headers: { get: () => null }, text: async () => html('x') };
  };

  const result = await fetchPage('https://uni.example/phd', { fetch, resolve: resolves('8.8.8.8') });
  assert.equal(result.ok, false);
  assert.equal(seen.length, 1, 'the redirect was followed to a private address');
  assert.equal(result.redirect, 'manual', 'the fetch must not follow redirects itself');
});

test('a non-HTML response is not passed off as an advert', async () => {
  const { fetch } = stub({ headers: { 'content-type': 'application/pdf' }, body: '%PDF-1.4' });
  const result = await fetchPage('https://uni.example/advert.pdf', { fetch, resolve: resolves('8.8.8.8') });

  assert.equal(result.ok, false);
  assert.match(result.reason, /html/i);
});

test('an error status is a failure, not an empty advert', async () => {
  const { fetch } = stub({ status: 404, body: html('Not found') });
  const result = await fetchPage('https://uni.example/gone', { fetch, resolve: resolves('8.8.8.8') });

  assert.equal(result.ok, false);
  assert.match(result.reason, /404/);
});

test('an oversized page is refused rather than silently truncated into a record', async () => {
  const { fetch } = stub({ headers: { 'content-length': String(MAX_PAGE_BYTES + 1) } });
  const result = await fetchPage('https://uni.example/huge', { fetch, resolve: resolves('8.8.8.8') });

  assert.equal(result.ok, false);
  assert.match(result.reason, /large/i);
});

test('a fetch that throws is reported, not raised at the caller', async () => {
  const fetch = async () => {
    throw new Error('getaddrinfo ENOTFOUND uni.example');
  };
  const result = await fetchPage('https://uni.example/phd', { fetch, resolve: resolves('8.8.8.8') });

  assert.equal(result.ok, false);
  assert.match(result.reason, /ENOTFOUND/);
});

test('the bounds are the ones stated, not whatever the runtime defaults to', async () => {
  assert.equal(FETCH_TIMEOUT_MS, 15_000);
  assert.equal(MAX_PAGE_BYTES, 5 * 1024 * 1024);
});
