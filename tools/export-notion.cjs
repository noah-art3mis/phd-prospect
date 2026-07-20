#!/usr/bin/env node
// Read-only snapshot of every Notion data source into JSON files.
// Usage: NOTION_TOKEN=... node tools/export-notion.cjs [--data-sources <path>] [--out <dir>]
const https = require('https');
const fs = require('fs');
const path = require('path');

function notionClient(token) {
  function request(method, apiPath, payload) {
    return new Promise((resolve, reject) => {
      const body = method === 'GET' ? null : JSON.stringify(payload);
      const req = https.request(
        'https://api.notion.com' + apiPath,
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

async function queryAll(request, dataSourceId) {
  const rows = [];
  let cursor = undefined;
  do {
    const payload = { page_size: 100 };
    if (cursor) payload.start_cursor = cursor;
    const res = await request('POST', '/v1/data_sources/' + dataSourceId + '/query', payload);
    rows.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return rows;
}

function parseArgs(argv) {
  const opts = { dataSources: 'notion-data-sources.json', out: 'notion-snapshot' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--data-sources') opts.dataSources = argv[++i];
    else if (argv[i] === '--out') opts.out = argv[++i];
  }
  return opts;
}

async function main(argv) {
  const token = process.env.NOTION_TOKEN;
  if (!token || token.startsWith('replace-with')) {
    throw new Error('NOTION_TOKEN is not set');
  }
  const opts = parseArgs(argv);
  const dataSources = JSON.parse(fs.readFileSync(opts.dataSources, 'utf8'));
  fs.mkdirSync(opts.out, { recursive: true });
  const { request } = notionClient(token);

  const summary = {};
  for (const [name, id] of Object.entries(dataSources)) {
    const schema = await request('GET', '/v1/data_sources/' + id, {});
    const rows = await queryAll(request, id);
    fs.writeFileSync(
      path.join(opts.out, name + '.json'),
      JSON.stringify({ data_source_id: id, schema, rows }, null, 2)
    );
    summary[name] = rows.length;
    console.log(`${name}: ${rows.length} rows`);
  }
  fs.writeFileSync(path.join(opts.out, '_summary.json'), JSON.stringify(summary, null, 2));
  console.log('Snapshot written to ' + path.resolve(opts.out));
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
