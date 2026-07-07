"""Compare a built n8n workflow against a live export, after normalization.

Usage:
    uv run python scripts/compare_workflows.py n8n/import/01-ingest-opportunity.json live.json

The live file may be the raw ``get_workflow_details`` MCP output ({"workflow": ...})
or a bare workflow object. Normalization keeps what defines behavior — workflow name,
node names/types/typeVersions/parameters (including inlined code and prompts), and
connections — and drops instance noise: node ids, positions, webhookIds, credential
bindings, versionId/timestamps/tags/meta/scopes, and sticky-note layout. Trailing
whitespace on jsCode is also ignored: the live nodes are inconsistent about a final
newline, which n8n does not care about.

Exit code 0 when equivalent, 1 with a unified diff when not.
"""

from __future__ import annotations

import difflib
import json
import sys
from pathlib import Path

_NODE_KEYS = ("name", "type", "typeVersion", "parameters")


def normalize(document: dict) -> dict:
    workflow = document.get("workflow", document)
    nodes = []
    for node in workflow.get("nodes", []):
        normalized = {key: node.get(key) for key in _NODE_KEYS}
        parameters = normalized.get("parameters")
        if isinstance(parameters, dict) and isinstance(parameters.get("jsCode"), str):
            parameters = dict(parameters)
            parameters["jsCode"] = parameters["jsCode"].rstrip()
            normalized["parameters"] = parameters
        nodes.append(normalized)
    nodes.sort(key=lambda node: str(node["name"]))
    return {
        "name": workflow.get("name"),
        "nodes": nodes,
        "connections": workflow.get("connections", {}),
    }


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__)
        return 2
    built = normalize(json.loads(Path(argv[1]).read_text()))
    live = normalize(json.loads(Path(argv[2]).read_text()))
    if built == live:
        print("EQUIVALENT: built workflow matches the live workflow (normalized)")
        return 0
    diff = difflib.unified_diff(
        json.dumps(built, indent=2, ensure_ascii=False, sort_keys=True).splitlines(),
        json.dumps(live, indent=2, ensure_ascii=False, sort_keys=True).splitlines(),
        fromfile=argv[1],
        tofile=argv[2],
        lineterm="",
    )
    for line in diff:
        print(line)
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
