"""Contract test for the shared missing-fields module used by the n8n Code nodes.

``n8n/code/missing_fields.js`` decides which critical fields still need research
(both on first extraction and on the "Research again" callback). The contract:
a field is complete only in the ``found`` / ``not_applicable`` states; every
other state — and an absent finding — keeps it on the research list.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
MODULE = REPO_ROOT / "n8n" / "code" / "missing_fields.js"

RUNNER = """
const m = require(process.argv[1]);
const candidate = JSON.parse(process.argv[2]);
process.stdout.write(JSON.stringify(m.computeMissingFields(candidate)));
"""


def compute(candidate: dict) -> list[str]:
    node = shutil.which("node")
    if node is None:
        pytest.fail("node is required for the missing-fields contract test")
    result = subprocess.run(
        [node, "-e", RUNNER, str(MODULE), json.dumps(candidate)],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(result.stdout)


def finding(state: str) -> dict:
    return {"state": state, "value": None, "evidence": []}


def test_complete_states_are_not_missing() -> None:
    candidate = {
        "title": "x",
        "findings": {
            "institution": finding("found"),
            "start_date": finding("not_applicable"),
        },
    }
    missing = compute(candidate)
    assert "institution" not in missing
    assert "start_date" not in missing


def test_incomplete_states_and_absent_findings_are_missing() -> None:
    candidate = {
        "title": "x",
        "findings": {
            "funding": finding("not_stated"),
            "eligibility": finding("needs_confirmation"),
            "deadlines": finding("conflicting_sources"),
        },
    }
    missing = compute(candidate)
    assert {"funding", "eligibility", "deadlines"} <= set(missing)
    # Fields with no finding at all stay missing.
    assert "required_documents" in missing
    assert "supervisors" in missing


def test_empty_candidate_reports_every_required_field() -> None:
    missing = compute({})
    assert missing == compute({"findings": {}})
    assert len(missing) == 13
    assert missing[0] == "institution"  # stable, deterministic ordering
