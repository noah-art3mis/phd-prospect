// Ingest: the request that goes out, and the responses that come back.
//
// Everything here runs from recorded fixtures with no network access. The two cases worth
// the fixtures are the HTTP-200-but-incomplete ones: a `pause_turn` response must cause a
// resume rather than being accepted as final, and a `max_tokens` response must be reported
// as a failure rather than persisted as a truncated record.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildIngestRequest,
  MAX_SEARCHES,
  MAX_FETCHES,
  MAX_CONTENT_TOKENS,
  UNION_LIMIT,
  FINDING_FIELDS,
} = require('../src/core/ingest-request.cjs');
const { readIngestResponse } = require('../src/core/ingest-response.cjs');
const { createIngest, MAX_RESUMES } = require('../src/ingest.cjs');
const { loadPrompt } = require('../src/core/prompt.cjs');
const { validate } = require('../src/core/validate.cjs');

const PROMPT = loadPrompt(path.join(__dirname, '..', 'prompts', 'ingest.prompt'));
const fixture = (name) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ingest', `${name}.json`), 'utf8'));

const ZONE = 'America/Mexico_City';
const SUBMISSION = { kind: 'url', url: 'https://uni.example/phd' };

const request = () => buildIngestRequest(PROMPT, { variables: { url: SUBMISSION.url }, content: null });

// --- the request ------------------------------------------------------------------------

test('the submitted URL is rendered into the prompt, not left as a placeholder', () => {
  const body = request();
  const userText = JSON.stringify(body.messages.at(-1).content);
  assert.match(userText, /https:\/\/uni\.example\/phd/);
  assert.ok(!userText.includes('{{url}}'), 'an unrendered placeholder reached the model');
});

test('the model and token budget come from the prompt file', () => {
  const body = request();
  assert.equal(body.model, PROMPT.metadata.model);
  assert.equal(body.max_tokens, PROMPT.metadata.max_tokens);
});

test('research is bounded: 3 searches, 8 fetches, 5000 content tokens per page', () => {
  const body = request();
  const search = body.tools.find((t) => t.name === 'web_search');
  const fetch = body.tools.find((t) => t.name === 'web_fetch');

  assert.equal(search.max_uses, MAX_SEARCHES);
  assert.equal(MAX_SEARCHES, 3);
  assert.equal(fetch.max_uses, MAX_FETCHES);
  assert.equal(MAX_FETCHES, 8);
  // max_uses limits how many pages are fetched, not how large they are – the content cap is
  // what actually bounds cost.
  assert.equal(fetch.max_content_tokens, MAX_CONTENT_TOKENS);
  assert.equal(MAX_CONTENT_TOKENS, 5000);
});

test('the model is given no tool that can write, send, run shell, or read credentials', () => {
  // Read-only holds by construction: there is nothing else in the list.
  assert.deepEqual(
    request().tools.map((t) => t.name).sort(),
    ['web_fetch', 'web_search']
  );
});

test('the tool versions are the ones that support the configured model', () => {
  const body = request();
  assert.equal(body.tools.find((t) => t.name === 'web_search').type, 'web_search_20260209');
  assert.equal(body.tools.find((t) => t.name === 'web_fetch').type, 'web_fetch_20260209');
});

test('citations are not requested – they are incompatible with structured outputs', () => {
  // Asking for both returns a 400. Provenance travels in the evidence findings instead.
  const body = request();
  assert.ok(!JSON.stringify(body).includes('citations'), 'citations were requested');
});

test('the response is constrained by a schema, so a malformed record is unreachable', () => {
  const format = request().output_config.format;
  assert.equal(format.type, 'json_schema');
  assert.equal(format.schema.additionalProperties, false);
  assert.deepEqual(format.schema.required.sort(), ['contacts', 'findings', 'references', 'source_url', 'title']);
});

test('findings are requested as a list, so the grammar holds one finding schema, not sixteen', () => {
  // Enumerating the sixteen fields as properties repeats the whole finding schema – state,
  // value, and the evidence objects – sixteen times over, and the API rejects the compiled
  // grammar as too large. A list states the shape once and names the field inside it.
  const findings = request().output_config.format.schema.properties.findings;

  assert.equal(findings.type, 'array');
  assert.deepEqual(findings.items.required.sort(), ['evidence', 'field', 'state', 'value']);
  assert.deepEqual(findings.items.properties.field.enum, FINDING_FIELDS);
});

