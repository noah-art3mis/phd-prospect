"""Map validated Prospect records to Notion page payloads."""

from __future__ import annotations

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
        "City": _rich_text(_found_value(findings, "city")),
        "Programme": _rich_text(_found_value(findings, "degree_or_programme")),
        "Duration": _rich_text(_found_value(findings, "duration")),
        "Advert ID": _rich_text(_found_value(findings, "advert_id")),
        "Supervisors": _rich_text(_found_value(findings, "supervisors")),
        "Research topics": _rich_text(_found_value(findings, "research_topics")),
        "Summary": _rich_text(_found_value(findings, "summary")),
        "Evidence": _rich_text(_evidence_summary(findings)),
    }
    properties.update(_optional_properties(findings))
    return {
        "parent": {"type": "data_source_id", "data_source_id": data_source_id},
        "properties": properties,
    }


# Free-text finding values map onto Notion select options only through these
# recorded synonyms; anything unmapped stays absent (unknown stays unknown).
_FUNDING_STATUS_OPTIONS = {
    "funded": "Fully funded",
    "fully funded": "Fully funded",
    "partially funded": "Partially funded",
    "partial": "Partially funded",
    "salaried": "Salaried",
    "salary": "Salaried",
    "self funded": "Self-funded",
    "self-funded": "Self-funded",
    "unclear": "Unclear",
    "unknown": "Unclear",
}
_TUITION_OPTIONS = {
    "full": "Full",
    "fully covered": "Full",
    "home only": "Home only",
    "home fees only": "Home only",
    "partial": "Partial",
    "none": "None",
    "not covered": "None",
    "unclear": "Unclear",
}
_CURRENCIES = ("EUR", "GBP", "USD", "CAD", "AUD", "CHF")
_SUPERVISOR_CONTACT_OPTIONS = {
    "true": "Required",
    "yes": "Required",
    "required": "Required",
    "false": "Not required",
    "no": "Not required",
    "not required": "Not required",
}


def _optional_properties(findings: dict[str, Any]) -> dict[str, Any]:
    """Properties emitted only when a found value maps cleanly onto the column."""

    properties: dict[str, Any] = {}
    opportunity_type = _found_value(findings, "opportunity_type")
    if opportunity_type:
        properties["Type"] = _select(opportunity_type.replace(",", " ")[:100])
    start_date = _found_value(findings, "start_date")
    if len(start_date) >= 10 and _is_iso_date(start_date[:10]):
        properties["Start date"] = {"date": {"start": start_date[:10]}}
    application_url = _found_value(findings, "application_url")
    if application_url.startswith(("http://", "https://")):
        properties["Application URL"] = {"url": application_url}
    contact = findings.get("supervisor_contact_required", {})
    if contact.get("state") == "found":
        value = contact.get("value")
        key = str(value).lower() if isinstance(value, bool) else _normalize_option(value)
        option = _SUPERVISOR_CONTACT_OPTIONS.get(key)
        if option:
            properties["Supervisor contact required"] = _select(option)
    funding = findings.get("funding", {})
    if funding.get("state") == "found" and isinstance(funding.get("value"), dict):
        properties.update(_funding_properties(funding["value"]))
    return properties


def _funding_properties(funding: dict[str, Any]) -> dict[str, Any]:
    properties: dict[str, Any] = {}
    status = _FUNDING_STATUS_OPTIONS.get(_normalize_option(funding.get("status")))
    if status:
        properties["Funding status"] = _select(status)
    stipend = funding.get("stipend")
    if isinstance(stipend, (int, float)) and not isinstance(stipend, bool):
        properties["Stipend or salary"] = {"number": stipend}
    currency = str(funding.get("currency") or "").strip().upper()
    if currency:
        properties["Currency"] = _select(
            currency if currency in _CURRENCIES else "Other"
        )
    tuition = _TUITION_OPTIONS.get(_normalize_option(funding.get("tuition_coverage")))
    if tuition:
        properties["Tuition coverage"] = _select(tuition)
    return properties


def _normalize_option(value: Any) -> str:
    return str(value or "").strip().lower().replace("_", " ")


def _is_iso_date(value: str) -> bool:
    parts = value.split("-")
    return (
        len(parts) == 3
        and tuple(len(part) for part in parts) == (4, 2, 2)
        and all(part.isdigit() for part in parts)
    )


def _select(name: str) -> dict[str, Any]:
    return {"select": {"name": name}}


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
        return ", ".join(_render_item(item) for item in value)
    return _render_item(value)


def _render_item(item: Any) -> str:
    if isinstance(item, dict):
        name = str(item.get("name") or item.get("title") or "").strip()
        return name or ", ".join(str(v) for v in item.values() if v not in (None, ""))
    return str(item)


def _evidence_summary(findings: dict[str, Any]) -> str:
    lines = []
    for name, finding in findings.items():
        for item in finding.get("evidence", []):
            excerpt = str(item.get("excerpt", "")).strip()
            url = str(item.get("url", "")).strip()
            lines.append(f"{name}: {excerpt}" + (f" ({url})" if url else ""))
    return "\n".join(lines)[:2000]


def _title(value: str) -> dict[str, Any]:
    return {"title": [{"type": "text", "text": {"content": value[:2000]}}]}


def _rich_text(value: str) -> dict[str, Any]:
    if not value:
        return {"rich_text": []}
    return {"rich_text": [{"type": "text", "text": {"content": value[:2000]}}]}
