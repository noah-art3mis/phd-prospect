# n8n implementation

The repository is the source of truth for the n8n workflows. The live n8n Cloud instance (`https://noah-art3mis.app.n8n.cloud`) is a deploy target and a schema oracle for credential-backed node types — never the record. Changes are authored here, built with the CLI, and pushed to the instance via the n8n MCP server.

## Source layout

- `workflows/*.json` – tracked workflow templates: full topology (nodes, connections, settings) with sentinel markers instead of embedded payloads, and placeholders instead of personal identifiers.
- `code/*.js` – one file per Code node (plus `validate_opportunity.js`, the golden-tested port of `normalize_opportunity` + identity that the Validate node embeds).
- `prompts/*.md` – Anthropic system prompts for the extract and research calls.
- `import/*.json` – git-ignored deployable copies with real identifiers substituted. Never committed.

## Template format

Templates and payload files are wired together with three sentinels, resolved by `uv run prospect build-workflows` (implementation: `src/prospect/workflows.py`):

| Sentinel                  | Where it appears             | Expansion                                                                                                    |
| ------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `{{FILE:<path>}}`         | a Code node's `jsCode`       | the referenced `n8n/code/*.js` file, inlined (minus its trailing newline)                                      |
| `{{INLINE_JS:<path>}}`    | inside a `n8n/code/*.js` file | the referenced JS file pasted verbatim, minus its sandbox-note header and its trailing Node `module.exports` guard |
| `{{PROMPT_LINES:<path>}}` | inside a `n8n/code/*.js` file | the referenced `n8n/prompts/*.md` rendered as the JSON-quoted lines of a JS array literal                      |

Every `n8n/code/*.js` file starts with a one-line sandbox note (`// n8n Cloud Code-node sandbox: ...`); the build strips it, so it annotates the file without changing the deployed payload. n8n Cloud Code nodes have no `URL` constructor and no `require` – parse URLs with regexes (Date and Set are fine).

Two placeholder families keep personal identifiers out of git and survive into the tracked templates: `REPLACE_WITH_TELEGRAM_USER_ID` (from `.env`'s `TELEGRAM_ALLOWED_USER_ID`) and `REPLACE_WITH_DATA_SOURCE_<NAME>` (from `notion-data-sources.json`, the output of `prospect bootstrap-notion`). The Anthropic `output_config` finding schema is not stored twice: the build refuses to emit if the `findingSchema` literal in the request-builder JS drifts from what `schemas/opportunity-candidate.schema.json` derives to.

## Build and deploy flow

1. Edit the payload files or templates in the repo.
2. `uv run prospect build-workflows` – canonicalizes the tracked templates in place and writes deployable copies to `n8n/import/` using `.env` and `notion-data-sources.json`.
3. Push the `n8n/import/*.json` content to the instance through the authenticated n8n MCP server (`update_workflow`).
4. Verify the round trip: fetch the live workflow with `get_workflow_details`, save the JSON, and run `uv run python scripts/compare_workflows.py n8n/import/<name>.json <live-export>.json`. It must print `EQUIVALENT`.

Never leave the live instance ahead of the repo at the end of a work session: fold live experiments back into `n8n/code/`, `n8n/prompts/`, and `n8n/workflows/`, rebuild, and re-verify.

Known MCP validator noise: `validate_workflow` falsely warns "Missing discriminator parameters.resource" on Telegram sendMessage nodes; ignore that specific warning.

## Workflow boundaries

- `01-ingest-opportunity.json`: Telegram admission, URL capture, retrieval, extraction, bounded read-only research, deterministic validation, Telegram approval callbacks, and Notion persistence of confirmed opportunities and their deadlines.
- `02-deadline-reminders.json`: daily scheduling scaffold; the reminder calculation and idempotent send pipeline land in phase 3.
- `03-recheck-active-opportunities.json`: weekly scheduling scaffold; the re-fetch/diff/alert pipeline lands in phase 3.

Do not put persistence tools directly on the research agent. Research is read-only (bounded web search and fetch); its output routes through validation and Telegram approval before any Notion mutation.

The ingestion flow rejects literal private-network, local-hostname, credentialed, and non-standard-port URLs before fetching. This does not prevent DNS rebinding; n8n Cloud's SSRF protection remains the backstop. The recorded future simplification is replacing the n8n-side fetch with Anthropic `web_fetch`.

## Invariants the graph must keep

1. Extraction conforms to `schemas/opportunity-candidate.schema.json`.
2. The researcher is limited to search and HTTP fetch, at most three searches and eight fetched pages per opportunity.
3. Deterministic field/evidence validation before anything is stored.
4. Telegram approval callbacks for confirm, research again, save incomplete, duplicate, and reject.
5. Notion create/update operations use the data-source IDs produced by `prospect bootstrap-notion`.
6. Reminder idempotency keyed as `opportunity_id:deadline_id:version:offset`.
7. Recheck diffs alert instead of silently overwriting confirmed critical findings.
