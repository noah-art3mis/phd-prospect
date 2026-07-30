// The approval card, as pure text.
//
// Findings come from pages an attacker controls and are interpolated straight into this
// message. It is sent with no parse_mode at all, so there is nothing to escape – that
// removes the class of bug rather than handling it, and it is why nothing here does any
// quoting or sanitising: any transformation would be a thing that could be got wrong.
//
// Also pure so the layout is assertable without a Telegram account.

const { resolveDeadline, formatLocalDate } = require('./deadline.cjs');
const { localDayNumber } = require('./reminders.cjs');

// One label per field, for the closing lines that name fields rather than show them.
const FIELD_LABELS = {
  deadline: 'Deadline',
  institution: 'Institution',
  opportunity_type: 'Type',
  programme: 'Programme',
  department_or_lab: 'Department',
  supervisors: 'Supervisors',
  research_topics: 'Topics',
  funding: 'Funding',
  eligibility: 'Eligibility',
  required_documents: 'Documents',
  duration: 'Duration',
  start_date: 'Starts',
  country: 'Country',
  city: 'City',
  summary: 'Summary',
};

// Sections, in the order a person decides in: when is it due, what is it, who runs it, can I
// afford it, am I eligible, what do I have to send. A section with nothing found is absent
// rather than empty – a card is read on a phone, and a heading over "not stated" is a line
// spent saying nothing.
const SECTIONS = [
  { title: 'THE POST', labelled: ['programme', 'department_or_lab', 'supervisors'] },
  { title: 'TOPICS', bare: 'research_topics' },
  { title: 'FUNDING', bare: 'funding' },
  { title: 'ELIGIBILITY', bare: 'eligibility' },
  { title: 'DOCUMENTS', bare: 'required_documents' },
];

// The one-line summary of the post itself: kind, length, and when it starts, which are three
// short answers that read worse as three labelled lines than as one.
const POST_SUMMARY = [
  ['opportunity_type', (text) => text],
  ['duration', (text) => text],
  ['start_date', (text) => `starts ${text}`],
];

// Header and closing lines are ours; everything else is page text. Only what a state machine
// decided is ever named, never a value, so this stays a layout module with nothing to escape.
const UNCERTAIN = new Set(['needs_confirmation', 'conflicting_sources']);

function valuesOf(finding) {
  if (!finding || finding.state === 'not_stated') return [];
  const value = finding.value;
  const list = Array.isArray(value) ? value : [value];
  return list.map((item) => String(item ?? '').trim()).filter(Boolean);
}

// Found or not, a value the model gave is shown – the user is the one judging it. What the
// state changes is where the doubt is reported, which is once, at the end.
function inlineValue(finding) {
  return valuesOf(finding).join(', ');
}

// Several values are lines, one value is a line: the arrays are what turned this card into a
// paragraph, and eligibility lists read as a list because that is what they are.
function valueLines(finding, { label = '' } = {}) {
  const values = valuesOf(finding);
  if (values.length === 0) return [];
  if (values.length === 1) return [label ? `${label}: ${values[0]}` : values[0]];
  // The label goes above the bullets rather than beside the first one: without it the list
  // floats under the section heading, reading as a continuation of whatever came before.
  const bullets = values.map((value) => `• ${value}`);
  return label ? [`${label}:`, ...bullets] : bullets;
}

// A record filed under a paste reference has no page to link to, and the reference is an
// internal key. Showing it would put a hash where the reader looks for a source.
function describeSourceUrl(sourceUrl) {
  return /^paste:/.test(String(sourceUrl ?? '')) ? 'from pasted text – no source page' : sourceUrl;
}

// Institution and place, on the line under the title. They answer "whose, and where" without
// spending three labelled rows on it, and any of the three may be missing.
function headerLine(findings) {
  const place = [inlineValue(findings.city), inlineValue(findings.country)].filter(Boolean).join(', ');
  return [inlineValue(findings.institution), place].filter(Boolean).join(' · ');
}

// How long is left, in local days – the number the whole card is read to find. Counted in
// calendar days rather than elapsed hours, so a deadline late tomorrow evening is "in 1 day"
// and not "in 2 days".
function timeRemaining(deadlineAt, zone, now) {
  const days = localDayNumber(new Date(deadlineAt), zone) - localDayNumber(now, zone);
  if (days === 0) return 'today';
  if (days < 0) return `${-days} ${-days === 1 ? 'day' : 'days'} ago`;
  return `in ${days} ${days === 1 ? 'day' : 'days'}`;
}

function approvalCard(opportunity, { zone, now = new Date() }) {
  const findings = opportunity.findings ?? {};
  const lines = [opportunity.title];

  const header = headerLine(findings);
  if (header) lines.push(header);

  lines.push('', 'DEADLINE');
  lines.push(
    opportunity.deadline_at
      ? `${formatLocalDate(opportunity.deadline_at, zone)} — ${timeRemaining(opportunity.deadline_at, zone, now)}`
      : 'none on file – no reminders will fire'
  );

  const summary = inlineValue(findings.summary);
  if (summary) lines.push('', summary);

  const post = POST_SUMMARY.map(([field, phrase]) => {
    const value = inlineValue(findings[field]);
    return value ? phrase(value) : '';
  }).filter(Boolean);

  for (const section of SECTIONS) {
    const body = section.bare
      ? valueLines(findings[section.bare])
      : section.labelled.flatMap((field) => valueLines(findings[field], { label: FIELD_LABELS[field] }));
    const opening = section.title === 'THE POST' && post.length > 0 ? [post.join(' · ')] : [];
    if (opening.length === 0 && body.length === 0) continue;
    lines.push('', section.title, ...opening, ...body);
  }

  const named = (predicate) =>
    Object.entries(FIELD_LABELS)
      .filter(([field]) => predicate(findings[field]))
      .map(([, label]) => label);

  const uncertain = named((finding) => finding && UNCERTAIN.has(finding.state));
  const unstated = named((finding) => !finding || finding.state === 'not_stated');
  const evidenceCount = Object.values(findings).reduce((n, finding) => n + (finding.evidence?.length ?? 0), 0);

  lines.push('', describeSourceUrl(opportunity.source_url));
  lines.push(`${evidenceCount} evidence item${evidenceCount === 1 ? '' : 's'}`);
  // Named rather than counted: a number says how much is missing, the names say whether what
  // is missing is the part that mattered.
  if (unstated.length > 0) lines.push(`Not stated: ${unstated.join(', ')}`);
  if (uncertain.length > 0) lines.push(`Check before trusting: ${uncertain.join(', ')}`);
  lines.push(`Correct with:  ${opportunity.id} deadline = 2026-12-01`);

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
