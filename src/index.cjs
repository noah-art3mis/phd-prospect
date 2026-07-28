#!/usr/bin/env node
// The entry point. One long-running process owning the Telegram bot, the ingest pipeline,
// the scheduled jobs, and (later) the web UI.
//
// `--check` boots and exits, which is what CI and a post-deploy smoke test want: it proves
// the configuration is complete and the database opens, without connecting to anything.

const { boot } = require('./boot.cjs');

function main(argv) {
  let booted;
  try {
    booted = boot();
  } catch (error) {
    // Nothing has connected yet, so there is no alert channel to report through – stderr and
    // a non-zero exit are the whole contract.
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  if (argv.includes('--check')) {
    booted.store.close();
    return;
  }

  const { run } = require('./app.cjs');
  run(booted);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { main };
