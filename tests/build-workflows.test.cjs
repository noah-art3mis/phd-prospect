// Tests for the workflow build step: sentinel inlining, placeholder substitution, and the
// knowledge-state tripwire between the prompts and the tracked opportunity-candidate schema.
// Ported from the retired Python test_build_workflows.py.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  SANDBOX_NOTE,
  buildWorkflow,
  inlinePayloads,
  parseEnvFile,
  renderPromptLines,
  stripModuleExports,
  stripSandboxNote,
  substitutePlaceholders,
  substitutionsFrom,
  buildAll,
} = require('../tools/build-workflows.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'build-workflows-'));
}

test('render_prompt_lines quotes each line as a js string', () => {
  const md = '# Role\n\nSay "hi" to c:\\temp\n';
  assert.equal(renderPromptLines(md), '  "# Role",\n  "",\n  "Say \\"hi\\" to c:\\\\temp"');
});

test('render_prompt_lines preserves non-ascii', () => {
  assert.equal(renderPromptLines('em – dash\n'), '  "em – dash"');
});

test('strip_sandbox_note removes only the leading note', () => {
  assert.equal(stripSandboxNote(SANDBOX_NOTE + '\nconst a = 1;\n'), 'const a = 1;\n');
  assert.equal(stripSandboxNote('const a = 1;\n'), 'const a = 1;\n');
});

test('strip_module_exports drops the trailing node guard', () => {
  const text =
    'function f() { return 1; }\n' +
    '\n' +
    "if (typeof module !== 'undefined' && module.exports) {\n" +
    '  module.exports = { f: f };\n' +
    '}\n';
  assert.equal(stripModuleExports(text), 'function f() { return 1; }');
});

test('inline_payloads expands nested sentinels', () => {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, 'n8n', 'code'), { recursive: true });
  fs.mkdirSync(path.join(root, 'n8n', 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'n8n', 'prompts', 'p.md'), 'line one\nline two\n');
  fs.writeFileSync(
    path.join(root, 'n8n', 'code', 'core.js'),
    SANDBOX_NOTE + '\nvar CORE = 1;\n\n' +
      "if (typeof module !== 'undefined' && module.exports) {\n" +
      '  module.exports = { CORE: CORE };\n' +
      '}\n'
  );
  const source =
    SANDBOX_NOTE + '\n' +
    '{{INLINE_JS:n8n/code/core.js}}\n' +
    'const system = [\n' +
    '{{PROMPT_LINES:n8n/prompts/p.md}}\n' +
    '].join("\\n");\n';
  assert.equal(
    inlinePayloads(source, root),
    'var CORE = 1;\n' +
      'const system = [\n' +
      '  "line one",\n' +
      '  "line two"\n' +
      '].join("\\n");\n'
  );
});

test('build_workflow inlines code files without mutating the template', () => {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, 'n8n', 'code'), { recursive: true });
  fs.writeFileSync(path.join(root, 'n8n', 'code', 'a.js'), SANDBOX_NOTE + '\nreturn $json;\n');
  const template = {
    name: 'wf',
    nodes: [
      { name: 'A', type: 'n8n-nodes-base.code', parameters: { jsCode: '{{FILE:n8n/code/a.js}}' } },
      { name: 'B', type: 'n8n-nodes-base.noOp', parameters: {} },
    ],
    connections: {},
  };
  const built = buildWorkflow(template, root);
  assert.equal(built.nodes[0].parameters.jsCode, 'return $json;');
  assert.deepEqual(built.nodes[1], template.nodes[1]);
  assert.equal(template.nodes[0].parameters.jsCode, '{{FILE:n8n/code/a.js}}');
});

test('build_workflow rejects unresolved sentinels', () => {
  const template = {
    name: 'wf',
    nodes: [{ name: 'A', type: 'n8n-nodes-base.code', parameters: { jsCode: '{{FILE:n8n/code/missing.js}}' } }],
    connections: {},
  };
  assert.throws(() => buildWorkflow(template, tmpdir()), /ENOENT/);
});

test('substitute_placeholders replaces every occurrence', () => {
  const wf = {
    nodes: [
      { parameters: { jsCode: "const id = 'REPLACE_WITH_TELEGRAM_USER_ID';" } },
      { parameters: { jsCode: "const ds = 'REPLACE_WITH_DATA_SOURCE_OPPORTUNITIES';" } },
    ],
  };
  const out = substitutePlaceholders(wf, {
    REPLACE_WITH_TELEGRAM_USER_ID: '42',
    REPLACE_WITH_DATA_SOURCE_OPPORTUNITIES: 'ds-1',
  });
  assert.equal(out.nodes[0].parameters.jsCode, "const id = '42';");
  assert.equal(out.nodes[1].parameters.jsCode, "const ds = 'ds-1';");
});

test('substitute_placeholders rejects leftover markers', () => {
  const wf = { nodes: [{ parameters: { jsCode: "'REPLACE_WITH_DATA_SOURCE_DEADLINES'" } }] };
  assert.throws(
    () => substitutePlaceholders(wf, { REPLACE_WITH_TELEGRAM_USER_ID: '42' }),
    /REPLACE_WITH_DATA_SOURCE_DEADLINES/
  );
});

test('substitutions_from maps env and data sources', () => {
  const subs = substitutionsFrom(
    { TELEGRAM_ALLOWED_USER_ID: '42' },
    { opportunities: 'o-1', deadlines: 'd-1', contacts: 'c-1' }
  );
  assert.deepEqual(subs, {
    REPLACE_WITH_TELEGRAM_USER_ID: '42',
    REPLACE_WITH_DATA_SOURCE_OPPORTUNITIES: 'o-1',
    REPLACE_WITH_DATA_SOURCE_DEADLINES: 'd-1',
    REPLACE_WITH_DATA_SOURCE_CONTACTS: 'c-1',
  });
});

