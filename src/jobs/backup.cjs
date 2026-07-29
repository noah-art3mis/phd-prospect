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
// The destination is a pre-authenticated URL: object storage issues one that grants writes
// to a single bucket, and it carries its own authority, so the upload sends no credential and
// there is no SDK, no request signing and no key file to install. The trade is that the URL
// *is* the credential - it lives in .env and expires on the date it was issued with - so it
// is write-only, scoped to one bucket, and never allowed into a log, an error or a database
// row where a leaked backup message would disclose it.
//
// A failed backup raises the Telegram alert. Silent backup failure is the specific hazard
// this design defends against – it is why continuous WAL replication was rejected, since
// that fails silently by design.

const fs = require('node:fs');
const path = require('node:path');
const { backup } = require('node:sqlite');

function backupName(instant) {
  return `prospect-${instant.toISOString().replace(/[:.]/g, '-')}.db`;
}

// What may be said about the destination out loud. The URL grants writes to whoever holds it,
// and this string reaches a Telegram alert and a backup_event row, so it names the bucket and
// stops there.
function describeDestination(uploadUrl, objectName) {
  const bucket = /\/b\/([^/]+)\//.exec(String(uploadUrl))?.[1] ?? 'object storage';
  return `${bucket}/${objectName}`;
}

async function uploadBackup({ fetch, uploadUrl, objectName, bytes }) {
  const response = await fetch(`${uploadUrl}${encodeURIComponent(objectName)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: bytes,
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    // Deliberately not the URL: a failed upload is reported to Telegram and written to the
    // database, and neither is a place to put something that grants writes.
    throw new Error(`upload to ${describeDestination(uploadUrl, objectName)} failed (${response.status}) ${detail}`.trim());
  }
  return describeDestination(uploadUrl, objectName);
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
  uploadUrl,
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
      destination = await uploadBackup({
        fetch,
        uploadUrl,
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
    store.recordBackup({
      succeeded: false,
      destination: uploadUrl ? describeDestination(uploadUrl, '') : null,
      detail: error.message,
    });
    throw new Error(`backup failed: ${error.message}`);
  }
}

module.exports = { runBackup, backupName, pruneLocal };
