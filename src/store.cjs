// SQLite storage – one `opportunity` table, opened from a file path.
//
// Scalar columns for what is queried or sorted on; JSON columns for the lists that are only
// ever read with the opportunity. Storing lists-of-objects natively - supervisors, evidence,
// contacts - is what this schema is shaped around: the previous store could not do it, and
// working around that was most of what made it painful.
//
// Supervisors, research topics and per-field evidence deliberately have no columns of their
// own: they are findings, and they travel inside `findings`. A second copy in its own column
// would be a second place for the same fact to be wrong.
//
// A pending candidate is an unconfirmed row in this same table. Keeping approval its own
// boolean makes "skip unapproved rows" one predicate that every query applies, rather than
// a value buried in an enum where it is possible to forget.
//
// This is a thin IO edge: no decisions live here. The reminder logic, validation and URL
// canonicalization are pure modules under src/core.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { canonicalizeUrl } = require('./core/url.cjs');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS opportunity (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT    NOT NULL,
  source_url     TEXT    NOT NULL,
  canonical_url  TEXT    NOT NULL,
  institution    TEXT,
  deadline_at    TEXT,             -- UTC instant, or NULL for rolling admission
  confirmed      INTEGER NOT NULL DEFAULT 0,
  findings       TEXT    NOT NULL DEFAULT '{}',
  contacts       TEXT    NOT NULL DEFAULT '[]',
  "references"   TEXT    NOT NULL DEFAULT '[]',
  reminders_sent TEXT    NOT NULL DEFAULT '[]',
  prompt_hash    TEXT,
  seeded         INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS opportunity_canonical_url ON opportunity (canonical_url);
CREATE INDEX IF NOT EXISTS opportunity_due ON opportunity (confirmed, deadline_at);

-- Token usage, for the weekly digest's approximate spend. One row per model call.
--
-- Three input columns because there are three input prices: fresh input at the base rate, a
-- cache read at a tenth of it, a cache write at a quarter above it. One summed column would
-- price a cached week exactly like an uncached one.
CREATE TABLE IF NOT EXISTS usage_event (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at       TEXT    NOT NULL,
  model             TEXT    NOT NULL,
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0
);

