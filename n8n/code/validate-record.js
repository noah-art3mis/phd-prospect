// n8n Cloud Code-node sandbox: no `URL`, no `require` (Date and Set are fine).
{{INLINE_JS:n8n/code/validate_opportunity.js}}

// ---------------------------------------------------------------------------
// Node glue — everything above this line is n8n/code/validate_opportunity.js
// pasted verbatim (the golden-tested canonical port). Only the code below is
// pipeline-specific: it validates the live candidate and builds the pending row.
// ---------------------------------------------------------------------------

// Drift guard: the golden fixture must normalize to itself. If the pasted port
// ever diverges from the spec, this throws before anything is stored.
var FIXTURE = {
  "title": "PhD in Trustworthy Artificial Intelligence",
  "source_url": "https://university.example/research/phd/trustworthy-ai",
  "findings": {
    "institution": {
      "state": "found",
      "value": "Example University",
      "evidence": [
        {
          "url": "https://university.example/research/phd/trustworthy-ai",
          "retrieved_at": "2026-07-06T10:00:00+00:00",
          "excerpt": "Example University invites applications for a PhD in Trustworthy AI."
        }
      ]
    },
    "funding": {
      "state": "found",
      "value": {
        "status": "fully_funded",
        "stipend": 25000,
        "currency": "EUR",
        "frequency": "annual",
        "tuition_coverage": "full"
      },
      "evidence": [
        {
          "url": "https://university.example/research/phd/trustworthy-ai#funding",
          "retrieved_at": "2026-07-06T10:00:00+00:00",
          "excerpt": "The studentship covers tuition and provides an annual EUR 25,000 stipend."
        }
      ]
    },
    "deadlines": {
      "state": "found",
      "value": [
        {
          "type": "programme_application",
          "due_at": "2026-12-01T23:59:00+01:00",
          "timezone": "Europe/Berlin",
          "rolling": false
        }
      ],
      "evidence": [
        {
          "url": "https://university.example/research/phd/trustworthy-ai#apply",
          "retrieved_at": "2026-07-06T10:00:00+00:00",
          "excerpt": "Applications close at 23:59 CET on 1 December 2026."
        }
      ]
    },
    "eligibility": {
      "state": "needs_confirmation",
      "value": null,
      "evidence": []
    },
    "required_documents": {
      "state": "not_stated",
      "value": null,
      "evidence": []
    }
  }
};
if (JSON.stringify(normalizeOpportunity(FIXTURE)) !== JSON.stringify(FIXTURE)) {
  throw new Error('Validation drift: fixture did not normalize to itself');
}

var env = $json;
var candidate = env.candidate;
var ok = true;
var errors = [];
var normalized = null;
try {
  normalized = normalizeOpportunity(candidate);
} catch (e) {
  ok = false;
  errors = [e.message];
  normalized = JSON.parse(JSON.stringify(candidate));
}

function foundVal(f, name) {
  var fi = f[name];
  if (!fi || fi.state !== 'found') return '';
  var v = fi.value;
  if (Array.isArray(v)) return v.map(function (x) { return typeof x === 'object' ? JSON.stringify(x) : String(x); }).join(', ');
  return v == null ? '' : String(v);
}
function fingerprintArgs(rec) {
  var f = rec.findings || {};
  var sup = '';
  var sfi = f.supervisors;
  if (sfi && sfi.state === 'found') {
    var v = sfi.value;
    if (Array.isArray(v)) { var a = v[0]; sup = a && typeof a === 'object' ? String(a.name || a.value || '') : String(a == null ? '' : a); }
    else sup = v == null ? '' : String(v);
  }
  var dl = '';
  var dfi = f.deadlines;
  if (dfi && dfi.state === 'found' && Array.isArray(dfi.value) && dfi.value.length) {
    var d = dfi.value[0];
    dl = String((d && (d.due_at || d.date)) || '');
  }
  return { institution: foundVal(f, 'institution'), title: rec.title || '', supervisor: sup, deadline: dl };
}

var canonical_url = canonicalizeUrl(candidate.source_url || env.source_url);
var fingerprint = opportunityFingerprint(fingerprintArgs(candidate));
// Research-again re-entries carry the pending row's token so the row is
// updated in place (upsert) instead of inserting a duplicate.
var token = env.token || (Date.now().toString(36) + Math.floor(Math.random() * 1e9).toString(36)).slice(0, 20);

var f = candidate.findings || {};
function renderFunding(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    var bits = [];
    if (v.status) bits.push(String(v.status));
    if (v.stipend != null) bits.push((v.currency ? v.currency + ' ' : '') + v.stipend + (v.frequency ? '/' + v.frequency : ''));
    if (v.tuition_coverage) bits.push('tuition ' + v.tuition_coverage);
    return bits.join(', ') || JSON.stringify(v);
  }
  return String(v);
}
function renderDeadlines(v) {
  if (Array.isArray(v)) return v.map(function (d) {
    if (d && typeof d === 'object') return (d.type || 'deadline') + (d.rolling ? ' (rolling)' : (d.due_at ? ' @ ' + String(d.due_at).slice(0, 16) : '')) + (d.timezone ? ' ' + d.timezone : '');
    return String(d);
  }).join('; ');
  return String(v);
}
function line(label, name) {
  var fi = f[name];
  if (!fi) return label + ': (absent)';
  if (fi.state !== 'found') return label + ': [' + fi.state + ']';
  if (name === 'funding') return label + ': ' + renderFunding(fi.value);
  if (name === 'deadlines') return label + ': ' + renderDeadlines(fi.value);
  return label + ': ' + foundVal(f, name);
}
var summaryLines = [
  '📌 ' + (candidate.title || '(untitled)'),
  candidate.source_url || env.source_url,
  '',
  line('Institution', 'institution'),
  line('Department/lab', 'department_or_lab'),
  line('Country', 'country'),
  line('Funding', 'funding'),
  line('Deadlines', 'deadlines'),
  line('Eligibility', 'eligibility'),
  line('Required docs', 'required_documents'),
  '',
  ok ? '✅ Passed deterministic validation.' : ('⚠️ Validation issue: ' + errors.join('; ')),
  (env.missing_fields && env.missing_fields.length) ? ('Still unknown: ' + env.missing_fields.join(', ')) : 'No missing critical fields.'
];

return { json: {
  chat_id: env.chat_id,
  source_url: candidate.source_url || env.source_url,
  canonical_url: canonical_url,
  fingerprint: fingerprint,
  token: token,
  validation_ok: ok,
  validation_errors: errors,
  candidate_json: JSON.stringify(normalized),
  validation_json: JSON.stringify({ ok: ok, errors: errors, missing_fields: env.missing_fields || [] }),
  approval_text: summaryLines.join('\n'),
  created_at: new Date().toISOString()
} };
