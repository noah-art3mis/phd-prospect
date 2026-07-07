# n8n implementation

The workflow files are versioned orchestration assets for n8n 2.25.7. They are inactive on import and intentionally contain no credential identifiers.

## Cloud setup

1. Import each JSON file under `workflows/` (or the pre-filled copies under the git-ignored `import/`, regenerated from `workflows/` with real IDs substituted).
2. Create the Telegram and Notion credentials plus an **Anthropic** credential (`anthropicApi`) in n8n. Claude's server-side `web_search` / `web_fetch` tools cover research, so no separate search provider is needed.
3. Create two Data Tables:
   - **pending approvals** (columns: `token`, `chat_id`, `source_url`, `canonical_url`, `fingerprint`, `candidate_json`, `validation_json`, `status`, `created_at`). The ingest workflow parks each validated candidate here between the approval message and the button callback — no Notion write happens before confirmation.
   - **sent reminders** (columns: `key`, `opportunity_id`, `deadline_id`, `sent_at`). Workflow 02 uses it as the reminder idempotency ledger, keyed `opportunity_id:deadline_id:version:offset`.
4. Replace every `REPLACE_...` marker:
   - `REPLACE_WITH_TELEGRAM_USER_ID` — your numeric Telegram user ID (auth gate, in code nodes).
   - `REPLACE_WITH_OPPORTUNITIES_DATA_SOURCE_ID` / `REPLACE_WITH_DEADLINES_DATA_SOURCE_ID` — the Notion data-source IDs from `prospect bootstrap-notion` (in the persist / query / recheck nodes).
   - `REPLACE_WITH_PENDING_APPROVALS_DATA_TABLE_ID` / `REPLACE_WITH_SENT_REMINDERS_DATA_TABLE_ID` — the two Data Table IDs from step 3.
5. Bind the `telegramApi`, `notionApi`, and `anthropicApi` credentials to every node showing a warning (the Anthropic and Notion calls are raw HTTP Request nodes using `predefinedCredentialType`).
6. Set the workflow timezone explicitly (reminder day-boundary maths uses it).
7. Test with fixtures before publishing.

The Codex user-level MCP configuration points at `https://noah-art3mis.app.n8n.cloud/mcp-server/http`. Restart Codex and complete OAuth before asking an agent to create or update cloud workflows through MCP.

## Self-hosted setup

Copy `.env.example` to `.env`, choose a long encryption key, and run `docker compose up -d`. Telegram needs a public HTTPS `N8N_WEBHOOK_URL`; a local-only URL cannot receive Telegram webhooks.

## Workflow boundaries

- `01-ingest-opportunity.json`: Telegram admission, URL capture, retrieval, and an explicit handoff to extraction/research.
- `02-deadline-reminders.json`: daily scheduling and an explicit handoff to Notion query/reminder calculation.
- `03-recheck-active-opportunities.json`: weekly scheduling and an explicit handoff to source comparison.

The workflow scaffolds establish triggers, authorization, bounded inputs, and operator instructions. Model and Notion nodes should be completed through the authenticated n8n MCP server because credential-backed node schemas are instance-specific. Do not put persistence tools directly on the research agent. The final graph must keep research read-only and route its output through validation and Telegram approval before any Notion mutation.

The ingestion scaffold rejects literal private-network, local-hostname, credentialed, and non-standard-port URLs before fetching. This does not prevent DNS rebinding. Keep n8n's SSRF protection enabled where available; for self-hosted Community Edition, prefer a dedicated fetch service or egress proxy that resolves and blocks non-public destinations after every redirect.

## Completed pipeline

The three workflows now implement the full flow (they stay inactive until the pre-publish test in `docs/setup.md` step 6):

1. **Ingest** (`01`): Telegram admission → per-URL fan-out → fetch → extract + classify (Anthropic) → listing enumerate *or* research the gaps (read-only `web_search` / `web_fetch`) → merge (research can only fill requested fields) → deterministic validation → park in the Data Table → Telegram approval keyboard (confirm / save incomplete / edit deadline / research again / duplicate / reject) → on the button callback, Notion create of the opportunity page plus first-class deadline rows. No Notion mutation happens before confirmation.
2. **Deadline reminders** (`02`): daily query of verified, non-rolling deadlines → offset maths in the workflow timezone → filter out keys already in the `sent reminders` Data Table (`rowNotExists`) → Telegram send → insert the key only after the send succeeds. Idempotency key: `opportunity_id:deadline_id:version:offset`.
3. **Recheck** (`03`): weekly query of confirmed, non-closed opportunities → re-fetch the source → re-read status via Anthropic → alert on change / closure / page disappearance and stamp `Last checked`. It never rewrites confirmed critical values.

### Notes on the AI calls

- Extraction and research call the Anthropic Messages API through raw **HTTP Request** nodes (the n8n Anthropic Chat Model node does not expose the server-side `web_search` / `web_fetch` tools). Add the `anthropic-version: 2023-06-01` header; the `anthropicApi` credential injects `x-api-key`.
- The calls request a single JSON object via the prompt rather than strict structured output: Anthropic's `output_config.format` json_schema cannot express a finding's free-form `value` (an object for funding, an array for deadlines). The deterministic Validate node (`n8n/code/validate_opportunity.js`, golden-tested against the Python spec) is the enforcement boundary — the prompt shape is convenience only.
- The Validate node embeds `n8n/code/validate_opportunity.js` verbatim so the cross-language contract test (`tests/test_contract_normalize.py`, `tests/test_contract_identity.py`) guards exactly what runs in production.

### SSRF scope

The host gate (ingest `Authorize and normalize request`, the shared `validate_public_url`, and the recheck `Prepare opportunities` re-gate) rejects **IP-literal** SSRF in every notation: private/reserved dotted quads, 1–3 part shorthand (`127.1`, `169.254.43518`), bare-decimal/hex/octal, and — because it accepts only ASCII letter/digit/hyphen/dot hosts — backslash parser-confusion and fullwidth/IDNA hosts that an HTTP client would fold to a private address. Redirect-following is disabled on both fetch nodes. What a string gate structurally **cannot** stop is a plain domain name whose DNS record resolves to a private IP (wildcard-DNS services, DNS rebinding). Closing that requires network-layer egress filtering — block RFC1918 / loopback / link-local / `169.254.169.254` at the container or a validating forward proxy for the n8n fetch path. Enforce this before publishing (Step 6); until then it remains a known, accepted limitation.
