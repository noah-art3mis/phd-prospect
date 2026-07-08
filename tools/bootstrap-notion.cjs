// One-time Notion workspace bootstrap: create Prospect's five related data sources.
//
// Ported from src/prospect/notion_schema.py + notion.py + scripts/bootstrap_notion.py.
// Notion API version 2026-03-11.
//
// Usage:
//     node tools/bootstrap-notion.cjs [--parent-page-id <id>] [--dry-run]
// Reads NOTION_TOKEN and NOTION_PARENT_PAGE_ID from the environment.

const https = require('https');

function select(...options) {
  return { select: { options: options.map((name) => ({ name })) } };
}

function multiSelect(...options) {
  return { multi_select: { options: options.map((name) => ({ name })) } };
}

function database(parentPageId, name, properties) {
  return {
    parent: { type: 'page_id', page_id: parentPageId },
    title: [{ type: 'text', text: { content: name } }],
    is_inline: false,
    initial_data_source: { properties },
  };
}

// Return database creation payloads for Notion API version 2026-03-11.
function databaseSpecs(parentPageId) {
  return {
    opportunities: database(parentPageId, 'Prospect – Opportunities', {
      Name: { title: {} },
      Type: select(
        'Advertised project',
        'Doctoral programme',
        'CDT or cohort',
        'Fellowship',
        'Scholarship',
        'Self-proposed route'
      ),
      Institution: { rich_text: {} },
      'Department or lab': { rich_text: {} },
      Country: { rich_text: {} },
      City: { rich_text: {} },
      Programme: { rich_text: {} },
      'Start date': { date: {} },
      Duration: { rich_text: {} },
      'Advert ID': { rich_text: {} },
      'Application stage': select(
        'Inbox',
        'Researching',
        'Eligible',
        'Shortlisted',
        'Supervisor outreach',
        'Preparing application',
        'Waiting for references',
        'Ready to submit',
        'Submitted',
        'Interview',
        'Decision pending',
        'Offer',
        'Accepted',
        'Rejected',
        'Withdrawn',
        'Ineligible',
        'Expired',
        'Declined'
      ),
      'Opportunity status': select('Open', 'Closed', 'Withdrawn', 'Unknown'),
      Priority: select('High', 'Medium', 'Low'),
      'Canonical URL': { url: {} },
      'Source URL': { url: {} },
      'Application URL': { url: {} },
      'Application ID': { rich_text: {} },
      'Portal status': { rich_text: {} },
      Fingerprint: { rich_text: {} },
      'Last checked': { date: {} },
      Confirmed: { checkbox: {} },
      'Supervisor contact required': { checkbox: {} },
      'Funding status': select(
        'Fully funded',
        'Partially funded',
        'Salaried',
        'Self-funded',
        'Unclear'
      ),
      'Stipend or salary': { number: { format: 'number' } },
      Currency: select('EUR', 'GBP', 'USD', 'CAD', 'AUD', 'CHF', 'Other'),
      'Tuition coverage': select('Full', 'Home only', 'Partial', 'None', 'Unclear'),
      'Eligibility state': select(
        'Eligible',
        'Likely eligible',
        'Needs confirmation',
        'Ineligible',
        'Unknown'
      ),
      Supervisors: { rich_text: {} },
      'Research topics': { rich_text: {} },
      'Research fit': { number: { format: 'number' } },
      'Funding fit': { number: { format: 'number' } },
      'Location fit': { number: { format: 'number' } },
      'Next action': { rich_text: {} },
      'Next action due': { date: {} },
      Summary: { rich_text: {} },
      Evidence: { rich_text: {} },
    }),
    deadlines: database(parentPageId, 'Prospect – Deadlines', {
      Name: { title: {} },
      Type: select(
        'Supervisor contact',
        'Expression of interest',
        'Programme application',
        'Funding application',
        'Reference request',
        'Recommender submission',
        'Supporting documents',
        'Certified documents',
        'Interview',
        'Expected decision',
        'Offer acceptance',
        'Enrolment',
        'Visa',
        'Start date'
      ),
      Due: { date: {} },
      Timezone: { rich_text: {} },
      Rolling: { checkbox: {} },
      Verified: { checkbox: {} },
      Version: { number: { format: 'number' } },
      'Reminder offsets': multiSelect('30', '14', '7', '1'),
      'Evidence URL': { url: {} },
      'Evidence excerpt': { rich_text: {} },
      'Reminder keys sent': { rich_text: {} },
    }),
    contacts: database(parentPageId, 'Prospect – Contacts', {
      Name: { title: {} },
      Role: select(
        'Supervisor',
        'Co-supervisor',
        'Programme coordinator',
        'Administrator',
        'Current student',
        'Referee',
        'Other'
      ),
      'Institution or lab': { rich_text: {} },
      'Research topics': { rich_text: {} },
      Email: { email: {} },
      'Profile URL': { url: {} },
      'Last contact': { date: {} },
      'Follow-up': { date: {} },
      'Response status': select('Not contacted', 'Waiting', 'Replied', 'Unavailable'),
      Notes: { rich_text: {} },
    }),
    activities: database(parentPageId, 'Prospect – Activities', {
      Name: { title: {} },
      Type: select(
        'Research',
        'Outreach',
        'Document',
        'Application',
        'Reference',
        'Interview',
        'Follow-up',
        'Decision',
        'Other'
      ),
      Due: { date: {} },
      Completed: { checkbox: {} },
      'Completed at': { date: {} },
      Result: { rich_text: {} },
      Notes: { rich_text: {} },
    }),
    documents: database(parentPageId, 'Prospect – Documents', {
      Name: { title: {} },
      Type: select(
        'CV',
        'Research proposal',
        'Statement of purpose',
        'Personal statement',
        'Transcript',
        'Certificate',
        'Language evidence',
        'Writing sample',
        'Publication',
        'Portfolio',
        'Other'
      ),
      Status: select('Missing', 'Drafting', 'Review', 'Ready', 'Submitted'),
      Version: { number: { format: 'number' } },
      File: { files: {} },
      'Submitted at': { date: {} },
      'Portal limit': { rich_text: {} },
      Notes: { rich_text: {} },
    }),
  };
}

