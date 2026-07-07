"""Normalization contract for scripts/compare_workflows.py.

When a Switch rule is removed live, n8n leaves a trailing empty output group in
the node's connections (e.g. ``[[A], []]``). Trailing empty groups carry no
behavior — there is no output to route — so normalization must ignore them.
Leading/middle empty groups DO define behavior (they keep output indices
aligned) and must be preserved.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location(
    "compare_workflows", REPO_ROOT / "scripts" / "compare_workflows.py"
)
compare_workflows = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(compare_workflows)  # type: ignore[union-attr]


def _workflow(connections: dict) -> dict:
    return {"name": "wf", "nodes": [], "connections": connections}


def test_trailing_empty_connection_groups_are_ignored() -> None:
    with_trailing = _workflow({"Switch": {"main": [[{"node": "A", "type": "main", "index": 0}], []]}})
    without = _workflow({"Switch": {"main": [[{"node": "A", "type": "main", "index": 0}]]}})
    assert compare_workflows.normalize(with_trailing) == compare_workflows.normalize(without)


def test_middle_empty_connection_groups_are_preserved() -> None:
    gap = _workflow({"Switch": {"main": [[], [{"node": "A", "type": "main", "index": 0}]]}})
    no_gap = _workflow({"Switch": {"main": [[{"node": "A", "type": "main", "index": 0}]]}})
    assert compare_workflows.normalize(gap) != compare_workflows.normalize(no_gap)
