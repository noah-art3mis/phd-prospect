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

// Structured outputs cannot express `additionalProperties: <schema>`, so the finding map is
// enumerated rather than open. That is a feature here: every field comes back explicitly,
// with not_stated where the source was silent, instead of being quietly omitted.
function findingSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['state', 'value', 'evidence'],
    properties: {
      state: { enum: KNOWLEDGE_STATES },
      value: {
        anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }, { type: 'null' }],
      },
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
      findings: {
        type: 'object',
        additionalProperties: false,
        required: [...FINDING_FIELDS],
        properties: Object.fromEntries(FINDING_FIELDS.map((field) => [field, findingSchema()])),
      },
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
    system,
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
};
