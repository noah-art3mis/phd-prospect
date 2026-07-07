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
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('source URL cannot target a local hostname');
  }
  var nonGlobal = isNonGlobalIpv4(host);
  if (nonGlobal === true) throw new Error('source URL cannot target a non-public address');
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { normalizeOpportunity: normalizeOpportunity, validatePublicUrl: validatePublicUrl };
}
