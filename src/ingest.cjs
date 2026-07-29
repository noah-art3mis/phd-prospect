// Ingest: a submission becomes a validated candidate.
//
// The IO edge around two pure seams – buildIngestRequest and readIngestResponse. The loop
// here exists for one reason: Anthropic's server-side tool loop stops at its iteration limit
// with stop_reason "pause_turn" and HTTP 200, and the call has to be re-sent to resume.
// Treating the first response as final is the failure mode this whole module is shaped
// around, because it produces a truncated candidate that looks successful.

const { buildIngestRequest } = require('./core/ingest-request.cjs');
const { readIngestResponse, readEverything, fetchErrors } = require('./core/ingest-response.cjs');
const { validate } = require('./core/validate.cjs');
const { canonicalizeUrl, submissionIdentity } = require('./core/url.cjs');
const { resolveDeadline } = require('./core/deadline.cjs');

// A stuck loop is worse than a reported failure: each resume costs another call.
const MAX_RESUMES = 6;

// Two bounds on the whole ingest, because nothing in the request bounds it. max_content_tokens
// bounds one fetched page and max_tokens bounds the output; neither bounds the loop, whose
// billed input grows with the square of the number of iterations, since every iteration
// re-sends the entire accumulated conversation.
//
// Ten minutes clears the measured successes (135s and 305s) and cuts off the measured
// failures (1101s and 3758s), which cost as much as the successes did. It is spent across the
// loop rather than per call: six resumes of nine minutes each would clear any per-call limit
// and still be an hour of billing.
const TIME_BUDGET_MS = 600_000;

// The context window. A resume that would carry billed input past it cannot succeed – there
// is nowhere for the conversation to go – so it can only be charged for.
const TOKEN_BUDGET = 1_000_000;

// The clock is the only lever there is inside a single request, and it is a blunt one:
// aborting stops the stream, not the billing for what was already generated. It bounds the
// worst case rather than making it free.
function abortedFailure(budgetMs) {
  return {
    ok: false,
    reason: `That one took too long – I stopped it after ${Math.round(budgetMs / 60_000)} minutes rather than let it keep billing.`,
  };
}

// Why an empty record came back. The generic version of this message listed four possible
// causes and committed to none, which left the one useful next step – paste the text yourself
// – looking like a guess. The response already knows: every fetch the tool refused is in
// `content` with the URL it was for and the code it failed with.
function unreadableReason(response) {
  const errors = fetchErrors(response);
  if (errors.length === 0) {
    // The fetches worked and the page still yielded nothing. Here the cause really is
    // unknown, and naming one would be worse than saying so.
    return 'I could not read anything from that page – it may be JS-rendered, paywalled, blocked, or gone.';
  }

  const codes = [...new Set(errors.map((error) => error.code))].join(', ');
  return (
    `I could not fetch that page – every attempt was refused (${codes}). ` +
    'That usually means the advert is rendered in the browser rather than served, so there is ' +
    'nothing there to read. Sending me the text or a PDF works where the link does not.'
  );
}

// Findings arrive as lists; `institution` and `deadline_at` are single columns. A field that
// holds one thing and came back with several is the model disagreeing with the column, and
// the first entry is the one its own ordering puts first – `conflicting_sources` is how a
// genuine disagreement is meant to travel, not a longer list under `found`.
function scalarValue(finding) {
  if (!finding || finding.state !== 'found') return null;
  return finding.value[0] ?? null;
}

// PDFs are handed to the model as base64 document blocks – nothing parses them locally, and
// the Telegram file URL is never given to web_fetch, because the bot token is in its path.
// Pasted text goes the same way: as content to read, never as an address to resolve.
function submissionContent(submission) {
  if (submission.kind === 'paste') return [{ type: 'text', text: submission.text }];
  if (submission.kind !== 'document') return null;
  return [
    {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: submission.pdfBase64 },
    },
  ];
}

// Where the advert is, in words the prompt can put in a sentence. A paste says the link is
// unfetchable as well as what it is: the user pasted because the fetch failed, and a URL
// offered without that invites the model to spend an attempt discovering it again.
function describeSource(submission) {
  if (submission.kind === 'paste') {
    const cite = `Cite it as ${submissionIdentity(submission)} in evidence, with an excerpt quoted from it.`;
    return submission.url
      ? `the advert text below, which the user pasted because ${submission.url} could not be fetched – do not try to fetch it. ${cite}`
      : `the advert text below, which the user pasted and which has no source page. ${cite}`;
  }
  if (submission.kind === 'document') return `the attached document (${submission.fileName})`;
  return submission.url;
}

