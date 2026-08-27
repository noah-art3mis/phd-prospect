// Contract for the app's own fetch – the one place this app connects to an address a person
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

// --- the guard, at the edge it actually defends --------------------------------------------

test('a hostname that will not resolve is refused, not fetched', async () => {
  // The failure this closes: `dns.lookup` throws on a bracketed literal, and answering
  // "could not resolve, so it must be fine" meant anything the resolver choked on was
  // fetched unchecked. That is how a mapped loopback address reached a live server.
  const { fetch, calls } = stub();
  const result = await fetchPage('https://uni.example/phd', {
    fetch,
    resolve: async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }); },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(calls, [], 'a request went out for an address nothing had checked');
});

test('a loopback address written as a mapped IPv6 literal never reaches fetch', async () => {
  const { fetch, calls } = stub();
  const result = await fetchPage('http://[::ffff:127.0.0.1]:8731/', { fetch, resolve: resolves('8.8.8.8') });

  assert.equal(result.ok, false);
  assert.match(result.reason, /will not fetch/i);
  assert.deepEqual(calls, [], 'the request went out anyway');
});

test('a redirect into a private range is refused on the hop, not on the first address', async () => {
  // The operator never types the odd address. An advert page we do not control answers 302.
  let hop = 0;
  const fetch = async (target) => {
    hop += 1;
    if (hop === 1) {
      return { ok: false, status: 302, url: target, headers: { get: (n) => (n.toLowerCase() === 'location' ? 'http://[::ffff:169.254.169.254]/latest/meta-data/' : null) }, text: async () => '' };
    }
    throw new Error('the second hop was attempted');
  };

  const result = await fetchPage('https://advert.example/phd', { fetch, resolve: resolves('8.8.8.8') });
  assert.equal(result.ok, false);
  assert.match(result.reason, /will not fetch/i);
  assert.equal(hop, 1, 'the redirect target was fetched');
});

test('a hostname that resolves to nothing at all is refused', async () => {
  // The same shape as the fail-open catch this guard replaced: `[].every(safe)` is `true`,
  // so an empty answer reads as "every address is fine" and the connection goes ahead
  // having classified nothing.
  const { fetch, calls } = stub();
  const result = await fetchPage('https://uni.example/phd', { fetch, resolve: async () => [] });

  assert.equal(result.ok, false);
  assert.deepEqual(calls, [], 'a request went out for a name nothing had been judged for');
});

test('a name answering with one public and one private address is refused', async () => {
  const { fetch, calls } = stub();
  const result = await fetchPage('https://uni.example/phd', {
    fetch,
    resolve: async () => [{ address: '8.8.8.8' }, { address: '169.254.169.254' }],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(calls, [], 'the public answer was enough to let it through');
});

test('a public IPv6 literal is still fetchable, which is what the literal short-circuit is for', async () => {
  // Load-bearing coupling, and the reason the two halves of this guard ship together: the
  // real `dns.lookup` throws ENOTFOUND on a bracketed literal, so once an unresolvable name
  // became a refusal, every bracketed public address would have become one too. The stub
  // throws the way the resolver does rather than being the resolver – this file reaches no
  // network, and a test that did would fail on a train.
  const { fetch } = stub();
  const result = await fetchPage('http://[2001:4860:4860::8888]/phd', {
    fetch,
    resolve: async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }); },
  });

  assert.equal(result.ok, true, 'a public address was refused because the resolver cannot parse a literal');
});

test('a malformed redirect target is reported, not thrown', async () => {
  // fetchPage's contract is that it answers {ok:false}; an exception escaping it lands in a
  // caller with no try around it.
  const fetch = async (target) => ({
    ok: false,
    status: 302,
    url: target,
    headers: { get: (n) => (n.toLowerCase() === 'location' ? 'http://[bad' : null) },
    text: async () => '',
  });

  const result = await fetchPage('https://advert.example/phd', { fetch, resolve: resolves('8.8.8.8') });
  assert.equal(result.ok, false);
});

test('a page that answered with a status hands the status on, not only the sentence', async () => {
  // Whether a refusal is worth trying somewhere else is the caller's decision, and 403 and
  // 503 are different answers to it. Recovering the number by matching the prose is how the
  // sentence stops being free to improve.
  const { fetch } = stub({ status: 403 });
  const result = await fetchPage('https://docs.google.com/document/d/abc/export?format=txt', {
    fetch,
    resolve: resolves('8.8.8.8'),
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.match(result.reason, /403/);
});

test('what a body is turned into is decided by what the server said it is', async () => {
  // The Google Doc export answers text/plain, and this is the one submission type the
  // rewrite exists to serve. Run through the markup stripper, every run from a `<` to the
  // next `>` goes as if it were a tag – so an eligibility bound takes the deadline three
  // lines below it, and the record comes back looking merely incomplete.
  const body = [
    'Elegibilidade: idade < 30 anos.',
    'O período de candidaturas vai estar aberto até 28 de Agosto.',
    'Bolsa mensal > 1.200 EUR.',
  ].join('\n\n');
  const { fetch } = stub({ body, headers: { 'content-type': 'text/plain; charset=utf-8' } });

  const result = await fetchPage('https://docs.google.com/document/d/abc/export?format=txt', {
    fetch,
    resolve: resolves('8.8.8.8'),
  });

  assert.match(result.text, /28 de Agosto/, 'the deadline was stripped as if it were a tag');
  assert.match(result.text, /idade < 30 anos/);
});
