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
10. As the user, I want **Critical findings** (deadline, funding, eligibility, required documents) to require Evidence before they count as `found`, so that I can trust the important fields.
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
22. As the user, I want the app to keep an opportunity's external **status** (open/closed/withdrawn/unknown) separate from my **application stage** (Inbox → … → Accepted), so that "the programme closed" and "I withdrew" never get confused.
23. As the user, I want to be alerted when a production step fails, so that a silent breakage doesn't cost me a deadline.
24. As the user, I want a minimal web page listing my opportunities sorted by deadline/priority/status, so that I can sit and compare them.
25. As the user, I want to open one opportunity and edit its fields on that page, so that I can maintain records outside Telegram.
26. As the user, I want the web page protected by a single password or a private network, so that only I can reach it.
27. As the user, I want to view an opportunity's findings and evidence as a readable list, so that I can check provenance.
28. As the user, I want the whole thing to run unattended on an always-on box, so that reminders fire even when my laptop is off.
29. As the user, I want all times interpreted in Europe/London unless a source states otherwise, so that deadlines are consistent.
30. As the user, I want the app's code and database schema in git, so that I can back up, recreate, and reason about the system.
31. As the user, I want to import my existing Notion data as seed records, so that I don't lose what I've already collected.

## Implementation Decisions