test('the schema stays within the API limit on union-typed parameters', () => {
  // The API rejects a schema with more than 16 union-typed parameters (type arrays, anyOf,
  // oneOf) with a 400 at request time, so an over-budget schema is not a style problem –
  // ingest stops working entirely. Counted here because nothing else can catch it offline.
  const countUnions = (node) => {
    if (!node || typeof node !== 'object') return 0;
    if (Array.isArray(node)) return node.reduce((n, item) => n + countUnions(item), 0);
    const self = Array.isArray(node.type) || node.anyOf || node.oneOf ? 1 : 0;
    return Object.entries(node).reduce((n, [key, value]) => {
      if (key === 'properties') return n + Object.values(value).reduce((m, v) => m + countUnions(v), 0);
      if (key === 'items') return n + countUnions(value);
      if (['anyOf', 'oneOf', 'allOf'].includes(key)) return n + countUnions(value);
      return n;
    }, self);
  };

  assert.ok(countUnions(request().output_config.format.schema) <= UNION_LIMIT);
  // Pinned, like the research bounds above: the limit is the API's, not ours to raise, and a
  // constant quietly bumped to fit an over-budget schema would make this test agree with it.
  assert.equal(UNION_LIMIT, 16);
});

test('a finding value is a list of strings, so no finding spends a union', () => {
  // One union per finding is 16 on its own, which leaves no room for anything else. A list
  // carries every case the union did: nothing found is [], and `state` already says which
  // kind of nothing it was, so a null value was only ever a second way to say not_stated.
  const value = request().output_config.format.schema.properties.findings.items.properties.value;
  assert.deepEqual(value, { type: 'array', items: { type: 'string' } });
});

test('adaptive thinking is on and effort is high', () => {
  // The design depends on the model actually calling its tools, and tool-use rate falls at
  // lower effort and with thinking disabled.
  const body = request();
  assert.deepEqual(body.thinking, { type: 'adaptive' });
  assert.equal(body.output_config.effort, 'high');
});

test('no sampling parameters are sent – they are rejected on this model', () => {
  const body = request();
  for (const removed of ['temperature', 'top_p', 'top_k']) {
    assert.ok(!(removed in body), `${removed} would be rejected with a 400`);
  }
});

test('a PDF submission carries a base64 document block, never a Telegram file URL', () => {
  const body = buildIngestRequest(PROMPT, {
    variables: { url: 'the attached document (advert.pdf)' },
    content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } }],
  });
  const content = body.messages.at(-1).content;

  assert.equal(content[0].type, 'document');
  assert.equal(content[0].source.type, 'base64');
  assert.ok(!JSON.stringify(body).includes('api.telegram.org'), 'a Telegram URL reached the request');
});

// --- reading the response ---------------------------------------------------------------

test('a finished response yields a candidate that passes validate', () => {
  const result = readIngestResponse(fixture('complete'));
  assert.equal(result.status, 'complete');
  assert.doesNotThrow(() => validate(result.candidate));
});

// The wire format is a list; everything downstream – validate, the card, the store – reads a
// map keyed by field. The reader is the one place that knows both.

const responseWith = (findings) => ({
  id: 'msg_x',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5',
  stop_reason: 'end_turn',
  usage: { input_tokens: 1, output_tokens: 1 },
  content: [
    {
      type: 'text',
      text: JSON.stringify({
        title: 'PhD in Something',
        source_url: 'https://uni.example/phd',
        findings,
        contacts: [],
        references: [],
      }),
    },
  ],
});

const everyField = (overrides = []) => {
  const listed = new Map(overrides.map((o) => [o.field, o]));
  return FINDING_FIELDS.map(
    (field) => listed.get(field) ?? { field, state: 'not_stated', value: [], evidence: [] }
  );
};

test('the findings list becomes a map keyed by field', () => {
  const result = readIngestResponse(
    responseWith(everyField([{ field: 'institution', state: 'found', value: ['UCD'], evidence: [] }]))
  );

  assert.equal(result.status, 'complete');
  assert.equal(result.candidate.findings.institution.state, 'found');
  assert.deepEqual(result.candidate.findings.institution.value, ['UCD']);
  assert.equal(result.candidate.findings.deadline.state, 'not_stated');
  assert.ok(!Array.isArray(result.candidate.findings), 'findings must be a map downstream');
});

