"""Cross-language contract test: the live JS due-reminder port must match the Python spec.

The n8n "Compute due reminders" Code node (``n8n/code/compute-due-reminders.js``) is a port
of ``prospect.reminders.due_reminders``. The JS reads Notion page property shapes and computes
"today" itself, so each golden case carries a Notion-shaped input for JS, a normalized-deadline
input for Python, and a frozen instant the JS runner injects in place of ``new Date()``.
Agreement is asserted on the shared projection (key, opportunity_id, deadline_id,
days_remaining, due_at):

    Python due_reminders  ==  JS port  ==  recorded expectation

``python: invalid`` cases pin KNOWN divergences: the strict Python validator raises
``InvalidDeadline`` where the lenient live JS silently proceeds (missing Version defaults to 1,
negative reminder offsets, date-only due values). Those cases assert the Python rejection AND
the JS behavior, so any silent convergence or new drift trips the suite. The divergences are
recorded in docs/PLAN-consolidation.md's deferred section — do not "fix" either side here.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from datetime import date
from pathlib import Path

import pytest

from prospect.deadlines import InvalidDeadline
from prospect.reminders import due_reminders

REPO_ROOT = Path(__file__).resolve().parent.parent
CASES_PATH = REPO_ROOT / "tests" / "golden" / "reminder_cases.json"
JS_RUNNER = REPO_ROOT / "tests" / "js" / "run_reminders_contract.cjs"

CASES = json.loads(CASES_PATH.read_text())["cases"]
_PROJECTION = ("key", "opportunity_id", "deadline_id", "days_remaining", "due_at")


def _project(reminders: list[dict]) -> list[dict]:
    return [{field: reminder[field] for field in _PROJECTION} for reminder in reminders]


@pytest.fixture(scope="module")
def js_results() -> dict[str, list[dict]]:
    node = shutil.which("node")
    if node is None:
        pytest.fail("node is required to run the JS reminder port contract test")
    result = subprocess.run(
        [node, str(JS_RUNNER), str(CASES_PATH)],
        capture_output=True,
        text=True,
        check=True,
    )
    payload = json.loads(result.stdout)
    return {entry["name"]: entry["result"] for entry in payload}


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_python_matches_expectation_or_rejects(case: dict) -> None:
    as_of = date.fromisoformat(case["as_of"])
    if case["python"] == "invalid":
        with pytest.raises(InvalidDeadline):
            due_reminders(case["deadlines"], as_of=as_of, sent_keys=set())
        return
    reminders = due_reminders(case["deadlines"], as_of=as_of, sent_keys=set())
    assert _project(reminders) == case["expect"]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_js_matches_expectation(case: dict, js_results: dict) -> None:
    assert js_results[case["name"]] == case["expect"], (
        f"live JS reminder port diverged from contract for {case['name']!r}"
    )


@pytest.mark.parametrize(
    "case",
    [c for c in CASES if c["python"] == "match"],
    ids=[c["name"] for c in CASES if c["python"] == "match"],
)
def test_js_matches_python(case: dict, js_results: dict) -> None:
    as_of = date.fromisoformat(case["as_of"])
    python_result = _project(due_reminders(case["deadlines"], as_of=as_of, sent_keys=set()))
    assert js_results[case["name"]] == python_result, (
        f"live JS reminder port diverged from the Python spec for {case['name']!r}"
    )


def test_sent_key_filtering_is_downstream_in_js() -> None:
    """Python filters sent keys in-function; the live JS delegates idempotency to the
    "Prospect sent reminders" Data Table (rowNotExists → insert). Pin the Python half
    of the contract so the key format both sides share stays load-bearing."""
    case = next(c for c in CASES if c["name"] == "due_in_seven_days_matches_offset")
    as_of = date.fromisoformat(case["as_of"])
    key = case["expect"][0]["key"]
    assert due_reminders(case["deadlines"], as_of=as_of, sent_keys={key}) == []
