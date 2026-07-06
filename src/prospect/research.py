"""Select bounded research targets from initial extraction output."""

from __future__ import annotations

from collections.abc import Iterable
from copy import deepcopy
from typing import Any

from prospect.records import normalize_opportunity


DEFAULT_REQUIRED_FIELDS = (
    "institution",
    "department_or_lab",
    "opportunity_type",
    "country",
    "summary",
    "research_topics",
    "supervisors",
    "funding",
    "eligibility",
    "required_documents",
    "deadlines",
    "application_url",
    "start_date",
)


class UnexpectedResearchField(ValueError):
    """The researcher attempted to change data outside its assigned gaps."""


def research_gaps(
    candidate: dict[str, Any], *, required_fields: Iterable[str] = DEFAULT_REQUIRED_FIELDS
) -> list[str]:
    """Return required fields that a bounded researcher should investigate once."""

    findings = candidate.get("findings", {})
    complete_states = {"found", "not_applicable"}
    return [
        field
        for field in required_fields
        if findings.get(field, {}).get("state") not in complete_states
    ]


def merge_research(
    initial: dict[str, Any], research: dict[str, Any], *, requested_fields: set[str]
) -> dict[str, Any]:
    """Merge and validate research constrained to explicitly requested fields."""

    researched_findings = research.get("findings", {})
    for field in researched_findings:
        if field not in requested_fields:
            raise UnexpectedResearchField(f"research returned unrequested field '{field}'")

    merged = deepcopy(initial)
    merged.setdefault("findings", {}).update(deepcopy(researched_findings))
    return normalize_opportunity(merged)
