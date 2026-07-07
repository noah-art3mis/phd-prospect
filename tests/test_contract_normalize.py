"""Cross-language contract test: the JS validation port must match the Python spec.

The n8n "Validate" Code node cannot run ``prospect.records`` (n8n Cloud has no Python), so
the deterministic validation contract is re-implemented in ``n8n/code/validate_opportunity.js``.
This is the single highest-risk drift point in the ingest pipeline (see issue #4). Here we run a
shared set of golden cases through BOTH implementations and assert three-way agreement:

    Python normalize_opportunity  ==  JS port  ==  recorded expectation

If either implementation drifts from the other, or from the recorded contract, this test fails.
Grow ``tests/golden/normalize_opportunity_cases.json`` with every new validation rule.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from prospect.records import InvalidRecord, normalize_opportunity

REPO_ROOT = Path(__file__).resolve().parent.parent
CASES_PATH = REPO_ROOT / "tests" / "golden" / "normalize_opportunity_cases.json"
JS_RUNNER = REPO_ROOT / "tests" / "js" / "run_contract.cjs"

CASES = json.loads(CASES_PATH.read_text())["cases"]
CASE_IDS = [case["name"] for case in CASES]


def _python_verdict(candidate: dict) -> object:
    try:
        normalize_opportunity(candidate)
        return "ok"
    except InvalidRecord as error:
        return {"invalid": str(error)}


@pytest.fixture(scope="module")
def js_verdicts() -> dict[str, object]:
    node = shutil.which("node")
    if node is None:
        pytest.fail("node is required to run the JS validation port contract test")
    result = subprocess.run(
        [node, str(JS_RUNNER), str(CASES_PATH)],
        capture_output=True,
        text=True,
        check=True,
    )
    return {entry["name"]: entry["verdict"] for entry in json.loads(result.stdout)}


@pytest.mark.parametrize("case", CASES, ids=CASE_IDS)
def test_python_matches_expectation(case: dict) -> None:
    assert _python_verdict(case["input"]) == case["expect"]


@pytest.mark.parametrize("case", CASES, ids=CASE_IDS)
def test_js_port_matches_python_and_expectation(case: dict, js_verdicts: dict) -> None:
    js_verdict = js_verdicts[case["name"]]
    assert js_verdict == case["expect"], f"JS port diverged from contract for {case['name']!r}"
    assert js_verdict == _python_verdict(case["input"]), (
        f"JS port diverged from Python spec for {case['name']!r}"
    )
