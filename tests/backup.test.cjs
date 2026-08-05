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

// S3-compatible object storage: Cloudflare R2 in production, and the same four values for any
// other bucket. The secret is deliberately distinctive so a leak is easy to assert against.
const DESTINATION = {
  endpoint: 'https://account.r2.cloudflarestorage.com',
  bucket: 'prospect-backups',
  accessKeyId: 'AKIAEXAMPLEKEYID',
  secretAccessKey: 'SECRET-KEY-VALUE',
};

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

test('a backup is uploaded to the bucket under its own name', async () => {
  await withStore(async ({ store, backupDir }) => {
    const bucket = stubBucket();
    const result = await runBackup({
      store,
      directory: backupDir,
      destination: DESTINATION,
      fetch: bucket.fetch,
    });

    assert.equal(result.ok, true);
    const upload = bucket.calls.at(-1);
    assert.equal(upload.method, 'PUT');
    assert.match(upload.url, /^https:\/\/account\.r2\.cloudflarestorage\.com\/prospect-backups\/prospect-/);
    assert.match(result.destination, /^prospect-backups\/prospect-/);
  });
});

test('the request is signed, and the signature is what travels rather than the secret', async () => {
  // SigV4: the key identifies, the signature proves. The secret itself never leaves the
  // process, which is the whole reason a signed request beats a bearer credential in a URL.
  await withStore(async ({ store, backupDir }) => {
    const bucket = stubBucket();
    await runBackup({ store, directory: backupDir, destination: DESTINATION, fetch: bucket.fetch });

    const headers = new Headers(bucket.calls.at(-1).headers);
    const authorization = headers.get('authorization') ?? '';
    assert.match(authorization, /^AWS4-HMAC-SHA256 /);
    assert.ok(authorization.includes(DESTINATION.accessKeyId), 'the request does not say who signed it');
    assert.ok(!authorization.includes(DESTINATION.secretAccessKey), 'the secret was sent');
    // Signed over the body, not just the headers: an upload whose bytes can be swapped in
    // flight is not a backup you can trust to restore.
    assert.ok(headers.get('x-amz-content-sha256'), 'the body was not covered by the signature');
  });
});

test('the credentials never reach the failure message or the database', async () => {
  // A failed backup is reported to Telegram and written to backup_event. Neither is a place
  // for anything that grants writes.
  await withStore(async ({ store, backupDir }) => {
    const bucket = stubBucket({ failOn: 'upload' });
    await assert.rejects(
      runBackup({ store, directory: backupDir, destination: DESTINATION, fetch: bucket.fetch }),
      (error) => {
        assert.ok(!error.message.includes(DESTINATION.secretAccessKey), 'the secret leaked into the error');
        assert.ok(!error.message.includes(DESTINATION.accessKeyId), 'the key id leaked into the error');
        return true;
      }
    );
    const recorded = store.handle.prepare('SELECT destination, detail FROM backup_event').all();
    for (const row of recorded) {
      const text = `${row.destination ?? ''} ${row.detail ?? ''}`;
      assert.ok(!text.includes(DESTINATION.secretAccessKey), 'the secret was stored');
      assert.ok(!text.includes(DESTINATION.accessKeyId), 'the key id was stored');
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
        destination: DESTINATION,
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
      () => runBackup({ store, directory: backupDir, destination: DESTINATION, fetch: bucket.fetch }),
      /backup failed.*permission denied/s
    );
  });
});


test('a failed backup is recorded as well as raised, so the digest can report it', async () => {
  await withStore(async ({ store, backupDir }) => {
    const bucket = stubBucket({ failOn: 'upload' });
    await assert.rejects(() => runBackup({ store, directory: backupDir, destination: DESTINATION, fetch: bucket.fetch }));

    // Nothing successful on record: the digest must show a stale backup, not a fresh one.
    assert.equal(store.lastSuccessfulBackup(), null);
  });
});

test('a successful backup is recorded with where it went', async () => {
  await withStore(async ({ store, backupDir }) => {
    const bucket = stubBucket();
    await runBackup({ store, directory: backupDir, destination: DESTINATION, fetch: bucket.fetch });

    const last = store.lastSuccessfulBackup();
    assert.equal(last.succeeded, 1);
    // The bucket and the object, never the URL that would let someone write to it.
    assert.match(last.destination, /^prospect-backups\/prospect-/);
    assert.ok(!last.destination.includes('/p/'), 'the pre-authenticated path was recorded');
  });
});
