// Build n8n workflows from tracked templates and payload files.
//
// The repo is the source of truth: workflow topology lives in n8n/workflows/*.json
// templates, Code-node JS in n8n/code/*.js, and Anthropic system prompts in
// n8n/prompts/*.md. Sentinels wire them together:
//
// - {{FILE:<path>}}         — a Code node's jsCode is the referenced JS file, inlined.
// - {{INLINE_JS:<path>}}    — inside a JS file: paste another JS file verbatim, minus its
//                             sandbox-note header and its trailing Node module.exports guard.
// - {{PROMPT_LINES:<path>}} — inside a JS file: render a markdown prompt as the indented,
//                             JSON-quoted lines of a JS array literal.
//
// Placeholders (REPLACE_WITH_TELEGRAM_USER_ID, REPLACE_WITH_DATA_SOURCE_<NAME>) stay in
// tracked output and are substituted only into the git-ignored n8n/import/ copies, with
// values read at runtime from .env and notion-data-sources.json.
//
// Ported from src/prospect/workflows.py; the JSON serialization matches Python's
// json.dump(indent=2, ensure_ascii=False, sort_keys=True) + trailing newline so the
// deployable copies stay byte-identical to the previous Python build.

const fs = require('fs');
const path = require('path');

const SANDBOX_NOTE =
  '// n8n Cloud Code-node sandbox: no `URL`, no `require` (Date and Set are fine).';

const FILE_SENTINEL = /^\{\{FILE:([^}]+)\}\}$/;
const LINE_SENTINEL = /^\{\{(INLINE_JS|PROMPT_LINES):([^}]+)\}\}$/;
const MODULE_GUARD = "if (typeof module !== 'undefined'";
const PLACEHOLDER = /REPLACE_WITH_[A-Z0-9_]+/;

// --- JSON serialization matching Python json.dumps -------------------------

// Mirror Python json.dumps string escaping (ensure_ascii=False): escape only the
// control characters and the two mandatory escapes; leave every printable (incl.
// non-ASCII) character raw. JS JSON.stringify already does exactly this.
function encodeString(value) {
  return JSON.stringify(value);
}

// Serialize like Python json.dumps(obj, indent=2, ensure_ascii=False, sort_keys=True).
function dumpsSorted(value, indentLevel) {
  const pad = '  '.repeat(indentLevel);
  const padInner = '  '.repeat(indentLevel + 1);
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!isFinite(value)) throw new Error('cannot serialize non-finite number');
    return String(value);
  }
  if (typeof value === 'string') return encodeString(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((item) => padInner + dumpsSorted(item, indentLevel + 1));
    return '[\n' + items.join(',\n') + '\n' + pad + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    if (keys.length === 0) return '{}';
    const items = keys.map(
      (key) => padInner + encodeString(key) + ': ' + dumpsSorted(value[key], indentLevel + 1)
    );
    return '{\n' + items.join(',\n') + '\n' + pad + '}';
  }
  throw new Error('cannot serialize value of type ' + typeof value);
}

function dump(workflow) {
  return dumpsSorted(workflow, 0) + '\n';
}

// --- Sentinel inlining ------------------------------------------------------

// Render markdown as the body of a JS array literal: one quoted string per line.
function renderPromptLines(markdown, indent = '  ') {
  const lines = markdown.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.map((line) => indent + JSON.stringify(line)).join(',\n');
}

// Drop the leading sandbox-note header; it annotates the file, not the payload.
function stripSandboxNote(text) {
  const idx = text.indexOf('\n');
  const first = idx === -1 ? text : text.slice(0, idx);
  if (first === SANDBOX_NOTE) {
    return idx === -1 ? '' : text.slice(idx + 1);
  }
  return text;
}

// Drop the trailing Node module.exports guard used only by the JS contract tests.
function stripModuleExports(text) {
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].startsWith(MODULE_GUARD)) {
      const core = lines.slice(0, index);
      while (core.length && core[core.length - 1].trim() === '') core.pop();
      return core.join('\n');
    }
  }
  return text;
}

// Expand line sentinels in a JS payload and strip its sandbox-note header.
function inlinePayloads(source, root) {
  const out = [];
  for (const line of stripSandboxNote(source).split('\n')) {
    const match = LINE_SENTINEL.exec(line);
    if (!match) {
      out.push(line);
      continue;
    }
    const kind = match[1];
    const relPath = match[2];
    const payload = fs.readFileSync(path.join(root, relPath), 'utf8');
    if (kind === 'INLINE_JS') {
      out.push(stripModuleExports(stripSandboxNote(payload)));
    } else {
      out.push(renderPromptLines(payload));
    }
  }
  return out.join('\n');
}

