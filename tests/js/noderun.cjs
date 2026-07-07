// Shared harness: run a tracked n8n Code-node payload (n8n/code/*.js) verbatim inside
// node:vm with the n8n globals it expects ($input, $, $json) mocked, and `new Date()`
// frozen to a case-supplied instant. This exercises the EXACT deployed logic without
// modifying the payload files — the injection point is the sandbox, not the code.
//
// The tracked payloads reference the bare identifier REPLACE_WITH_TELEGRAM_USER_ID
// (the build substitutes the real chat id); the harness defines it as a test constant.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CODE_DIR = path.join(__dirname, '..', '..', 'n8n', 'code');
const TEST_CHAT_ID = 111222333;

function frozenDateClass(frozenIso) {
  const RealDate = Date;
  return class FrozenDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) {
        super(frozenIso);
      } else {
        super(...args);
      }
    }
    static now() {
      return new RealDate(frozenIso).getTime();
    }
  };
}

// Run a Code-node payload file as n8n does (a function body ending in `return`).
// `mocks` supplies the n8n globals a payload uses: $input, $ (node-output lookup), $json.
function runNodeCode(fileName, { frozenNowUtc, mocks = {} }) {
  const source = fs.readFileSync(path.join(CODE_DIR, fileName), 'utf8');
  const context = vm.createContext({
    Date: frozenDateClass(frozenNowUtc),
    REPLACE_WITH_TELEGRAM_USER_ID: TEST_CHAT_ID,
    ...mocks,
  });
  return vm.runInContext(`(function () {\n${source}\n})()`, context, { filename: fileName });
}

module.exports = { runNodeCode, TEST_CHAT_ID };
