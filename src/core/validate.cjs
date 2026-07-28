// Deterministic validation — the seam every candidate crosses before a human sees it.
//
// Pure: a candidate object goes in, an accepted clone comes out or an InvalidRecord is
// thrown. No clock, no environment, no network. Structured outputs already guarantee the
// record's *shape*; this enforces what a schema cannot express — the evidence rule and
// the knowledge-state machine. It never upgrades a state and never fills in a value.

const CRITICAL_FINDINGS = ['deadline'];
const KNOWLEDGE_STATES = ['found', 'not_stated', 'not_applicable', 'conflicting_sources', 'needs_confirmation'];

// Candidate data that cannot be persisted. Distinguished by name so callers can tell a
// rejected record apart from a bug in the validator.
function InvalidRecord(message) {
  const err = new Error(message);
  err.name = 'InvalidRecord';
  return err;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEmptyValue(value) {
  return value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
}

// The app never resolves or connects to a user-submitted URL — the model's server-side
// web_fetch does (ADR-0007) — so there is no SSRF surface here to defend and the private
// address checks of the n8n build are not ported. A URL only has to be a web link.
function isHttpUrl(value) {
  return /^https?:\/\/\S+$/i.test(String(value == null ? '' : value).trim());
}

// Strict ISO-8601 instant, rejecting impossible calendar dates a bare regex would pass.
// Returns {valid, hasOffset}: evidence must be stamped with an offset, so "10:00" without
// one cannot be silently read as whichever zone the reader happens to be in.
function parseIsoInstant(value) {
  const m = String(value).match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/
  );
  if (!m) return { valid: false, hasOffset: false };
  const [year, month, day, hour, minute] = [+m[1], +m[2], +m[3], +m[4], +m[5]];
  const second = m[6] ? +m[6] : 0;
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) {
    return { valid: false, hasOffset: false };
  }
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (day > daysInMonth) return { valid: false, hasOffset: false };
  return { valid: true, hasOffset: !!m[7] };
}

function validateEvidence(name, evidence) {
  if (!isPlainObject(evidence)) throw InvalidRecord(`finding '${name}' has malformed evidence`);
  if (!isHttpUrl(evidence.url)) throw InvalidRecord(`finding '${name}' has evidence with an invalid url`);
  const parsed = parseIsoInstant(evidence.retrieved_at);
  if (!parsed.valid) throw InvalidRecord(`finding '${name}' has evidence with an invalid retrieved_at`);
  if (!parsed.hasOffset) throw InvalidRecord(`finding '${name}' retrieved_at must include a UTC offset`);
  if (!String(evidence.excerpt == null ? '' : evidence.excerpt).trim()) {
    throw InvalidRecord(`finding '${name}' has evidence without an excerpt`);
  }
}

// Returns a persistence-safe clone of the candidate, or throws InvalidRecord.
function validate(candidate) {
  const accepted = structuredClone(candidate);
  if (!String(accepted.title == null ? '' : accepted.title).trim()) {
    throw InvalidRecord('opportunity requires a title');
  }
  if (!isHttpUrl(accepted.source_url)) {
    throw InvalidRecord('opportunity requires an http or https source_url');
  }
  const findings = accepted.findings || {};
  if (!isPlainObject(findings)) throw InvalidRecord('opportunity findings must be an object');

  for (const [name, finding] of Object.entries(findings)) {
    if (!isPlainObject(finding)) throw InvalidRecord(`finding '${name}' must be an object`);
    const { state } = finding;
    if (!KNOWLEDGE_STATES.includes(state)) {
      throw InvalidRecord(`finding '${name}' has unknown state '${state}'`);
    }
    const evidenceItems = finding.evidence === undefined ? [] : finding.evidence;
    if (!Array.isArray(evidenceItems)) throw InvalidRecord(`finding '${name}' evidence must be a list`);
    if (state === 'found' && isEmptyValue(finding.value)) {
      throw InvalidRecord(`finding '${name}' marked found without a value`);
    }
    // The deadline is the one field the app acts on unprompted, so it is the one field
    // that cannot be `found` on the model's word alone.
    if (CRITICAL_FINDINGS.includes(name) && state === 'found' && evidenceItems.length === 0) {
      throw InvalidRecord(`critical finding '${name}' requires evidence`);
    }
    if (state === 'conflicting_sources' && evidenceItems.length < 2) {
      throw InvalidRecord(`finding '${name}' marked conflicting with fewer than two sources`);
    }
    for (const evidence of evidenceItems) validateEvidence(name, evidence);
  }
  return accepted;
}

module.exports = { validate, InvalidRecord, CRITICAL_FINDINGS, KNOWLEDGE_STATES, parseIsoInstant };
