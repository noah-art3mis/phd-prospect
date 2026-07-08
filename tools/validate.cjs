// Validate an extracted opportunity JSON file against the deterministic ingest
// contract and print the normalized record. Ported from the prospect CLI
// `validate` command; the validation logic is the live n8n payload
// n8n/code/validate_opportunity.js (normalizeOpportunity).
//
// Usage:
//     node tools/validate.cjs <record.json>

const fs = require('fs');
const path = require('path');
const { normalizeOpportunity } = require(path.join(__dirname, '..', 'n8n', 'code', 'validate_opportunity.js'));

// Serialize like Python json.dumps(obj, indent=2, sort_keys=True).
function dumpSorted(value, level) {
  const pad = '  '.repeat(level);
  const padInner = '  '.repeat(level + 1);
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return '[\n' + value.map((v) => padInner + dumpSorted(v, level + 1)).join(',\n') + '\n' + pad + ']';
  }
  const keys = Object.keys(value).sort();
  if (keys.length === 0) return '{}';
  return '{\n' + keys.map((k) => padInner + JSON.stringify(k) + ': ' + dumpSorted(value[k], level + 1)).join(',\n') + '\n' + pad + '}';
}

function main(argv) {
  const recordPath = argv[0];
  if (!recordPath) {
    process.stderr.write('usage: validate.cjs <record.json>\n');
    return 2;
  }
  const candidate = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  process.stdout.write(dumpSorted(normalizeOpportunity(candidate), 0) + '\n');
  return 0;
}

module.exports = { main };

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
