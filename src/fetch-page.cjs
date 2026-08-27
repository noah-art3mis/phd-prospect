// Our own fetch: the one place this app connects to an address a person gave it.
//
// It exists because Anthropic's web_fetch refuses some pages that are perfectly readable –
// a LinkedIn post that returned `url_not_allowed` to the model served 174 KB to an ordinary
// client on the first try. When that happens the advert is not gone, it is simply out of
// reach of the fetcher we were using, and asking the user to copy it out by hand is work a
// program should do.
//
// This narrows ADR-0007 rather than reversing it. Fetches the *model* chooses still happen
// entirely on Anthropic's infrastructure, which is where a page saying "now fetch
// http://169.254.169.254/" would be obeyed. What runs here is one fetch of one address the
// operator typed, after the other fetcher failed to read it – whether it refused the address
// or ran out of time trying. The narrowing is the address, not the reason we are here.
//
// The guard is in src/core/page-text.cjs, checked twice: once against the address as written,
// and again against every IP this is about to connect to, since a public hostname is free to
// resolve to the metadata service.

const dns = require('node:dns/promises');

const { isFetchableUrl, isPrivateAddress, isIpLiteral, pageText, plainText } = require('./core/page-text.cjs');

const FETCH_TIMEOUT_MS = 15_000;
const MAX_PAGE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;

// The difference that made this work at all. Sites that serve a crawler nothing serve a
// browser the whole page, and this is a fetch the operator asked for by hand.
const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// One shape, whether or not there was a status. A caller deciding whether a refusal is worth
// trying somewhere else needs the number, and recovering it by matching the prose is how the
// sentence stops being free to improve.
const failed = (reason, status) => ({ ok: false, reason, status, redirect: 'manual' });

// Every address behind a hostname, not just the first: a name that answers with one public
// and one private address would otherwise pass on a coin flip.
async function addressesAreSafe(hostname, resolve) {
  if (isPrivateAddress(hostname)) return false;
  // A literal has already been judged, and asking the resolver about one throws – which is
  // how the fail-open branch below used to wave through `[::ffff:7f00:1]` without anything
  // ever classifying it.
  if (isIpLiteral(hostname)) return true;

  let addresses;
  try {
    addresses = await resolve(hostname);
  } catch {
    // Refusing is the only safe answer. Reading "I could not resolve it" as "then it is
    // fine" hands a free pass to everything the resolver chokes on, and the resolver chokes
    // on more than anyone enumerating cases expects.
    return false;
  }
  // Something has to have been judged. `[].every(...)` is `true`, which would let a name
  // that resolved to nothing through on the strength of having no addresses to object to –
  // the same shape as the catch above, and the reason that one is now a refusal.
  return addresses.length > 0 && addresses.every((address) => !isPrivateAddress(address.address ?? address));
}

async function fetchPage(url, { fetch = globalThis.fetch, resolve = (h) => dns.lookup(h, { all: true }) } = {}) {
  let target = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!isFetchableUrl(target)) return failed(`I will not fetch that address (${target}).`);
    if (!(await addressesAreSafe(new URL(target).hostname, resolve))) {
      return failed(`I will not fetch that address (${target}).`);
    }

    let response;
    try {
      response = await fetch(target, {
        // Followed by hand: left to the runtime, a redirect walks past the guard entirely
        // and the second address is the one nobody checked.
        redirect: 'manual',
        credentials: 'omit',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'user-agent': BROWSER_UA, accept: 'text/html,application/xhtml+xml' },
      });
    } catch (error) {
      return failed(error.message);
    }

    const location = response.headers.get('location');
    if (location && response.status >= 300 && response.status < 400) {
      try {
        target = new URL(location, target).toString();
      } catch {
        // The contract here is an answer, not an exception: this runs unawaited behind a
        // Telegram acknowledgement, and a caller with no try around it is the one who finds
        // out. A Location we cannot parse is a page we cannot follow.
        return failed('that page redirected somewhere I could not read.');
      }
      continue;
    }

    if (!response.ok) return failed(`that page answered ${response.status}.`, response.status);

    const type = response.headers.get('content-type') ?? '';
    if (type && !/html|text\/plain/i.test(type)) {
      return failed(`that page is ${type.split(';')[0]}, not HTML – send it to me as a file instead.`);
    }

    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > MAX_PAGE_BYTES) return failed('that page is too large to read.');

    const body = await response.text();
    if (body.length > MAX_PAGE_BYTES) return failed('that page is too large to read.');

    // What a body is turned into is decided by what the server said it is. The type is
    // known ten lines up and used to be dropped after the check there, leaving the
    // extraction to assume markup – which is wrong for every plain-text document, and this
    // app now asks for documents as plain text on purpose.
    const text = /text\/plain/i.test(type) ? plainText(body) : pageText(body);
    if (!text) return failed('that page had no readable text in it.');
    return { ok: true, text, url: response.url ?? target };
  }

  return failed('that address redirected too many times.');
}

module.exports = { fetchPage, FETCH_TIMEOUT_MS, MAX_PAGE_BYTES, BROWSER_UA };
