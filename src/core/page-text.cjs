// Fetching a page ourselves: the two decisions, as pure functions.
//
// ADR-0007 gave every fetch to Anthropic's server-side web_fetch so that this app never
// resolved a user-submitted address, which removed SSRF rather than defending against it.
// That property is given up here, narrowly and on purpose: only for the exact address the
// operator typed, and never for an address the model chose. Model-chosen fetches stay on
// Anthropic's infrastructure, which is where the prompt-injection-drives-a-fetch risk lives.
//
// What is left to defend is one fetch of one address the operator typed. The guard below is
// the whole defence, so it is stated once and tested directly – and it is checked again on
// every redirect hop, because the operator's address is free to hand us somebody else's.

const net = require('node:net');

// Everything the fetcher must never connect to, decided against the address itself rather
// than against how it happened to be written.
//
// The predicates this replaces matched regexes over the hostname string, and the encodings a
// URL parser emits are richer than any set of them anticipates. `http://[::ffff:127.0.0.1]/`
// reaches the parser as `[::ffff:7f00:1]` – loopback in hex – and a pattern looking for
// dotted quads walks straight past it. Reproduced against a live server before this changed:
// the dotted form was refused and the hex form returned the body.
//
// net.BlockList compares parsed addresses and maps IPv4-in-IPv6 back to IPv4 before it does,
// so one entry covers every spelling of the range it holds. Names are a different question
// and this cannot answer it: `localhost` is gated here as a convenience, but for any other
// name the real answer comes from resolving it and judging what comes back.
function blockedRanges() {
  const blocked = new net.BlockList();

  blocked.addSubnet('0.0.0.0', 8, 'ipv4'); // "this network"
  blocked.addSubnet('10.0.0.0', 8, 'ipv4'); // RFC1918
  blocked.addSubnet('100.64.0.0', 10, 'ipv4'); // carrier-grade NAT
  blocked.addSubnet('127.0.0.0', 8, 'ipv4'); // loopback
  blocked.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local: the metadata service lives here
  blocked.addSubnet('172.16.0.0', 12, 'ipv4'); // RFC1918
  blocked.addSubnet('192.0.0.0', 24, 'ipv4'); // IETF protocol assignments
  blocked.addSubnet('192.168.0.0', 16, 'ipv4'); // RFC1918
  blocked.addSubnet('198.18.0.0', 15, 'ipv4'); // benchmarking
  blocked.addSubnet('224.0.0.0', 4, 'ipv4'); // multicast
  blocked.addSubnet('240.0.0.0', 4, 'ipv4'); // reserved, and 255.255.255.255 with it

  // ::/96 is the unspecified address, loopback, and IPv4-*compatible* IPv6 in one entry.
  // That last is the parser's other way of handing you an IPv4 address: `[::127.0.0.1]`
  // arrives as `[::7f00:1]`. Deprecated and unroutable, which is not the same as classified.
  blocked.addSubnet('::', 96, 'ipv6');
  blocked.addSubnet('fc00::', 7, 'ipv6'); // unique-local
  blocked.addSubnet('fe80::', 10, 'ipv6'); // link-local – the range runs to febf, not fe80
  blocked.addSubnet('ff00::', 8, 'ipv6'); // multicast, as 224/4 is in the other family

  return blocked;
}

const BLOCKED = blockedRanges();

// Brackets are the URL parser's, not the address's; the trailing dot is the DNS root, and
// `localhost.` is the same host as `localhost`.
function bare(address) {
  return String(address ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

// Whether this is an address at all, rather than a name for one. A name cannot be judged
// here: it is judged after resolution, against every address it answers with.
function isIpLiteral(address) {
  return net.isIP(bare(address)) !== 0;
}

function isPrivateAddress(address) {
  const value = bare(address);
  if (value === 'localhost') return true;
  if (net.isIPv4(value)) return BLOCKED.check(value, 'ipv4');
  if (net.isIPv6(value)) return BLOCKED.check(value, 'ipv6');
  // A hostname. Not private in itself, and not this function's question.
  return false;
}

function isFetchableUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url ?? ''));
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  // A password in an advert link is never intentional, and this fetch would forward it.
  if (parsed.username || parsed.password) return false;
  if (!parsed.hostname) return false;
  return !isPrivateAddress(parsed.hostname);
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&(\w+);/g, (match, name) => ENTITIES[name.toLowerCase()] ?? match);
}

// Markup to prose. Not a parser and not trying to be: what the model needs is the words, and
// what it must not be charged for is the scripts, the styles, and the tag soup around them.
//
// The cap is the cost control. A LinkedIn post is 170 KB of page for two paragraphs of
// advert, and every character of it would otherwise be billed as input.
function pageText(html, { maxChars = 20_000 } = {}) {
  const stripped = String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, '')
    // Block-level boundaries become newlines, so paragraphs do not run together into one
    // sentence that says something neither of them did.
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote)\s*>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  const text = decodeEntities(stripped)
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text.length > maxChars ? text.slice(0, maxChars).trimEnd() : text;
}

module.exports = { isFetchableUrl, isPrivateAddress, isIpLiteral, pageText };
