// Prompt assets: YAML frontmatter, then a body split by {{role "name"}} markers.
//
// Ported from ~/capta/adapta's loader. Tuning the ingest prompt means editing a file, not
// a module, and the model id and max_tokens live in the frontmatter because they are tuned
// together with the wording rather than varying by deployment.
//
// The frontmatter reader below handles scalars only and throws on anything else. That is
// deliberate: a hand-rolled parser that quietly misreads a nested block would let a prompt
// look configured when it is not, and the alternative — a YAML dependency — buys nothing
// for four keys.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROLE_PATTERN = /\{\{role\s+"(\w+)"\}\}/g;
const VAR_PATTERN = /\{\{(\w+)\}\}/g;

function parseScalar(raw) {
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '') return null;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^-?\d*\.\d+$/.test(value)) return Number(value);
  const quoted = value.match(/^"(.*)"$/) || value.match(/^'(.*)'$/);
  return quoted ? quoted[1] : value;
}

function parseFrontmatter(text) {
  const metadata = {};
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (/^\s/.test(line)) {
      throw new Error(`prompt frontmatter is not a flat key: value map (offending line: ${line.trim()})`);
    }
    const separator = line.indexOf(':');
    if (separator === -1) {
      throw new Error(`prompt frontmatter is not a flat key: value map (offending line: ${line.trim()})`);
    }
    const key = line.slice(0, separator).trim();
    const value = parseScalar(line.slice(separator + 1));
    if (value === null && line.slice(separator + 1).trim() === '') {
      throw new Error(`prompt frontmatter key '${key}' has no scalar value`);
    }
    metadata[key] = value;
  }
  return metadata;
}

// Split the body into role-tagged messages. No markers at all means the whole body is one
// user message, which is what a short single-turn prompt should be able to be.
function splitRoles(body) {
  const markers = [...body.matchAll(ROLE_PATTERN)];
  if (markers.length === 0) return [{ role: 'user', content: body.trim() }];

  return markers.map((match, i) => {
    const start = match.index + match[0].length;
    const end = i + 1 < markers.length ? markers[i + 1].index : body.length;
    return { role: match[1], content: body.slice(start, end).trim() };
  });
}

function parsePrompt(raw, nameFallback = '') {
  const contentHash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
  const parts = raw.split('---');
  if (parts.length < 3 || parts[0].trim() !== '') {
    throw new Error('prompt is missing its YAML frontmatter');
  }
  const metadata = parseFrontmatter(parts[1]);
  const body = parts.slice(2).join('---').trim();

  return {
    name: metadata.name || nameFallback,
    metadata,
    body,
    messages: splitRoles(body),
    contentHash,
  };
}

function loadPrompt(file) {
  return parsePrompt(fs.readFileSync(file, 'utf8'), path.basename(file, '.prompt'));
}

// Replace {{var}} placeholders. An unmatched placeholder throws: an unrendered {{url}}
// reaching the model as literal text is a silent failure that still costs a call.
function render(template, variables) {
  return template.replace(VAR_PATTERN, (_match, key) => {
    if (!Object.prototype.hasOwnProperty.call(variables, key)) {
      throw new Error(`prompt placeholder '{{${key}}}' has no matching variable`);
    }
    return String(variables[key]);
  });
}

// A prompt's messages with every placeholder resolved — what the caller sends.
function renderMessages(prompt, variables) {
  return prompt.messages.map((message) => ({
    role: message.role,
    content: render(message.content, variables),
  }));
}

module.exports = { parsePrompt, loadPrompt, render, renderMessages };
