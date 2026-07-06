# n8n implementation

The workflow files are versioned orchestration assets for n8n 2.25.7. They are inactive on import and intentionally contain no credential identifiers.

## Cloud setup

1. Import each JSON file under `workflows/`.
2. Create Telegram, Notion, model-provider, and search-provider credentials in n8n.
3. Replace every `REPLACE_...` marker.
4. Bind credentials to every node showing a warning.
5. Set the workflow timezone explicitly.
6. Test with fixtures before publishing.

The Codex user-level MCP configuration points at `https://noah-art3mis.app.n8n.cloud/mcp-server/http`. Restart Codex and complete OAuth before asking an agent to create or update cloud workflows through MCP.

## Self-hosted setup

Copy `.env.example` to `.env`, choose a long encryption key, and run `docker compose up -d`. Telegram needs a public HTTPS `N8N_WEBHOOK_URL`; a local-only URL cannot receive Telegram webhooks.

## Workflow boundaries

- `01-ingest-opportunity.json`: Telegram admission, URL capture, retrieval, and an explicit handoff to extraction/research.
- `02-deadline-reminders.json`: daily scheduling and an explicit handoff to Notion query/reminder calculation.
- `03-recheck-active-opportunities.json`: weekly scheduling and an explicit handoff to source comparison.

The workflow scaffolds establish triggers, authorization, bounded inputs, and operator instructions. Model and Notion nodes should be completed through the authenticated n8n MCP server because credential-backed node schemas are instance-specific. Do not put persistence tools directly on the research agent. The final graph must keep research read-only and route its output through validation and Telegram approval before any Notion mutation.

The ingestion scaffold rejects literal private-network, local-hostname, credentialed, and non-standard-port URLs before fetching. This does not prevent DNS rebinding. Keep n8n's SSRF protection enabled where available; for self-hosted Community Edition, prefer a dedicated fetch service or egress proxy that resolves and blocks non-public destinations after every redirect.

## Required workflow completion

The authenticated implementation must add:

1. Initial information extraction using `schemas/opportunity-candidate.schema.json`.
2. Missing-field detection and a read-only researcher limited to search and HTTP fetch tools.
3. A maximum of three searches and eight fetched pages per opportunity.
4. Deterministic field/evidence validation.
5. Telegram approval callbacks for confirm, edit deadline, research again, save incomplete, duplicate, and reject.
6. Notion create/update operations using the data-source IDs produced by `prospect bootstrap-notion`.
7. Reminder idempotency keyed as `opportunity_id:deadline_id:version:offset`.
8. Recheck diffs that alert instead of silently overwriting confirmed critical findings.
