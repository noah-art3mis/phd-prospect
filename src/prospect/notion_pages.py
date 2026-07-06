"""Map validated Prospect records to Notion page payloads."""

from __future__ import annotations

import json
from typing import Any

from prospect.identity import canonicalize_url
from prospect.records import normalize_opportunity


def opportunity_page_payload(data_source_id: str, candidate: dict[str, Any]) -> dict[str, Any]:
    """Build a pending Notion page from a validated extraction candidate."""

    record = normalize_opportunity(candidate)
    findings = record["findings"]
    properties: dict[str, Any] = {
        "Name": _title(record["title"]),
        "Canonical URL": {"url": canonicalize_url(record["source_url"])},
        "Source URL": {"url": record["source_url"]},
        "Confirmed": {"checkbox": False},
        "Institution": _rich_text(_found_value(findings, "institution")),
        "Department or lab": _rich_text(_found_value(findings, "department_or_lab")),
        "Country": _rich_text(_found_value(findings, "country")),
        "Summary": _rich_text(_found_value(findings, "summary")),
        "Evidence": _rich_text(_evidence_summary(findings)),
    }
    return {
        "parent": {"type": "data_source_id", "data_source_id": data_source_id},
        "properties": properties,
    }


def contact_page_payload(data_source_id: str, contact: dict[str, Any]) -> dict[str, Any]:
    """Build a Notion contact page from a seed record."""

    properties: dict[str, Any] = {
        "Name": _title(str(contact["name"])),
        "Institution or lab": _rich_text(str(contact.get("institution_or_lab", ""))),
        "Research topics": _rich_text(str(contact.get("research_topics", ""))),
        "Notes": _rich_text(str(contact.get("notes", ""))),
        "Response status": {"select": {"name": "Not contacted"}},
    }
    if contact.get("role"):
        properties["Role"] = {"select": {"name": str(contact["role"])}}
    if contact.get("email"):
        properties["Email"] = {"email": str(contact["email"])}
    if contact.get("profile_url"):
        properties["Profile URL"] = {"url": str(contact["profile_url"])}
    return {
        "parent": {"type": "data_source_id", "data_source_id": data_source_id},
        "properties": properties,
    }


def _found_value(findings: dict[str, Any], name: str) -> str:
    finding = findings.get(name, {})
    if finding.get("state") != "found":
        return ""
    value = finding.get("value")
    if isinstance(value, list):
        return ", ".join(str(item) for item in value)
    return str(value)


def _evidence_summary(findings: dict[str, Any]) -> str:
    evidence = {
        name: finding.get("evidence", [])
        for name, finding in findings.items()
        if finding.get("evidence")
    }
    return json.dumps(evidence, ensure_ascii=False, separators=(",", ":"))[:2000]


def _title(value: str) -> dict[str, Any]:
    return {"title": [{"type": "text", "text": {"content": value[:2000]}}]}


def _rich_text(value: str) -> dict[str, Any]:
    if not value:
        return {"rich_text": []}
    return {"rich_text": [{"type": "text", "text": {"content": value[:2000]}}]}
