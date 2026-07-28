// Daily backup, and the same command by hand.
//
// The copy uses SQLite's own backup API, never a filesystem copy of a live database — a
// `cp` of a database mid-write produces a torn file that restores to nothing, and you find
// out when you need it.
//
// The scheduler and the user invoke exactly this function, so the path that runs nightly is
// the path that has been exercised by hand. Keeping an occasional copy outside the provider
// should be a habit rather than a project.
//
// No credential is needed: the service account attached to the instance is read from the
// metadata server, so the component most likely to break from an expired key has no key.
//
// A failed backup raises the Telegram alert. Silent backup failure is the specific hazard
// this design defends against — it is why continuous WAL replication was rejected, since
// that fails silently by design.

const fs = require('node:fs');
const path = require('node:path');
const { backup } = require('node:sqlite');

const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

function backupName(instant) {
  return `prospect-${instant.toISOString().replace(/[:.]/g, '-')}.db`;
}

// An access token from the instance's attached service account. No key file exists to
// expire, be rotated, or be committed by accident.
async function instanceAccessToken(fetch) {
  const response = await fetch(METADATA_TOKEN_URL, {
    headers: { 'Metadata-Flavor': 'Google' },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    throw new Error(`could not read the instance service account (${response.status})`);
  }
  const { access_token: token } = await response.json();
  if (!token) throw new Error('the metadata server returned no access token');
  return token;
}

async function uploadToBucket({ fetch, bucket, objectName, bytes }) {
  const token = await instanceAccessToken(fetch);
  const url =
    `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o` +
    `?uploadType=media&name=${encodeURIComponent(objectName)}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
    body: bytes,
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`upload to gs://${bucket} failed (${response.status}) ${detail}`.trim());
  }
  return `gs://${bucket}/${objectName}`;
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
  bucket,
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

    let destination = localPath;
    if (upload) {
      destination = await uploadToBucket({
        fetch,
        bucket,
        objectName: path.basename(localPath),
        bytes: fs.readFileSync(localPath),
      });
    }

    const pruned = pruneLocal(directory, keepLocal);
    store.recordBackup({ succeeded: true, destination, detail: null });
    return { ok: true, localPath, destination, pruned };
  } catch (error) {
    // Recorded as well as raised, so the weekly digest can report a stale backup rather than
    // the failure only existing in the alert that fired at the time.
    store.recordBackup({ succeeded: false, destination: bucket ? `gs://${bucket}` : null, detail: error.message });
    throw new Error(`backup failed: ${error.message}`);
  }
}

module.exports = { runBackup, backupName, pruneLocal };
