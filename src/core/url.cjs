// Stable opportunity identity from a link.
//
// Pure. Canonicalization strips everything that does not change which page a link points
// at – scheme, default ports, host case, duplicated and trailing slashes, the fragment,
// tracking parameters, query order – so the same opportunity shared from two places
// collapses to one key. That key is what the re-submission short-circuit looks up.
//
// There is deliberately no fuzzy cross-source identity beyond this: reject deletes the row,
// so nothing needs to recognise the same opportunity arriving from a different address.

const crypto = require('node:crypto');

const TRACKING_PARAMETERS = new Set(['fbclid', 'gclid', 'mc_cid', 'mc_eid', 'igshid', 'ref_src']);

function isTracking(key) {
  const lower = key.toLowerCase();
  return lower.startsWith('utm_') || TRACKING_PARAMETERS.has(lower);
}

function canonicalizeUrl(url) {
  const raw = String(url == null ? '' : url).trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return raw; // Not a URL we can reason about; the caller's own validation will reject it.
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return raw;

  // http and https of the same page are one opportunity, not two rows firing the same
  // reminder twice, so the scheme is folded rather than preserved.
  const port = parsed.port === '443' ? '' : parsed.port;
  const host = parsed.hostname + (port ? ':' + port : '');
  const path = parsed.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';

  const pairs = [...parsed.searchParams]
    .filter(([key]) => !isTracking(key))
    .sort(([ka, va], [kb, vb]) => (ka < kb ? -1 : ka > kb ? 1 : va < vb ? -1 : va > vb ? 1 : 0));
  const query = new URLSearchParams(pairs).toString();

  return 'https://' + host + path + (query ? '?' + query : '');
}

// A record with no link still needs an identity: it is the primary key of the row, what the
// re-submission short-circuit looks up, and what evidence points at. Pasted text has no
// address, so its identity is derived from the text – the same advert pasted twice is one
// record, and two different adverts are two.
//
// Deliberately not URL-shaped. `paste:` says plainly that there is no page behind this and
// nothing will ever fetch it, where a plausible-looking https address would invite both.
//
// Whitespace is normalised first because a copy-paste rarely repeats byte for byte – a
// trailing newline, a rewrapped line – and identity that moved with those would file the
// same advert twice.
function pasteIdentity(text) {
  const normalized = String(text ?? '').trim().replace(/\s+/g, ' ');
  return 'paste:' + crypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16);
}

// What a submission is filed under. One definition, because the duplicate check and the
// stored source_url have to agree: if they disagreed, a record would be saved under a key
// nothing later looks up.
function submissionIdentity(submission) {
  return submission.url ?? pasteIdentity(submission.text);
}

module.exports = { canonicalizeUrl, pasteIdentity, submissionIdentity };