- **Architecture (ADR-0006):** a single long-running Node application, containerised with Docker, hosted on a free always-on VM (GCP "Always Free" e2-micro; a ~€3/mo Hetzner box is the zero-hassle fallback). The one process owns the Telegram bot, the ingest pipeline, the scheduled reminder job, and the web UI. No n8n, no Notion, no build/deploy pipeline, no MCP.
- **Ingest transport:** the Telegram bot uses **long polling** — no domain, TLS certificate, reverse proxy, or inbound port, and no need to authenticate incoming requests, because the app dials out. Approval runs through inline buttons. Exactly one user is admitted, gated on `TELEGRAM_ALLOWED_USER_ID`.
- **Ingest is one agentic call (ADR-0007):** the submitted URL goes to a single Anthropic call whose server-side `web_fetch` and `web_search` tools fetch the page, extract the opportunity, and fill gaps. The app never fetches a user-submitted URL itself, so no SSRF surface exists to defend. The remaining stages are ordinary testable functions: `validate` (deterministic) → `approve` (human gate) → `persist`.
- **`pause_turn` must be handled.** Anthropic's server-side tool loop stops at its iteration limit with `stop_reason: "pause_turn"` and HTTP 200. Ingest checks `stop_reason` and re-sends to resume; treating the first response as final yields truncated candidates that look successful.
- **Research bound (ADR-0001):** read-only tools only, bounded by `max_uses` on the tool definitions — 3 searches, 8 fetches — carried over from the n8n build. The model has no tool that can write records, send messages, run shell, or touch credentials, so the read-only property holds by construction rather than by policy.
- **Telegram messages carry no `parse_mode`.** Findings come from pages an attacker controls and are interpolated into the approval message. Sending plain text means there is nothing to escape, removing the class of bug that required commits `5ff20d5` and `1c5601d` in the n8n build.
- **Data contract (ADR-0003):** the record is `{ title, source_url, findings: { <field>: { state, value, evidence[] } } }`, per `schemas/opportunity-candidate.schema.json`. `state` ∈ {`found`, `not_stated`, `not_applicable`, `conflicting_sources`, `needs_confirmation`}. Evidence items are `{ url, retrieved_at, excerpt }`. Critical findings cannot be `found` without evidence; `conflicting_sources` needs ≥2 sources; validation never upgrades a state.
- **AI model:** `claude-sonnet-5` at effort `high` with adaptive thinking, for the single ingest call. Haiku is not eligible — the `web_search_20260209` / `web_fetch_20260209` tool versions require Opus 5/4.8/4.7/4.6, Sonnet 5, or Sonnet 4.6. Effort stays at `high` because the design depends on the model actually calling its tools, and tool-use rate falls at lower effort and with thinking disabled. Cost is roughly $0.12–$0.30 per opportunity. Model output is parsed leniently; deterministic validation is the guardrail (not a schema-enforced decode).
- **PDFs** are downloaded from Telegram's own API and passed to the model as base64 `document` blocks — no local PDF parsing. A Telegram file URL is never handed to `web_fetch`: the bot token is embedded in its path.
- **Storage — SQLite, a single `opportunity` table.** Scalar columns for the queried/sorted fields (title, source_url, status, application stage, priority, institution, …). Attached lists that are only ever read with the opportunity — `findings`, `evidence`, `supervisors`, `contacts`, `research_topics`, `references` — are **JSON columns**, not separate tables. This stores lists-of-objects natively, which was the specific thing Notion made painful.
- **Pending candidates are unconfirmed rows in the same table**, marked by a `confirmed` flag — not a second table, and *not* a value of `application_stage` or `status`. Those two mean the user's progress and the external world respectively; whether a record has been approved is a property of the record. Keeping it a separate column makes "skip unapproved rows" one predicate that the reminder query and every listing must apply, rather than an enum value it is possible to forget.
- **Reject deletes the row.** No rejected-history is kept, so resubmitting a previously rejected link runs the full call again. Accepted as a simplification; `opportunityFingerprint` therefore has no consumer and is not ported.
- **Re-submission of a confirmed opportunity is caught before the model call:** canonicalize the submitted URL (porting `canonicalizeUrl` from `validate_opportunity.js`, already golden-tested), look for an existing confirmed row, and if found reply with its deadline and stage instead of calling the model. This prevents both the wasted call and the duplicate reminders two rows for one deadline would produce.
- **Deadline as a scalar:** a single nullable `deadline_at` timestamp column on the opportunity, plus a `reminders_sent` JSON field recording which lead-times have already fired (idempotency). Rolling/dateless ⇒ `deadline_at = NULL`. No deadline `type`, no per-deadline evidence (the reference lives in the opportunity's `references`), no `verified`/`rolling` flags — Telegram approval *is* verification, and NULL *is* rolling.
- **Reminder query:** the daily job selects opportunities where `deadline_at` is non-null and falls within a configured lead window, sends any lead-time reminder not yet in `reminders_sent`, and records it. Idempotency key is effectively `opportunity + lead_time`.
- **Status vs stage:** external opportunity status and the user's application stage are separate fields (invariant from CONTEXT.md); neither derives from the other.
- **Web UI:** server-rendered pages in the same app, reading/writing the same SQLite file — a list/sort view, a detail/edit view, and evidence rendering. Auth is a single password (signed session cookie) or exposure only over a private network (Tailscale). **Deferred** until the Telegram + reminder loop is demonstrably reliable.
- **Timezone:** Europe/London default; an explicit source timezone wins.
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
- [x] Cost per opportunity — ~$0.12–$0.30 measured against current pricing; single-digit dollars per month at realistic volume. A *hard* ceiling is still undecided (see below).
- [ ] Where prompt assets live and how they're versioned; the exact ingest prompt. (`n8n/prompts/research.md` is prior art; the extraction prompt lived in the workflow JSON.)
- [ ] Behaviour when the model returns malformed / unparseable output (retry policy, surfacing).
- [ ] Whether to set a hard token ceiling — `max_tokens`, or a `task_budget` — so a pathological page can't run up an unbounded call.

### Integrations (each as a contract: purpose, config/secret, failure mode)
- [x] Telegram — long polling; single-user gate on `TELEGRAM_ALLOWED_USER_ID`.
- [x] Web fetch — server-side; JS-rendered pages, paywalls and bot-blocking become a reported failure, not local engineering. Size capped by `max_content_tokens`.
- [x] Search provider — none. `web_search` is part of the model call; no vendor, no account, no key.
- [x] PDF — downloaded from Telegram's API, passed as a base64 `document` block.
- [ ] Anthropic — key management, rate limits, timeout handling (note a single ingest call can run for minutes).

### Persistence, backup & migration — TODO
- [ ] Where the SQLite file lives on the VM; backup cadence and target (off-box?).
- [ ] Schema migration approach as the model evolves.
- [ ] Notion snapshot → `opportunity` seed transform (field mapping).
- [x] Retention — reject deletes the row; no rejected history, no audit trail.

### Security
- [x] SSRF — dissolved. The app never resolves or connects to a user-submitted URL; its only outbound hosts are `api.anthropic.com` and `api.telegram.org`. ADR-0004's design is not built.
- [x] "External content is data, never instructions" — enforced by shape. The model's only tools are read-only search and fetch, so an injected page instruction cannot reach the database, Telegram, or credentials; the worst outcome is a wrong candidate, which meets validation and human approval. The one rendering hazard is closed by sending Telegram messages with no `parse_mode`.
- [ ] Web UI auth — single password vs. Tailscale, final call.
- [ ] Secrets management (env only, never in git); which secrets exist.

### Configuration & deployment / ops — TODO
- [ ] VM choice (GCP e2-micro vs. Hetzner) and the Docker Compose shape.
- [ ] Config/env surface (all tunables in one place).
- [ ] Error-alert channel mechanics (Telegram-to-self on any production failure).
- [ ] Cost/health monitoring so a silent failure or overage is noticed.

### Non-functional budget
- [x] Monthly cost — single-digit dollars at realistic volume; the VM is free and there is no SaaS subscription.
- [ ] Acceptable latency (instant Telegram ack vs. the ingest call completing in minutes).
- [ ] Rate limits to respect (Telegram, Anthropic).

### Domain model & code structure — TODO

Raised by a DDD / functional-core-imperative-shell pass over this spec (2026-07-28). The architecture in *Implementation Decisions* is unaffected; these are about the shape of the code inside it.

- [x] **The pending-candidate gap** — resolved as an unconfirmed row in the `opportunity` table, marked by a `confirmed` column kept separate from both `application_stage` and `status`. No second aggregate.
- [x] **FCIS research inversion** — dissolved. Anthropic runs the search/fetch loop, so there is no loop on our side to invert; the bound is a `max_uses` number, not a counter we maintain. What stays pure is what already was.
- [x] **SSRF checks in domain normalization** — moot; the checks aren't ported, because nothing fetches user URLs locally.
- [ ] Whether the finding invariants become constructor-enforced value objects (`Finding`, `Evidence`, `SourceUrl`, `KnowledgeState`) rather than post-hoc checks in `validate` — making "a critical finding cannot be `found` without evidence" unrepresentable instead of defended against.
- [ ] Confirm `now`, IDs, and randomness are arguments everywhere, never ambient. `n8n/code/compute-due-reminders.js` calls `new Date()` inline and reads `$input` from scope; story 20's idempotency is untestable if that ports across as-is.
- [ ] Rename ported payloads from pipeline-stage names (`build-opportunity-payload`, `prepare-opportunities`, `diff-and-alert`) to the domain terms already in CONTEXT.md.

### Open questions carried over — TODO
- [ ] Weekly recheck: in or out (currently Out of Scope — confirm or schedule).
- [ ] Exact application-stage enum (Inbox → … → Accepted; terminal states).
- [ ] Exact opportunity-status enum (open/closed/withdrawn/unknown — final set).
- [ ] The definitive set of "critical findings" beyond deadline/funding/eligibility/required-documents.

## Further Notes

- Unchanged invariants carried from CONTEXT.md: external content is untrusted data (never instructions); research is read-only and bounded; unknown stays unknown; critical findings require evidence and human confirmation; status ≠ stage; every mutation passes deterministic validation and explicit approval.
- The AI calls are the only recurring cost; everything else is free (VM, SQLite, Telegram, the app itself).
- Suggested build order: (1) the Telegram → fetch → extract → validate → approve → persist loop against SQLite; (2) the daily reminder job; (3) the web UI. Each is independently useful and testable.
- Work is on branch `rewrite/standalone-app`. Decisions are recorded in `docs/adr/0006-standalone-node-app-replaces-n8n-and-notion.md`; the domain glossary is `CONTEXT.md`.