test('substitutions_from requires the telegram id', () => {
  assert.throws(() => substitutionsFrom({}, { opportunities: 'o-1' }), /TELEGRAM_ALLOWED_USER_ID/);
});

test('parse_env_file reads simple assignments', () => {
  const root = tmpdir();
  const env = path.join(root, 'dotenv');
  fs.writeFileSync(env, '# comment\n\nTELEGRAM_ALLOWED_USER_ID=42\nQUOTED="a b"\nexport EXPORTED=\'x\'\n');
  assert.deepEqual(parseEnvFile(env), { TELEGRAM_ALLOWED_USER_ID: '42', QUOTED: 'a b', EXPORTED: 'x' });
});

for (const promptSource of ['code/build-extract-request.js', 'prompts/research.md']) {
  test('prompts carry the schema knowledge states: ' + promptSource, () => {
    const schema = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'schemas', 'opportunity-candidate.schema.json'), 'utf8')
    );
    const states = schema.$defs.finding.properties.state.enum;
    const prompt = fs.readFileSync(path.join(REPO_ROOT, 'n8n', promptSource), 'utf8');
    assert.ok(prompt.includes(states.join('|')));
  });
}

test('cli build-workflows emits template and import', () => {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, 'n8n', 'workflows'), { recursive: true });
  fs.mkdirSync(path.join(root, 'n8n', 'code'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'n8n', 'code', 'a.js'),
    SANDBOX_NOTE + "\nconst id = 'REPLACE_WITH_TELEGRAM_USER_ID';\n"
  );
  const template = {
    name: 'wf',
    settings: {},
    nodes: [{ name: 'A', type: 'n8n-nodes-base.code', parameters: { jsCode: '{{FILE:n8n/code/a.js}}' } }],
    connections: {},
  };
  fs.writeFileSync(path.join(root, 'n8n', 'workflows', '10-test.json'), JSON.stringify(template));
  fs.writeFileSync(path.join(root, '.env'), 'TELEGRAM_ALLOWED_USER_ID=42\n');
  fs.writeFileSync(path.join(root, 'notion-data-sources.json'), JSON.stringify({ opportunities: 'o-1' }));

  buildAll(root);

  const imported = JSON.parse(fs.readFileSync(path.join(root, 'n8n', 'import', '10-test.json'), 'utf8'));
  assert.equal(imported.nodes[0].parameters.jsCode, "const id = '42';");
  const tracked = JSON.parse(fs.readFileSync(path.join(root, 'n8n', 'workflows', '10-test.json'), 'utf8'));
  assert.equal(tracked.nodes[0].parameters.jsCode, '{{FILE:n8n/code/a.js}}');
});

test('repo templates build without leftover sentinels', () => {
  const workflowsDir = path.join(REPO_ROOT, 'n8n', 'workflows');
  for (const name of fs.readdirSync(workflowsDir).filter((n) => n.endsWith('.json'))) {
    const template = JSON.parse(fs.readFileSync(path.join(workflowsDir, name), 'utf8'));
    const dumped = JSON.stringify(buildWorkflow(template, REPO_ROOT));
    assert.ok(!dumped.includes('{{FILE:'), name);
    assert.ok(!dumped.includes('{{PROMPT_LINES:'), name);
    assert.ok(!dumped.includes('{{INLINE_JS:'), name);
  }
});

// --- Telegram send-node lint (ported from the retired Python lint tests) ---

function telegramSendNodes() {
  const nodes = [];
  const workflowsDir = path.join(REPO_ROOT, 'n8n', 'workflows');
  for (const name of fs.readdirSync(workflowsDir).filter((n) => n.endsWith('.json')).sort()) {
    const workflow = JSON.parse(fs.readFileSync(path.join(workflowsDir, name), 'utf8'));
    for (const node of workflow.nodes || []) {
      const params = node.parameters || {};
      if (node.type === 'n8n-nodes-base.telegram' && params.operation === 'sendMessage') {
        nodes.push([name + ':' + node.name, params]);
      }
    }
  }
  return nodes;
}

test('telegram send nodes declare HTML parse_mode', () => {
  const nodes = telegramSendNodes();
  assert.ok(nodes.length, 'expected telegram sendMessage nodes in the templates');
  const missing = nodes
    .filter(([, params]) => ((params.additionalFields || {}).parse_mode) !== 'HTML')
    .map(([name]) => name);
  assert.deepEqual(missing, []);
});

test('telegram send nodes escape interpolated values', () => {
  const escaped = new RegExp(
    "^String\\(.+ \\?\\? ''\\)" +
      "\\.replaceAll\\('&','&amp;'\\)" +
      "\\.replaceAll\\('<','&lt;'\\)" +
      "\\.replaceAll\\('>','&gt;'\\)$"
  );
  const allowlist = new Set([
    "$json.batch_size > 1 ? ' (' + ($json.batch_index + 1) + ' of ' + $json.batch_size + ')' : ''",
    "$('Authorize callback').item.json.action === 'save_incomplete' ? ' (marked incomplete)' : ''",
  ]);
  const violations = [];
  for (const [name, params] of telegramSendNodes()) {
    const text = params.text || '';
    const chunks = text.split('{{').slice(1);
    for (const chunk of chunks) {
      const expr = chunk.split('}}')[0].trim();
      if (allowlist.has(expr) || escaped.test(expr)) continue;
      violations.push(name + ': ' + expr);
    }
  }
  assert.deepEqual(violations, []);
});
