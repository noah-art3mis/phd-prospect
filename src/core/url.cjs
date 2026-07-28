// Stable opportunity identity from a link.
//
// Pure. Canonicalization strips everything that does not change which page a link points
// at — scheme, default ports, host case, duplicated and trailing slashes, the fragment,
// tracking parameters, query order — so the same opportunity shared from two places
// collapses to one key. That key is what the re-submission short-circuit looks up.
//
// `opportunityFingerprint` from the n8n build is deliberately not ported: reject deletes
// the row, so cross-source identity has no consumer.

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

module.exports = { canonicalizeUrl };
