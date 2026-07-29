#!/usr/bin/env node
// One-time transform: Notion snapshot -> seed records for the standalone app.
//
// The Notion corpus predates the findings model. It stores flat scalar columns plus a single
// `Evidence` rich_text blob per opportunity, capped by Notion at 2000 characters. This recovers
// per-field evidence from that blob where the line survived the cap, and marks everything else
// `not_stated`. The deadline is the sole critical finding and is the one field whose evidence
// survives cleanly, because the Deadlines database carries its own excerpt and URL.
//
// Usage: node tools/notion-to-seed.cjs [snapshotDir] [outFile]

const fs = require('node:fs');
const path = require('node:path');

const NOTION_TEXT_LIMIT = 2000;

// Fields the seed carries as findings. Deliberately excludes the concepts cut from the model:
// application stage, opportunity status, priority, activities, documents.
const FINDING_FIELDS = [
  'institution',
  'department_or_lab',
  'opportunity_type',
  'country',
  'city',
  'programme',
  'summary',
  'research_topics',
  'supervisors',
  'duration',
  'application_url',
  'start_date',
  'deadline',
];

// Notion property name -> finding field. Notion's own labels are inconsistent with the
// ubiquitous language, so the mapping is explicit rather than derived from the column names.
const SCALAR_SOURCES = {
  institution: 'Institution',
  department_or_lab: 'Department or lab',
  opportunity_type: 'Type',
  country: 'Country',
  city: 'City',
  programme: 'Programme',
  summary: 'Summary',
  research_topics: 'Research topics',
  supervisors: 'Supervisors',
  duration: 'Duration',
  application_url: 'Application URL',
  start_date: 'Start date',
};

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Notion property readers. Each returns a string/null; empties normalise to null so that
// "present but blank" and "absent" collapse into one not_stated state.
function plainText(prop) {
  if (!prop) return null;
  const parts = prop[prop.type];
  if (!Array.isArray(parts)) return null;
  const text = parts.map((p) => p.plain_text ?? '').join('').trim();
  return text || null;
}

function selectName(prop) {
  return prop && prop.select ? prop.select.name : null;
}

function urlValue(prop) {
  return prop && prop.url ? prop.url : null;
}

function dateStart(prop) {
  return prop && prop.date ? prop.date.start : null;
}

function relationIds(prop) {
  return prop && Array.isArray(prop.relation) ? prop.relation.map((r) => r.id) : [];
}

function readScalar(props, notionName) {
  const prop = props[notionName];
  if (!prop) return null;
  switch (prop.type) {
    case 'title':
    case 'rich_text':
      return plainText(prop);
    case 'select':
      return selectName(prop);
    case 'url':
      return urlValue(prop);
    case 'date':
      return dateStart(prop);
    case 'number':
      return prop.number == null ? null : String(prop.number);
    default:
      return null;
  }
}

/**
 * Parse the flat `Evidence` blob into per-field {excerpt, url}.
 *
 * Lines look like `field: some excerpt text (https://source)`. A line with no parenthesised
 * URL carries no verifiable source and is discarded. When the blob hit Notion's character cap
 * the final line is cut mid-value, so its excerpt would misquote the page: drop it.
 */
function parseEvidenceBlob(blob, truncated) {
  if (!blob) return {};
  const lines = blob.split('\n').filter((l) => l.trim());
  const usable = truncated ? lines.slice(0, -1) : lines;

  const out = {};
  for (const line of usable) {
    const match = /^([a-z_]+):\s*(.*)\s\((https?:\/\/[^\s)]+)\)\s*$/.exec(line.trim());
    if (!match) continue;
    const [, field, excerpt, url] = match;
    const text = excerpt.trim();
    if (!text) continue;
    out[field] = { excerpt: text, url };
  }
  return out;
}

function finding(value, evidence) {
  if (value == null) return { state: 'not_stated', value: null, evidence: [] };
  return { state: 'found', value, evidence: evidence || [] };
}

