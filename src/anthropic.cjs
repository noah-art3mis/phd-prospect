// The Anthropic client, constructed in one place so its cost-bearing defaults are stated
// once rather than repeated at each call site.
//
// Both defaults the SDK ships are wrong for this workload. An ingest is a single agentic
// call that can run for many minutes – the model fetches up to eight pages and reasons over
// them – and the SDK's ten-minute timeout with two retries turns one slow advert into three
// billed attempts and no record. Streaming removes the cliff; maxRetries removes the
// silent triple-charge.

const Anthropic = require('@anthropic-ai/sdk');

// A backstop for a connection that stalls before the response starts, not a bound on how
// long the model may think: once headers arrive the SDK clears this timer, and a streamed
// generation runs as long as it needs.
const REQUEST_TIMEOUT_MS = 120_000;

function createAnthropicClient({ apiKey }) {
  // No retries. A 429 or a 500 now surfaces instead of being absorbed, which is the intended
  // trade: every failure path here already reports to Telegram, and a silent retry of a call
  // this expensive is worse than being told it failed.
  return new Anthropic({ apiKey, maxRetries: 0, timeout: REQUEST_TIMEOUT_MS });
}

module.exports = { createAnthropicClient, REQUEST_TIMEOUT_MS };
