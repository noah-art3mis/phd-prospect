# Prospect — specification

A personal, single-user tool for tracking PhD opportunities. This spec supersedes the earlier n8n + Notion design (see ADR-0006); it describes the standalone-app rebuild.

## Problem Statement

I keep finding PhD opportunities — programme pages, scholarship adverts, PDFs — scattered across my browser and inbox. Capturing each one means manually reading the page, pulling out the deadline, funding, eligibility, and supervisor, deciding whether it's worth pursuing, and then remembering to act before the deadline. It's tedious and I miss things.

The first attempt automated this as four n8n Cloud workflows storing to Notion. It worked, but it became too complicated to maintain (a 38-node ingest graph, a build/deploy pipeline, draft-vs-published drift) and it is no longer free to run (n8n Cloud dropped its free tier). I want the same outcome as a small, simple, free thing I actually understand.

## Solution

One small self-hosted application. I send a link (or PDF) to a private Telegram bot; it fetches the page, extracts a structured **Opportunity** record with an AI model, does a little bounded research to fill obvious gaps from official sources, validates the result, and shows it to me on Telegram with Approve / Edit / Reject buttons. On approval it saves the record to a local database. A daily job reminds me of upcoming **Deadlines**. Later, a minimal web page lets me browse and edit my opportunities.

It runs as a single always-on process in Docker on a free VM, with no n8n, no Notion, no build pipeline, and no cloud subscription — only pay-per-use AI calls, which are cents per opportunity for one user.

## User Stories

1. As the sole user, I want the bot to ignore anyone whose Telegram ID is not mine, so that my tracker stays private.
2. As the user, I want to send a URL to the bot, so that I can capture an opportunity without leaving Telegram.
3. As the user, I want to send a PDF to the bot, so that I can capture opportunities that only exist as documents.
4. As the user, I want the bot to acknowledge receipt immediately, so that I know it's working on it.
5. As the user, I want the app to fetch the linked page's content, so that extraction has something to read.
6. As the user, I want an AI model to extract a structured Opportunity record (title, source, and **Findings** with **Knowledge states** and **Evidence**), so that I don't have to read the whole page myself.
7. As the user, I want a bounded, read-only research step to fill fields that are explicitly missing, preferring official sources, so that gaps are closed without inventing facts.
8. As the user, I want research strictly limited in the number of searches and fetched pages, so that it stays cheap and fast.
9. As the user, I want unknown information to stay unknown, so that the record never contains guessed values.
10. As the user, I want the **Deadline** to require Evidence before it counts as `found`, so that the one field the app acts on unprompted is one I can trust.
11. As the user, I want conflicting sources kept visible rather than silently resolved, so that I can judge them myself.
12. As the user, I want deterministic validation of the record before I ever see it, so that malformed or unsupported values are caught.
13. As the user, I want the validated record presented on Telegram with Approve / Edit / Reject buttons, so that nothing is stored without my say-so.
14. As the user, I want to reject a record, so that junk is discarded.
15. As the user, I want to edit a field before approving, so that I can correct the model.
16. As the user, I want to approve a record, so that it is saved to the database.
17. As the user, I want the opportunity's operative **Deadline** stored as a single date (or none, if rolling), so that reminders have something to fire on.
18. As the user, I want approved records to carry their supervisors, contacts, research topics, findings, evidence, and references, so that the context travels with the opportunity.
19. As the user, I want a daily job to tell me which deadlines are approaching, so that I act in time.
20. As the user, I want each **Reminder** to fire at most once per configured lead time, so that repeated daily runs never nag me twice for the same date.
21. As the user, I want opportunities with no deadline (rolling admission) to be skipped by reminders, so that I'm not reminded about nothing.
22. As the user, I want to be alerted when a production step fails, so that a silent breakage doesn't cost me a deadline.
23. As the user, I want a minimal web page listing my opportunities sorted by deadline, so that I can sit and compare them.
24. As the user, I want to open one opportunity and edit its fields on that page, so that I can maintain records outside Telegram.
25. As the user, I want the web page protected by a single password or a private network, so that only I can reach it.
26. As the user, I want to view an opportunity's findings and evidence as a readable list, so that I can check provenance.
27. As the user, I want the whole thing to run unattended on an always-on box, so that reminders fire even when my laptop is off.
28. As the user, I want all times interpreted in my configured local timezone unless a source states otherwise, so that deadlines are consistent as I relocate.
29. As the user, I want the app's code and database schema in git, so that I can back up, recreate, and reason about the system.
30. As the user, I want to import my existing Notion data as seed records, so that I don't lose what I've already collected.