function createIngest({
  anthropic,
  prompt,
  zone,
  onUsage = () => {},
  // The raw response, before anything reads it. Offered for every call the loop made, paused
  // and failed ones included: those are the calls worth debugging, and a filtered trace is
  // missing exactly the run somebody went looking for.
  onResponse = () => {},
  timeBudgetMs = TIME_BUDGET_MS,
  tokenBudget = TOKEN_BUDGET,
}) {
  async function ingest(submission) {
    const request = buildIngestRequest(prompt, {
      variables: { source: describeSource(submission) },
      content: submissionContent(submission),
    });

    // Computed once and used for both the stored key and what the model is told to cite,
    // so the two cannot disagree.
    const identity = submission.kind === 'paste' ? submissionIdentity(submission) : submission.url;

    const messages = [...request.messages];
    const deadline = Date.now() + timeBudgetMs;
    let billedTokens = 0;
    let result;
    // Kept for the failure path: why a page could not be read is in the response, not the record.
    let lastResponse;

    for (let attempt = 0; attempt <= MAX_RESUMES; attempt += 1) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return abortedFailure(timeBudgetMs);
      // A copy, not the live array: a resume pushes onto `messages`, and a request body that
      // aliased it would keep changing after it was sent.
      // Streamed, not awaited whole: a non-streaming call races the SDK's request timeout,
      // and an advert that takes the model past it fails after being billed in full. The
      // stream is consumed only for its final message – nothing here renders tokens as they
      // arrive – so what changes is the timeout, not the shape of the result.
      const signal = AbortSignal.timeout(remainingMs);
      let response;
      try {
        response = await anthropic.messages
          .stream({ ...request, messages: [...messages] }, { signal })
          .finalMessage();
      } catch (error) {
        // Whether our own signal fired, not what the error looks like. Running out of time is
        // the deliberate outcome of the budget, so it has to arrive the way every other
        // ingest failure does – and the SDK wraps an abort in APIUserAbortError, whose `name`
        // is the inherited 'Error' and whose message is prose, so matching on either would
        // quietly stop recognising the one outcome this budget exists to produce.
        if (signal.aborted) return abortedFailure(timeBudgetMs);
        throw error;
      }

      lastResponse = response;
      onResponse(response, submission);
      result = readIngestResponse(response);
      onUsage(result.usage);

      if (result.status !== 'paused') break;

      // Counted across the loop, not per call: what is billed is the sum, and the sum is what
      // grows quadratically.
      billedTokens += result.usage.inputTokens + result.usage.cacheReadTokens + result.usage.cacheWriteTokens;
      if (billedTokens >= tokenBudget) {
        return {
          ok: false,
          reason: `That one used more than ${(tokenBudget / 1e6).toFixed(1)}M tokens without finishing, so I stopped it.`,
        };
      }

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
      // Cause before symptom. A run whose fetches were refused never read the page, so
      // whatever is wrong with the record it assembled anyway is downstream of that – and
      // 'research_topics more than once' tells nobody what to do next.
      const refused = fetchErrors(lastResponse).length > 0;
      return { ok: false, reason: refused ? unreadableReason(lastResponse) : result.reason };
    }

    const candidate = result.candidate;

    // A record where nothing was found means the page could not be read. It is structurally
    // a success, which is the trap: presenting it as a finished opportunity with every field
    // unknown is worse than saying so.
    if (!readEverything(candidate)) {
      return { ok: false, reason: unreadableReason(lastResponse) };
    }

    // Deterministic validation. Structured outputs guarantee the shape; this enforces the
    // evidence rule and the state machine, which a schema cannot express.
    let accepted;
    try {
      // The record is filed under what the user sent, never under an address the model
      // decided on: a link the model preferred would key a row nothing later looks up.
      accepted = validate({ ...candidate, source_url: identity ?? candidate.source_url });
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
        institution: scalarValue(accepted.findings.institution),
        // Resolved with the zone in force now, so changing TZ later never reinterprets it.
        deadline_at: resolveDeadline(scalarValue(deadlineFinding), zone),
        contacts: accepted.contacts ?? [],
        references: accepted.references ?? [],
        prompt_hash: prompt.contentHash,
      },
    };
  }

  return { ingest };
}

module.exports = { createIngest, MAX_RESUMES, TIME_BUDGET_MS, TOKEN_BUDGET };