test('a field named twice is a failure, not a silent last-one-wins', () => {
  // Collapsing a list into a map hides duplicates by construction: the second write simply
  // replaces the first, and a contradicted deadline would vanish without anyone seeing it.
  const findings = everyField([
    { field: 'deadline', state: 'found', value: ['2026-01-01'], evidence: [] },
  ]).concat([{ field: 'deadline', state: 'not_stated', value: [], evidence: [] }]);

  const result = readIngestResponse(responseWith(findings));
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /deadline/);
});

test('a field nobody asked for is a failure, not a stowaway in the record', () => {
  // The enum makes this unreachable, which is the reason to check it rather than a reason
  // not to: the reader is where an untrusted response stops being untrusted, and a field
  // invented here would be stored, shown, and never matched by anything that reads findings.
  const result = readIngestResponse(
    responseWith(everyField().concat([{ field: 'tuition_fees', state: 'found', value: ['x'], evidence: [] }]))
  );

  assert.equal(result.status, 'failed');
  assert.match(result.reason, /tuition_fees/);
});

test('a missing field is a failure – the schema can no longer require all sixteen', () => {
  // A list cannot express "exactly these sixteen", so the guarantee moves here. Without it a
  // silently omitted field reads downstream as a field that was never asked about.
  const result = readIngestResponse(responseWith(everyField().filter((f) => f.field !== 'funding')));

  assert.equal(result.status, 'failed');
  assert.match(result.reason, /funding/);
});

test('a pause_turn response is not an answer', () => {
  const result = readIngestResponse(fixture('pause_turn'));
  assert.equal(result.status, 'paused');
  assert.ok(result.assistantContent.length > 0, 'the turn to replay must come back');
});

test('a max_tokens response is a failure, not a partial record', () => {
  const result = readIngestResponse(fixture('max_tokens'));
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /ran out of room/i);
  assert.ok(!('candidate' in result), 'a truncated record must not be offered to the caller');
});

test('a refusal is a failure and does not crash on empty content', () => {
  const result = readIngestResponse(fixture('refusal'));
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /declined/i);
});

test('token usage is reported on every outcome, including ones that produced nothing', () => {
  // The weekly digest sums these; a paused or refused call still cost money.
  for (const name of ['complete', 'pause_turn', 'max_tokens', 'refusal']) {
    const result = readIngestResponse(fixture(name));
    assert.equal(typeof result.usage.inputTokens, 'number', name);
    assert.equal(typeof result.usage.outputTokens, 'number', name);
  }
});

test('the three input token classes are kept apart – they bill at different rates', () => {
  // Fresh input bills at 1×, a cache read at 0.1×, a cache write at 1.25×. Added together
  // they become one number that cannot tell an expensive ingest from a cheap one, which is
  // precisely the difference prompt caching is supposed to make.
  const response = responseWith(everyField());
  response.usage = {
    input_tokens: 1000,
    cache_read_input_tokens: 2000,
    cache_creation_input_tokens: 300,
    output_tokens: 40,
  };

  assert.deepEqual(readIngestResponse(response).usage, {
    model: 'claude-sonnet-5',
    inputTokens: 1000,
    cacheReadTokens: 2000,
    cacheWriteTokens: 300,
    outputTokens: 40,
  });
});

test('a response with no caching reports zero, not absent, for the cache classes', () => {
  // Every live run so far reported both as zero. A missing key and a measured zero read the
  // same downstream, so the reader states it rather than leaving the caller to guess.
  const { usage } = readIngestResponse(fixture('complete'));
  assert.equal(usage.cacheReadTokens, 0);
  assert.equal(usage.cacheWriteTokens, 0);
});

// --- the loop ---------------------------------------------------------------------------

// Only `stream` is offered, deliberately: a non-streaming ingest races the SDK's ten-minute
// timeout, and on a heavy advert it loses. Anything reaching for `create` should fail here.
function fakeAnthropic(responses) {
  const requests = [];
  return {
    requests,
    messages: {
      stream(body) {
        requests.push(body);
        const response = responses[Math.min(requests.length - 1, responses.length - 1)];
        return { finalMessage: async () => response };
      },
    },
  };
}

const ingestWith = (anthropic, onUsage = () => {}) =>
  createIngest({ anthropic, prompt: PROMPT, zone: ZONE, onUsage }).ingest;

