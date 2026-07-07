"""Cross-language contract test: the JS identity port must match the Python spec.

The n8n "Validate" Code node computes the canonical URL and duplicate fingerprint the same
way ``prospect.identity`` does, but in JavaScript (n8n Cloud has no Python). As with the
normalize contract, we run a shared set of golden cases through BOTH implementations and
assert three-way agreement:

    Python identity  ==  JS port  ==  recorded expectation

Grow ``tests/golden/identity_cases.json`` with every new canonicalization or fingerprint rule.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from prospect.identity import canonicalize_url, opportunity_fingerprint

REPO_ROOT = Path(__file__).resolve().parent.parent
CASES_PATH = REPO_ROOT / "tests" / "golden" / "identity_cases.json"
JS_RUNNER = REPO_ROOT / "tests" / "js" / "run_identity_contract.cjs"

CASES = json.loads(CASES_PATH.read_text())
CANON_CASES = CASES["canonicalize"]
FP_CASES = CASES["fingerprint"]


@pytest.fixture(scope="module")
def js_results() -> dict[str, dict[str, str]]:
    node = shutil.which("node")
    if node is None:
        pytest.fail("node is required to run the JS identity port contract test")
    result = subprocess.run(
        [node, str(JS_RUNNER), str(CASES_PATH)],
        capture_output=True,
        text=True,
        check=True,
    )
    payload = json.loads(result.stdout)
    return {
        "canonicalize": {entry["name"]: entry["result"] for entry in payload["canonicalize"]},
        "fingerprint": {entry["name"]: entry["result"] for entry in payload["fingerprint"]},
    }


@pytest.mark.parametrize("case", CANON_CASES, ids=[c["name"] for c in CANON_CASES])
def test_canonicalize_python_matches_expectation(case: dict) -> None:
    assert canonicalize_url(case["input"]) == case["expect"]


@pytest.mark.parametrize("case", CANON_CASES, ids=[c["name"] for c in CANON_CASES])
def test_canonicalize_js_matches_python_and_expectation(case: dict, js_results: dict) -> None:
    js_result = js_results["canonicalize"][case["name"]]
    assert js_result == case["expect"], f"JS canonicalize diverged from contract for {case['name']!r}"
    assert js_result == canonicalize_url(case["input"]), (
        f"JS canonicalize diverged from Python spec for {case['name']!r}"
    )


@pytest.mark.parametrize("case", FP_CASES, ids=[c["name"] for c in FP_CASES])
def test_fingerprint_python_matches_expectation(case: dict) -> None:
    assert opportunity_fingerprint(**case["input"]) == case["expect"]


@pytest.mark.parametrize("case", FP_CASES, ids=[c["name"] for c in FP_CASES])
def test_fingerprint_js_matches_python_and_expectation(case: dict, js_results: dict) -> None:
    js_result = js_results["fingerprint"][case["name"]]
    assert js_result == case["expect"], f"JS fingerprint diverged from contract for {case['name']!r}"
    assert js_result == opportunity_fingerprint(**case["input"]), (
        f"JS fingerprint diverged from Python spec for {case['name']!r}"
    )
