// Loading the Notion seed into the store.
//
// The transform itself is already built and tested (tools/notion-to-seed.cjs); this only
// loads its committed output. The one rule worth stating: seeded rows cross the same
// validate() seam as live ingest, so the seed is not a back door into the database. A row
// that would fail the deadline evidence rule is rejected rather than written.
//
// Idempotent on canonical URL, because there is no migration framework — the schema changes
// by recreating the database and reseeding, and reseeding must not duplicate what is there.

const { validate } = require('./core/validate.cjs');
const { canonicalizeUrl } = require('./core/url.cjs');
const { resolveDeadline } = require('./core/deadline.cjs');

function loadSeed(store, records, { zone = 'UTC' } = {}) {
  // Validate everything before writing anything: a seed that is half-loaded because the
  // fifth record was malformed is worse than one that refused to load at all.
  const accepted = records.map((record) => {
    validate(record);
    return {
      ...record,
      canonical_url: record.canonical_url || canonicalizeUrl(record.source_url),
      deadline_at: resolveDeadline(record.deadline_at, zone),
      seeded: true,
    };
  });

  let inserted = 0;
  let skipped = 0;
  for (const record of accepted) {
    if (store.findConfirmedByUrl(record.canonical_url)) {
      skipped += 1;
      continue;
    }
    store.insertCandidate(record);
    inserted += 1;
  }
  return { inserted, skipped };
}

module.exports = { loadSeed };
