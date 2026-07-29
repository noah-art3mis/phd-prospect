// Building the ingest request – pure, so what gets sent to the model is assertable without
// a network call.
//
// One agentic call does the whole job: the model's own server-side web_fetch and web_search
// tools fetch the page, extract the opportunity, and fill gaps. The app never resolves or
// connects to a user-submitted URL itself, so there is no SSRF surface to defend (ADR-0007).
//
// The model is given no tool that can write records, send messages, run shell, or read
// credentials. Read-only holds by construction rather than by policy: there is nothing else
// in the list.

const { renderMessages } = require('./prompt.cjs');

// Carried over from the n8n build. max_uses bounds how many pages are fetched;
// max_content_tokens bounds how large each one is, which is what actually bounds cost –
// one verbose advert could otherwise run up the bill inside a single permitted fetch.
const MAX_SEARCHES = 3;
const MAX_FETCHES = 8;
const MAX_CONTENT_TOKENS = 5000;

const FINDING_FIELDS = [
  'institution',
  'department_or_lab',
  'opportunity_type',
  'programme',
  'country',
  'city',
  'summary',
  'research_topics',
  'supervisors',
  'funding',
  'eligibility',
  'required_documents',
  'duration',
  'start_date',
  'application_url',
  'deadline',
];

const KNOWLEDGE_STATES = ['found', 'not_stated', 'not_applicable', 'conflicting_sources', 'needs_confirmation'];

// The API compiles union-typed parameters (type arrays, anyOf, oneOf) at exponential cost and
// rejects a schema carrying more than this many with a 400. Sixteen findings means one union
// per finding would spend the entire budget, which is why a finding value is a plain list.
const UNION_LIMIT = 16;

// One finding schema, named by `field`, rather than sixteen properties each repeating it.
// Enumerating them compiles a grammar the API rejects as too large: the evidence objects are
// the bulk of it, and a map pays for them once per field. The list pays once.
//
// Requiring all sixteen fields is no longer expressible here – a list cannot say "exactly
// these" – so readIngestResponse enforces it instead. "The page did not say" must still be a
// stated answer rather than a missing key, and that rule now has one owner.
function findingSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['field', 'state', 'value', 'evidence'],
    properties: {
      field: { enum: FINDING_FIELDS },
      state: { enum: KNOWLEDGE_STATES },
      // Always a list, never a union: nothing found is [], and `state` already distinguishes
      // the kinds of nothing, so a null value would only restate it. See UNION_LIMIT.
      value: { type: 'array', items: { type: 'string' } },
      evidence: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['url', 'retrieved_at', 'excerpt'],
          properties: {
            url: { type: 'string' },
            retrieved_at: { type: 'string' },
            excerpt: { type: 'string' },
          },
        },
      },
    },
  };
}

function candidateSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'source_url', 'findings', 'contacts', 'references'],
    properties: {
      title: { type: 'string' },
      source_url: { type: 'string' },
      findings: { type: 'array', items: findingSchema() },
      contacts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'role', 'email'],
          properties: {
            name: { type: 'string' },
            role: { type: 'string' },
            email: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          },
        },
      },
      references: { type: 'array', items: { type: 'string' } },
    },
  };
}

// Split the rendered prompt into the system string and the message list the API wants.
function splitRoles(messages) {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const rest = messages.filter((m) => m.role !== 'system');
  return { system, messages: rest };
}

// `content` is the user turn's content blocks – text for a URL submission, or a document
// block followed by text for a PDF.
function buildIngestRequest(prompt, { variables, content }) {
  const rendered = renderMessages(prompt, variables);
  const { system, messages } = splitRoles(rendered);

  const userTurn = messages.at(-1);
  const userContent = content
    ? [...content, { type: 'text', text: userTurn.content }]
    : userTurn.content;

  return {
    model: prompt.metadata.model,
    max_tokens: prompt.metadata.max_tokens,
    // A block rather than a string, so it can carry a cache breakpoint. The cached prefix is
    // tools then system – everything ahead of the submitted URL, which is the only part that
    // varies per ingest. A cache read bills at a tenth of fresh input.
    //
    // Whether this saves anything real is measured, not assumed. Both open questions are
    // answered by cache_read_input_tokens after a live run: the prefix has to clear the
    // 1024-token minimum, and the server-side tool loop's own iterations – where the 300,000
    // input tokens of a single call actually come from – have to read a caller-set
    // breakpoint at all. If they do not, this caches about a thousand tokens of a third of a
    // million and is worth almost nothing.
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    // Adaptive thinking, because the design depends on the model actually calling its tools
    // and tool-use rate falls with thinking disabled.
    thinking: { type: 'adaptive' },
    output_config: {
      effort: prompt.metadata.effort ?? 'high',
      // A malformed record is not a state this system can reach. The deterministic validator
      // still runs – it enforces the evidence rule and the state machine, which a schema
      // cannot express.
      format: { type: 'json_schema', schema: candidateSchema() },
    },
    tools: [
      { type: 'web_search_20260209', name: 'web_search', max_uses: MAX_SEARCHES },
      {
        type: 'web_fetch_20260209',
        name: 'web_fetch',
        max_uses: MAX_FETCHES,
        max_content_tokens: MAX_CONTENT_TOKENS,
        // Citations are deliberately not requested: they are incompatible with structured
        // outputs and the pair returns a 400. Provenance travels in the evidence findings.
      },
    ],
    messages: [
      ...messages.slice(0, -1).map((m) => ({ role: m.role, content: m.content })),
      { role: userTurn.role, content: userContent },
    ],
  };
}

module.exports = {
  buildIngestRequest,
  candidateSchema,
  FINDING_FIELDS,
  MAX_SEARCHES,
  MAX_FETCHES,
  MAX_CONTENT_TOKENS,
  UNION_LIMIT,
};
