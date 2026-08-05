// Daily backup, and the same command by hand.
//
// The copy uses SQLite's own backup API, never a filesystem copy of a live database – a
// `cp` of a database mid-write produces a torn file that restores to nothing, and you find
// out when you need it.
//
// The scheduler and the user invoke exactly this function, so the path that runs nightly is
// the path that has been exercised by hand. Keeping an occasional copy outside the provider
// should be a habit rather than a project.
//
// The destination is S3-compatible object storage – Cloudflare R2 in production, but nothing
// here is R2-specific. The request is signed with SigV4, so what travels is a signature over
// this request and this body; the secret stays in the process. That is the property a URL
// carrying its own authority cannot have: a leaked signed request expires, a leaked
// pre-authenticated URL grants writes until someone notices.
//
// Signing is `aws4fetch` (about 4 KB) rather than the AWS SDK: one algorithm, no client
// lifecycle, no credential-file discovery, nothing to install on the box. The key id and the
// secret are still never allowed into a log, an error, or a database row.
//
// A failed backup raises the Telegram alert. Silent backup failure is the specific hazard
// this design defends against – it is why continuous WAL replication was rejected, since
// that fails silently by design.

const fs = require('node:fs');
const path = require('node:path');
const { backup } = require('node:sqlite');
const { AwsV4Signer } = require('aws4fetch');

function backupName(instant) {
  return `prospect-${instant.toISOString().replace(/[:.]/g, '-')}.db`;
}

// What may be said about the destination out loud. This string reaches a Telegram alert and a
// backup_event row, so it names the bucket and the object and stops there – never the
// endpoint's credentials and never the signed URL.
function describeDestination(destination, objectName) {
  return `${destination?.bucket ?? 'object storage'}/${objectName}`;
}

async function uploadBackup({ fetch, destination, objectName, bytes }) {
  const { endpoint, bucket, accessKeyId, secretAccessKey, region = 'auto' } = destination;
  const url = `${String(endpoint).replace(/\/+$/, '')}/${bucket}/${encodeURIComponent(objectName)}`;

  // Signed over the body as well as the headers: x-amz-content-sha256 is what makes a
  // swapped-in-flight upload fail rather than restore to something else.
  const signed = await new AwsV4Signer({
    url,
    method: 'PUT',
    body: bytes,
    headers: { 'content-type': 'application/octet-stream' },
    accessKeyId,
    secretAccessKey,
    service: 's3',
    region,
  }).sign();

  const response = await fetch(signed.url.toString(), {
    method: 'PUT',
    headers: signed.headers,
    body: bytes,
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`upload to ${describeDestination(destination, objectName)} failed (${response.status}) ${detail}`.trim());
  }
  return describeDestination(destination, objectName);
}

// Keep the last few on the box as well as off it, so recovering from a bad write does not
// depend on the network.
function pruneLocal(directory, keep) {
  const files = fs
    .readdirSync(directory)
    .filter((name) => /^prospect-.*\.db$/.test(name))
    .sort();
  const removed = files.slice(0, Math.max(0, files.length - keep));
  for (const name of removed) fs.rmSync(path.join(directory, name), { force: true });
  return removed;
}

async function runBackup({
  store,
  directory,
  destination,
  fetch = globalThis.fetch,
  keepLocal = 5,
  now = new Date(),
  upload = true,
}) {
  fs.mkdirSync(directory, { recursive: true });
  const localPath = path.join(directory, backupName(now));

  try {
    // The SQLite backup API: consistent even while the database is being written to.
    await backup(store.handle, localPath);

    // Where the copy ended up, in words fit for an alert: the local path when the upload is
    // skipped, the bucket and object when it is not.
    let wroteTo = localPath;
    if (upload) {
      wroteTo = await uploadBackup({
        fetch,
        destination,
        objectName: path.basename(localPath),
        bytes: fs.readFileSync(localPath),
      });
    }

    const pruned = pruneLocal(directory, keepLocal);
    store.recordBackup({ succeeded: true, destination: wroteTo, detail: null });
    return { ok: true, localPath, destination: wroteTo, pruned };
  } catch (error) {
    // Recorded as well as raised, so the weekly digest can report a stale backup rather than
    // the failure only existing in the alert that fired at the time.
    store.recordBackup({
      succeeded: false,
      destination: destination ? describeDestination(destination, '') : null,
      detail: error.message,
    });
    throw new Error(`backup failed: ${error.message}`);
  }
}

module.exports = { runBackup, backupName, pruneLocal };
