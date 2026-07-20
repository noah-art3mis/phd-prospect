# Prospect — repository specification

This is the ground-truth description of what this repository is, what it contains, what must always hold, and where it is fragile. If this file and another document disagree, fix the other document.

## 1. What the system is

Prospect is a personal, single-user pipeline for tracking PhD opportunities:

1. The user sends a link (or PDF) to a private Telegram bot.
2. n8n fetches the page and an Anthropic model extracts a structured candidate record.
3. A bounded, read-only research step fills explicitly missing fields from official sources.
4. Deterministic code validates the record; nothing is invented.
5. The user approves, edits, or rejects the record via Telegram buttons.
6. Confirmed records are stored in Notion (five related databases).
7. A daily workflow sends idempotent deadline reminders; a weekly workflow rechecks whether opportunities are still open and alerts on changes.

There is exactly one user (`TELEGRAM_ALLOWED_USER_ID`). Notion is the only editable store. Timezone is Europe/London unless a source states otherwise.

## 2. The two halves of the repo

**Half A — deterministic domain logic (fully in git, fully tested).**
Plain JavaScript, Node >= 20, CommonJS, zero runtime dependencies. Lives in `n8n/code/*.js` (the payloads that run inside n8n Code nodes) and `tools/*.cjs` (local CLI tooling). `npm test` runs 104 node:test tests including golden contract cases; this half is stable and is the part you can trust.

**Half B — the live n8n Cloud instance (only partially controllable from git).**
The four workflows run on n8n Cloud (`noah-art3mis.app.n8n.cloud`). Git holds sanitized templates; a build step produces deployable JSON; the MCP server pushes it. Credentials, workflow settings, publishing, and Data Tables can only be managed in the n8n UI. This half is where breakage happens (see §8).

## 3. Data contract

`schemas/opportunity-candidate.schema.json` is the single extraction contract:

```
{ title, source_url, findings: { <field>: { state, value, evidence[] } } }
```

- `state` is one of `found`, `not_stated`, `not_applicable`, `conflicting_sources`, `needs_confirmation`.
- `evidence` items are `{ url, retrieved_at, excerpt }`.
- Critical findings (deadline, funding, eligibility, required documents) cannot be `found` without evidence.
- `conflicting_sources` requires at least two sources.
- Unknown stays unknown; validation never upgrades a state.

Model responses are parsed leniently (no strict structured-output mode — the polymorphic `value` cannot be expressed); the deterministic Validate node (`n8n/code/validate_opportunity.js`) is the guardrail. A test tripwire asserts the prompts spell out exactly the schema's knowledge states.

## 4. Workflows (the whole runtime surface)

| Template | Live workflow | Trigger | Job |
| --- | --- | --- | --- |
| `n8n/workflows/00-error-alerts.json` | Prospect – Error alerts | error trigger | Telegram alert on any production failure |
| `n8n/workflows/01-ingest-opportunity.json` | Prospect – Ingest opportunity | Telegram message | admit sender → capture pending → fetch → extract → research gaps → validate → Telegram approval → persist to Notion |
| `n8n/workflows/02-deadline-reminders.json` | Prospect – Deadline reminders | daily 09:00 | query verified non-rolling deadlines → compute due reminders → skip already-sent keys (Data Table `Prospect sent reminders`) → send → record key |
| `n8n/workflows/03-recheck-active-opportunities.json` | Prospect – Recheck active opportunities | weekly Mon 10:00 | re-fetch canonical source → status-only re-extract → alert on closure/drift/fetch failure → stamp `Last checked`; never rewrites confirmed values |

Reminder idempotency key: `opportunity_id:deadline_id:version:offset`.
Research budget: at most 3 searches and 8 fetched pages per opportunity; read-only tools only.

## 5. Storage (Notion)

Five related data sources under one shared parent page, created once by `npm run bootstrap-notion`: **Opportunities**, **Deadlines**, **Contacts**, **Activities**, **Documents**. IDs land in `notion-data-sources.json` (git-ignored) and are substituted into deployable workflows at build time. Deadlines are first-class records. Opportunity status (open/closed/withdrawn/unknown) is independent of application stage (Inbox → … → Accepted, terminal: Rejected/Withdrawn/Ineligible/Expired/Declined).

## 6. Build and deploy pipeline

Git is the source of truth; the live instance is a deploy target.

