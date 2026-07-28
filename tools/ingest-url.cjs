#!/usr/bin/env node
// Run one real ingest and print the validated candidate.
//
// The demo for issue #26: a URL in, a record out, with no Telegram and no database. Also the
// way to see what a prompt change did without approving anything.
//
//     node tools/ingest-url.cjs https://example.org/phd-position

const path = require('node:path');
const { createAnthropicClient } = require('../src/anthropic.cjs');

const { loadConfig } = require('../src/config.cjs');
const { loadPrompt } = require('../src/core/prompt.cjs');
const { createIngest } = require('../src/ingest.cjs');

async function main(url) {
  if (!url) {
    console.error('usage: node tools/ingest-url.cjs <url>');
    process.exitCode = 1;
    return;
  }

  const config = loadConfig(process.env);
  const prompt = loadPrompt(path.join(__dirname, '..', 'prompts', 'ingest.prompt'));
  const anthropic = createAnthropicClient({ apiKey: config.anthropicApiKey });

  console.error(`prompt ${prompt.name} (${prompt.contentHash.slice(0, 12)}) on ${prompt.metadata.model}`);

  const { ingest } = createIngest({
    anthropic,
    prompt,
    zone: config.timezone,
    onUsage: (u) => console.error(`  call: ${u.inputTokens} in, ${u.outputTokens} out`),
  });

  const result = await ingest({ kind: 'url', url });
  if (!result.ok) {
    console.error(`failed: ${result.reason}`);
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(result.candidate, null, 2));
}

main(process.argv[2]).catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
