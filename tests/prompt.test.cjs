// Contract for the .prompt loader.
//
// Prompts are assets, not code: tuning the ingest wording must never mean editing a
// module. The format is ported from ~/capta/adapta — YAML frontmatter, then a body split
// by {{role "name"}} markers, with {{var}} placeholders rendered at call time.
//
// The rule worth a test of its own: an unmatched placeholder throws. An unrendered
// {{url}} reaching the model as literal text is a silent, expensive failure.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parsePrompt, loadPrompt, render } = require('../src/core/prompt.cjs');

const FULL = `---
name: ingest
description: Extract an opportunity from a page
model: claude-sonnet-5
max_tokens: 8192
---
{{role "system"}}
You extract PhD opportunities. Unknown stays unknown.

{{role "user"}}
Extract the opportunity at {{url}}.
`;

test('a .prompt file parses into name, metadata, role-tagged messages and a hash', () => {
  const prompt = parsePrompt(FULL);

  assert.equal(prompt.name, 'ingest');
  assert.equal(prompt.metadata.model, 'claude-sonnet-5');
  assert.equal(prompt.metadata.max_tokens, 8192);
  assert.deepEqual(
    prompt.messages.map((m) => m.role),
    ['system', 'user']
  );
  assert.equal(prompt.messages[0].content, 'You extract PhD opportunities. Unknown stays unknown.');
  assert.equal(prompt.messages[1].content, 'Extract the opportunity at {{url}}.');
  assert.match(prompt.contentHash, /^[0-9a-f]{64}$/);
});

test('model id and max_tokens come from frontmatter, not from the environment', () => {
  // They are tuned together with the wording, so they travel with the file. If this ever
  // reads process.env, a prompt change and a config change can disagree.
  const before = { ...process.env };
  process.env.ANTHROPIC_MODEL = 'claude-opus-5';
  try {
    assert.equal(parsePrompt(FULL).metadata.model, 'claude-sonnet-5');
  } finally {
    process.env = before;
  }
});

test('{{var}} substitution replaces every occurrence', () => {
  assert.equal(
    render('Fetch {{url}} then re-read {{url}}.', { url: 'https://uni.example/phd' }),
    'Fetch https://uni.example/phd then re-read https://uni.example/phd.'
  );
});

test('an unmatched placeholder throws rather than rendering literally', () => {
  assert.throws(() => render('Extract the opportunity at {{url}}.', {}), /url/);
});

test('a variable with no placeholder is not an error', () => {
  assert.equal(render('No placeholders here.', { url: 'https://uni.example' }), 'No placeholders here.');
});

test('single braces are left untouched', () => {
  assert.equal(render('Return {"state": "found"} as JSON.', {}), 'Return {"state": "found"} as JSON.');
});

test('a body with no role markers yields a single user message', () => {
  const prompt = parsePrompt('---\nname: bare\n---\nJust a body.\n');
  assert.deepEqual(prompt.messages, [{ role: 'user', content: 'Just a body.' }]);
});

test('missing frontmatter is an error, not an empty metadata object', () => {
  assert.throws(() => parsePrompt('Just a body with no frontmatter.'), /frontmatter/i);
});

test('the content hash is stable for identical contents and changes when the file changes', () => {
  assert.equal(parsePrompt(FULL).contentHash, parsePrompt(FULL).contentHash);
  assert.notEqual(parsePrompt(FULL).contentHash, parsePrompt(FULL.replace('Unknown', 'unknown')).contentHash);
});

test('the hash covers the whole file, so a frontmatter-only change is a different prompt', () => {
  // The hash is stamped on every record it produces, so "did extraction get better after
  // that change?" has to include a model or max_tokens change, not just wording.
  assert.notEqual(
    parsePrompt(FULL).contentHash,
    parsePrompt(FULL.replace('max_tokens: 8192', 'max_tokens: 4096')).contentHash
  );
});

test('frontmatter reads scalars, quoted strings, numbers and booleans', () => {
  const { metadata } = parsePrompt(
    '---\nname: t\nmax_tokens: 4096\nmodel: "claude-sonnet-5"\nthinking: true\n---\nbody\n'
  );
  assert.deepEqual(metadata, { name: 't', max_tokens: 4096, model: 'claude-sonnet-5', thinking: true });
});

test('frontmatter this parser cannot represent is an error, not a silent misread', () => {
  // A hand-rolled reader that quietly turns a nested block into the string "" would let a
  // prompt look configured when it is not.
  assert.throws(() => parsePrompt('---\nname: t\ntools:\n  - web_fetch\n---\nbody\n'), /frontmatter/i);
});

test('loadPrompt reads a file and falls back to its stem for the name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prospect-prompt-'));
  const file = path.join(dir, 'unnamed.prompt');
  fs.writeFileSync(file, '---\nmodel: claude-sonnet-5\n---\nbody\n');
  try {
    const prompt = loadPrompt(file);
    assert.equal(prompt.name, 'unnamed');
    assert.equal(prompt.metadata.model, 'claude-sonnet-5');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the shipped ingest prompt loads and declares its model and token budget', () => {
  const prompt = loadPrompt(path.join(__dirname, '..', 'prompts', 'ingest.prompt'));
  assert.equal(typeof prompt.metadata.model, 'string');
  assert.equal(typeof prompt.metadata.max_tokens, 'number');
  assert.ok(prompt.messages.length > 0);
});
