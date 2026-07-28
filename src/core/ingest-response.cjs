// Reading an Anthropic response — pure, driven from recorded fixtures in tests.
//
// Structured outputs make a malformed record unreachable, so the shape is not what this
// guards. What it guards is the two ways to get an *incomplete* record, both of which arrive
// as HTTP 200 and both of which look like success if you only read `content`:
//
//   pause_turn  — the server-side tool loop hit its iteration limit. The call must be
//                 re-sent to resume. Treating it as final yields a truncated candidate.
//   max_tokens  — the output was cut off. There is nothing to salvage; it is a failure.
//
// Every branch returns a status rather than throwing, so the caller's loop reads as a state
// machine instead of a pile of try/catch.

function textOf(response) {
  return (response.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

function usageOf(response) {
  const usage = response.usage ?? {};
  return {
    model: response.model,
    inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
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

  return { status: 'complete', usage, candidate };
}

// Whether the model actually managed to read the submitted page. An unreadable page —
// JS-rendered, paywalled, bot-blocked, dead — comes back as a well-formed record with
// nothing in it, which would otherwise be presented as a finished opportunity with every
// field unknown.
function readEverything(candidate) {
  const findings = Object.values(candidate.findings ?? {});
  return findings.some((finding) => finding.state === 'found');
}

module.exports = { readIngestResponse, readEverything, textOf, usageOf };
