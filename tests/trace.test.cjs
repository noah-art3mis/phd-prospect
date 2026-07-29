// Traces: the raw response, kept.
//
// Every fixture under tests/fixtures/ingest is a recorded API response, so a trace and a
// regression fixture are the same artifact. That is the whole design: what gets written here
// is the object that came off the wire, unaltered, so it can be gunzipped straight into the
// fixtures directory when a live run finds something the suite could not.
//
// The two live schema failures and the timeout bug all cost money to find because nothing
// kept what the API actually returned.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { createTraceWriter, RETENTION_DAYS } = require('../src/trace.cjs');

const RESPONSE = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'ingest', 'complete.json'), 'utf8')
);

function withDirectory(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prospect-trace-'));
  try {
    return run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const traces = (directory) => fs.readdirSync(directory).sort();
const readTrace = (directory, name) =>
  JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(directory, name))).toString('utf8'));

test('the response is written back byte-identical, so a trace can become a fixture', () => {
  withDirectory((directory) => {
    const writer = createTraceWriter({ directory, now: () => new Date('2026-07-28T10:00:00Z') });
    writer.record(RESPONSE, { url: 'https://uni.example/phd' });

    const [name] = traces(directory);
    assert.deepEqual(readTrace(directory, name), RESPONSE);
  });
});

test('traces are gzipped – a real one carries every page the model fetched', () => {
  // The committed fixtures are 5 KB because they are hand-trimmed. A live trace holds the
  // web_fetch_tool_result blocks, which is the fetched document, and those run to megabytes.
  withDirectory((directory) => {
    const writer = createTraceWriter({ directory, now: () => new Date('2026-07-28T10:00:00Z') });
    writer.record(RESPONSE, { url: 'https://uni.example/phd' });

    const [name] = traces(directory);
    assert.match(name, /\.json\.gz$/);
    assert.ok(
      fs.statSync(path.join(directory, name)).size < Buffer.byteLength(JSON.stringify(RESPONSE)),
      'the trace was not compressed'
    );
  });
});

test('a name carries the instant and the page, so a run can be found without opening files', () => {
  withDirectory((directory) => {
    const writer = createTraceWriter({ directory, now: () => new Date('2026-07-28T10:00:00Z') });
    writer.record(RESPONSE, { url: 'https://uni.example/phd' });
    writer.record(RESPONSE, { url: 'https://uni.example/phd' });

    const names = traces(directory);
    assert.equal(names.length, 2, 'the second call of one ingest overwrote the first');
    for (const name of names) assert.match(name, /^2026-07-28T10-00-00/);
  });
});

test('every call of one ingest is kept, not just the last', () => {
  // A paused call is where a resume loop goes wrong, and it is the call that gets replaced
  // if the name only identifies the ingest.
  withDirectory((directory) => {
    const writer = createTraceWriter({ directory, now: () => new Date('2026-07-28T10:00:00Z') });
    for (let i = 0; i < 3; i += 1) writer.record(RESPONSE, { url: 'https://uni.example/phd' });
    assert.equal(traces(directory).length, 3);
  });
});

test('traces older than the retention window are pruned; newer ones are kept', () => {
  withDirectory((directory) => {
    const now = new Date('2026-07-28T10:00:00Z');
    const old = new Date(now.getTime() - (RETENTION_DAYS + 1) * 86400000);

    createTraceWriter({ directory, now: () => old }).record(RESPONSE, { url: 'https://uni.example/old' });
    assert.equal(traces(directory).length, 1);

    createTraceWriter({ directory, now: () => now }).record(RESPONSE, { url: 'https://uni.example/new' });
    const kept = traces(directory);
    assert.equal(kept.length, 1, 'the expired trace was not pruned');
    assert.match(kept[0], /^2026-07-28/);
  });
});

test('nothing but a trace file is pruned', () => {
  // The directory is under data/, which the backup job also writes into. Deleting by age
  // without checking the name is how a prune eats something it did not create.
  withDirectory((directory) => {
    fs.writeFileSync(path.join(directory, 'prospect-2020-01-01.db'), 'not a trace');
    createTraceWriter({ directory, now: () => new Date('2026-07-28T10:00:00Z') }).record(RESPONSE, {
      url: 'https://uni.example/phd',
    });

    assert.ok(traces(directory).includes('prospect-2020-01-01.db'), 'the prune took a file it did not write');
  });
});

test('a trace that cannot be written is reported but does not fail the ingest', () => {
  // The record is worth up to $1.84 and the trace is a debugging convenience. A full disk
  // must not turn the expensive half of the job into nothing – but it must not be silent
  // either, or the traces are simply missing when they are next needed.
  withDirectory((directory) => {
    // A plain file where the directory should be: mkdir fails, and so would every write.
    const blocked = path.join(directory, 'traces');
    fs.writeFileSync(blocked, 'in the way');

    const reported = [];
    const writer = createTraceWriter({ directory: blocked, onError: (e) => reported.push(e) });

    assert.doesNotThrow(() => writer.record(RESPONSE, { url: 'https://uni.example/phd' }));
    assert.equal(reported.length, 1);
    assert.ok(reported[0] instanceof Error);
  });
});
