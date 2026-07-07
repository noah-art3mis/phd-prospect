# Plan — consolidation after step 5

Step 5 (extract → research → validate → approve → persist) is built and verified in the live `Prospect – Ingest opportunity` workflow. This plan covers everything between that and a published, monitored system: repo sync with a real source-of-truth pipeline, hardening the ingest workflow, building the two scheduler workflows, and the final end-to-end test (step 6). Each phase is its own branch → PR → `review-polytoken` → merge cycle. Phases are ordered by dependency; 2 and 3 could interleave, but 1 gates everything because it establishes where changes get authored.

## Decisions this plan assumes (defaults — flag if you disagree)

- **Timezone:** `Europe/London` for workflow scheduling and deadline interpretation when a source doesn't state one (most targets are UK/EU; adjust per-deadline when a source is explicit). Documented in CONTEXT.md as part of phase 2.
- **Edit-deadline button:** removed for now rather than implemented — it needs a stateful reply-capture flow that isn't worth building until a real deadline correction is needed. Correcting a deadline happens in Notion directly (the editable source of truth).
- **Research-again button:** implemented — it loops the pending record back through the Research node with the missing fields as the target.
- **Idempotency store:** n8n Data Tables for reminder sent-keys, same mechanism as pending approvals.
- **Self-hosted path:** deleted (`compose.yaml`, self-hosted sections of docs). The project runs on n8n Cloud; no legacy alternative path.
- **SSRF fetch:** kept as-is (n8n-side fetch + blocklist). The Anthropic `web_fetch` alternative is recorded as a future simplification, not done now.

## Phase 1 — Repo sync and source-of-truth pipeline

Goal: the repo becomes the source of truth; the live instance becomes a deploy target. This phase merges the current `feat/ingest-pipeline` branch.

1. **Export the live ingest workflow** via MCP (`get_workflow_details`) as the raw material. Do not hand-edit it yet.
2. **Extract embedded payloads into files:**
   - Every Code node's JS → `n8n/code/<node-slug>.js` (auth-normalize, envelope, extract-request, parse-extraction, listing-reply, research-request, merge-research, validate, opportunity-payload, deadline-payloads, authorize-callback). Header comment in each noting the sandbox limits: no `URL`, no `require`.
   - Extraction and research prompts → `n8n/prompts/extract.md`, `n8n/prompts/research.md`.
   - The Anthropic `output_config` schema is derived from `schemas/opportunity-candidate.schema.json` at build time, not stored twice.
3. **Write the build step** as a `prospect` CLI subcommand (`prospect build-workflows`): reads the topology template in `n8n/workflows/`, inlines code/prompts/schema, and emits two outputs — the tracked template (placeholders: `REPLACE_WITH_TELEGRAM_USER_ID`, `REPLACE_WITH_DATA_SOURCE_*`) and the git-ignored deployable `n8n/import/` copy with real values from `.env` + `notion-data-sources.json`. TDD the substitution/inlining logic.
4. **Contract tests for the JS validate port.** Run `n8n/code/validate.js` under `node` from pytest (subprocess) against `fixtures/opportunity-candidate.json`, asserting output equivalence with `normalize_opportunity` in `src/prospect/records.py`. This is the drift tripwire — Python and JS pinned to the same fixture. Add at least one fixture per knowledge-state edge (evidence-less critical finding stays non-`found`, `conflicting_sources`, unknown stays unknown).
5. **Round-trip check:** deploy the built JSON to a scratch workflow via MCP, `get_workflow_details` it back, and diff against the live one (normalized). Delete the scratch workflow. This proves the repo copy is complete, not approximately complete.
6. **Cleanup:** delete `docs/HANDOFF-step5.md` (stale), delete `compose.yaml` and self-hosted doc sections, update `n8n/README.md` to describe the build/deploy flow (repo → `prospect build-workflows` → MCP push) instead of manual import.
7. Full `review-polytoken` (security-relevant surface), merge.

Exit criterion: a from-scratch MCP deploy of `n8n/import/01-ingest-opportunity.json` produces a workflow behaviorally identical to the live one.

## Phase 2 — Harden the ingest workflow

Authoring rule from here on: iterate live via `update_workflow` + pinned `test_workflow`, then fold each verified change back into the repo source and redeploy from repo. Never leave the live instance ahead of the repo at the end of a work session.

1. **Error workflow.** New small workflow: error trigger → format (workflow name, node, message, source URL if present) → Telegram to the allowed user. Set as `errorWorkflow` on all three workflows. Tracked as `n8n/workflows/00-error-alerts.json` through the same build pipeline.
2. **Stale/duplicate callback handling.** After `Load pending`, route the row-not-found case to an "already handled" `answerQuery` instead of erroring. Test: press confirm twice on the same pending item (pinned).
3. **Pending-approval TTL.** Add `created_at` to the pending table if absent; the daily scheduler (phase 3) sweeps rows older than 7 days and notifies "expired without decision".
4. **Concurrency key check.** Verify the callback data keys the exact pending row (not "latest") with two pending items in flight; fix keying if needed.
5. **Buttons:** implement research-again (loop back through Build research request → Research → Merge → Validate → update pending row → re-send approval); remove edit-deadline button and its notify stub.
6. **Timezone:** set explicitly on all workflows; add the timezone interpretation rule to CONTEXT.md.
7. Review → merge.

