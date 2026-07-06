"""Normalize untrusted extraction output at Prospect's persistence boundary."""

from __future__ import annotations

from copy import deepcopy
from datetime import datetime
from typing import Any

from prospect.identity import UnsafeSourceUrl, validate_public_url


CRITICAL_FINDINGS = frozenset({"deadlines", "funding", "eligibility", "required_documents"})
KNOWLEDGE_STATES = frozenset(
    {"found", "not_stated", "not_applicable", "conflicting_sources", "needs_confirmation"}
)


class InvalidRecord(ValueError):
    """Candidate data cannot be persisted as a Prospect record."""


def normalize_opportunity(candidate: dict[str, Any]) -> dict[str, Any]:
    """Return persistence-safe opportunity data or raise ``InvalidRecord``."""

    normalized = deepcopy(candidate)
    if not str(normalized.get("title", "")).strip():
        raise InvalidRecord("opportunity requires a title")
    try:
        validate_public_url(str(normalized.get("source_url", "")))
    except UnsafeSourceUrl as error:
        raise InvalidRecord("opportunity requires an http or https source_url") from error
    findings = normalized.get("findings", {})
    if not isinstance(findings, dict):
        raise InvalidRecord("opportunity findings must be an object")
    for name, finding in findings.items():
        if not isinstance(finding, dict):
            raise InvalidRecord(f"finding '{name}' must be an object")
        state = finding.get("state")
        if state not in KNOWLEDGE_STATES:
            raise InvalidRecord(f"finding '{name}' has unknown state '{state}'")
        evidence_items = finding.get("evidence", [])
        if not isinstance(evidence_items, list):
            raise InvalidRecord(f"finding '{name}' evidence must be a list")
        if state == "found" and finding.get("value") in (None, "", []):
            raise InvalidRecord(f"finding '{name}' marked found without a value")
        if (
            name in CRITICAL_FINDINGS
            and state == "found"
            and not evidence_items
        ):
            raise InvalidRecord(f"critical finding '{name}' requires evidence")
        if state == "conflicting_sources" and len(evidence_items) < 2:
            raise InvalidRecord(
                f"finding '{name}' marked conflicting with fewer than two sources"
            )
        for evidence in evidence_items:
            _validate_evidence(name, evidence)
    return normalized


def _validate_evidence(name: str, evidence: Any) -> None:
    if not isinstance(evidence, dict):
        raise InvalidRecord(f"finding '{name}' has malformed evidence")
    try:
        validate_public_url(str(evidence.get("url", "")))
    except UnsafeSourceUrl as error:
        raise InvalidRecord(f"finding '{name}' has evidence with an invalid url") from error
    try:
        retrieved_at = datetime.fromisoformat(str(evidence.get("retrieved_at", "")))
    except ValueError as error:
        raise InvalidRecord(
            f"finding '{name}' has evidence with an invalid retrieved_at"
        ) from error
    if retrieved_at.utcoffset() is None:
        raise InvalidRecord(
            f"finding '{name}' retrieved_at must include a UTC offset"
        )
    if not str(evidence.get("excerpt", "")).strip():
        raise InvalidRecord(f"finding '{name}' has evidence without an excerpt")
