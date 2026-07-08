"""Tests for the workflow build step: sentinel inlining, placeholder substitution,
and the knowledge-state tripwire between the prompts and the tracked
opportunity-candidate schema."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from prospect.workflows import (
    SANDBOX_NOTE,
    build_workflow,
    inline_payloads,
    parse_env_file,
    render_prompt_lines,
    strip_module_exports,
    strip_sandbox_note,
    substitute_placeholders,
    substitutions_from,
)

REPO_ROOT = Path(__file__).resolve().parents[1]


def test_render_prompt_lines_quotes_each_line_as_a_js_string() -> None:
    md = '# Role\n\nSay "hi" to c:\\temp\n'
    assert render_prompt_lines(md) == (
        '  "# Role",\n'
        '  "",\n'
        '  "Say \\"hi\\" to c:\\\\temp"'
    )


def test_render_prompt_lines_preserves_non_ascii() -> None:
    assert render_prompt_lines("em – dash\n") == '  "em – dash"'


def test_strip_sandbox_note_removes_only_the_leading_note() -> None:
    body = SANDBOX_NOTE + "\nconst a = 1;\n"
    assert strip_sandbox_note(body) == "const a = 1;\n"
    # Untouched when the note is absent or not first.
    assert strip_sandbox_note("const a = 1;\n") == "const a = 1;\n"


def test_strip_module_exports_drops_the_trailing_node_guard() -> None:
    text = (
        "function f() { return 1; }\n"
        "\n"
        "if (typeof module !== 'undefined' && module.exports) {\n"
        "  module.exports = { f: f };\n"
        "}\n"
    )
    assert strip_module_exports(text) == "function f() { return 1; }"


def test_inline_payloads_expands_nested_sentinels(tmp_path: Path) -> None:
    (tmp_path / "n8n" / "code").mkdir(parents=True)
    (tmp_path / "n8n" / "prompts").mkdir(parents=True)
    (tmp_path / "n8n" / "prompts" / "p.md").write_text("line one\nline two\n")
    (tmp_path / "n8n" / "code" / "core.js").write_text(
        SANDBOX_NOTE + "\nvar CORE = 1;\n\n"
        "if (typeof module !== 'undefined' && module.exports) {\n"
        "  module.exports = { CORE: CORE };\n"
        "}\n"
    )
    source = (
        SANDBOX_NOTE + "\n"
        "{{INLINE_JS:n8n/code/core.js}}\n"
        "const system = [\n"
        "{{PROMPT_LINES:n8n/prompts/p.md}}\n"
        '].join("\\n");\n'
    )
    assert inline_payloads(source, tmp_path) == (
        "var CORE = 1;\n"
        "const system = [\n"
        '  "line one",\n'
        '  "line two"\n'
        '].join("\\n");\n'
    )


def test_build_workflow_inlines_code_files(tmp_path: Path) -> None:
    (tmp_path / "n8n" / "code").mkdir(parents=True)
    (tmp_path / "n8n" / "code" / "a.js").write_text(SANDBOX_NOTE + "\nreturn $json;\n")
    template = {
        "name": "wf",
        "nodes": [
            {
                "name": "A",
                "type": "n8n-nodes-base.code",
                "parameters": {"jsCode": "{{FILE:n8n/code/a.js}}"},
            },
            {"name": "B", "type": "n8n-nodes-base.noOp", "parameters": {}},
        ],
        "connections": {},
    }
    built = build_workflow(template, tmp_path)
    # The payload file's trailing newline is a file convention, not payload content.
    assert built["nodes"][0]["parameters"]["jsCode"] == "return $json;"
    assert built["nodes"][1] == template["nodes"][1]
    # The input template is not mutated.
    assert template["nodes"][0]["parameters"]["jsCode"] == "{{FILE:n8n/code/a.js}}"


def test_build_workflow_rejects_unresolved_sentinels(tmp_path: Path) -> None:
    template = {
        "name": "wf",
        "nodes": [
            {
                "name": "A",
                "type": "n8n-nodes-base.code",
                "parameters": {"jsCode": "{{FILE:n8n/code/missing.js}}"},
            }
        ],
        "connections": {},
    }
    with pytest.raises(FileNotFoundError):
        build_workflow(template, tmp_path)


def test_substitute_placeholders_replaces_every_occurrence() -> None:
    wf = {
        "nodes": [
            {"parameters": {"jsCode": "const id = 'REPLACE_WITH_TELEGRAM_USER_ID';"}},
            {"parameters": {"jsCode": "const ds = 'REPLACE_WITH_DATA_SOURCE_OPPORTUNITIES';"}},
        ]
    }
    out = substitute_placeholders(
        wf,
        {
            "REPLACE_WITH_TELEGRAM_USER_ID": "42",
            "REPLACE_WITH_DATA_SOURCE_OPPORTUNITIES": "ds-1",
        },
    )
    assert out["nodes"][0]["parameters"]["jsCode"] == "const id = '42';"
    assert out["nodes"][1]["parameters"]["jsCode"] == "const ds = 'ds-1';"


def test_substitute_placeholders_rejects_leftover_markers() -> None:
    wf = {"nodes": [{"parameters": {"jsCode": "'REPLACE_WITH_DATA_SOURCE_DEADLINES'"}}]}
    with pytest.raises(ValueError, match="REPLACE_WITH_DATA_SOURCE_DEADLINES"):
        substitute_placeholders(wf, {"REPLACE_WITH_TELEGRAM_USER_ID": "42"})


def test_substitutions_from_maps_env_and_data_sources() -> None:
    subs = substitutions_from(
        {"TELEGRAM_ALLOWED_USER_ID": "42"},
        {"opportunities": "o-1", "deadlines": "d-1", "contacts": "c-1"},
    )
    assert subs == {
        "REPLACE_WITH_TELEGRAM_USER_ID": "42",
        "REPLACE_WITH_DATA_SOURCE_OPPORTUNITIES": "o-1",
        "REPLACE_WITH_DATA_SOURCE_DEADLINES": "d-1",
        "REPLACE_WITH_DATA_SOURCE_CONTACTS": "c-1",
    }


def test_substitutions_from_requires_the_telegram_id() -> None:
    with pytest.raises(ValueError, match="TELEGRAM_ALLOWED_USER_ID"):
        substitutions_from({}, {"opportunities": "o-1"})


def test_parse_env_file_reads_simple_assignments(tmp_path: Path) -> None:
    env = tmp_path / "dotenv"
    env.write_text(
        "# comment\n"
        "\n"
        "TELEGRAM_ALLOWED_USER_ID=42\n"
        "QUOTED=\"a b\"\n"
        "export EXPORTED='x'\n"
    )
    assert parse_env_file(env) == {
        "TELEGRAM_ALLOWED_USER_ID": "42",
        "QUOTED": "a b",
        "EXPORTED": "x",
    }


@pytest.mark.parametrize(
    "prompt_source",
    ["code/build-extract-request.js", "prompts/research.md"],
)
def test_prompts_carry_the_schema_knowledge_states(prompt_source: str) -> None:
    """Drift tripwire successor to the removed findingSchema literal: the JSON
    contract lives in the prompt text (extract's prompt is embedded in its
    request-builder payload), so each output contract must spell out exactly
    the knowledge states the tracked schema defines."""
    schema = json.loads(
        (REPO_ROOT / "schemas" / "opportunity-candidate.schema.json").read_text()
    )
    states = schema["$defs"]["finding"]["properties"]["state"]["enum"]
    prompt = (REPO_ROOT / "n8n" / prompt_source).read_text()
    assert "|".join(states) in prompt


def test_cli_build_workflows_emits_template_and_import(tmp_path: Path) -> None:
    from prospect.cli import main

    root = tmp_path
    (root / "n8n" / "workflows").mkdir(parents=True)
    (root / "n8n" / "code").mkdir(parents=True)
    (root / "n8n" / "code" / "a.js").write_text(
        SANDBOX_NOTE + "\nconst id = 'REPLACE_WITH_TELEGRAM_USER_ID';\n"
    )
    template = {
        "name": "wf",
        "settings": {},
        "nodes": [
            {
                "name": "A",
                "type": "n8n-nodes-base.code",
                "parameters": {"jsCode": "{{FILE:n8n/code/a.js}}"},
            }
        ],
        "connections": {},
    }
    (root / "n8n" / "workflows" / "10-test.json").write_text(json.dumps(template))
    (root / ".env").write_text("TELEGRAM_ALLOWED_USER_ID=42\n")
    (root / "notion-data-sources.json").write_text(json.dumps({"opportunities": "o-1"}))

    assert main(["build-workflows", "--root", str(root)]) == 0

    imported = json.loads((root / "n8n" / "import" / "10-test.json").read_text())
    assert imported["nodes"][0]["parameters"]["jsCode"] == "const id = '42';"
    # The tracked template is canonicalized in place and keeps its placeholders.
    tracked = json.loads((root / "n8n" / "workflows" / "10-test.json").read_text())
    assert tracked["nodes"][0]["parameters"]["jsCode"] == "{{FILE:n8n/code/a.js}}"


def test_repo_templates_build_without_leftover_sentinels() -> None:
    """Every tracked template inlines cleanly against the real payload files."""
    for template_path in sorted((REPO_ROOT / "n8n" / "workflows").glob("*.json")):
        template = json.loads(template_path.read_text())
        built = build_workflow(template, REPO_ROOT)
        dumped = json.dumps(built)
        assert "{{FILE:" not in dumped, template_path.name
        assert "{{PROMPT_LINES:" not in dumped, template_path.name
        assert "{{INLINE_JS:" not in dumped, template_path.name


def _telegram_send_nodes() -> list[tuple[str, dict]]:
    nodes = []
    for path in sorted((REPO_ROOT / "n8n" / "workflows").glob("*.json")):
        workflow = json.loads(path.read_text())
        for node in workflow.get("nodes", []):
            params = node.get("parameters", {})
            if (
                node.get("type") == "n8n-nodes-base.telegram"
                and params.get("operation") == "sendMessage"
            ):
                nodes.append((f"{path.name}:{node['name']}", params))
    return nodes


def test_telegram_send_nodes_declare_html_parse_mode() -> None:
    """Without an explicit parse_mode the node falls back to legacy Markdown,
    where a bare underscore in an interpolated URL or title makes Telegram
    reject the send with 400 can't-parse-entities (live incident: ingest
    acknowledgement failed on a URL containing `ukp_home/jobs_ukp`)."""
    nodes = _telegram_send_nodes()
    assert nodes, "expected telegram sendMessage nodes in the templates"
    missing = [
        name
        for name, params in nodes
        if params.get("additionalFields", {}).get("parse_mode") != "HTML"
    ]
    assert missing == []


def test_telegram_send_nodes_escape_interpolated_values() -> None:
    """In HTML parse mode every interpolated value must be HTML-escaped, or
    a `<`, `>`, or `&` in a title, URL, or error string breaks the send."""
    escape = ".replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')"
    unescaped = []
    for name, params in _telegram_send_nodes():
        text = params.get("text", "")
        for chunk in text.split("{{")[1:]:
            expr = chunk.split("}}")[0]
            is_string_valued = "$" in expr and "?" not in expr
            if is_string_valued and escape not in expr:
                unescaped.append(f"{name}: {expr.strip()}")
    assert unescaped == []
