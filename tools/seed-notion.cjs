// Seed Notion data sources from local, git-ignored seed files.
//
// Ported from src/prospect/seed.py + notion_pages.contact_page_payload. The
// contact-page payload builder lived in notion_pages.py with the opportunity
// payload; the opportunity payload is now only in n8n/code/build-opportunity-payload.js
// (the live logic), so its contact sibling moves here, its only remaining caller.
//
// Usage:
//     node tools/seed-notion.cjs <contacts.json> [--data-sources <file>] [--data-source-id <id>]
// Reads NOTION_TOKEN from the environment.

const fs = require('fs');
const { notionClient } = require('./bootstrap-notion.cjs');

function title(value) {
  return { title: [{ type: 'text', text: { content: String(value).slice(0, 2000) } }] };
}

function richText(value) {
  if (!value) return { rich_text: [] };
  return { rich_text: [{ type: 'text', text: { content: String(value).slice(0, 2000) } }] };
}

// Build a Notion contact page from a seed record.
function contactPagePayload(dataSourceId, contact) {
  const properties = {
    Name: title(String(contact.name)),
    'Institution or lab': richText(String(contact.institution_or_lab || '')),
    'Research topics': richText(String(contact.research_topics || '')),
    Notes: richText(String(contact.notes || '')),
    'Response status': { select: { name: 'Not contacted' } },
  };
  if (contact.role) properties.Role = { select: { name: String(contact.role) } };
  if (contact.email) properties.Email = { email: String(contact.email) };
  if (contact.profile_url) properties['Profile URL'] = { url: String(contact.profile_url) };
  return {
    parent: { type: 'data_source_id', data_source_id: dataSourceId },
    properties,
  };
}

// Create one contact page per seed record; return the created page IDs.
async function seedContacts(dataSourceId, contacts, { request }) {
  const created = [];
  for (const contact of contacts) {
    const payload = contactPagePayload(dataSourceId, contact);
    const page = await request('POST', '/v1/pages', payload);
    created.push(page.id);
  }
  return created;
}

function dataSourceIdFrom(filePath, key) {
  if (!filePath) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))[key] || null;
}

async function main(argv) {
  const positional = [];
  let dataSourcesFile = null;
  let dataSourceId = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--data-sources') {
      dataSourcesFile = argv[i + 1];
      i++;
    } else if (argv[i] === '--data-source-id') {
      dataSourceId = argv[i + 1];
      i++;
    } else {
      positional.push(argv[i]);
    }
  }
  const contactsPath = positional[0];
  if (!contactsPath) {
    process.stderr.write('usage: seed-notion.cjs <contacts.json> [--data-sources <file>] [--data-source-id <id>]\n');
    return 2;
  }
  const contacts = JSON.parse(fs.readFileSync(contactsPath, 'utf8'));
  const resolvedId = dataSourceId || dataSourceIdFrom(dataSourcesFile, 'contacts');
  if (!resolvedId) {
    process.stderr.write('pass --data-source-id or a --data-sources file with a contacts id\n');
    return 2;
  }
  const token = process.env.NOTION_TOKEN;
  if (!token) {
    process.stderr.write('set NOTION_TOKEN before seeding Notion\n');
    return 2;
  }
  const client = notionClient(token);
  const created = await seedContacts(resolvedId, contacts, { request: client.request });
  process.stdout.write('Seeded ' + created.length + ' contacts into ' + resolvedId + '\n');
  return 0;
}

module.exports = { contactPagePayload, seedContacts, dataSourceIdFrom };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
