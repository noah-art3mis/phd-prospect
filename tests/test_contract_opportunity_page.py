"""Cross-language contract test: the live JS opportunity-page builder must match the Python spec.

The n8n "Build opportunity payload" Code node (``n8n/code/build-opportunity-payload.js``)
mirrors ``prospect.notion_pages.opportunity_page_payload``. Each golden case carries an
extraction candidate plus the pending-approval row fields the JS reads, the recorded
expected Notion properties, and a list of properties that must stay ABSENT (unknown
stays unknown — a finding that is missing, non-found, or unmappable must not invent a
column value). Agreement is asserted per expected property:

    Python opportunity_page_payload  ==  JS builder  ==  recorded expectation

The two implementations intentionally differ outside the shared projection: the JS
adds workflow-state properties (Application stage, Opportunity status, Fingerprint,
Last checked) and sets Confirmed from the callback action, while the Python spec
builds the pending shape. Only the properties named by each case are compared.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from prospect.notion_pages import opportunity_page_payload

REPO_ROOT = Path(__file__).resolve().parent.parent
CASES_PATH = REPO_ROOT / "tests" / "golden" / "opportunity_page_cases.json"
JS_RUNNER = REPO_ROOT / "tests" / "js" / "run_opportunity_contract.cjs"

CASES = json.loads(CASES_PATH.read_text())["cases"]


@pytest.fixture(scope="module")
def js_results() -> dict[str, dict]:
    node = shutil.which("node")
    if node is None:
        pytest.fail("node is required to run the JS opportunity-page contract test")
    result = subprocess.run(
        [node, str(JS_RUNNER), str(CASES_PATH)],
        capture_output=True,
        text=True,
        check=True,
    )
    payload = json.loads(result.stdout)
    return {entry["name"]: entry["properties"] for entry in payload}


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_python_matches_expectation(case: dict) -> None:
    payload = opportunity_page_payload("test-data-source", case["candidate"])
    properties = payload["properties"]
    for name, expected in case["expected_properties"].items():
        assert properties.get(name) == expected, f"Python property {name!r} diverged"
    for name in case.get("absent_properties", []):
        assert name not in properties, f"Python invented a value for {name!r}"


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_js_matches_expectation(case: dict, js_results: dict) -> None:
    properties = js_results[case["name"]]
    for name, expected in case["expected_properties"].items():
        assert properties.get(name) == expected, f"JS property {name!r} diverged"
    for name in case.get("absent_properties", []):
        assert name not in properties, f"JS invented a value for {name!r}"
