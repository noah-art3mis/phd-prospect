// Fetching a page ourselves: the two decisions, as pure functions.
//
// ADR-0007 gave every fetch to Anthropic's server-side web_fetch so that this app never
// resolved a user-submitted address, which removed SSRF rather than defending against it.
// That property is given up here, narrowly and on purpose: only for the exact address the
// user typed, only after web_fetch has already refused it, and never for an address the
// model chose. Model-chosen fetches stay on Anthropic's infrastructure, which is where the
// prompt-injection-drives-a-fetch risk actually lives.
//
// What is left to defend is one fetch of one address the operator typed. The guard below is
// the whole defence, so it is stated once and tested directly.

// Link-local (the cloud metadata service lives at 169.254.169.254 and hands out the
// instance's credentials), loopback, and the RFC1918 ranges. Checked against the literal in
// the URL and again against every address the fetcher is about to connect to, because a
// public hostname is free to resolve to any of these.
function isPrivateAddress(address) {
  const value = String(address ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');

  if (value === '::1' || value === '::' || value === 'localhost') return true;
  // Unique-local and link-local IPv6.
  if (/^f[cd][0-9a-f]{2}:/.test(value) || /^fe80:/.test(value)) return true;
  // IPv4-mapped IPv6 carries an IPv4 address that must be judged as one.
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]);

  const octets = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!octets) return false;
  const [a, b] = octets.slice(1).map(Number);
  if (a === 0 || a === 127 || a === 10) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
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

module.exports = { isFetchableUrl, isPrivateAddress, pageText };
