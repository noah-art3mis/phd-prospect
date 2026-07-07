// Deterministic validation for the Prospect ingest pipeline — the JS port of
// src/prospect/records.py::normalize_opportunity (+ identity.py::validate_public_url).
//
// This is the ONE tracked source for the validation logic that the n8n "Validate"
// Code node embeds. n8n Cloud CE cannot run the Python package, so the contract is
// re-implemented here and pinned against the Python spec by tests/test_contract_normalize.py
// (which drives this file through tests/js/run_contract.cjs over the shared golden cases).
// If this and normalize_opportunity ever disagree, CI goes red.
//
// n8n Code-node sandbox constraints (see docs/HANDOFF-step5.md): no `require`, no WHATWG
// `URL`. Only Date/Set/JSON/RegExp are available. Keep this file inside that subset so its
// function bodies can be pasted verbatim into the Code node. The `module.exports` footer is
// guarded so it is inert in the sandbox (where `module` is undefined) but usable under Node.

var CRITICAL_FINDINGS = ['deadlines', 'funding', 'eligibility', 'required_documents'];
var KNOWLEDGE_STATES = ['found', 'not_stated', 'not_applicable', 'conflicting_sources', 'needs_confirmation'];

// InvalidRecord mirrors records.InvalidRecord: candidate data that cannot be persisted.
function InvalidRecord(message) {
  var err = new Error(message);
  err.name = 'InvalidRecord';
  return err;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEmptyValue(value) {
  // Mirrors Python `value in (None, "", [])`: None/"" /[] are empty; 0 and {} are not.
  return value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
}

// Mirror of ipaddress.ip_address(host).is_global == False for IPv4 literals: the private
// and reserved ranges that must never be fetched. IPv6 literals are not reachable through
// the shared regex parser (same limitation as the live auth node) — a documented gap.
function isNonGlobalIpv4(host) {
  var m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null; // not an IPv4 literal — caller treats as a domain name
  var octets = [+m[1], +m[2], +m[3], +m[4]];
  for (var i = 0; i < 4; i++) {
    if (octets[i] > 255) return null; // not a valid IPv4 literal
  }
  var n = ((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3];
  function inRange(cidr, bits) { return (n >>> (32 - bits)) === (cidr >>> (32 - bits)); }
  var ranges = [
    [0x00000000, 8],   // 0.0.0.0/8       this-network
    [0x0A000000, 8],   // 10.0.0.0/8      private
    [0x64400000, 10],  // 100.64.0.0/10   shared/CGNAT
    [0x7F000000, 8],   // 127.0.0.0/8     loopback
    [0xA9FE0000, 16],  // 169.254.0.0/16  link-local
    [0xAC100000, 12],  // 172.16.0.0/12   private
    [0xC0000000, 24],  // 192.0.0.0/24    IETF protocol assignments
    [0xC0000200, 24],  // 192.0.2.0/24    documentation
    [0xC0A80000, 16],  // 192.168.0.0/16  private
    [0xC6120000, 15],  // 198.18.0.0/15   benchmarking
    [0xC6336400, 24],  // 198.51.100.0/24 documentation
    [0xCB007100, 24],  // 203.0.113.0/24  documentation
    [0xE0000000, 4],   // 224.0.0.0/4     multicast
    [0xF0000000, 4]    // 240.0.0.0/4     reserved (incl. 255.255.255.255)
  ];
  for (var r = 0; r < ranges.length; r++) {
    if (inRange(ranges[r][0], ranges[r][1])) return true;
  }
  return false;
}

// Port of identity.validate_public_url. Throws on any SSRF-shaped URL; message text is
// internal (callers wrap it into the coarse InvalidRecord messages the contract asserts).
function validatePublicUrl(url) {
  var parts = String(url).match(/^(https?):\/\/(?:([^@/?#]*)@)?([^:/?#]+)(?::(\d+))?([/?#]|$)/i);
  if (!parts) throw new Error('source URL must use http or https');
  var scheme = parts[1].toLowerCase();
  var userinfo = parts[2];
  var host = parts[3].toLowerCase().replace(/\.$/, '');
  var port = parts[4] || '';
  if (scheme !== 'http' && scheme !== 'https') throw new Error('source URL must use http or https');
  if (userinfo) throw new Error('source URL cannot contain credentials');
  if (port !== '' && port !== '80' && port !== '443') throw new Error('source URL cannot use a non-standard port');
  // Only ASCII LDH hosts, so a WHATWG URL parser cannot resolve a different host than validated.
  if (!host || !/^[a-z0-9.-]+$/.test(host)) throw new Error('source URL host is not a public hostname');
  if (host.charAt(0) === '.' || host.indexOf('..') !== -1) throw new Error('source URL host is malformed');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('source URL cannot target a local hostname');
  }
  // Any host whose final label is numeric or hex is an IP literal in some notation; allow only a
  // canonical global dotted quad, reject every other numeric form an HTTP client would expand.
  var lastLabel = host.split('.').pop();
  if (/^(0x[0-9a-f]+|[0-9]+)$/.test(lastLabel)) {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) throw new Error('source URL cannot target an obfuscated IP address');
    if (isNonGlobalIpv4(host) !== false) throw new Error('source URL cannot target a non-public address');
  }
}

// Strict ISO-8601 parse mirroring datetime.fromisoformat + a utcoffset()-is-None check.
// Returns {valid, hasOffset}; rejects impossible calendar dates so a bare regex can't pass
// what Python's fromisoformat would reject.
function parseIsoInstant(value) {
  var m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (!m) return { valid: false, hasOffset: false };
  var year = +m[1], month = +m[2], day = +m[3], hour = +m[4], minute = +m[5], second = m[6] ? +m[6] : 0;
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) {
    return { valid: false, hasOffset: false };
  }
  var leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  var daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (day > daysInMonth) return { valid: false, hasOffset: false };
  return { valid: true, hasOffset: !!m[7] };
}

function validateEvidence(name, evidence) {
  if (!isPlainObject(evidence)) throw InvalidRecord("finding '" + name + "' has malformed evidence");
  try {
    validatePublicUrl(evidence.url);
  } catch (e) {
    throw InvalidRecord("finding '" + name + "' has evidence with an invalid url");
  }
  var parsed = parseIsoInstant(evidence.retrieved_at);
  if (!parsed.valid) throw InvalidRecord("finding '" + name + "' has evidence with an invalid retrieved_at");
  if (!parsed.hasOffset) throw InvalidRecord("finding '" + name + "' retrieved_at must include a UTC offset");
  if (!String(evidence.excerpt == null ? '' : evidence.excerpt).trim()) {
    throw InvalidRecord("finding '" + name + "' has evidence without an excerpt");
  }
}

// Port of records.normalize_opportunity. Returns a persistence-safe clone or throws InvalidRecord.
function normalizeOpportunity(candidate) {
  var normalized = JSON.parse(JSON.stringify(candidate));
  if (!String(normalized.title == null ? '' : normalized.title).trim()) {
    throw InvalidRecord('opportunity requires a title');
  }
  try {
    validatePublicUrl(normalized.source_url);
  } catch (e) {
    throw InvalidRecord('opportunity requires an http or https source_url');
  }
  var findings = normalized.findings || {};
  if (!isPlainObject(findings)) throw InvalidRecord('opportunity findings must be an object');
  var names = Object.keys(findings);
  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    var finding = findings[name];
    if (!isPlainObject(finding)) throw InvalidRecord("finding '" + name + "' must be an object");
    var state = finding.state;
    if (KNOWLEDGE_STATES.indexOf(state) === -1) {
      throw InvalidRecord("finding '" + name + "' has unknown state '" + state + "'");
    }
    var evidenceItems = finding.evidence === undefined ? [] : finding.evidence;
    if (!Array.isArray(evidenceItems)) throw InvalidRecord("finding '" + name + "' evidence must be a list");
    if (state === 'found' && isEmptyValue(finding.value)) {
      throw InvalidRecord("finding '" + name + "' marked found without a value");
    }
    if (CRITICAL_FINDINGS.indexOf(name) !== -1 && state === 'found' && evidenceItems.length === 0) {
      throw InvalidRecord("critical finding '" + name + "' requires evidence");
    }
    if (state === 'conflicting_sources' && evidenceItems.length < 2) {
      throw InvalidRecord("finding '" + name + "' marked conflicting with fewer than two sources");
    }
    for (var j = 0; j < evidenceItems.length; j++) {
      validateEvidence(name, evidenceItems[j]);
    }
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Stable opportunity identity — the JS port of src/prospect/identity.py's
// canonicalize_url and opportunity_fingerprint. Pinned to the Python spec by
// tests/test_contract_identity.py over tests/golden/identity_cases.json.
// ---------------------------------------------------------------------------

var TRACKING_PARAMETERS = ['fbclid', 'gclid', 'mc_cid', 'mc_eid'];

// Split a URL into the parts canonicalize_url needs. Mirrors urlsplit closely
// enough for http(s) inputs; the fragment is dropped, credentials are ignored.
function splitUrlParts(url) {
  var m = String(url).trim().match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(?:[^@/?#]*@)?([^:/?#]*)(?::(\d+))?([^?#]*)(?:\?([^#]*))?(?:#.*)?$/);
  if (!m) return null;
  return { scheme: m[1].toLowerCase(), host: (m[2] || '').toLowerCase(), port: m[3] || '', path: m[4] || '', query: m[5] || '' };
}

// urllib quote_plus: percent-encode, space -> '+'. encodeURIComponent leaves
// !'()* unencoded where quote_plus encodes them, so patch those to match Python.
function quotePlus(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/g, function (c) { return '%' + c.charCodeAt(0).toString(16).toUpperCase(); })
    .replace(/%20/g, '+');
}

function decodePlus(value) {
  try {
    return decodeURIComponent(String(value).replace(/\+/g, ' '));
  } catch (e) {
    return String(value);
  }
}

// Port of identity.canonicalize_url: drop transport + marketing noise, keep identity.
function canonicalizeUrl(url) {
  var p = splitUrlParts(url);
  if (!p) return String(url).trim();
  var host = p.host;
  if (p.port && !((p.scheme === 'https' && p.port === '443') || (p.scheme === 'http' && p.port === '80'))) {
    host = host + ':' + p.port;
  }
  var path = p.path.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
  var pairs = [];
  if (p.query) {
    var segs = p.query.split('&');
    for (var i = 0; i < segs.length; i++) {
      if (segs[i] === '') continue;
      var eq = segs[i].indexOf('=');
      var key = decodePlus(eq === -1 ? segs[i] : segs[i].slice(0, eq));
      var val = decodePlus(eq === -1 ? '' : segs[i].slice(eq + 1));
      var lower = key.toLowerCase();
      if (lower.indexOf('utm_') === 0 || TRACKING_PARAMETERS.indexOf(lower) !== -1) continue;
      pairs.push([key, val]);
    }
  }
  pairs.sort(function (a, b) {
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
  });
  var query = pairs.map(function (kv) { return quotePlus(kv[0]) + '=' + quotePlus(kv[1]); }).join('&');
  return p.scheme + '://' + host + path + (query ? '?' + query : '');
}

// Port of identity._words: NFKD-fold, drop non-ASCII, lowercase, collapse to tokens.
// Because the input is folded to ASCII before hashing, sha256Hex (which hashes char
// codes) produces the same digest as Python's UTF-8 hashlib.sha256 on this input.
function foldWords(value) {
  var v = String(value == null ? '' : value)
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]/g, '')
    .toLowerCase()
    .replace(/ph\.d\./g, 'phd');
  var parts = v.replace(/[^a-z0-9]+/g, ' ').split(' ');
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    if (parts[i]) out.push(parts[i]);
  }
  return out.join(' ');
}

// Pure-JS SHA-256 (n8n Cloud CE has no `require`, so `crypto` is unavailable). Hashes
// char codes; safe here because foldWords() reduces every input to ASCII first.
function sha256Hex(ascii) {
  function rotr(n, x) { return (x >>> n) | (x << (32 - n)); }
  var K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  var h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a, h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  var bytes = [];
  for (var i = 0; i < ascii.length; i++) bytes.push(ascii.charCodeAt(i) & 0xff);
  var l = bytes.length;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  var hi = Math.floor((l * 8) / 0x100000000), lo = (l * 8) >>> 0;
  bytes.push((hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff, (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff);
  var w = new Array(64);
  for (var off = 0; off < bytes.length; off += 64) {
    for (var t = 0; t < 16; t++) w[t] = (bytes[off + t * 4] << 24) | (bytes[off + t * 4 + 1] << 16) | (bytes[off + t * 4 + 2] << 8) | (bytes[off + t * 4 + 3]);
    for (var t2 = 16; t2 < 64; t2++) {
      var s0 = rotr(7, w[t2 - 15]) ^ rotr(18, w[t2 - 15]) ^ (w[t2 - 15] >>> 3);
      var s1 = rotr(17, w[t2 - 2]) ^ rotr(19, w[t2 - 2]) ^ (w[t2 - 2] >>> 10);
      w[t2] = (w[t2 - 16] + s0 + w[t2 - 7] + s1) | 0;
    }
    var a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (var r = 0; r < 64; r++) {
      var S1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
      var ch = (e & f) ^ (~e & g);
      var t1 = (h + S1 + ch + K[r] + w[r]) | 0;
      var S0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
      var maj = (a & b) ^ (a & c) ^ (b & c);
      var t22 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t22) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  function hex(n) { return ('00000000' + (n >>> 0).toString(16)).slice(-8); }
  return hex(h0) + hex(h1) + hex(h2) + hex(h3) + hex(h4) + hex(h5) + hex(h6) + hex(h7);
}

// Port of identity.opportunity_fingerprint: a stable cross-source identity hint.
function opportunityFingerprint(args) {
  var supervisor = foldWords(args.supervisor);
  if (supervisor.indexOf('dr ') === 0) supervisor = supervisor.slice(3);
  var parts = [
    foldWords(args.institution),
    foldWords(args.title),
    supervisor,
    String(args.deadline == null ? '' : args.deadline).slice(0, 10)
  ];
  return sha256Hex(parts.join('\x1F'));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    normalizeOpportunity: normalizeOpportunity,
    validatePublicUrl: validatePublicUrl,
    canonicalizeUrl: canonicalizeUrl,
    opportunityFingerprint: opportunityFingerprint
  };
}