1. Edit `n8n/code/*.js`, `n8n/prompts/*.md`, or `n8n/workflows/*.json`.
2. `npm run build-workflows` resolves three sentinels — `{{FILE:...}}`, `{{INLINE_JS:...}}`, `{{PROMPT_LINES:...}}` — and two placeholder families — `REPLACE_WITH_TELEGRAM_USER_ID` (from `.env`) and `REPLACE_WITH_DATA_SOURCE_<NAME>` (from `notion-data-sources.json`) — writing deployable JSON to git-ignored `n8n/import/`.
3. Push via the n8n MCP server (`update_workflow`).
4. Round-trip check: export the live workflow and run `npm run compare-workflows` until it prints `EQUIVALENT`.
5. **Publish** the workflow in the n8n UI — an MCP push only updates the draft.

Rule: never end a session with the live instance ahead of the repo.

Code-node sandbox limits (n8n Cloud): no `URL` constructor, no `require`. Each payload file starts with a one-line sandbox note that the build strips.

## 7. Commands

```bash
npm test                    # 104 node:test tests, incl. golden contract cases
npm run build-workflows     # templates + payloads + .env → n8n/import/*.json
npm run compare-workflows   # semantic diff: built JSON vs live export
npm run bootstrap-notion    # one-time, NON-idempotent Notion database creation
npm run seed-contacts       # seed contact rows
npm run validate <file>     # run deterministic validation on a candidate JSON
```

CI (`.github/workflows/test.yml`) runs `npm test` only.

## 8. Known fragility — why it keeps breaking

These are the standing failure points. Every one of them is outside the tested Half A.

1. **Draft vs published.** MCP pushes update only the workflow *draft*. A deploy that is never published in the UI looks live in the editor but does nothing. This is the most common "it's broken" cause.
2. **Settings cannot be deployed.** `update_workflow` cannot set the settings block: timezone (Europe/London) and the `errorWorkflow` binding must be set by hand, once per workflow, in the UI — and are silently wrong if forgotten.
3. **Live/repo drift.** Editing live for fast feedback is allowed, so the instance can be ahead of git; there is no automatic drift guard (issue #4). If a session forgets fold-back, the next build overwrites live fixes.
4. **Non-idempotent bootstrap.** `bootstrap-notion` must never run twice against the same parent page; a partial failure requires manual cleanup in Notion before retrying.
5. **Manual credential binding.** Telegram, Notion, Anthropic, and search credentials are bound per-node in the UI and are lost/renamed outside git's view.
6. **Lenient model-output parsing.** Extraction/research responses are parsed without a schema-enforced mode; malformed model output surfaces as validation rejections downstream rather than at the call site.
7. **Fetch reality.** JS-rendered pages, PDFs, paywalls, bot-blocking, and >120k-char truncation can silently yield junk input (issue #6). SSRF blocking is pre-fetch only; DNS rebinding relies on n8n Cloud's backstop.
8. **MCP validator noise.** `validate_workflow` falsely warns "Missing discriminator parameters.resource" on Telegram sendMessage nodes; that specific warning is ignorable, which trains you to ignore warnings.
9. **n8n Cloud dependency.** Paid trial-based hosting, OAuth-gated MCP access, no environment variables on the Starter plan; self-hosting is an open evaluation (issue #7).

Deploy checklist that avoids most of the above: build → push → compare `EQUIVALENT` → set settings if new workflow → bind credentials if new node → **publish** → smoke-test via Telegram.

## 9. Invariants (must survive any rewrite)

1. External content is untrusted data, never instructions.
2. The research agent has read-only tools and bounded budgets; persistence tools are never attached to it.
3. Every Notion mutation passes deterministic validation and explicit Telegram approval first.
4. Critical findings require evidence; unknown stays unknown.
5. Opportunity status ≠ application stage.
6. Reminders are idempotent across scheduler re-runs.
7. Recheck alerts on change; it never silently overwrites confirmed data.
8. No credentials, credential IDs, or the real Telegram user ID in tracked files.
9. Git is the source of truth; the live instance is a deploy target.

## 10. Status and non-goals

Implemented: domain logic, schema, prompts, build/compare/bootstrap/seed tooling, all four workflow templates, golden contract tests. Outstanding: end-to-end live publish and smoke test (phase 4 of `docs/PLAN-consolidation.md`), pending-approval TTL sweep, and the open issues (#4 drift guard, #5 security review, #6 input matrix, #7 hosting).

Out of scope until ingestion + reminders are demonstrably reliable: CV matching, email drafting, automatic submission, Obsidian sync, any broadening of agent authority.