-- Backup outcomes, so the digest can report the age of the last successful one rather than
-- only the alert that fired at the time.
CREATE TABLE IF NOT EXISTS backup_event (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT    NOT NULL,
  succeeded   INTEGER NOT NULL,
  destination TEXT,
  detail      TEXT
);
`;

const JSON_COLUMNS = ['findings', 'contacts', 'references', 'reminders_sent'];

// What updateOpportunity is allowed to write. The column name is an identifier, so it cannot
// be a bound parameter and has to be interpolated – which means the set of things that can
// appear there must be closed rather than checked. Today's only caller already constrains
// its fields, but that is its invariant, not this one's.
const UPDATABLE_COLUMNS = new Set([
  'title',
  'source_url',
  'canonical_url',
  'institution',
  'deadline_at',
  'findings',
  'contacts',
  'references',
  'reminders_sent',
]);

// CREATE TABLE IF NOT EXISTS is silent about a table that exists with the wrong columns, so
// a database written before a column was added would keep working until the first insert
// against it. Adding what is missing on open keeps the running instance upgradeable in place.
function ensureColumns(db, table, columns) {
  const present = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const [name, definition] of Object.entries(columns)) {
    if (!present.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

function hydrate(row) {
  if (!row) return null;
  const out = { ...row, confirmed: row.confirmed === 1, seeded: row.seeded === 1 };
  for (const column of JSON_COLUMNS) out[column] = JSON.parse(row[column]);
  return out;
}

function openStore(dbPath, { now = () => new Date().toISOString() } = {}) {
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  ensureColumns(db, 'usage_event', {
    cache_read_tokens: 'INTEGER NOT NULL DEFAULT 0',
    cache_write_tokens: 'INTEGER NOT NULL DEFAULT 0',
  });

  const statements = {
    insert: db.prepare(`
      INSERT INTO opportunity
        (title, source_url, canonical_url, institution, deadline_at, confirmed,
         findings, contacts, "references", reminders_sent, prompt_hash, seeded, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    byId: db.prepare('SELECT * FROM opportunity WHERE id = ?'),
    byCanonicalUrl: db.prepare('SELECT * FROM opportunity WHERE canonical_url = ? AND confirmed = 1 LIMIT 1'),
    confirm: db.prepare('UPDATE opportunity SET confirmed = 1, updated_at = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM opportunity WHERE id = ?'),
    setReminders: db.prepare('UPDATE opportunity SET reminders_sent = ?, updated_at = ? WHERE id = ?'),
    listConfirmed: db.prepare(`
      SELECT * FROM opportunity WHERE confirmed = 1
      ORDER BY deadline_at IS NULL, deadline_at, id
    `),
    countConfirmed: db.prepare('SELECT COUNT(*) AS n FROM opportunity WHERE confirmed = 1'),
    recordUsage: db.prepare(`
      INSERT INTO usage_event
        (occurred_at, model, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    usageSince: db.prepare(`
      SELECT COALESCE(SUM(input_tokens), 0)       AS input_tokens,
             COALESCE(SUM(cache_read_tokens), 0)  AS cache_read_tokens,
             COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
             COALESCE(SUM(output_tokens), 0)      AS output_tokens,
             COUNT(*) AS calls
      FROM usage_event WHERE occurred_at >= ?
    `),
    recordBackup: db.prepare(
      'INSERT INTO backup_event (occurred_at, succeeded, destination, detail) VALUES (?, ?, ?, ?)'
    ),
    lastBackup: db.prepare(
      'SELECT * FROM backup_event WHERE succeeded = 1 ORDER BY occurred_at DESC LIMIT 1'
    ),
  };

  return {
    // Save a candidate. Unconfirmed unless the caller says otherwise (the seed does, having
    // already been through a human once in the build these records came from).
    insertCandidate(candidate) {
      const stamp = now();
      const result = statements.insert.run(
        candidate.title,
        candidate.source_url,
        candidate.canonical_url || canonicalizeUrl(candidate.source_url),
        candidate.institution ?? null,
        candidate.deadline_at ?? null,
        candidate.confirmed ? 1 : 0,
        JSON.stringify(candidate.findings ?? {}),
        JSON.stringify(candidate.contacts ?? []),
        JSON.stringify(candidate.references ?? []),
        JSON.stringify(candidate.reminders_sent ?? []),
        candidate.prompt_hash ?? null,
        candidate.seeded ? 1 : 0,
        stamp,
        stamp
      );
      return Number(result.lastInsertRowid);
    },

    getOpportunity(id) {
      return hydrate(statements.byId.get(id));
    },

    // The re-submission short-circuit: confirmed rows only, so a pending candidate never
    // suppresses a fresh ingest.
    findConfirmedByUrl(url) {
      return hydrate(statements.byCanonicalUrl.get(canonicalizeUrl(url)));
    },

    confirmOpportunity(id) {
      statements.confirm.run(now(), id);
    },

    // Reject. No rejected-history is kept, so resubmitting a rejected link runs the full
    // call again – accepted as a simplification.
    deleteOpportunity(id) {
      statements.remove.run(id);
    },

    updateOpportunity(id, changes) {
      const columns = Object.keys(changes);
      if (columns.length === 0) return;
      for (const column of columns) {
        if (!UPDATABLE_COLUMNS.has(column)) throw new Error(`'${column}' is not an updatable column`);
      }
      const assignments = columns.map((c) => `"${c}" = ?`).join(', ');
      const values = columns.map((c) => (JSON_COLUMNS.includes(c) ? JSON.stringify(changes[c]) : changes[c]));
      db.prepare(`UPDATE opportunity SET ${assignments}, updated_at = ? WHERE id = ?`).run(
        ...values,
        now(),
        id
      );
    },

    recordRemindersSent(id, leadTimes) {
      statements.setReminders.run(JSON.stringify(leadTimes), now(), id);
    },

    listConfirmed() {
      return statements.listConfirmed.all().map(hydrate);
    },

    countConfirmed() {
      return statements.countConfirmed.get().n;
    },

    recordUsage({ model, inputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0, outputTokens = 0 }) {
      statements.recordUsage.run(now(), model, inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens);
    },

    usageSince(instant) {
      return statements.usageSince.get(instant);
    },

    recordBackup({ succeeded, destination = null, detail = null }) {
      statements.recordBackup.run(now(), succeeded ? 1 : 0, destination, detail);
    },

    lastSuccessfulBackup() {
      return statements.lastBackup.get() ?? null;
    },

    // The handle itself, for the backup job's .backup() call.
    handle: db,

    close() {
      db.close();
    },
  };
}

module.exports = { openStore, SCHEMA };
