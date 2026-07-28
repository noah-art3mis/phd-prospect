// Configuration — the one place in the app that reads process.env.
//
// Everything downstream receives values as arguments, which is what keeps the rest of the
// modules testable without mutating a global. loadConfig is the pure half (environment in,
// config out); readConfig is the impure caller.
//
// Fail-fast is load-bearing rather than tidy. The bot dials out over long polling, so a
// misconfigured app starts cleanly and sits there looking healthy; a missing key would
// otherwise surface hours later as a failed ingest.

// The whole surface. Model id and max_tokens are deliberately absent — they live in the
// prompt file, tuned together with the wording rather than varying by deployment.
const CONFIG_KEYS = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_ALLOWED_USER_ID',
  'ANTHROPIC_API_KEY',
  'TZ',
  'REMINDER_LEAD_TIMES',
  'REMINDER_SEND_HOUR',
  'GCS_BACKUP_BUCKET',
  'DB_PATH',
];

function ConfigError(problems) {
  const err = new Error(
    `configuration is incomplete or invalid:\n  ${problems.join('\n  ')}\n` +
      'See .env.example for the full set of keys.'
  );
  err.name = 'ConfigError';
  return err;
}

function isKnownTimezone(zone) {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

// Every problem is collected before throwing: being told about one missing key at a time
// turns a first deploy into a boot loop.
function loadConfig(env) {
  const problems = [];
  const present = {};

  for (const key of CONFIG_KEYS) {
    const raw = env[key];
    if (raw === undefined || String(raw).trim() === '') {
      problems.push(`${key} is missing`);
    } else {
      present[key] = String(raw).trim();
    }
  }

  const userId = Number(present.TELEGRAM_ALLOWED_USER_ID);
  if (present.TELEGRAM_ALLOWED_USER_ID && !Number.isInteger(userId)) {
    problems.push(`TELEGRAM_ALLOWED_USER_ID must be a Telegram numeric user id`);
  }

  if (present.TZ && !isKnownTimezone(present.TZ)) {
    problems.push(`TZ must be an IANA timezone name, e.g. America/Mexico_City`);
  }

  const sendHour = Number(present.REMINDER_SEND_HOUR);
  if (present.REMINDER_SEND_HOUR && !(Number.isInteger(sendHour) && sendHour >= 0 && sendHour <= 23)) {
    problems.push(`REMINDER_SEND_HOUR must be an hour from 0 to 23`);
  }

  let leadTimes = [];
  if (present.REMINDER_LEAD_TIMES) {
    const parsed = present.REMINDER_LEAD_TIMES.split(',').map((part) => Number(part.trim()));
    if (parsed.some((n) => !Number.isInteger(n) || n < 0)) {
      problems.push(`REMINDER_LEAD_TIMES must be a comma-separated list of whole days, e.g. 30,7,1`);
    } else {
      leadTimes = [...new Set(parsed)].sort((a, b) => b - a);
    }
  }

  if (problems.length > 0) throw ConfigError(problems);

  const config = {
    telegramBotToken: present.TELEGRAM_BOT_TOKEN,
    telegramAllowedUserId: userId,
    anthropicApiKey: present.ANTHROPIC_API_KEY,
    timezone: present.TZ,
    reminderLeadTimes: leadTimes,
    reminderSendHour: sendHour,
    gcsBackupBucket: present.GCS_BACKUP_BUCKET,
    dbPath: present.DB_PATH,
  };

  // Config is interpolated into boot logs and Telegram alerts, and an unhandled rejection
  // prints whatever it was carrying. Secrets are non-enumerable so they cannot ride along
  // into a message; property access still works normally.
  return redactSecrets(config, ['telegramBotToken', 'anthropicApiKey']);
}

function redactSecrets(config, secretKeys) {
  const safe = { ...config };
  for (const key of secretKeys) {
    delete safe[key];
    Object.defineProperty(safe, key, { value: config[key], enumerable: false, writable: false });
  }
  Object.defineProperty(safe, 'toString', {
    value: () => `[config ${JSON.stringify(safe)}]`,
    enumerable: false,
  });
  return Object.freeze(safe);
}

function readConfig() {
  return loadConfig(process.env);
}

module.exports = { loadConfig, readConfig, CONFIG_KEYS, ConfigError };
