// n8n Cloud Code-node sandbox: no `URL`, no `require` (Date and Set are fine).
const request = $('Authorize and normalize request').item.json;
const raw = typeof $json === 'string' ? $json : ($json.data ?? $json.body ?? JSON.stringify($json));
return [{ json: {
  ...request,
  external_content: String(raw).slice(0, 120000),
  external_content_truncated: String(raw).length > 120000,
  security_boundary: 'EXTERNAL_UNTRUSTED_CONTENT',
  missing_fields: []
} }];
