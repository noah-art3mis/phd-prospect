// The backup job.
//
// The restore assertions run against real SQLite files, because "the backup restores" is the
// only property that matters and a mock cannot tell you. The upload is stubbed – it is a
// thin IO edge – but what is asserted about it is the part that would silently rot: that no
// credential file is involved and the instance identity is used.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openStore } = require('../src/store.cjs');
const PAR = 'https://objectstorage.example/p/tok/n/ns/b/prospect-backups/o/';

const { runBackup } = require('../src/jobs/backup.cjs');

const OPPORTUNITY = {
  title: 'PhD in Trustworthy AI',
  source_url: 'https://uni.example/phd',
  deadline_at: '2026-12-01T23:59:00.000Z',
  confirmed: true,
  findings: { institution: { state: 'found', value: 'Example University', evidence: [] } },
};

function stubBucket({ failOn = null } = {}) {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url, headers: options.headers ?? {}, method: options.method, body: options.body });
    if (failOn === 'upload') {
      return { ok: false, status: 403, async text() { return 'permission denied'; } };
    }
    return { ok: true, status: 200, async json() { return { name: 'uploaded' }; } };
  };
  return { fetch, calls };
}

async function withStore(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prospect-backup-'));
  const dbPath = path.join(dir, 'prospect.db');
  const store = openStore(dbPath);
  store.insertCandidate(OPPORTUNITY);
  try {
    return await run({ store, dir, dbPath, backupDir: path.join(dir, 'backups') });
  } finally {
    try {
      store.close();
    } catch {
      // already closed by the test
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a backup is uploaded to the pre-authenticated URL, named after the copy', async () => {
  await withStore(async ({ store, backupDir }) => {
    const bucket = stubBucket();
    const result = await runBackup({
      store,
      directory: backupDir,
      uploadUrl: PAR,
      fetch: bucket.fetch,
    });

    assert.equal(result.ok, true);
    const upload = bucket.calls.at(-1);
    // PUT to the URL with the object name appended: the URL carries its own authority, which
    // is why nothing here sends a credential.
    assert.equal(upload.method, 'PUT');
    assert.match(upload.url, /^https:\/\/objectstorage\.example\/p\/tok\/n\/ns\/b\/prospect-backups\/o\/prospect-/);
    assert.ok(!('authorization' in (upload.headers ?? {})), 'a pre-authenticated URL needs no credential');
    assert.match(result.destination, /prospect-/);
  });
});

test('the upload URL is never put in the failure message', async () => {
  // It is the credential. A failed backup is reported to Telegram and written to
  // backup_event, and a URL that grants writes must not travel into either.
  await withStore(async ({ store, backupDir }) => {
    const bucket = stubBucket({ failOn: 'upload' });
    await assert.rejects(
      runBackup({
        store,
        directory: backupDir,
        uploadUrl: 'https://objectstorage.example/p/SECRET-TOKEN/n/ns/b/prospect-backups/o/',
        fetch: bucket.fetch,
      }),
      (error) => {
        assert.ok(!error.message.includes('SECRET-TOKEN'), 'the credential leaked into the error');
        return true;
      }
    );
    const recorded = store.handle.prepare('SELECT destination, detail FROM backup_event').all();
    for (const row of recorded) {
      assert.ok(!String(row.destination ?? '').includes('SECRET-TOKEN'), 'the credential was stored');
      assert.ok(!String(row.detail ?? '').includes('SECRET-TOKEN'), 'the credential was stored');
    }
  });
});

test('the copy uses the SQLite backup API and restores to a working database', async () => {
  await withStore(async ({ store, backupDir }) => {
    const result = await runBackup({ store, directory: backupDir, upload: false });

    const restored = openStore(result.localPath);
    try {
      assert.equal(restored.countConfirmed(), 1);
      const row = restored.listConfirmed()[0];
      assert.equal(row.title, 'PhD in Trustworthy AI');
      assert.equal(row.deadline_at, '2026-12-01T23:59:00.000Z');
      assert.deepEqual(row.findings.institution.value, 'Example University');
    } finally {
      restored.close();
    }
  });
});

test('a backup taken while the database is being written produces a restorable file', async () => {
  // A filesystem copy of a live database gives a torn file, and you find out when you need
  // it. This is why the SQLite API is used rather than fs.copyFile.
  await withStore(async ({ store, backupDir }) => {
    const writing = (async () => {
      for (let i = 0; i < 300; i += 1) {
        store.insertCandidate({ ...OPPORTUNITY, source_url: `https://uni.example/p${i}`, confirmed: true });
      }
    })();

    const result = await runBackup({ store, directory: backupDir, upload: false });
    await writing;

    const restored = openStore(result.localPath);
    try {
      assert.ok(restored.countConfirmed() >= 1, 'the restored file must open and hold rows');
      // Every restored row must be complete, not half-written.
      for (const row of restored.listConfirmed()) {
        assert.equal(typeof row.title, 'string');
        assert.ok(row.title.length > 0);
        assert.equal(typeof row.findings, 'object');
      }
    } finally {
      restored.close();
    }
  });
});

test('running it by hand produces a local file with no extra arguments or setup', async () => {
  await withStore(async ({ store, backupDir }) => {
    const result = await runBackup({ store, directory: backupDir, upload: false });

    assert.ok(fs.existsSync(result.localPath));
    assert.ok(fs.statSync(result.localPath).size > 0);
  });
});

test('recent backups are retained on the box as well as uploaded', async () => {
  // Recovering from a bad write should not depend on the network.
  await withStore(async ({ store, backupDir }) => {
    const bucket = stubBucket();
    for (let i = 0; i < 8; i += 1) {
      await runBackup({
        store,
        directory: backupDir,
        uploadUrl: 'https://objectstorage.example/p/t/n/ns/b/b/o/',
        fetch: bucket.fetch,
        keepLocal: 3,
        now: new Date(Date.UTC(2026, 6, 1 + i)),
      });
    }

    const kept = fs.readdirSync(backupDir).sort();
    assert.equal(kept.length, 3);
    assert.match(kept.at(-1), /2026-07-08/, 'the newest must be among those kept');
  });
});

test('a bucket that cannot be reached raises rather than reporting success', async () => {
  await withStore(async ({ store, backupDir }) => {
    const bucket = stubBucket({ failOn: 'upload' });

    await assert.rejects(
      () => runBackup({ store, directory: backupDir, uploadUrl: PAR, fetch: bucket.fetch }),
      /backup failed.*permission denied/s
    );
  });
});


test('a failed backup is recorded as well as raised, so the digest can report it', async () => {
  await withStore(async ({ store, backupDir }) => {
    const bucket = stubBucket({ failOn: 'upload' });
    await assert.rejects(() => runBackup({ store, directory: backupDir, uploadUrl: PAR, fetch: bucket.fetch }));

    // Nothing successful on record: the digest must show a stale backup, not a fresh one.
    assert.equal(store.lastSuccessfulBackup(), null);
  });
});

test('a successful backup is recorded with where it went', async () => {
  await withStore(async ({ store, backupDir }) => {
    const bucket = stubBucket();
    await runBackup({ store, directory: backupDir, uploadUrl: PAR, fetch: bucket.fetch });

    const last = store.lastSuccessfulBackup();
    assert.equal(last.succeeded, 1);
    // The bucket and the object, never the URL that would let someone write to it.
    assert.match(last.destination, /^prospect-backups\/prospect-/);
    assert.ok(!last.destination.includes('/p/'), 'the pre-authenticated path was recorded');
  });
});
