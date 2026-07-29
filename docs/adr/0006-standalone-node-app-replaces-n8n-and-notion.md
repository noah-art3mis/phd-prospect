# ADR-0006: A standalone Node app replaces n8n and Notion

## Status

Accepted (2026-07-20). Supersedes ADR-0002 (Notion-first storage) and ADR-0005 (git is the source of truth for the n8n workflow).

## Context

The original design ran the pipeline as four n8n Cloud workflows (the ingest graph alone was 38 nodes) with Notion as the store, kept in sync with git through a build pipeline (sentinel/placeholder substitution, MCP push, compare-until-`EQUIVALENT`, manual publish). Every standing failure point recorded in the old spec's fragility section was in that machinery, not in the domain logic — it was the accidental cost of keeping git and a live SaaS instance mirrored.

Two constraints then hardened the decision:

- **Free.** n8n Cloud dropped its permanent free tier ($24/mo after a trial). Staying free forces self-hosting a runtime regardless — at which point n8n's main advantage (hosted, no-ops) disappears while its structural ceremony remains.
- **Simple.** The rewritten spec states the goal plainly: "a prototype made to work with one user. Not bulletproof code. If in doubt, opt for simplicity."

## Decision

Replace the n8n + Notion stack with a single long-running Node application, containerised with Docker, hosted on a free always-on VM (GCP "Always Free" e2-micro, or a ~€3/mo Hetzner box if its caveats bite). The app owns the whole runtime surface:

- **Telegram bot** (webhook, instant replies) for ingest and approve/edit/reject.
- **Pipeline** in plain testable code: fetch → LLM extract → bounded read-only research → deterministic validation → human approval → persist.
- **`node-cron`** for daily deadline reminders.
- **SQLite** as the store — a single `opportunity` table. Entities that are only ever read attached to an opportunity (supervisors, contacts, research topics, findings, evidence, references) are **JSON columns**, not tables. The deadline is a single nullable `deadline_at` **timestamp column** with a `reminders_sent` JSON field for idempotency; a rolling or dateless opportunity has `deadline_at = NULL`.
- **Minimal self-hosted web UI** (same process) for browsing/editing opportunities, behind single-password or Tailscale auth. Deferred until the Telegram + reminder loop is reliable.

Anthropic is the extraction/research model (usage-based, unavoidable in any design). Git holds all application code as the source of truth; there is no live-instance mirror to reconcile.

## Consequences

- The entire accidental-complexity layer is deleted: no visual node graph, no build pipeline, no draft-vs-published, no MCP push, no git↔live drift, no Notion data-source-ID substitution, no code-node sandbox limits. The domain logic becomes ordinary, git-native, unit-tested code.
- SQLite stores lists-of-objects natively (JSON columns), removing the Notion pain of flattening JSON arrays into rich-text/multi-select.
- The data model collapses from five related Notion sources to one table plus JSON — justified because only the reminder query needed a scalar `deadline_at` column, and nothing else needs cross-parent queries yet. Promoting a JSON list to a table later (e.g. contacts) is a small migration; deferred under YAGNI.
- Cost is the free VM plus metered Anthropic tokens (cents per opportunity for one user). No SaaS subscription.
- We give up Notion's polished relational UI and native mobile app; the self-hosted web UI is a deliberately smaller, functional substitute, and a responsive page is the mobile story.
- The always-on host removes both earlier hosting compromises at once: no "laptop must be on," and no GitHub-Actions polling latency / stateless-approval workaround.

## References

- `SPEC.md` — the rewritten, simplified specification this ADR serves.
- ADR-0001 (bounded agentic research) and ADR-0003 (evidence-backed records) still stand — the research bound and the findings/evidence contract are unchanged.
- ADR-0002, ADR-0005 — superseded by this decision.
