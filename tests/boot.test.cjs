// Boot behaviour, exercised through the real entry point as a subprocess.
//
// This is the one test that has to run the process rather than a function: the acceptance
// criterion is that a bad configuration exits non-zero *before any network connection*, and
// that is a property of the startup ordering, not of any single module.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ENTRY = path.join(__dirname, '..', 'src', 'index.cjs');

function runBoot(env, dir) {
  return spawnSync(process.execPath, [ENTRY, '--check'], {
    // An empty base env, so the developer's own shell cannot accidentally satisfy a key the
    // test means to leave missing.
    env: { PATH: process.env.PATH, DB_PATH: path.join(dir, 'prospect.db'), ...env },
    encoding: 'utf8',
    timeout: 30000,
  });
}

const COMPLETE = {
  TELEGRAM_BOT_TOKEN: '123456:ABC-DEF',
  TELEGRAM_ALLOWED_USER_ID: '987654321',
  ANTHROPIC_API_KEY: 'sk-ant-test',
  TZ: 'America/Mexico_City',
  REMINDER_LEAD_TIMES: '30,7,1',
  REMINDER_SEND_HOUR: '9',
  BACKUP_UPLOAD_URL: 'https://objectstorage.us-ashburn-1.oraclecloud.com/p/EXAMPLE-TOKEN/n/mynamespace/b/prospect-backups/o/',
};

function withTempDir(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prospect-boot-'));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a complete environment creates the database and loads the seed', () => {
  withTempDir((dir) => {
    const result = runBoot(COMPLETE, dir);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(path.join(dir, 'prospect.db')), 'database file was not created');
    assert.match(result.stdout, /tracking 7 opportunities/);
  });
});

test('a missing key exits non-zero, naming the key', () => {
  withTempDir((dir) => {
    const env = { ...COMPLETE };
    delete env.ANTHROPIC_API_KEY;
    const result = runBoot(env, dir);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ANTHROPIC_API_KEY/);
    assert.ok(!fs.existsSync(path.join(dir, 'prospect.db')), 'database was created despite bad config');
  });
});

test('a malformed key exits non-zero, naming the key', () => {
  withTempDir((dir) => {
    const result = runBoot({ ...COMPLETE, REMINDER_SEND_HOUR: 'noon' }, dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /REMINDER_SEND_HOUR/);
  });
});

test('booting twice does not duplicate the seed', () => {
  withTempDir((dir) => {
    assert.equal(runBoot(COMPLETE, dir).status, 0);
    const second = runBoot(COMPLETE, dir);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /seed: 0 loaded, 7 already present/);
    assert.match(second.stdout, /tracking 7 opportunities/);
  });
});

test('.env.example lists every configuration key and no values', () => {
  const example = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
  const { CONFIG_KEYS } = require('../src/config.cjs');

  for (const key of CONFIG_KEYS) {
    assert.match(example, new RegExp(`^${key}=`, 'm'), `${key} is missing from .env.example`);
  }
  for (const line of example.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [key, ...rest] = line.split('=');
    assert.equal(rest.join('='), '', `${key} in .env.example carries a value`);
  }
});
