# ADR-0005: Git is the source of truth for the n8n workflow

## Status

Accepted

## Context

Step 5 (extract → research → validate → approve → persist) is built live in n8n Cloud through the n8n MCP, but the repo also tracks canonical workflow JSON under `n8n/workflows/`. The same artifacts then exist in more than one place – the workflow graph, the deterministic validation logic (Python spec vs. the JS Code node), the prompts, and the output schema – and can silently drift. This change touches security-relevant logic (SSRF, auth, untrusted content, no-invention validation), so it is explicitly not a fast-lane patch and needs an agreed development approach before more nodes are added. See issue #4.

## Decision

Git is the single source of truth; the live n8n workflow is a deployment artifact, not authoritative. Build live via MCP for fast feedback (`test_workflow`, pinned nodes), but treat that as a scratch build that must round-trip back to git through tooling, never by hand.

Concretely, each duplication surface gets one owner and a mechanical guard:

- **Deterministic validation logic** – the JS Code node cannot run `prospect.records`, so the contract is re-implemented once in `n8n/code/validate_opportunity.js` and pinned to the Python spec by a cross-language contract test (`tests/test_contract_normalize.py`) over shared golden cases (`tests/golden/normalize_opportunity_cases.json`). Both implementations and the recorded expectation must agree or CI fails. This is the highest-risk drift point and is guarded first.
- **Workflow graph** – a round-trip sync script pulls the live workflow, strips credential IDs, replaces the real Telegram user ID with `REPLACE_WITH_TELEGRAM_USER_ID`, normalises node positions / `versionId` / `meta`, and writes deterministic `n8n/workflows/*.json`; a companion step regenerates the git-ignored `n8n/import/*.json`.
- **Prompts and output schema** – `n8n/prompts/*.md` and `schemas/opportunity-candidate.schema.json` stay the only tracked copies and are injected into node bodies at import time, not pasted.
- **Secrets / IDs** – tracked JSON never contains real credential IDs or the real Telegram user ID; a secret-scan check enforces this.
- **CI drift guard** – a check re-runs the sanitising export and fails if `n8n/workflows/` would change (live ≠ git), alongside the secret-scan.

Step 5 nodes are built and merged incrementally through branch → `review-polytoken` → merge; the workflow stays inactive until Step 6.

## Consequences

- `git diff` is meaningful: a reviewer sees the actual change to the workflow, not a hand-sanitised approximation.
- The single most dangerous divergence – the JS validation port silently disagreeing with the Python spec – turns any drift into a red build. A mutation test confirms the guard has teeth.
- The remaining guards (export/sync script, CI drift + secret-scan, prompt/schema injection) are follow-up work tracked under #4; until they land, the workflow-graph round-trip stays a manual, review-gated step and must not be trusted to a fast-lane merge.
- The validation logic now lives in two languages by necessity; keeping them in step costs one shared golden file that must grow with every new rule.

## References

- Issue #4 – single source of truth for the MCP-built workflow.
- `docs/HANDOFF-step5.md` – build plan, repo-sync obligation, MCP lessons.
- `src/prospect/records.py`, `src/prospect/identity.py` – the Python validation spec being ported.
- ADR-0003 – evidence-backed records (the contract the validation enforces).
