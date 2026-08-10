#!/usr/bin/env node
// Restore the database from the backup bucket – the other half of `npm run backup`.
//
//     npm run restore              -- list what is in the bucket
//     npm run restore -- <object>  -- download it and replace the database
//
// Run it with the app stopped, and restart afterwards: a running process keeps its handle on
// the old file and would go on writing to a database that is no longer there.
//
// The downloaded file is staged beside the real one, opened, and counted before it replaces
// anything – a truncated or corrupt download must fail here, not at the next boot.

const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { AwsV4Signer } = require('aws4fetch');

const { readConfig } = require('../src/config.cjs');

async function s3Get(destination, suffix) {
  const { endpoint, bucket, accessKeyId, secretAccessKey, region = 'auto' } = destination;
  const url = `${String(endpoint).replace(/\/+$/, '')}/${bucket}${suffix}`;
  const signed = await new AwsV4Signer({
    url,
    method: 'GET',
    accessKeyId,
    secretAccessKey,
    service: 's3',
    region,
  }).sign();
  const response = await fetch(signed.url.toString(), {
    headers: signed.headers,
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error(`GET ${bucket}${suffix} failed (${response.status})`);
  return response;
}

async function listBackups(destination) {
  const body = await (await s3Get(destination, '?list-type=2')).text();
  return [...body.matchAll(/<Key>([^<]+)<\/Key>/g)].map((match) => match[1]).sort();
}

async function main(argv) {
  const config = readConfig();
  const destination = config.backupDestination;

  const objectName = argv[0];
  if (!objectName) {
    const keys = await listBackups(destination);
    if (keys.length === 0) {
      console.log(`${destination.bucket} is empty`);
    } else {
      for (const key of keys) console.log(key);
      console.log(`\nnpm run restore -- <object> to restore one`);
    }
    return;
  }

  const response = await s3Get(destination, `/${encodeURIComponent(objectName)}`);
  const bytes = Buffer.from(await response.arrayBuffer());

  const staging = `${config.dbPath}.restore`;
  fs.writeFileSync(staging, bytes);

  const database = new DatabaseSync(staging, { readOnly: true });
  const { n } = database.prepare('SELECT COUNT(*) AS n FROM opportunity WHERE confirmed = 1').get();
  database.close();

  fs.renameSync(staging, config.dbPath);
  // Leftover WAL and shared-memory files belong to the database that was just replaced;
  // paired with the restored file they would corrupt it on first open.
  fs.rmSync(`${config.dbPath}-wal`, { force: true });
  fs.rmSync(`${config.dbPath}-shm`, { force: true });

  console.log(`restored ${objectName} (${bytes.length} bytes) to ${config.dbPath}`);
  console.log(`tracking ${n} opportunities – restart the app so it opens the restored file`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
