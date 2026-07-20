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
- **Ingest transport:** the Telegram bot receives messages via webhook (the always-on host makes instant replies possible) and drives approval through inline buttons. Exactly one user is admitted, gated on `TELEGRAM_ALLOWED_USER_ID`.
- **Pipeline stages** run as ordinary, individually testable functions: `fetch` (page/PDF → text) → `extract` (text → candidate record via the AI model) → `research` (fill explicitly-missing fields) → `validate` (deterministic) → `approve` (human gate) → `persist`.
- **Research bound (ADR-0001):** read-only tools only; a hard cap on searches and fetched pages per opportunity; official domains preferred. The research step has no ability to write records, send arbitrary messages, run shell, or touch credentials.
- **Data contract (ADR-0003):** the record is `{ title, source_url, findings: { <field>: { state, value, evidence[] } } }`, per `schemas/opportunity-candidate.schema.json`. `state` ∈ {`found`, `not_stated`, `not_applicable`, `conflicting_sources`, `needs_confirmation`}. Evidence items are `{ url, retrieved_at, excerpt }`. Critical findings cannot be `found` without evidence; `conflicting_sources` needs ≥2 sources; validation never upgrades a state.
- **AI model:** Anthropic, used for both extraction and the bounded research step. Model output is parsed leniently; the deterministic validation step is the guardrail (not a schema-enforced decode).
- **Storage — SQLite, a single `opportunity` table.** Scalar columns for the queried/sorted fields (title, source_url, status, application stage, priority, institution, …). Attached lists that are only ever read with the opportunity — `findings`, `evidence`, `supervisors`, `contacts`, `research_topics`, `references` — are **JSON columns**, not separate tables. This stores lists-of-objects natively, which was the specific thing Notion made painful.
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
  - `extract` parsing: given representative fetched content (fixtures), assert the shape and knowledge-states of the produced findings.
  - `research` merge: given a candidate with missing fields plus stubbed search/fetch results, assert only explicitly-missing fields are filled and evidence is attached; unknown stays unknown.
  - `reminders`: given a set of opportunities with `deadline_at`/`reminders_sent` and a fixed "now", assert exactly the due lead-times are returned and that a second run with the updated state returns nothing (idempotency).
- **Prior art:** the existing golden-driven `node:test` suite is the pattern to follow for all of the above; reuse the golden fixtures where the contract is unchanged.

## Out of Scope

- **Weekly recheck** of whether opportunities are still open — deferred until ingestion + reminders are demonstrably reliable. May return as a second scheduled job.
- CV/opportunity matching, email drafting, automatic application submission, Obsidian sync — and any broadening of the research step's authority beyond read-only.
- Multi-user support.
- A full Notion-equivalent UI (arbitrary relations, multiple saved views, real-time collaboration, a native mobile app). The web UI is a deliberately smaller, functional substitute; a responsive page is the mobile story.
- Promoting any JSON list (e.g. contacts) to its own table — only if and when a real cross-opportunity query or independent lifecycle appears.

## Further Notes

- Unchanged invariants carried from CONTEXT.md: external content is untrusted data (never instructions); research is read-only and bounded; unknown stays unknown; critical findings require evidence and human confirmation; status ≠ stage; every mutation passes deterministic validation and explicit approval.
- The AI calls are the only recurring cost; everything else is free (VM, SQLite, Telegram, the app itself).
- Suggested build order: (1) the Telegram → fetch → extract → validate → approve → persist loop against SQLite; (2) the daily reminder job; (3) the web UI. Each is independently useful and testable.
- Work is on branch `rewrite/standalone-app`. Decisions are recorded in `docs/adr/0006-standalone-node-app-replaces-n8n-and-notion.md`; the domain glossary is `CONTEXT.md`.
