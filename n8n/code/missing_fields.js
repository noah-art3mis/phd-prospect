// n8n Cloud Code-node sandbox: no `URL`, no `require` (Date and Set are fine).
// Shared missing-fields contract: a critical field is complete only when its
// finding is `found` or `not_applicable`; every other state (or an absent
// finding) keeps it on the research list. Inlined into "Parse extraction" and
// "Rebuild pending request" so first-pass and research-again agree.
var REQUIRED_FIELDS = ['institution', 'department_or_lab', 'opportunity_type', 'country', 'summary', 'research_topics', 'supervisors', 'funding', 'eligibility', 'required_documents', 'deadlines', 'application_url', 'start_date'];

function computeMissingFields(candidate) {
  var findings = (candidate && candidate.findings && typeof candidate.findings === 'object') ? candidate.findings : {};
  var complete = new Set(['found', 'not_applicable']);
  return REQUIRED_FIELDS.filter(function (field) {
    return !complete.has((findings[field] || {}).state);
  });
}

if (typeof module !== 'undefined') module.exports = { REQUIRED_FIELDS: REQUIRED_FIELDS, computeMissingFields: computeMissingFields };
