// Golden pins for the branchy Code nodes of workflow 03 (recheck active opportunities):
// n8n/code/diff-and-alert.js and n8n/code/prepare-opportunities.js. These are n8n-only
// glue with real branches (status-change detection, fetch-failure alerts, loose JSON
// parsing of model output, URL/title/status fallbacks) and never had a Python counterpart.
//
// The payloads run verbatim under node:vm against tests/golden/recheck_cases.json; any live
// edit that changes behavior trips the suite. These cases pin CURRENT live behavior, bugs
// included (a failed Anthropic call is indistinguishable from "no change": no alert fires
// and Last checked is still stamped).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runNodeCode } = require('./js/noderun.cjs');

const CASES = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden', 'recheck_cases.json'), 'utf8'));

function diffResult(c) {
  const item = runNodeCode('diff-and-alert.js', {
    frozenNowUtc: c.frozen_now_utc,
    mocks: {
      $: (nodeName) => {
        if (nodeName !== 'Build recheck request') throw new Error('unexpected node lookup: ' + nodeName);
        return { item: { json: c.ctx } };
      },
      $json: c.resp,
    },
  });
  const json = item.json;
  return {
    page_id: json.page_id,
    alert: json.alert,
    new_status: json.new_status,
    alert_text: json.alert_text,
    last_checked_start: json.last_checked_body.properties['Last checked'].date.start,
  };
}

for (const c of CASES.diff_and_alert) {
  test('diff-and-alert: ' + c.name, () => {
    const result = diffResult(c);
    const expect = c.expect;
    assert.equal(result.alert, expect.alert);
    assert.equal(result.new_status, expect.new_status);
    const expectedText =
      '🔁 Recheck — ' +
      c.ctx.title +
      '\n' +
      c.ctx.canonical_url +
      '\n- ' +
      expect.alert_lines.join('\n- ') +
      '\n\nNo confirmed values were changed. Review and update in Notion if needed.';
    assert.equal(result.alert_text, expectedText);
    assert.equal(result.page_id, c.ctx.page_id);
    // Last checked is stamped unconditionally with the (frozen) execution instant.
    assert.equal(result.last_checked_start, c.frozen_now_utc);
  });
}

for (const c of CASES.prepare_opportunities) {
  test('prepare-opportunities: ' + c.name, () => {
    const items = runNodeCode('prepare-opportunities.js', {
      frozenNowUtc: c.frozen_now_utc,
      mocks: { $input: { first: () => ({ json: { results: c.pages } }) } },
    });
    // Round-trip through JSON: values built inside node:vm carry the sandbox realm's prototypes.
    assert.deepEqual(JSON.parse(JSON.stringify(items.map((item) => item.json))), c.expect);
  });
}