test('a URL becomes a validated candidate in a single call', async () => {
  const anthropic = fakeAnthropic([fixture('complete')]);
  const result = await ingestWith(anthropic)(SUBMISSION);

  assert.equal(anthropic.requests.length, 1);
  assert.equal(result.ok, true);
  assert.equal(result.candidate.title, 'PhD in Trustworthy Artificial Intelligence');
  assert.doesNotThrow(() => validate(result.candidate));
});

test('list-valued findings become scalar columns on the candidate', async () => {
  // `institution` and `deadline_at` are single columns, so the list the model returns has to
  // be narrowed on the way in. Storing "Example University" as a one-element list would put
  // a JSON array into a text column and every later read would have to undo it.
  const result = await ingestWith(fakeAnthropic([fixture('complete')]))(SUBMISSION);

  assert.equal(result.candidate.institution, 'Example University');
  assert.equal(result.candidate.deadline_at, '2026-12-01T23:59:00.000Z');
});

test('a pause_turn causes a resume rather than being accepted as final', async () => {
  const anthropic = fakeAnthropic([fixture('pause_turn'), fixture('complete')]);
  const result = await ingestWith(anthropic)(SUBMISSION);

  assert.equal(anthropic.requests.length, 2, 'the call was not resumed');
  assert.equal(result.ok, true);

  // The resume appends the paused turn and adds no new user message: the API sees the
  // trailing server_tool_use and picks up where it stopped.
  const resumed = anthropic.requests[1].messages;
  assert.equal(resumed.at(-1).role, 'assistant');
  assert.equal(anthropic.requests[0].messages.length + 1, resumed.length);
});

test('endless pausing is reported rather than looping forever', async () => {
  const anthropic = fakeAnthropic([fixture('pause_turn')]);
  const result = await ingestWith(anthropic)(SUBMISSION);

  assert.equal(result.ok, false);
  assert.match(result.reason, /pausing/i);
  assert.equal(anthropic.requests.length, MAX_RESUMES + 1, 'each resume costs a call; the loop must be bounded');
});

test('a truncated response produces a failure and no record to persist', async () => {
  const result = await ingestWith(fakeAnthropic([fixture('max_tokens')]))(SUBMISSION);
  assert.equal(result.ok, false);
  assert.ok(!('candidate' in result));
});

test('an unreadable page produces a clear failure, not a record of unknowns', async () => {
  const result = await ingestWith(fakeAnthropic([fixture('unreadable_page')]))(SUBMISSION);
  assert.equal(result.ok, false);
  assert.match(result.reason, /could not read/i);
});

test('unstated fields come back not_stated; the deadline is found only with evidence', async () => {
  const result = await ingestWith(fakeAnthropic([fixture('complete')]))(SUBMISSION);
  const { findings } = result.candidate;

  assert.equal(findings.start_date.state, 'not_stated');
  assert.deepEqual(findings.start_date.value, []);
  assert.equal(findings.deadline.state, 'found');
  assert.ok(findings.deadline.evidence.length > 0);
});

test('the candidate carries the hash of the prompt that produced it', async () => {
  const result = await ingestWith(fakeAnthropic([fixture('complete')]))(SUBMISSION);
  assert.equal(result.candidate.prompt_hash, PROMPT.contentHash);
  assert.match(result.candidate.prompt_hash, /^[0-9a-f]{64}$/);
});

test('the deadline is stored as a UTC instant resolved with the ingest-time zone', async () => {
  const result = await ingestWith(fakeAnthropic([fixture('complete')]))(SUBMISSION);
  assert.equal(result.candidate.deadline_at, '2026-12-01T23:59:00.000Z');
});

test('usage is reported for every call the loop made, not just the last', async () => {
  const usage = [];
  const anthropic = fakeAnthropic([fixture('pause_turn'), fixture('complete')]);
  await ingestWith(anthropic, (u) => usage.push(u))(SUBMISSION);
  assert.equal(usage.length, 2, 'the paused call cost money too');
});

test('a candidate that fails validation is reported, not stored', async () => {
  const ungated = structuredClone(fixture('complete'));
  const record = JSON.parse(ungated.content.at(-1).text);
  record.findings.find((f) => f.field === 'deadline').evidence = [];
  ungated.content.at(-1).text = JSON.stringify(record);

  const result = await ingestWith(fakeAnthropic([ungated]))(SUBMISSION);
  assert.equal(result.ok, false);
  assert.match(result.reason, /critical finding 'deadline' requires evidence/);
});