function removeSuffixNewline(text) {
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

// Return the workflow with every {{FILE:...}} jsCode sentinel inlined.
function buildWorkflow(template, root) {
  const built = JSON.parse(JSON.stringify(template));
  for (const node of built.nodes || []) {
    const jsCode = node.parameters && node.parameters.jsCode;
    if (typeof jsCode !== 'string') continue;
    const match = FILE_SENTINEL.exec(jsCode.trim());
    if (!match) continue;
    const source = fs.readFileSync(path.join(root, match[1]), 'utf8');
    // A payload file's final newline is a file convention, not node content.
    node.parameters.jsCode = removeSuffixNewline(inlinePayloads(source, root));
  }
  return built;
}

// --- Placeholder substitution ----------------------------------------------

// Replace every REPLACE_WITH_* marker; unresolved markers are an error.
function substitutePlaceholders(workflow, substitutions) {
  let text = JSON.stringify(workflow);
  for (const [placeholder, value] of Object.entries(substitutions)) {
    text = text.split(placeholder).join(value);
  }
  const leftover = PLACEHOLDER.exec(text);
  if (leftover) throw new Error('unresolved placeholder ' + leftover[0]);
  return JSON.parse(text);
}

// Build the placeholder map from environment values and the Notion data-source ids.
function substitutionsFrom(env, dataSources) {
  const telegramId = String(env.TELEGRAM_ALLOWED_USER_ID || '').trim();
  if (!telegramId) throw new Error('TELEGRAM_ALLOWED_USER_ID is required (set it in .env)');
  const substitutions = { REPLACE_WITH_TELEGRAM_USER_ID: telegramId };
  for (const [name, identifier] of Object.entries(dataSources)) {
    substitutions['REPLACE_WITH_DATA_SOURCE_' + name.toUpperCase()] = identifier;
  }
  return substitutions;
}

// Minimal KEY=VALUE parser so the build can consume .env at runtime.
function parseEnvFile(filePath) {
  const values = {};
  const contents = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of contents.split('\n')) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#') || line.indexOf('=') === -1) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length);
    const eq = line.indexOf('=');
    const key = line.slice(0, eq);
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
      value = value.slice(1, -1);
    }
    values[key.trim()] = value;
  }
  return values;
}

// Canonicalize every template and emit the deployable copies under n8n/import/.
function buildAll(root) {
  const envPath = path.join(root, '.env');
  const env = fs.existsSync(envPath) ? parseEnvFile(envPath) : {};
  const dataSourcesPath = path.join(root, 'notion-data-sources.json');
  const dataSources = fs.existsSync(dataSourcesPath)
    ? JSON.parse(fs.readFileSync(dataSourcesPath, 'utf8'))
    : {};
  const substitutions = substitutionsFrom(env, dataSources);

  const importDir = path.join(root, 'n8n', 'import');
  fs.mkdirSync(importDir, { recursive: true });
  const written = [];
  const workflowsDir = path.join(root, 'n8n', 'workflows');
  const templateNames = fs
    .readdirSync(workflowsDir)
    .filter((name) => name.endsWith('.json'))
    .sort();
  for (const name of templateNames) {
    const templatePath = path.join(workflowsDir, name);
    const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
    fs.writeFileSync(templatePath, dump(template));

    const built = buildWorkflow(template, root);
    const deployable = substitutePlaceholders(built, substitutions);
    const importPath = path.join(importDir, name);
    fs.writeFileSync(importPath, dump(deployable));
    written.push(importPath);
  }
  return written;
}

function main(argv) {
  let root = '.';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') {
      root = argv[i + 1];
      i++;
    }
  }
  const written = buildAll(root);
  for (const p of written) process.stdout.write('Wrote ' + p + '\n');
  return 0;
}

module.exports = {
  SANDBOX_NOTE,
  dump,
  dumpsSorted,
  renderPromptLines,
  stripSandboxNote,
  stripModuleExports,
  inlinePayloads,
  buildWorkflow,
  substitutePlaceholders,
  substitutionsFrom,
  parseEnvFile,
  buildAll,
  main,
};

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
