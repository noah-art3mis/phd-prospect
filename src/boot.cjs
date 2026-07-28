// Boot: read the configuration, open the database, load the seed.
//
// Nothing here connects to Telegram or Anthropic. That ordering is the point of the ticket –
// the app must refuse to start on a bad configuration *before* any network connection, so a
// missing key surfaces at boot rather than hours later mid-ingest.

const fs = require('node:fs');
const path = require('node:path');

const { readConfig } = require('./config.cjs');
const { openStore } = require('./store.cjs');
const { loadSeed } = require('./seed.cjs');

const SEED_FILE = path.join(__dirname, '..', 'seed', 'opportunities.json');

function boot({ log = console.log, seedFile = SEED_FILE } = {}) {
  const config = readConfig();
  log(`config ok – timezone ${config.timezone}, lead times ${config.reminderLeadTimes.join(', ')}`);

  const store = openStore(config.dbPath);
  log(`database ready at ${config.dbPath}`);

  if (fs.existsSync(seedFile)) {
    const records = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
    const { inserted, skipped } = loadSeed(store, records, { zone: config.timezone });
    log(`seed: ${inserted} loaded, ${skipped} already present`);
  }

  log(`tracking ${store.countConfirmed()} opportunities`);
  return { config, store };
}

module.exports = { boot };
