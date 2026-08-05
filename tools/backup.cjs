#!/usr/bin/env node
// Back up the database, on the same code path the nightly job uses.
//
//     npm run backup            -- copy locally and upload to the configured bucket
//     npm run backup -- --local -- copy locally only (a file you can grab and take away)
//
// No arguments, no setup: keeping an occasional copy outside the provider should be a habit
// rather than a project.

const path = require('node:path');

const { boot } = require('../src/boot.cjs');
const { runBackup } = require('../src/jobs/backup.cjs');

async function main(argv) {
  const { config, store } = boot({ log: () => {} });
  const directory = path.join(path.dirname(path.resolve(config.dbPath)), 'backups');

  try {
    const result = await runBackup({
      store,
      directory,
      destination: config.backupDestination,
      upload: !argv.includes('--local'),
    });
    console.log(result.localPath);
    if (result.destination !== result.localPath) console.log(result.destination);
    if (result.pruned.length > 0) console.log(`pruned ${result.pruned.length} older local copies`);
  } finally {
    store.close();
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
