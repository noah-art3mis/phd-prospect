// Contract for the `validate` CLI (tools/validate.cjs): it normalizes an extracted
// opportunity JSON file and prints the persistence-safe record. Ported from the retired
// Python test_cli.py::test_validate_command.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('validate command prints a normalized record', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-cli-'));
  const recordPath = path.join(dir, 'record.json');
  fs.writeFileSync(
    recordPath,
    JSON.stringify({
      title: 'Trustworthy AI PhD',
      source_url: 'https://university.example/phd',
      findings: { funding: { state: 'not_stated', value: null, evidence: [] } },
    })
  );
  const tool = path.resolve(__dirname, '..', 'tools', 'validate.cjs');
  const out = execFileSync('node', [tool, recordPath], { encoding: 'utf8' });
  assert.equal(JSON.parse(out).title, 'Trustworthy AI PhD');
});
