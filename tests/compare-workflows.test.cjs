// Normalization contract for tools/compare-workflows.cjs.
//
// When a Switch rule is removed live, n8n leaves a trailing empty output group in the
// node's connections (e.g. [[A], []]). Trailing empty groups carry no behavior — there is
// no output to route — so normalization must ignore them. Leading/middle empty groups DO
// define behavior (they keep output indices aligned) and must be preserved.
// Ported from the retired Python test_compare_workflows.py.

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize } = require('../tools/compare-workflows.cjs');

function workflow(connections) {
  return { name: 'wf', nodes: [], connections };
}

test('trailing empty connection groups are ignored', () => {
  const withTrailing = workflow({ Switch: { main: [[{ node: 'A', type: 'main', index: 0 }], []] } });
  const without = workflow({ Switch: { main: [[{ node: 'A', type: 'main', index: 0 }]] } });
  assert.deepEqual(normalize(withTrailing), normalize(without));
});

test('middle empty connection groups are preserved', () => {
  const gap = workflow({ Switch: { main: [[], [{ node: 'A', type: 'main', index: 0 }]] } });
  const noGap = workflow({ Switch: { main: [[{ node: 'A', type: 'main', index: 0 }]] } });
  assert.notDeepEqual(normalize(gap), normalize(noGap));
});
