// The approval card, as pure text.
//
// Findings come from pages an attacker controls and are interpolated straight into this
// message. It is sent with no parse_mode at all, so there is nothing to escape – that
// removes the class of bug rather than handling it, and it is why nothing here does any
// quoting or sanitising: any transformation would be a thing that could be got wrong.
//
// Also pure so the layout is assertable without a Telegram account.

const { resolveDeadline, formatLocalDate } = require('./deadline.cjs');

// Order matters: what the user needs to judge whether to approve, first.
const SHOWN_FIELDS = [
  ['deadline', 'Deadline'],
  ['institution', 'Institution'],
  ['opportunity_type', 'Type'],
  ['programme', 'Programme'],
  ['department_or_lab', 'Department'],
  ['supervisors', 'Supervisors'],
  ['research_topics', 'Topics'],
  ['funding', 'Funding'],
  ['eligibility', 'Eligibility'],
  ['required_documents', 'Documents'],
  ['duration', 'Duration'],
  ['start_date', 'Starts'],
  ['country', 'Country'],
  ['city', 'City'],
];

const STATE_LABEL = {
  not_stated: 'not stated',
  not_applicable: 'n/a',
  conflicting_sources: 'SOURCES DISAGREE',
  needs_confirmation: 'NEEDS CHECKING',
};

function renderValue(value) {
  if (Array.isArray(value)) return value.join(', ');
  return String(value ?? '');
}

function renderFinding(finding) {
  if (!finding) return 'not stated';
  if (finding.state === 'found') return renderValue(finding.value);
  const label = STATE_LABEL[finding.state] ?? finding.state;
  // A conflicting or unconfirmed value is shown, not hidden – the user judges it.
  const value = renderValue(finding.value);
  return value ? `${value}  (${label})` : label;
}

// A record filed under a paste reference has no page to link to, and the reference is an
// internal key. Showing it would put a hash where the reader looks for a source.
function describeSourceUrl(sourceUrl) {
  return /^paste:/.test(String(sourceUrl ?? '')) ? 'from pasted text – no source page' : sourceUrl;
}

function approvalCard(opportunity, { zone }) {
  const lines = [opportunity.title, describeSourceUrl(opportunity.source_url), ''];

  lines.push(
    opportunity.deadline_at
      ? `Deadline: ${formatLocalDate(opportunity.deadline_at, zone)}`
      : 'Deadline: none on file – no reminders will fire'
  );
  lines.push('');

  for (const [field, label] of SHOWN_FIELDS) {
    if (field === 'deadline') continue; // Already shown above, resolved.
    const finding = opportunity.findings?.[field];
    if (!finding || finding.state === 'not_stated') continue;
    lines.push(`${label}: ${renderFinding(finding)}`);
  }

  const summary = opportunity.findings?.summary;
  if (summary?.state === 'found') lines.push('', renderValue(summary.value));

  const evidenceCount = Object.values(opportunity.findings ?? {}).reduce(
    (n, finding) => n + (finding.evidence?.length ?? 0),
    0
  );
  const unknown = Object.values(opportunity.findings ?? {}).filter((f) => f.state === 'not_stated').length;
  lines.push('', `${evidenceCount} evidence items, ${unknown} fields not stated`);

  lines.push('', `To correct a field first: ${opportunity.id} deadline = 2026-12-01`);

  return lines.join('\n');
}

function approvalButtons(opportunityId) {
  return {
    inline_keyboard: [
      [
        { text: 'Approve', callback_data: `approve:${opportunityId}` },
        { text: 'Reject', callback_data: `reject:${opportunityId}` },
      ],
    ],
  };
}

// Editing carries no server-side state: the correction names the row it applies to, so a
// restart between the card and the correction loses nothing. Format: `<id> <field> = <value>`.
const EDITABLE_FIELDS = ['title', 'institution', 'deadline'];
const EDIT_PATTERN = /^(\d+)\s+([a-z_]+)\s*=\s*(.+)$/i;

// Whether text is shaped like a correction at all, without needing a zone to find out. The
// router asks this to tell a correction from a pasted advert; parseEdit answers what the
// correction says. One pattern, so the two can never disagree about what an edit looks like.
function looksLikeEdit(text) {
  return EDIT_PATTERN.test(String(text).trim());
}

function parseEdit(text, { zone }) {
  const match = String(text).trim().match(EDIT_PATTERN);
  if (!match) return null;

  const [, rawId, rawField, rawValue] = match;
  const field = rawField.toLowerCase();
  const value = rawValue.trim();

  if (!EDITABLE_FIELDS.includes(field)) {
    return { opportunityId: Number(rawId), error: `I can only correct: ${EDITABLE_FIELDS.join(', ')}.` };
  }

  if (field === 'deadline') {
    // "none" is how a user says rolling admission – the column's NULL, not a placeholder.
    if (/^(none|null|rolling)$/i.test(value)) {
      return { opportunityId: Number(rawId), changes: { deadline_at: null } };
    }
    try {
      return { opportunityId: Number(rawId), changes: { deadline_at: resolveDeadline(value, zone) } };
    } catch (error) {
      return { opportunityId: Number(rawId), error: error.message };
    }
  }

  return { opportunityId: Number(rawId), changes: { [field]: value } };
}

module.exports = { approvalCard, approvalButtons, parseEdit, looksLikeEdit, EDITABLE_FIELDS };
