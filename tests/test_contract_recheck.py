"""Golden pins for the branchy Code nodes of workflow 03 (recheck active opportunities).

``n8n/code/diff-and-alert.js`` and ``n8n/code/prepare-opportunities.js`` have no Python
counterpart — they are n8n-only glue with real branches (status-change detection,
fetch-failure alerts, loose JSON parsing of model output, URL/title/status fallbacks).
The JS runner (tests/js/run_recheck_contract.cjs) executes the verbatim payload files
under node:vm against ``tests/golden/recheck_cases.json`` and this test asserts the
recorded expectations, so any live edit that changes behavior trips the suite.

These cases pin CURRENT live behavior, bugs included: the
``model_call_failure_is_silent_and_still_stamps_last_checked`` case records that a failed
Anthropic call is indistinguishable from "no change" — no alert fires and Last checked is
still stamped. That is a phase-4 finding (docs/PLAN-consolidation.md), not something to
fix in the payload here.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
CASES_PATH = REPO_ROOT / "tests" / "golden" / "recheck_cases.json"
JS_RUNNER = REPO_ROOT / "tests" / "js" / "run_recheck_contract.cjs"

CASES = json.loads(CASES_PATH.read_text())
DIFF_CASES = CASES["diff_and_alert"]
PREPARE_CASES = CASES["prepare_opportunities"]


@pytest.fixture(scope="module")
def js_results() -> dict[str, dict[str, dict]]:
    node = shutil.which("node")
    if node is None:
        pytest.fail("node is required to run the recheck golden tests")
    result = subprocess.run(
        [node, str(JS_RUNNER), str(CASES_PATH)],
        capture_output=True,
        text=True,
        check=True,
    )
    payload = json.loads(result.stdout)
    return {
        "diff_and_alert": {entry["name"]: entry["result"] for entry in payload["diff_and_alert"]},
        "prepare_opportunities": {
            entry["name"]: entry["result"] for entry in payload["prepare_opportunities"]
        },
    }


@pytest.mark.parametrize("case", DIFF_CASES, ids=[c["name"] for c in DIFF_CASES])
def test_diff_and_alert_matches_expectation(case: dict, js_results: dict) -> None:
    result = js_results["diff_and_alert"][case["name"]]
    expect = case["expect"]
    assert result["alert"] == expect["alert"]
    assert result["new_status"] == expect["new_status"]
    expected_text = (
        "🔁 Recheck — "
        + case["ctx"]["title"]
        + "\n"
        + case["ctx"]["canonical_url"]
        + "\n- "
        + "\n- ".join(expect["alert_lines"])
        + "\n\nNo confirmed values were changed. Review and update in Notion if needed."
    )
    assert result["alert_text"] == expected_text
    assert result["page_id"] == case["ctx"]["page_id"]
    # Last checked is stamped unconditionally with the (frozen) execution instant —
    # even on the silent model-failure path.
    assert result["last_checked_start"] == case["frozen_now_utc"]


@pytest.mark.parametrize("case", PREPARE_CASES, ids=[c["name"] for c in PREPARE_CASES])
def test_prepare_opportunities_matches_expectation(case: dict, js_results: dict) -> None:
    assert js_results["prepare_opportunities"][case["name"]] == case["expect"]
