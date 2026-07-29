// Reading an Anthropic response – pure, driven from recorded fixtures in tests.
//
// Structured outputs make a malformed record unreachable, so the shape is not what this
// guards. What it guards is the two ways to get an *incomplete* record, both of which arrive
// as HTTP 200 and both of which look like success if you only read `content`:
//
//   pause_turn – the server-side tool loop hit its iteration limit. The call must be
//                 re-sent to resume. Treating it as final yields a truncated candidate.
//   max_tokens – the output was cut off. There is nothing to salvage; it is a failure.
//
// Every branch returns a status rather than throwing, so the caller's loop reads as a state
// machine instead of a pile of try/catch.

const { FINDING_FIELDS } = require('./ingest-request.cjs');

function textOf(response) {
  return (response.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

// Four classes, kept apart, because three of them are input and all three bill differently:
// fresh input at the base rate, a cache read at a tenth of it, a cache write at a quarter
// above it. Added together they make one number that cannot distinguish an expensive ingest
// from a cheap one – which is exactly the distinction prompt caching exists to create.
function usageOf(response) {
  const usage = response.usage ?? {};
  return {
    model: response.model,
    inputTokens: usage.input_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
  };
}

function readIngestResponse(response) {
  const usage = usageOf(response);

  switch (response.stop_reason) {
    case 'pause_turn':
      // Not an answer. The caller re-sends with this turn appended so the server resumes
      // where it left off.
      return { status: 'paused', usage, assistantContent: response.content };

    case 'max_tokens':
      return {
        status: 'failed',
        usage,
        reason: 'The model ran out of room before it finished the record. Nothing was saved.',
      };

    case 'refusal':
      return {
        status: 'failed',
        usage,
        reason: `The model declined to answer${response.stop_details?.category ? ` (${response.stop_details.category})` : ''}.`,
      };

    case 'end_turn':
    case 'stop_sequence':
      break;

    default:
      return { status: 'failed', usage, reason: `Unexpected stop reason: ${response.stop_reason}.` };
  }

  const text = textOf(response).trim();
  if (!text) {
    return { status: 'failed', usage, reason: 'The model returned no record.' };
  }

  let candidate;
  try {
    candidate = JSON.parse(text);
  } catch {
    // Unreachable under structured outputs, which is why it is a failure rather than a
    // repair attempt: if it happens, something is wrong that guessing would hide.
    return { status: 'failed', usage, reason: 'The model returned something that was not a record.' };
  }

  // Findings travel as a list because the schema grammar cannot afford sixteen copies of the
  // finding shape, but a list is the wrong thing to reason with: every reader downstream
  // wants "the deadline finding", not a scan. The conversion happens once, here.
  const findings = candidate.findings;
  if (!Array.isArray(findings)) {
    return { status: 'failed', usage, reason: 'The model returned findings that were not a list.' };
  }

  const byField = new Map();
  for (const finding of findings) {
    const { field, ...rest } = finding ?? {};
    // The enum in the schema already forbids this. Checked anyway because this is where an
    // untrusted response stops being untrusted: an invented field would be stored and shown
    // like any other, and nothing downstream looks for it, so nothing would ever notice.
    if (!FINDING_FIELDS.includes(field)) {
      return { status: 'failed', usage, reason: `The model returned a field nobody asked for: '${field}'.` };
    }
    // A map would swallow this: the second write replaces the first, and a contradicted
    // deadline would disappear with nothing to show anyone.
    if (byField.has(field)) {
      return { status: 'failed', usage, reason: `The model returned '${field}' more than once.` };
    }
    byField.set(field, rest);
  }

  const missing = FINDING_FIELDS.filter((field) => !byField.has(field));
  if (missing.length > 0) {
    // The schema used to guarantee this. A missing field is not an unknown value – it is a
    // field nobody answered, and downstream cannot tell the two apart.
    return { status: 'failed', usage, reason: `The model left out: ${missing.join(', ')}.` };
  }

  return {
    status: 'complete',
    usage,
    candidate: { ...candidate, findings: Object.fromEntries(byField) },
  };
}

// Whether the model actually managed to read the submitted page. An unreadable page –
// JS-rendered, paywalled, bot-blocked, dead – comes back as a well-formed record with
// nothing in it, which would otherwise be presented as a finished opportunity with every
// field unknown.
function readEverything(candidate) {
  const findings = Object.values(candidate.findings ?? {});
  return findings.some((finding) => finding.state === 'found');
}

module.exports = { readIngestResponse, readEverything, textOf, usageOf };