## Implementation Decisions

- **Architecture (ADR-0006):** a single long-running Node application, containerised with Docker, hosted on a GCP "Always Free" e2-micro. The one process owns the Telegram bot, the ingest pipeline, the scheduled reminder job, and the web UI. No n8n, no Notion, no build/deploy pipeline, no MCP.
- **Ingest transport:** the Telegram bot uses **long polling** — no domain, TLS certificate, reverse proxy, or inbound port, and no need to authenticate incoming requests, because the app dials out. Approval runs through inline buttons. Exactly one user is admitted, gated on `TELEGRAM_ALLOWED_USER_ID`.
- **Ingest is fire-and-forget:** the Telegram handler acks and returns; the call runs unawaited and delivers the approval message when it finishes. Nothing about an in-flight submission is persisted.
- **Ingest is one agentic call (ADR-0007):** the submitted URL goes to a single Anthropic call whose server-side `web_fetch` and `web_search` tools fetch the page, extract the opportunity, and fill gaps. The app never fetches a user-submitted URL itself, so no SSRF surface exists to defend. The remaining stages are ordinary testable functions: `validate` (deterministic) → `approve` (human gate) → `persist`.
- **`pause_turn` must be handled.** Anthropic's server-side tool loop stops at its iteration limit with `stop_reason: "pause_turn"` and HTTP 200. Ingest checks `stop_reason` and re-sends to resume; treating the first response as final yields truncated candidates that look successful.
- **Research bound (ADR-0001):** read-only tools only, bounded by `max_uses` on the tool definitions — 3 searches, 8 fetches — carried over from the n8n build, and by `max_content_tokens: 5000` per fetched page, which is what actually bounds cost. The model has no tool that can write records, send messages, run shell, or touch credentials, so the read-only property holds by construction rather than by policy.
- **Telegram messages carry no `parse_mode`.** Findings come from pages an attacker controls and are interpolated into the approval message. Sending plain text means there is nothing to escape, removing the class of bug that required commits `5ff20d5` and `1c5601d` in the n8n build.
- **Data contract (ADR-0003):** the record is `{ title, source_url, findings: { <field>: { state, value, evidence[] } } }`, per `schemas/opportunity-candidate.schema.json`. `state` ∈ {`found`, `not_stated`, `not_applicable`, `conflicting_sources`, `needs_confirmation`}. Evidence items are `{ url, retrieved_at, excerpt }`. The deadline — the sole critical finding — cannot be `found` without evidence; `conflicting_sources` needs ≥2 sources; validation never upgrades a state.
- **AI model:** `claude-sonnet-5` at effort `high` with adaptive thinking, for the single ingest call. Haiku is not eligible — the `web_search_20260209` / `web_fetch_20260209` tool versions require Opus 5/4.8/4.7/4.6, Sonnet 5, or Sonnet 4.6. Effort stays at `high` because the design depends on the model actually calling its tools, and tool-use rate falls at lower effort and with thinking disabled. Cost is roughly $0.11 per opportunity typically, bounded at ~$0.31 by the content cap. The response is constrained by **structured outputs** (`output_config.format`), so a malformed record is not a state the system can reach. Deterministic validation still runs — it enforces the evidence rule and the state machine, which a schema cannot express.
- **PDFs** are downloaded from Telegram's own API and passed to the model as base64 `document` blocks — no local PDF parsing. A Telegram file URL is never handed to `web_fetch`: the bot token is embedded in its path.
- **Storage — SQLite, a single `opportunity` table.** Scalar columns for the queried/sorted fields (title, source_url, deadline_at, confirmed, institution, …). Attached lists that are only ever read with the opportunity — `findings`, `evidence`, `supervisors`, `contacts`, `research_topics`, `references` — are **JSON columns**, not separate tables. This stores lists-of-objects natively, which was the specific thing Notion made painful.
- **Pending candidates are unconfirmed rows in the same table**, marked by a `confirmed` flag — not a second table. Whether a record has been approved is a property of the record, and keeping it its own boolean column makes "skip unapproved rows" one predicate that the reminder query and every listing applies, rather than a value buried in some other enum where it is possible to forget.
- **Reject deletes the row.** No rejected-history is kept, so resubmitting a previously rejected link runs the full call again. Accepted as a simplification; `opportunityFingerprint` therefore has no consumer and is not ported.
- **Re-submission of a confirmed opportunity is caught before the model call:** canonicalize the submitted URL (porting `canonicalizeUrl` from `validate_opportunity.js`, already golden-tested), look for an existing confirmed row, and if found reply with its deadline instead of calling the model. This prevents both the wasted call and the duplicate reminders two rows for one deadline would produce.
- **Deadline as a scalar:** a single nullable `deadline_at` timestamp column on the opportunity, plus a `reminders_sent` JSON field recording which lead-times have already fired (idempotency). Rolling/dateless ⇒ `deadline_at = NULL`. No deadline `type`, no per-deadline evidence (the reference lives in the opportunity's `references`), no `verified`/`rolling` flags — Telegram approval *is* verification, and NULL *is* rolling.
- **Reminder query:** the daily job selects opportunities where `deadline_at` is non-null and falls within a configured lead window, sends any lead-time reminder not yet in `reminders_sent`, and records it. Idempotency key is effectively `opportunity + lead_time`.
- **No workflow state.** The app records opportunities and deadlines. It does not track the user's progress through an application, and it does not track whether the external opportunity is still open. There is no `application_stage` column and no `status` column: both were Notion-era furniture, both required an enum to keep current by hand, and neither is an opportunity or a deadline. A closed programme is handled the way a passed deadline is — it stops being due.
- **Web UI:** server-rendered pages in the same app, reading/writing the same SQLite file — a list/sort view, a detail/edit view, and evidence rendering. Auth is a single password (signed session cookie) or exposure only over a private network (Tailscale). **Deferred** until the Telegram + reminder loop is demonstrably reliable.
- **Timezone:** the local timezone is configuration (`TZ`), currently `America/Mexico_City`; an explicit source timezone wins. A deadline is resolved to a UTC instant at ingest using the zone in force then, so changing `TZ` never reinterprets a stored deadline — it affects only how new ones are read and when reminders fire. The reminder schedule is pinned to the same zone, so a relocation moves *when* reminders arrive rather than silently shifting them by the UTC offset.
- **Git is the source of truth** for ordinary application code and schema — there is no live instance to reconcile (this is what ADR-0005 becomes once n8n is gone).
- **Seed migration:** the existing Notion export (already snapshotted locally) is transformed into `opportunity` rows as one-time seed data.

## Testing Decisions

- **What a good test is here:** it asserts external behaviour at a stage boundary — given inputs, the record/verdict/reminders produced — not internal wiring. IO edges (Telegram, the AI model, the HTTP fetch, the database) are thin and are stubbed or exercised as focused integration tests, never asserted on for their internal calls.
- **Primary seam — validation/normalization:** the deterministic `validate` function (candidate record → accepted record or rejection) is the highest-value, purest seam and already has **golden contract cases** as prior art (`node:test` over `tests/golden/*.json`). New rules extend the golden set. This is the one seam to prefer.
- **Secondary seams:**
  - Response parsing: given a recorded Anthropic response (fixture), assert the shape and knowledge-states of the produced findings — including a `pause_turn` fixture, asserting the caller resumes rather than accepting a partial candidate as final.
  - `reminders`: given a set of opportunities with `deadline_at`/`reminders_sent` and a fixed "now", assert exactly the due lead-times are returned, that a second run with the updated state returns nothing (idempotency), and that unconfirmed rows are never returned at all.
  - Re-submission: given a confirmed row, assert a URL that canonicalizes to the same value short-circuits without a model call.
- **The research-merge seam is gone** along with the two-stage pipeline; `merge-research.js` and `build-research-request.js` have no successor.
- **Prior art:** the existing golden-driven `node:test` suite is the pattern to follow for all of the above; reuse the golden fixtures where the contract is unchanged.

## Out of Scope

- **Weekly recheck** of whether opportunities are still open — deferred until ingestion + reminders are demonstrably reliable. May return as a second scheduled job.
- CV/opportunity matching, email drafting, automatic application submission, Obsidian sync — and any broadening of the research step's authority beyond read-only.
- Multi-user support.
- A full Notion-equivalent UI (arbitrary relations, multiple saved views, real-time collaboration, a native mobile app). The web UI is a deliberately smaller, functional substitute; a responsive page is the mobile story.
- Promoting any JSON list (e.g. contacts) to its own table — only if and when a real cross-opportunity query or independent lifecycle appears.

## Still to specify

Comparing against the CAPTA platform spec (`~/capta/plataforma-herramientas-capta/spec/`) surfaced dimensions a mature spec decides that this one had not. (CAPTA's personas/roles/tenancy/multi-module-handoff structure is intentionally omitted: irrelevant to a single-user tool.)

A grilling session on 2026-07-28 resolved the ingest, transport, storage-shape, and security branches — those are ticked below and written up in *Implementation Decisions* and ADR-0007. Unticked items are still open: **decide them explicitly rather than guessing.**

### LLM pipeline
- [x] Model — `claude-sonnet-5`, effort `high`, adaptive thinking. One call, so no extraction/research split. Haiku ineligible (server-side tool versions).
- [x] Research bound — 3 searches, 8 fetches, as `max_uses` on the tool definitions.
- [x] Cost per opportunity — ~$0.11 typical, ~$0.31 worst case once `max_content_tokens: 5000` bounds fetched content. Single-digit dollars per month at realistic volume; ~$9/month if every submission goes pathological.
- [ ] Where prompt assets live and how they're versioned; the exact ingest prompt. (`n8n/prompts/research.md` is prior art; the extraction prompt lived in the workflow JSON.)
- [x] **Malformed output is designed out, not handled.** The ingest call uses structured outputs (`output_config.format`, supported on Sonnet 5), so the response is schema-valid by construction: no parse errors, no repair retry, no surfacing policy, nothing to test. **Cost: structured outputs are incompatible with citations (400).** Evidence excerpts become model-authored text rather than citation-verified spans. Accepted because evidence is `{url, retrieved_at, excerpt}` and the URL is what gets verified — the user approves every record with the source link in front of them. Residual risk, named: a plausible-but-wrong excerpt is exactly how a wrong deadline would pass approval.
- [x] **The remaining incomplete-record failure is `stop_reason: "max_tokens"`**, which structured outputs do not prevent. Ingest checks for it and reports a failure rather than persisting a truncated record — the same discipline as `pause_turn`, and the same class of bug: an HTTP 200 that is not a complete answer.
- [x] **Two caps, and the one that matters is on input.** `max_content_tokens: 5000` on the `web_fetch` tool definition, `max_tokens: 16000` for output. `max_uses` bounds how many pages are fetched but nothing bounds their size, so without a content cap the worst case is ~$0.79 per opportunity and ~$24/month at thirty submissions — 2.6x the stated per-opportunity figure and outside the single-digit-dollars budget. At 5000 the worst case holds at ~$9.36/month. A PhD advert's useful content is a deadline, a stipend, an eligibility paragraph and a supervisor; a 40k-token page is mostly navigation and sidebars. Failure mode if the cap does bite: a `not_stated` deadline rather than a wrong one, visible on the approval card.
- [x] **No cumulative spend ceiling.** There is no `task_budget` on the Messages API — that is a Managed Agents concept — so a budget would mean tracking spend and refusing calls, guarding against a runaway loop that does not exist here: one submission is one bounded call.

### Integrations (each as a contract: purpose, config/secret, failure mode)
- [x] Telegram — long polling; single-user gate on `TELEGRAM_ALLOWED_USER_ID`.
- [x] Web fetch — server-side; JS-rendered pages, paywalls and bot-blocking become a reported failure, not local engineering. Size capped by `max_content_tokens`.
- [x] Search provider — none. `web_search` is part of the model call; no vendor, no account, no key.
- [x] PDF — downloaded from Telegram's API, passed as a base64 `document` block.
- [ ] Anthropic — key management, rate limits, timeout handling (note a single ingest call can run for minutes).

### Persistence, backup & migration — TODO
- [x] Storage & backup — the database lives in a bind-mounted host directory, and a daily job copies it off-box to an object-storage bucket. The copy goes through SQLite's `.backup` API, never a filesystem copy of a live database, which would produce a torn file. A failed backup raises the Telegram error alert: silent backup failure is the specific hazard this shape has to defend against, since the alternative (continuous WAL replication) fails silently by design. Bucket vendor is settled with the VM choice below.
- [x] **Migration — none. The schema changes by recreating the database and reseeding.** No migration files, no version tracking, no framework. `schema.sql` is the single source of truth for the shape, and changing it means dropping the file and reseeding from the Notion snapshot. This is correct while the schema is still moving and the only real data is the snapshot; it is a decision with an expiry, not a permanent one. **The tripwire: the first confirmed opportunity that does not exist in the Notion snapshot.** From that moment, recreating loses user decisions, and the approach must change — the cheapest successor is dump-to-JSON, recreate, reload, which handles SQLite's `ALTER TABLE` limits without a framework. Until then, recreation is the migration.
- [ ] Notion snapshot → `opportunity` seed transform (field mapping).
- [x] Retention — reject deletes the row; no rejected history, no audit trail.

### Security
- [x] SSRF — dissolved. The app never resolves or connects to a user-submitted URL; its only outbound hosts are `api.anthropic.com` and `api.telegram.org`. ADR-0004's design is not built.
- [x] "External content is data, never instructions" — enforced by shape. The model's only tools are read-only search and fetch, so an injected page instruction cannot reach the database, Telegram, or credentials; the worst outcome is a wrong candidate, which meets validation and human approval. The one rendering hazard is closed by sending Telegram messages with no `parse_mode`.
- [ ] Web UI auth — single password vs. Tailscale, final call.
- [ ] Secrets management (env only, never in git); which secrets exist.

### Configuration & deployment / ops — TODO
- [x] **Host — GCP "Always Free" e2-micro, backups to a GCS bucket in the same project.** One Compose service, `restart: unless-stopped`, a bind mount at `./data`, an env file, and the local timezone supplied as configuration (`TZ`), currently `America/Mexico_City`. The timezone is a tunable, not a constant: the user relocates, and a hard-coded zone would silently misread every deadline afterwards. Timestamps are stored as UTC instants resolved at ingest, so changing `TZ` never reinterprets stored deadlines — it only affects how new ones are read and when reminders fire. No reverse proxy, no published ports, no sidecar — long polling means nothing dials in. Accepted risk: primary and backup share a GCP project, so a billing or account suspension takes both. Mitigated by making a manual off-box copy trivial (below) rather than by a second vendor.
- [x] **Backup is one command, not a hidden job.** A single `backup` entry point does the `.backup` and the upload; the daily scheduler and the user invoke exactly the same code path. Running it by hand must produce a downloadable file with no ceremony, so that keeping an occasional copy outside GCP is a habit rather than a project. The daily run also keeps the last few backups on the box, so recovery from a bad write does not depend on the network.
- [ ] Config/env surface (all tunables in one place).
- [ ] Error-alert channel mechanics (Telegram-to-self on any production failure).
- [ ] Cost/health monitoring so a silent failure or overage is noticed.

### Non-functional budget
- [x] Monthly cost — single-digit dollars at realistic volume; the VM is free and there is no SaaS subscription.
- [x] **Ack is immediate; ingest is fire-and-forget in process.** The bot acknowledges on receipt, echoing back what it got, then runs ingest as unawaited work and sends the approval message when it resolves — minutes later is fine. No job table, no queue, no resume-on-boot. **Accepted loss: a restart mid-ingest drops the submission with no record it existed.** This is tolerable only because one user is present and will notice the reply never came; recovery is resending the link. Rejected: a durable submission row, whose resume-on-boot path would run rarely, test awkwardly, and be wrong the first time it mattered.
- [x] **Silence means "still working" and nothing else.** Every ingest failure — unreadable page, model error, validation rejection — sends a Telegram message saying so. Without this, silence means both "working" and "died", which is what would make the fire-and-forget design unpleasant to live with.
- [ ] Rate limits to respect (Telegram, Anthropic).

### Domain model & code structure — TODO

Raised by a DDD / functional-core-imperative-shell pass over this spec (2026-07-28). The architecture in *Implementation Decisions* is unaffected; these are about the shape of the code inside it.

- [x] **The pending-candidate gap** — resolved as an unconfirmed row in the `opportunity` table, marked by a `confirmed` boolean column. No second aggregate.
- [x] **FCIS research inversion** — dissolved. Anthropic runs the search/fetch loop, so there is no loop on our side to invert; the bound is a `max_uses` number, not a counter we maintain. What stays pure is what already was.
- [x] **SSRF checks in domain normalization** — moot; the checks aren't ported, because nothing fetches user URLs locally.
- [x] **No value objects — the invariant stays a check in `validate`.** Findings travel as plain data; `validate` is the single gate. Considered and rejected: constructor-enforced `Finding`/`Evidence`/`SourceUrl`/`KnowledgeState` types. Value objects earn their keep when an invariant is enforced at many construction sites; here there is one — parsing the model's response — and, since the critical-findings cut, one invariant. Wrapping a single check in a class gives the check somewhere to live, not more safety. Revisit if a second write path appears: the web UI's edit view is the likely one, and with no migrations a bad row written through it is permanent.
- [x] **Nothing in the functional core reads a clock, an environment variable, or a random source.** `now`, the local timezone, lead times, and generated IDs are parameters; the shell mints them and passes them in. The reminder core becomes `dueReminders({ opportunities, now, zone, leadTimes }) → reminders[]`, which makes story 20 assertable in-process: run it, feed the output back as state, run again with the same `now`, assert nothing comes out. Ported n8n code does not satisfy this — `compute-due-reminders.js` calls `new Date()` inline and reads `$input` from scope — so every ported signature changes. Evidence timestamps are exempt by construction: the model returns them inside its response, so they arrive as data.
- [ ] Rename ported payloads from pipeline-stage names (`build-opportunity-payload`, `prepare-opportunities`, `diff-and-alert`) to the domain terms already in CONTEXT.md.

### Open questions carried over — TODO
- [ ] Weekly recheck: in or out (currently Out of Scope — confirm or schedule).
- [x] **Application stage — cut.** The app records opportunities and deadlines; it does not track progress through an application. No enum, no column, no user story.
- [x] **Opportunity status — cut**, for the same reason. "Still open?" is a fact about the world that would need hand-maintaining to stay true, and a stale status is worse than no status. Absence of a future deadline carries what the reminder loop actually needs.
- [x] **Critical findings — deadline only.** The evidence requirement exists to stop the app acting on an unchecked assertion, and after the workflow-state cut there is exactly one field it acts on unattended: `deadline_at` fires a reminder weeks later with nobody watching. Funding, eligibility and required documents are read on screen with the source URL beside them — display, not automation — so gating them produces `needs_confirmation` noise on fields the page stated plainly. Accepted cost: a wrong eligibility claim can waste a week, it just cannot waste it silently.

## Further Notes

- Unchanged invariants carried from CONTEXT.md: external content is untrusted data (never instructions); research is read-only and bounded; unknown stays unknown; critical findings require evidence and human confirmation; every mutation passes deterministic validation and explicit approval.
- The AI calls are the only recurring cost; everything else is free (VM, SQLite, Telegram, the app itself).
- Suggested build order: (1) the Telegram → fetch → extract → validate → approve → persist loop against SQLite; (2) the daily reminder job; (3) the web UI. Each is independently useful and testable.
- Work is on branch `rewrite/standalone-app`. Decisions are recorded in `docs/adr/0006-standalone-node-app-replaces-n8n-and-notion.md`; the domain glossary is `CONTEXT.md`.