// Return relation properties after all five data sources exist.
function relationUpdates(dataSourceIds) {
  const opportunityId = dataSourceIds.opportunities;
  const updates = {};
  for (const collection of ['deadlines', 'contacts', 'activities', 'documents']) {
    updates[collection] = {
      properties: {
        Opportunity: {
          relation: {
            data_source_id: opportunityId,
            dual_property: {},
          },
        },
      },
    };
  }
  return updates;
}

// Create Prospect's data sources and their opportunity relations.
async function bootstrapWorkspace(parentPageId, { request }) {
  const dataSourceIds = {};
  for (const [key, payload] of Object.entries(databaseSpecs(parentPageId))) {
    const created = await request('POST', '/v1/databases', payload);
    const db = await request('GET', '/v1/databases/' + created.id, {});
    dataSourceIds[key] = db.data_sources[0].id;
  }
  for (const [key, payload] of Object.entries(relationUpdates(dataSourceIds))) {
    await request('PATCH', '/v1/data_sources/' + dataSourceIds[key], payload);
  }
  return dataSourceIds;
}

// Minimal authenticated client for the endpoints Prospect bootstraps.
function notionClient(token) {
  function request(method, path, payload) {
    return new Promise((resolve, reject) => {
      const body = method === 'GET' ? null : JSON.stringify(payload);
      const req = https.request(
        'https://api.notion.com' + path,
        {
          method,
          headers: {
            Authorization: 'Bearer ' + token,
            'Content-Type': 'application/json',
            'Notion-Version': '2026-03-11',
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            if (res.statusCode >= 400) {
              reject(new Error('Notion API returned HTTP ' + res.statusCode + ': ' + data));
              return;
            }
            resolve(JSON.parse(data));
          });
        }
      );
      req.on('error', reject);
      req.setTimeout(30000, () => req.destroy(new Error('Notion API request timed out')));
      if (body !== null) req.write(body);
      req.end();
    });
  }
  return { request };
}

async function main(argv) {
  let parentPageId = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--parent-page-id') {
      parentPageId = argv[i + 1];
      i++;
    } else if (argv[i] === '--dry-run') {
      dryRun = true;
    }
  }
  parentPageId = parentPageId || process.env.NOTION_PARENT_PAGE_ID;
  if (!parentPageId) {
    process.stderr.write('set NOTION_PARENT_PAGE_ID or pass --parent-page-id\n');
    return 2;
  }
  if (dryRun) {
    process.stdout.write(JSON.stringify(databaseSpecs(parentPageId), null, 2) + '\n');
    return 0;
  }
  const token = process.env.NOTION_TOKEN;
  if (!token) {
    process.stderr.write('set NOTION_TOKEN before bootstrapping Notion\n');
    return 2;
  }
  const client = notionClient(token);
  const identifiers = await bootstrapWorkspace(parentPageId, { request: client.request });
  process.stdout.write(JSON.stringify(identifiers, null, 2) + '\n');
  return 0;
}

module.exports = { databaseSpecs, relationUpdates, bootstrapWorkspace, notionClient };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
