// Compare a built n8n workflow against a live export, after normalization.
//
// Usage:
//     node tools/compare-workflows.cjs n8n/import/01-ingest-opportunity.json live.json
//
// The live file may be the raw get_workflow_details MCP output ({"workflow": ...})
// or a bare workflow object. Normalization keeps what defines behavior — workflow name,
// node names/types/typeVersions/parameters (including inlined code and prompts), and
// connections — and drops instance noise: node ids, positions, webhookIds, credential
// bindings, versionId/timestamps/tags/meta/scopes, and sticky-note layout. Trailing
// whitespace on jsCode is also ignored: the live nodes are inconsistent about a final
// newline, which n8n does not care about.
//
// Exit code 0 when equivalent, 1 with a unified diff when not.
//
// Ported from scripts/compare_workflows.py.

const fs = require('fs');
const { dumpsSorted } = require('./build-workflows.cjs');

const NODE_KEYS = ['name', 'type', 'typeVersion', 'parameters'];

// Drop trailing empty output groups: removing a Switch rule live leaves an empty [] at
// the tail of the outputs, which routes nothing. Leading and middle empty groups keep
// output indices aligned, so they stay.
function trimConnections(connections) {
  const trimmed = {};
  for (const [source, kinds] of Object.entries(connections || {})) {
    trimmed[source] = {};
    for (const [kind, groups] of Object.entries(kinds)) {
      let value = groups;
      if (Array.isArray(value)) {
        value = value.slice();
        while (value.length && Array.isArray(value[value.length - 1]) && value[value.length - 1].length === 0) {
          value.pop();
        }
      }
      trimmed[source][kind] = value;
    }
  }
  return trimmed;
}

function normalize(document) {
  const workflow = document && document.workflow ? document.workflow : document;
  const nodes = [];
  for (const node of (workflow && workflow.nodes) || []) {
    const normalized = {};
    for (const key of NODE_KEYS) normalized[key] = node[key] === undefined ? null : node[key];
    let parameters = normalized.parameters;
    if (parameters && typeof parameters === 'object' && !Array.isArray(parameters) && typeof parameters.jsCode === 'string') {
      parameters = Object.assign({}, parameters);
      parameters.jsCode = parameters.jsCode.replace(/\s+$/, '');
      normalized.parameters = parameters;
    }
    nodes.push(normalized);
  }
  nodes.sort((a, b) => {
    const an = String(a.name);
    const bn = String(b.name);
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  return {
    name: (workflow && workflow.name) === undefined ? null : workflow.name,
    nodes,
    connections: trimConnections((workflow && workflow.connections) || {}),
  };
}

// Minimal unified diff over two arrays of lines (Python difflib.unified_diff shape).
function unifiedDiff(aLines, bLines, fromFile, toFile) {
  // Simple LCS-based diff sufficient for reporting divergences.
  const n = aLines.length;
  const m = bLines.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = aLines[i] === bLines[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out = ['--- ' + fromFile, '+++ ' + toFile];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) {
      out.push(' ' + aLines[i]);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push('-' + aLines[i]);
      i++;
    } else {
      out.push('+' + bLines[j]);
      j++;
    }
  }
  while (i < n) out.push('-' + aLines[i++]);
  while (j < m) out.push('+' + bLines[j++]);
  return out;
}

function deepEqual(a, b) {
  return dumpsSorted(a, 0) === dumpsSorted(b, 0);
}

function main(argv) {
  if (argv.length !== 2) {
    process.stdout.write(fs.readFileSync(__filename, 'utf8').split('\n\n')[0] + '\n');
    return 2;
  }
  const built = normalize(JSON.parse(fs.readFileSync(argv[0], 'utf8')));
  const live = normalize(JSON.parse(fs.readFileSync(argv[1], 'utf8')));
  if (deepEqual(built, live)) {
    process.stdout.write('EQUIVALENT: built workflow matches the live workflow (normalized)\n');
    return 0;
  }
  const diff = unifiedDiff(
    dumpsSorted(built, 0).split('\n'),
    dumpsSorted(live, 0).split('\n'),
    argv[0],
    argv[1]
  );
  for (const line of diff) process.stdout.write(line + '\n');
  return 1;
}

module.exports = { normalize, trimConnections };

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
