# Plan: rewrite all Python to JavaScript (single-language repo)

## Why
The repo currently maintains a Python "spec" package (src/prospect) whose domain modules mirror JS logic that actually runs in n8n Code nodes (n8n/code/*.js), pinned by cross-language golden contract tests. That means every domain contract is implemented twice. Decision: make JS the single language. The n8n/code payloads become the only domain implementation; the Python tooling (workflow build, Notion bootstrap, seeding, comparison) is ported to Node.

## Ground rules
- Plain JavaScript (Node >= 20), CommonJS to match the existing tests/js/*.cjs and n8n/code style. No TypeScript, no bundler, no new runtime dependencies unless unavoidable (prefer node builtins: node:test, node:fs, node:https).
- No backwards-compatibility shims. When something moves, update every caller, test, doc, and CI reference. Delete the Python entirely at the end: src/, pyproject.toml, uv.lock, tests/*.py.
- Golden case JSON files in tests/golden/ are the durable contracts — keep them unchanged wherever possible.
- The build output must be verified byte-identical: before touching anything, run "uv run prospect build-workflows" and save hashes of n8n/import/*.json. After the Node port, the new build command must produce identical files. This is the migration's key invariant.
- n8n/code/*.js payload files are ALREADY the live logic — do not rewrite their behavior, only extend exports if a test needs a function handle (the existing module.exports guard pattern, stripped at build time by the inliner, is the mechanism).

## Inventory (what maps to what)
1. Domain mirrors to DELETE (JS equivalent already live):
   - src/prospect/records.py -> n8n/code/validate_opportunity.js (normalizeOpportunity)
   - src/prospect/identity.py -> canonicalizeUrl/opportunityFingerprint in validate_opportunity.js
   - src/prospect/deadlines.py + reminders.py -> n8n/code/compute-due-reminders.js
   - src/prospect/notion_pages.py (opportunity_page_payload) -> n8n/code/build-opportunity-payload.js
   - src/prospect/research.py -> n8n/code/build-research-request.js
   Note: notion_pages.contact_page_payload is used only by seeding — port it into the new seed tool (step 3), not into n8n/code.
2. Tooling to PORT to Node (new top-level tools/ directory):
   - src/prospect/workflows.py + cli.py "build-workflows" -> tools/build-workflows.cjs (sentinel inlining {{FILE:}}, {{INLINE_JS:}}, {{PROMPT_LINES:}}, sandbox-note stripping, module.exports stripping, placeholder substitution from .env + notion-data-sources.json, leftover-marker rejection). Read workflows.py carefully and port behavior exactly - the byte-identical check depends on it (JSON serialization: match Python json.dump with indent=2 + ensure_ascii=False + trailing newline).
   - scripts/compare_workflows.py -> tools/compare-workflows.cjs (same normalization semantics and exit codes; keep the module docstring's behavior contract as a header comment).
   - src/prospect/notion.py + notion_schema.py + scripts/bootstrap_notion.py -> tools/bootstrap-notion.cjs (one-time; keep the schema definition data structure faithful).
   - src/prospect/seed.py + contact seeding -> tools/seed-notion.cjs.
   - Wire "npm run build-workflows", "npm run compare-workflows", "npm test" etc. in a new package.json (no dependencies).
3. Tests to CONVERT (node:test, keep tests/golden/*.json):
   - Cross-language contract tests (test_contract_*.py + tests/js/run_*_contract.cjs) collapse into direct JS unit tests over the golden files using the existing tests/js/noderun.cjs harness. The "python: invalid" divergence cases in reminder_cases.json lose their Python side - convert them to assertions pinning the JS behavior only, and note in the test header that the strict-Python contract is retired.
   - Pure tooling tests (test_build_workflows.py incl. the telegram parse_mode/escaping lint tests, test_compare_workflows.py, test_notion_schema.py, test_notion_pages.py, test_contact_pages.py, test_records.py, test_identity.py, test_deadlines.py, test_reminders.py, test_missing_fields.py, test_research.py, test_seed.py, test_notion_bootstrap.py, test_cli.py) -> port the ones whose subject survives (tooling + lint + golden contracts); drop the ones whose subject was a deleted Python mirror IF the same contract is already covered by a golden-driven JS test; otherwise port the missing assertions into the JS test for the corresponding n8n/code payload.
4. CI: update .github/workflows/* from uv/pytest to Node (actions/setup-node, npm test, and the byte-identical build check). Remove Python setup.
5. Docs: update AGENTS.md, README.md, docs/setup.md, docs/adr/0005 (add a note: JS became the single language, date it), CONTEXT.md if it references Python. Update the user-facing commands (uv run ... -> npm run ...).

## Verification gates (in order, each must pass before moving on)
1. Baseline: pytest green + build hashes recorded (run BEFORE any change).
2. After tooling port: node build produces byte-identical n8n/import/*.json to the Python baseline.
3. After test conversion: npm test green with at least the same number of behavioral assertions (list any dropped test and why in the PR body).
4. After deletion: git grep -iE "pytest|uv run|pyproject|prospect\." returns no live references (docs/history mentions are fine); npm test green; build still byte-identical.
5. Open the PR with a body summarizing: file mapping table, dropped tests + rationale, and the byte-identical proof (hashes before/after).

Report back: PR URL, test counts before/after, any contracts you had to change and why.
