// Contract for configuration loading.
//
// Fail-fast is load-bearing here rather than tidy: the bot uses long polling, so a
// misconfigured app starts cleanly and sits dialling out looking perfectly healthy. A
// missing key has to surface at boot, not hours later as a failed ingest.
//
// loadConfig takes the environment as an argument so this is assertable without mutating
// process.env; readConfig is the one place in the app that touches process.env.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig, CONFIG_KEYS } = require('../src/config.cjs');

const COMPLETE = {
  TELEGRAM_BOT_TOKEN: '123456:ABC-DEF',
  TELEGRAM_ALLOWED_USER_ID: '987654321',
  ANTHROPIC_API_KEY: 'sk-ant-test',
  TZ: 'America/Mexico_City',
  REMINDER_LEAD_TIMES: '30,7,1',
  REMINDER_SEND_HOUR: '9',
  GCS_BACKUP_BUCKET: 'prospect-backups',
  DB_PATH: '/data/prospect.db',
};

test('a complete environment loads into typed values', () => {
  const config = loadConfig(COMPLETE);

  assert.equal(config.telegramBotToken, '123456:ABC-DEF');
  assert.equal(config.telegramAllowedUserId, 987654321);
  assert.equal(config.anthropicApiKey, 'sk-ant-test');
  assert.equal(config.timezone, 'America/Mexico_City');
  assert.deepEqual(config.reminderLeadTimes, [30, 7, 1]);
  assert.equal(config.reminderSendHour, 9);
  assert.equal(config.gcsBackupBucket, 'prospect-backups');
  assert.equal(config.dbPath, '/data/prospect.db');
});

test('nothing that belongs in the prompt file has leaked into the config surface', () => {
  // The bug this catches: someone making the model or token budget an environment variable.
  // They are tuned together with the prompt wording rather than varying by deployment, and
  // splitting them across two places lets a prompt change and a config change disagree.
  for (const key of CONFIG_KEYS) {
    assert.ok(!/MODEL|MAX_TOKENS|EFFORT|PROMPT|THINKING/.test(key), `${key} belongs in prompts/, not the environment`);
  }
});

test('every declared config key is actually required at boot', () => {
  // The bug this catches: a key added to CONFIG_KEYS and then never read, or read from
  // process.env somewhere downstream instead — either of which makes the fail-fast promise
  // partly false.
  const config = loadConfig(COMPLETE);
  assert.equal(Object.keys(COMPLETE).length, CONFIG_KEYS.length, 'the fixture and the surface have drifted');
  assert.equal(
    Object.keys(config).length + 2, // the two secrets are non-enumerable
    CONFIG_KEYS.length,
    'a declared key produced no config value'
  );
});

for (const key of Object.keys(COMPLETE)) {
  test(`a missing ${key} is an error naming that key`, () => {
    const env = { ...COMPLETE };
    delete env[key];
    assert.throws(() => loadConfig(env), new RegExp(key));
  });

  test(`a blank ${key} is treated as missing`, () => {
    assert.throws(() => loadConfig({ ...COMPLETE, [key]: '   ' }), new RegExp(key));
  });
}

const MALFORMED = {
  TELEGRAM_ALLOWED_USER_ID: 'me',
  REMINDER_SEND_HOUR: '25',
  REMINDER_LEAD_TIMES: '30,soon,1',
  TZ: 'Mars/Olympus_Mons',
};

for (const [key, value] of Object.entries(MALFORMED)) {
  test(`a malformed ${key} is an error naming that key`, () => {
    assert.throws(() => loadConfig({ ...COMPLETE, [key]: value }), new RegExp(key));
  });
}

test('the error names every offending key at once, not just the first', () => {
  // Fixing a missing key only to be told about the next one is a bad boot loop.
  const env = { ...COMPLETE };
  delete env.TELEGRAM_BOT_TOKEN;
  delete env.GCS_BACKUP_BUCKET;
  assert.throws(() => loadConfig(env), /TELEGRAM_BOT_TOKEN[\s\S]*GCS_BACKUP_BUCKET/);
});

test('lead times are sorted descending and de-duplicated', () => {
  const config = loadConfig({ ...COMPLETE, REMINDER_LEAD_TIMES: '1,30,7,7' });
  assert.deepEqual(config.reminderLeadTimes, [30, 7, 1]);
});

test('a zero lead time is allowed – "closes today" is a reminder worth sending', () => {
  assert.deepEqual(loadConfig({ ...COMPLETE, REMINDER_LEAD_TIMES: '7,0' }).reminderLeadTimes, [7, 0]);
});

test('a negative lead time is an error', () => {
  assert.throws(() => loadConfig({ ...COMPLETE, REMINDER_LEAD_TIMES: '7,-1' }), /REMINDER_LEAD_TIMES/);
});

test('config carries no secrets into its string form', () => {
  // Config is interpolated into boot logs and alerts; a token in a stack trace is a leak.
  const config = loadConfig(COMPLETE);
  const printed = `${config}` + JSON.stringify(config);
  assert.ok(!printed.includes('123456:ABC-DEF'), 'bot token leaked');
  assert.ok(!printed.includes('sk-ant-test'), 'api key leaked');
});
