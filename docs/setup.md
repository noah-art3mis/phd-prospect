# Setup

## 1. Authorize Codex against n8n Cloud

The global Codex configuration contains:

```toml
[mcp_servers.n8n]
url = "https://noah-art3mis.app.n8n.cloud/mcp-server/http"
```

Restart Codex and complete the n8n OAuth flow in the browser. The n8n tools are unavailable in the session that wrote the configuration. Do not debug missing tools until both restart and OAuth are complete.

## 2. Create the Notion integration

Create an internal Notion integration with read, insert, and update content capabilities. Create an empty parent page named `Prospect`, then share that page with the integration. Copy the integration token and parent page ID into a local `.env` based on `.env.example`.

Preview the exact API payload without making changes:

```bash
set -a; . ./.env; set +a; uv run prospect bootstrap-notion --dry-run
```

Create the five databases and their relations:

```bash
set -a; . ./.env; set +a; uv run prospect bootstrap-notion > notion-data-sources.json
```

The command targets Notion API version `2026-03-11`. It is a one-time, non-idempotent bootstrap: do not run it twice against the same parent page. Keep the generated IDs for n8n configuration. If a request fails partway through, inspect the parent page and remove partial databases before retrying.

## 3. Create the Telegram bot

Use BotFather in Telegram to create a bot and copy its token. Send the bot a message, then obtain your numeric Telegram user ID from the trigger test output. In the imported ingestion workflow, replace `REPLACE_WITH_TELEGRAM_USER_ID` before publishing. Bind the same Telegram credential to the trigger and send nodes.

Do not accept group messages or additional users during the initial experiment.

## 4. Configure n8n

Import the JSON files under `n8n/workflows/`. They are deliberately inactive. In n8n Cloud, bind credentials in the UI; custom environment variables are not available on Cloud Starter. Complete the credential-backed sections through the authenticated n8n MCP server, following `n8n/README.md` and the sticky notes in each workflow.

For self-hosting, set `N8N_WEBHOOK_URL` to a public HTTPS origin before publishing Telegram workflows. The local Docker Compose file cannot receive Telegram events through `localhost` alone.

## 5. Configure AI and search

Choose one current structured-output-capable chat model and one search provider. Do not expose Notion, Telegram-send, filesystem, arbitrary HTTP credentials, or shell execution as agent tools. The researcher receives only bounded search and public page-fetch tools. Use `n8n/prompts/extract.md`, `n8n/prompts/research.md`, and `schemas/opportunity-candidate.schema.json` as the contract.

## 6. Test before publishing

Use `fixtures/opportunity-candidate.json` to verify deterministic validation:

```bash
uv run prospect validate fixtures/opportunity-candidate.json
uv run pytest
```

Test ingestion with a public university page, a PDF listing, a page with no deadline, a page with conflicting dates, a duplicate listing, and an inaccessible page. Confirm that no Notion mutation happens before Telegram approval and that repeated reminder executions do not resend a prior key.