## Phase 3 — Scheduler workflows (02 and 03) — built live by a concurrent session; folded back here

The live builds of 02 (`Prospect – Deadline reminders`, `8PJDDDrPkVHX284l`) and 03 (`Prospect – Recheck active opportunities`, `SD9qiTXrdkCHa9Sj`) were done by a concurrent session directly on the instance. This branch folded them back verbatim into the build pipeline (payloads in `n8n/code/`, sentinel templates in `n8n/workflows/`, round-trip `EQUIVALENT` against fresh exports) and pinned the ported logic with contract tests. Divergences from the plan below were recorded (deferred list), not fixed.

1. ~~**Data Table `sent_reminders`**~~ Done as Data Table `Prospect sent reminders` (`132FXPAohVWMXdHq`), keyed `opportunity_id:deadline_id:version:offset`; the workflow filters with `rowNotExists` and inserts after the Telegram send.
2. ~~**02 deadline reminders (daily):**~~ Built: Notion deadlines query (Verified, non-rolling) → `compute-due-reminders.js` (port of `src/prospect/reminders.py`, pinned by `tests/test_contract_reminders.py`, Python == JS == golden) → Data Table filter → Telegram send → insert sent key. The pending-approval TTL sweep is NOT wired in yet (deferred). The pinned twice-run idempotency test is still to do live (phase 4 smoke).
3. ~~**03 recheck active opportunities (weekly):**~~ Built: active-opportunity query → per-page fetch → status-only re-extract (Anthropic) → `diff-and-alert.js` (closure/withdrawal/drift/no-longer-accepting/fetch-failure alerts, golden-pinned by `tests/test_contract_recheck.py`) → Telegram alert + `Last checked` stamp. It diffs status only, not the full critical-finding set the plan sketched; it never writes confirmed values.
4. Fold-back through the build pipeline done; review → merge pending.

## Phase 4 — Step 6: end-to-end test and publish

1. **Live smoke tests** (workflows still inactive, triggered via `test_workflow`/manual): the UKP jobs index URL → expect listing enumeration reply, no Notion write; the Gurevych post URL → expect full posting flow through approval; press confirm → verify the Notion opportunity page and deadline rows match `opportunity_page_payload` expectations; press reject on a second run → verify no write and pending row deleted.
2. **Failure-path test:** submit an unreachable URL → expect the error workflow's Telegram alert.
3. **Publish** all four workflows (error, ingest, reminders, recheck). Watch the first scheduled runs of 02 and 03; verify reminder idempotency across two consecutive days.
4. **Wrap:** update `docs/setup.md` status table, note the `web_fetch`-instead-of-n8n-fetch simplification as a recorded future option.

## Deferred (recorded, not scheduled)

- Replace n8n-side fetch with Anthropic `web_fetch` in the extract call (removes the SSRF surface; costs raw-content control).
- Move baked-in config (Telegram user ID, data-source IDs) to n8n Variables to shrink the build step's substitution work.
- Edit-deadline flow via Telegram reply capture, if editing in Notion proves annoying in practice.

### Phase-4 fixes carried out of phase 3 (live logic folded verbatim; fix live-then-fold, then update the pins)

- **Timezone in `compute-due-reminders.js`:** the live node hardcodes `TZ = 'America/Mexico_City'` for "today"; the project decision (CONTEXT.md) is `Europe/London`. Left verbatim to preserve round-trip equivalence; fix live, re-fold, and update `tests/golden/reminder_cases.json`'s `frozen_now_utc`/`as_of` pairing.
- **Pending-approval TTL sweep** (phase 2 item 3) is not wired into workflow 02's daily run yet.
- **Silent model-call failure in recheck:** when the `Re-extract status` Anthropic call errors (it continues on error), `diff-and-alert.js` extracts `{}`, fires no alert, and still stamps `Last checked` — an outage is indistinguishable from "no change" and postpones the next look. Pinned as current behavior in `tests/golden/recheck_cases.json` (`model_call_failure_is_silent_and_still_stamps_last_checked`).
- **Lenient JS vs strict Python reminder validation** (pinned as divergence cases in `tests/golden/reminder_cases.json`): the live port defaults a missing `Version` to 1, accepts negative reminder offsets (would remind after the deadline passed), and accepts date-only due values, where `prospect.deadlines.normalize_deadline` raises `InvalidDeadline`. Decide one contract and align.
- **`sent_at` is computed at calculation time,** not after the Telegram send, so the recorded timestamp slightly predates the actual send (cosmetic).
- **Manual UI step from phase 2:** set `errorWorkflow` (→ `Prospect – Error alerts`) and the `Europe/London` timezone in workflow Settings for all existing workflows — `update_workflow` cannot reach the settings block.
