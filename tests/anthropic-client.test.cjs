// The client's retry and timeout defaults, which cost real money when they are wrong.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createAnthropicClient, REQUEST_TIMEOUT_MS } = require('../src/anthropic.cjs');

test('a timed-out ingest is not retried', () => {
  // The SDK retries request timeouts twice by default. An ingest is one long agentic call:
  // the server keeps generating after the client gives up, so each retry is billed in full
  // and returns the same timeout. Three attempts, three charges, no record.
  assert.equal(createAnthropicClient({ apiKey: 'sk-test' }).maxRetries, 0);
});

test('the request timeout is set here rather than left to the SDK default', () => {
  // Streaming is what removes the ten-minute cliff – the SDK's timer is cleared once the
  // response headers arrive, so a long generation no longer races it. This bound is the
  // backstop for a connection that stalls before that, and it is stated rather than
  // inherited so that raising it is a decision someone made.
  const client = createAnthropicClient({ apiKey: 'sk-test' });
  assert.equal(client.timeout, REQUEST_TIMEOUT_MS);
  assert.equal(REQUEST_TIMEOUT_MS, 120_000);
});
