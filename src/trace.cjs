// Traces: the raw API response, kept on disk.
//
// Every fixture under tests/fixtures/ingest is a recorded response, which makes a trace and
// a regression fixture the same artifact. So this writes the object exactly as it came off
// the wire – no summary, no projection – and a live run that finds something the suite could
// not becomes a test by being gunzipped into that directory.
//
// One response holds more than a debug log would: the whole server-side tool loop travels in
// `content`, every server_tool_use with the URL it fetched and every web_fetch_tool_result
// with what came back, in order, alongside the exact `usage` the call was billed on. The two
// schema failures and the timeout bug all cost money to find because none of that was kept.
//
// Written into data/, which is volume-mounted, but not into the backup: runBackup copies the
// database and nothing else, so traces stay on the box by construction.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// Long enough to cover a spend surprise noticed at the end of a month, short enough that a
// megabyte-scale trace per ingest cannot fill the disk of the smallest instance.
const RETENTION_DAYS = 30;

// Matches only what traceName writes, and captures the instant back out of it. Age comes
// from the name rather than from mtime because a restored or copied file keeps its name and
// loses its timestamps.
const TRACE_NAME = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-[0-9a-f]{8}-[0-9a-f]{6}\.json\.gz$/;

// The instant first, so the directory sorts chronologically; then the page, so one advert's
// runs can be found without opening anything; then a random suffix, because a resume loop
// makes several calls that can land in the same millisecond and each one is worth keeping.
function traceName(instant, url) {
  const stamp = instant.toISOString().replace(/[:.]/g, '-');
  const page = crypto.createHash('sha256').update(url ?? '').digest('hex').slice(0, 8);
  return `${stamp}-${page}-${crypto.randomBytes(3).toString('hex')}.json.gz`;
}

// By name rather than by mtime alone: the directory sits under data/, and a prune that
// deletes whatever is old enough would eventually take something it did not write.
function prune(directory, before) {
  for (const name of fs.readdirSync(directory)) {
    const parts = TRACE_NAME.exec(name);
    if (!parts) continue;
    const [, day, hour, minute, second, ms] = parts;
    if (Date.parse(`${day}T${hour}:${minute}:${second}.${ms}Z`) >= before) continue;
    fs.rmSync(path.join(directory, name), { force: true });
  }
}

function createTraceWriter({
  directory,
  retentionDays = RETENTION_DAYS,
  now = () => new Date(),
  onError = (error) => console.error(`trace not written: ${error.message}`),
}) {
  return {
    // Best-effort on purpose, and the one place in this module that swallows anything: the
    // record it belongs to costs real money to produce, and losing it because a disk filled
    // would be the expensive failure defending the cheap one.
    record(response, { url } = {}) {
      try {
        fs.mkdirSync(directory, { recursive: true });
        const instant = now();
        fs.writeFileSync(
          path.join(directory, traceName(instant, url)),
          zlib.gzipSync(JSON.stringify(response))
        );
        prune(directory, instant.getTime() - retentionDays * 86400000);
      } catch (error) {
        onError(error);
      }
    },
  };
}

module.exports = { createTraceWriter, traceName, RETENTION_DAYS };
