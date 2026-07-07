"""Build n8n workflows from tracked templates and payload files.

The repo is the source of truth: workflow topology lives in ``n8n/workflows/*.json``
templates, Code-node JS in ``n8n/code/*.js``, and Anthropic system prompts in
``n8n/prompts/*.md``. Sentinels wire them together:

- ``{{FILE:<path>}}`` — a Code node's ``jsCode`` is the referenced JS file, inlined.
- ``{{INLINE_JS:<path>}}`` — inside a JS file: paste another JS file verbatim, minus
  its sandbox-note header and its trailing Node ``module.exports`` guard.
- ``{{PROMPT_LINES:<path>}}`` — inside a JS file: render a markdown prompt as the
  indented, JSON-quoted lines of a JS array literal.

Placeholders (``REPLACE_WITH_TELEGRAM_USER_ID``, ``REPLACE_WITH_DATA_SOURCE_<NAME>``)
stay in tracked output and are substituted only into the git-ignored ``n8n/import/``
copies, with values read at runtime from ``.env`` and ``notion-data-sources.json``.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path
from typing import Mapping

SANDBOX_NOTE = "// n8n Cloud Code-node sandbox: no `URL`, no `require` (Date and Set are fine)."

_FILE_SENTINEL = re.compile(r"^\{\{FILE:([^}]+)\}\}$")
_LINE_SENTINEL = re.compile(r"^\{\{(INLINE_JS|PROMPT_LINES):([^}]+)\}\}$")
_MODULE_GUARD = "if (typeof module !== 'undefined'"
_PLACEHOLDER = re.compile(r"REPLACE_WITH_[A-Z0-9_]+")


def render_prompt_lines(markdown: str, indent: str = "  ") -> str:
    """Render markdown as the body of a JS array literal: one quoted string per line."""
    lines = markdown.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    return ",\n".join(indent + json.dumps(line, ensure_ascii=False) for line in lines)


def strip_sandbox_note(text: str) -> str:
    """Drop the leading sandbox-note header; it annotates the file, not the payload."""
    first, sep, rest = text.partition("\n")
    if first == SANDBOX_NOTE:
        return rest
    return text


def strip_module_exports(text: str) -> str:
    """Drop the trailing Node ``module.exports`` guard used only by the JS contract tests."""
    lines = text.split("\n")
    for index, line in enumerate(lines):
        if line.startswith(_MODULE_GUARD):
            core = lines[:index]
            while core and core[-1].strip() == "":
                core.pop()
            return "\n".join(core)
    return text


def inline_payloads(source: str, root: Path) -> str:
    """Expand line sentinels in a JS payload and strip its sandbox-note header."""
    out: list[str] = []
    for line in strip_sandbox_note(source).split("\n"):
        match = _LINE_SENTINEL.match(line)
        if not match:
            out.append(line)
            continue
        kind, rel_path = match.groups()
        payload = (root / rel_path).read_text()
        if kind == "INLINE_JS":
            out.append(strip_module_exports(strip_sandbox_note(payload)))
        else:
            out.append(render_prompt_lines(payload))
    return "\n".join(out)


def build_workflow(template: Mapping[str, object], root: Path) -> dict:
    """Return the workflow with every ``{{FILE:...}}`` jsCode sentinel inlined."""
    built = json.loads(json.dumps(template))
    for node in built.get("nodes", []):
        js_code = node.get("parameters", {}).get("jsCode")
        if not isinstance(js_code, str):
            continue
        match = _FILE_SENTINEL.match(js_code.strip())
        if not match:
            continue
        source = (root / match.group(1)).read_text()
        node["parameters"]["jsCode"] = inline_payloads(source, root)
    return built


def substitute_placeholders(workflow: Mapping[str, object], substitutions: Mapping[str, str]) -> dict:
    """Replace every REPLACE_WITH_* marker; unresolved markers are an error."""
    text = json.dumps(workflow, ensure_ascii=False)
    for placeholder, value in substitutions.items():
        text = text.replace(placeholder, value)
    leftover = _PLACEHOLDER.search(text)
    if leftover:
        raise ValueError(f"unresolved placeholder {leftover.group(0)}")
    return json.loads(text)


def substitutions_from(env: Mapping[str, str], data_sources: Mapping[str, str]) -> dict[str, str]:
    """Build the placeholder map from environment values and the Notion data-source ids."""
    telegram_id = env.get("TELEGRAM_ALLOWED_USER_ID", "").strip()
    if not telegram_id:
        raise ValueError("TELEGRAM_ALLOWED_USER_ID is required (set it in .env)")
    substitutions = {"REPLACE_WITH_TELEGRAM_USER_ID": telegram_id}
    for name, identifier in data_sources.items():
        substitutions[f"REPLACE_WITH_DATA_SOURCE_{name.upper()}"] = identifier
    return substitutions


def parse_env_file(path: Path) -> dict[str, str]:
    """Minimal KEY=VALUE parser so the build can consume .env at runtime."""
    values: dict[str, str] = {}
    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[len("export ") :]
        key, _, value = line.partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key.strip()] = value
    return values


def derive_finding_schema(candidate_schema: Mapping[str, object]) -> dict:
    """Derive the Anthropic strict-output finding schema from the tracked candidate schema.

    Strict structured output forbids open-ended values and ignores refinements, so the
    ``value: {}`` wildcard becomes an explicit type union and ``format``/``minLength``
    are dropped from evidence. Everything else (state enum, required keys, closed
    objects) comes straight from ``schemas/opportunity-candidate.schema.json``.
    """
    defs = candidate_schema["$defs"]
    finding = defs["finding"]
    evidence = defs["evidence"]

    def strict(prop: Mapping[str, object]) -> dict:
        return {"type": prop["type"]}

    evidence_schema = {
        "type": "object",
        "required": list(evidence["required"]),
        "additionalProperties": False,
        "properties": {name: strict(prop) for name, prop in evidence["properties"].items()},
    }
    return {
        "type": "object",
        "required": list(finding["required"]),
        "additionalProperties": False,
        "properties": {
            "state": {"enum": list(finding["properties"]["state"]["enum"])},
            "value": {"type": ["string", "number", "integer", "boolean", "object", "array", "null"]},
            "evidence": {"type": "array", "items": evidence_schema},
        },
    }


def finding_schema_from_js(js_code: str) -> dict:
    """Evaluate the ``const findingSchema = {...};`` literal in a request builder via node."""
    node_binary = shutil.which("node")
    if node_binary is None:
        raise RuntimeError("node is required to evaluate the findingSchema literal")
    marker = "const findingSchema = "
    start = js_code.index(marker) + len(marker)
    end = js_code.index("\n};", start) + len("\n}")
    literal = js_code[start:end]
    result = subprocess.run(
        [node_binary, "-e", f"process.stdout.write(JSON.stringify({literal}))"],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(result.stdout)


def build_all(root: Path) -> list[Path]:
    """Canonicalize every template and emit the deployable copies under n8n/import/.

    Refuses to emit when a request builder's findingSchema drifts from the schema
    derived from ``schemas/opportunity-candidate.schema.json``.
    """
    env = dict(parse_env_file(root / ".env")) if (root / ".env").exists() else {}
    data_sources_path = root / "notion-data-sources.json"
    data_sources = (
        json.loads(data_sources_path.read_text()) if data_sources_path.exists() else {}
    )
    substitutions = substitutions_from(env, data_sources)

    schema_path = root / "schemas" / "opportunity-candidate.schema.json"
    expected_finding = (
        derive_finding_schema(json.loads(schema_path.read_text()))
        if schema_path.exists()
        else None
    )

    import_dir = root / "n8n" / "import"
    import_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for template_path in sorted((root / "n8n" / "workflows").glob("*.json")):
        template = json.loads(template_path.read_text())
        template_path.write_text(_dump(template))

        built = build_workflow(template, root)
        if expected_finding is not None:
            _check_schema_drift(built, expected_finding, template_path.name)
        deployable = substitute_placeholders(built, substitutions)
        import_path = import_dir / template_path.name
        import_path.write_text(_dump(deployable))
        written.append(import_path)
    return written


def _check_schema_drift(workflow: Mapping[str, object], expected: Mapping[str, object], name: str) -> None:
    for node in workflow.get("nodes", []):
        js_code = node.get("parameters", {}).get("jsCode", "")
        if isinstance(js_code, str) and "const findingSchema = " in js_code:
            actual = finding_schema_from_js(js_code)
            if actual != expected:
                raise ValueError(
                    f"{name}: node {node['name']!r} findingSchema drifted from "
                    "schemas/opportunity-candidate.schema.json"
                )


def _dump(workflow: Mapping[str, object]) -> str:
    return json.dumps(workflow, indent=2, ensure_ascii=False, sort_keys=True) + "\n"