function buildSeedRecords(snapshotDir) {
  const opportunities = readJson(path.join(snapshotDir, 'opportunities.json'));
  const deadlines = readJson(path.join(snapshotDir, 'deadlines.json'));
  const contacts = readJson(path.join(snapshotDir, 'contacts.json'));

  // Deadlines and contacts point at opportunities, so invert the relation once.
  const deadlinesByOpportunity = new Map();
  for (const row of deadlines.rows) {
    for (const id of relationIds(row.properties.Opportunity)) {
      if (!deadlinesByOpportunity.has(id)) deadlinesByOpportunity.set(id, []);
      deadlinesByOpportunity.get(id).push(row);
    }
  }

  const contactsByOpportunity = new Map();
  for (const row of contacts.rows) {
    for (const id of relationIds(row.properties.Opportunity)) {
      if (!contactsByOpportunity.has(id)) contactsByOpportunity.set(id, []);
      contactsByOpportunity.get(id).push(row);
    }
  }

  return opportunities.rows.map((row) => {
    const props = row.properties;
    const blob = plainText(props.Evidence) || '';
    const evidence = parseEvidenceBlob(blob, blob.length >= NOTION_TEXT_LIMIT);

    // Every excerpt in the blob was gathered in one pass, timestamped by "Last checked".
    const retrievedAt = dateStart(props['Last checked']) || row.last_edited_time;

    const findings = {};
    for (const field of FINDING_FIELDS) {
      if (field === 'deadline') continue;
      const value = readScalar(props, SCALAR_SOURCES[field]);
      const cited = evidence[field];
      findings[field] = finding(
        value,
        cited ? [{ url: cited.url, retrieved_at: retrievedAt, excerpt: cited.excerpt }] : []
      );
    }

    // The deadline is the sole critical finding: it may only be `found` with evidence, so a
    // deadline row lacking an excerpt or URL yields not_stated rather than an ungated value.
    const linked = deadlinesByOpportunity.get(row.id) || [];
    const dated = linked
      .map((d) => ({
        due: dateStart(d.properties.Due),
        excerpt: plainText(d.properties['Evidence excerpt']),
        url: urlValue(d.properties['Evidence URL']),
      }))
      .filter((d) => d.due && d.excerpt && d.url)
      .sort((a, b) => a.due.localeCompare(b.due));

    // Notion allowed several deadlines per opportunity; the scalar model keeps the earliest,
    // which is the operative one — the date by which action is due.
    const operative = dated[0] || null;
    findings.deadline = operative
      ? finding(operative.due, [
          { url: operative.url, retrieved_at: retrievedAt, excerpt: operative.excerpt },
        ])
      : finding(null, []);

    const relatedContacts = (contactsByOpportunity.get(row.id) || [])
      .map(contactRecord)
      .filter((c) => c.name);

    return {
      title: plainText(props.Name),
      source_url: urlValue(props['Source URL']) || urlValue(props['Canonical URL']),
      canonical_url: urlValue(props['Canonical URL']),
      institution: readScalar(props, 'Institution'),
      deadline_at: operative ? operative.due : null,
      confirmed: Boolean(props.Confirmed && props.Confirmed.checkbox),
      findings,
      contacts: relatedContacts,
      references: [urlValue(props['Source URL']), urlValue(props['Canonical URL'])].filter(Boolean),
      seeded_from_notion: row.id,
    };
  });
}

function contactRecord(row) {
  return {
    name: plainText(row.properties.Name),
    role: selectName(row.properties.Role),
    email: row.properties.Email ? row.properties.Email.email : null,
    profile_url: urlValue(row.properties['Profile URL']),
    institution_or_lab: plainText(row.properties['Institution or lab']),
    research_topics: plainText(row.properties['Research topics']),
    notes: plainText(row.properties.Notes),
  };
}

/**
 * Contacts with no Opportunity relation. In the snapshot this is all of them: the relation was
 * never filled in on either side. They cannot be placed on a record without guessing an owner,
 * and there is no contacts table in the new model, so they are exported on their own.
 */
function collectUnlinkedContacts(snapshotDir) {
  const contacts = readJson(path.join(snapshotDir, 'contacts.json'));
  return contacts.rows
    .filter((row) => relationIds(row.properties.Opportunity).length === 0)
    .map(contactRecord)
    .filter((c) => c.name);
}

function main() {
  const snapshotDir = process.argv[2] || path.join(__dirname, '..', 'notion-snapshot');
  const outFile = process.argv[3] || path.join(__dirname, '..', 'seed', 'opportunities.json');

  const records = buildSeedRecords(snapshotDir);
  const orphans = collectUnlinkedContacts(snapshotDir);
  const orphanFile = path.join(path.dirname(outFile), 'contacts-unlinked.json');

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  fs.writeFileSync(orphanFile, `${JSON.stringify(orphans, null, 2)}\n`, 'utf8');

  const withDeadline = records.filter((r) => r.deadline_at !== null).length;
  const evidenced = records.reduce(
    (n, r) => n + Object.values(r.findings).filter((f) => f.evidence.length).length,
    0
  );
  process.stdout.write(
    `${records.length} opportunities -> ${outFile}\n` +
      `  ${withDeadline} with an evidenced deadline, ${evidenced} evidenced findings total\n` +
      `${orphans.length} unlinked contacts -> ${orphanFile}\n`
  );
}

if (require.main === module) main();

module.exports = { parseEvidenceBlob, buildSeedRecords, collectUnlinkedContacts, FINDING_FIELDS };
