// Ingest: a submission becomes a validated candidate.
//
// The IO edge around two pure seams – buildIngestRequest and readIngestResponse. The loop
// here exists for one reason: Anthropic's server-side tool loop stops at its iteration limit
// with stop_reason "pause_turn" and HTTP 200, and the call has to be re-sent to resume.
// Treating the first response as final is the failure mode this whole module is shaped
// around, because it produces a truncated candidate that looks successful.

const { buildIngestRequest } = require('./core/ingest-request.cjs');
const { readIngestResponse, readEverything } = require('./core/ingest-response.cjs');
const { validate } = require('./core/validate.cjs');
const { canonicalizeUrl } = require('./core/url.cjs');
const { resolveDeadline } = require('./core/deadline.cjs');

// A stuck loop is worse than a reported failure: each resume costs another call.
const MAX_RESUMES = 6;

// PDFs are handed to the model as base64 document blocks – nothing parses them locally, and
// the Telegram file URL is never given to web_fetch, because the bot token is in its path.
function submissionContent(submission) {
  if (submission.kind !== 'document') return null;
  return [
    {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: submission.pdfBase64 },
    },
  ];
}

function createIngest({ anthropic, prompt, zone, onUsage = () => {} }) {
  async function ingest(submission) {
    const request = buildIngestRequest(prompt, {
      variables: { url: submission.url ?? `the attached document (${submission.fileName})` },
      content: submissionContent(submission),
    });

    const messages = [...request.messages];
    let result;

    for (let attempt = 0; attempt <= MAX_RESUMES; attempt += 1) {
      // A copy, not the live array: a resume pushes onto `messages`, and a request body that
      // aliased it would keep changing after it was sent.
      const response = await anthropic.messages.create({ ...request, messages: [...messages] });
      result = readIngestResponse(response);
      onUsage(result.usage);

      if (result.status !== 'paused') break;

      // Resume: append the paused turn and re-send. No extra user message – the API sees the
      // trailing server_tool_use and picks up where it stopped.
      messages.push({ role: 'assistant', content: result.assistantContent });
    }

    if (result.status === 'paused') {
      return {
        ok: false,
        reason: `The model kept pausing after ${MAX_RESUMES} resumes; the record was never finished.`,
      };
    }
    if (result.status === 'failed') {
      return { ok: false, reason: result.reason };
    }

    const candidate = result.candidate;

    // A record where nothing was found means the page could not be read. It is structurally
    // a success, which is the trap: presenting it as a finished opportunity with every field
    // unknown is worse than saying so.
    if (!readEverything(candidate)) {
      return {
        ok: false,
        reason: 'I could not read anything from that page – it may be JS-rendered, paywalled, blocked, or gone.',
      };
    }

    // Deterministic validation. Structured outputs guarantee the shape; this enforces the
    // evidence rule and the state machine, which a schema cannot express.
    let accepted;
    try {
      accepted = validate({ ...candidate, source_url: submission.url ?? candidate.source_url });
    } catch (error) {
      if (error.name !== 'InvalidRecord') throw error;
      return { ok: false, reason: `The record did not pass validation: ${error.message}` };
    }

    const deadlineFinding = accepted.findings.deadline;
    return {
      ok: true,
      candidate: {
        ...accepted,
        canonical_url: canonicalizeUrl(accepted.source_url),
        institution: accepted.findings.institution?.state === 'found' ? accepted.findings.institution.value : null,
        // Resolved with the zone in force now, so changing TZ later never reinterprets it.
        deadline_at: deadlineFinding?.state === 'found' ? resolveDeadline(deadlineFinding.value, zone) : null,
        contacts: accepted.contacts ?? [],
        references: accepted.references ?? [],
        prompt_hash: prompt.contentHash,
      },
    };
  }

  return { ingest };
}

module.exports = { createIngest, MAX_RESUMES };
