"""Validate external deadline events before scheduling reminders."""

from __future__ import annotations

from copy import deepcopy
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


DEADLINE_TYPES = frozenset(
    {
        "supervisor_contact",
        "expression_of_interest",
        "programme_application",
        "funding_application",
        "reference_request",
        "recommender_submission",
        "supporting_documents",
        "certified_documents",
        "interview",
        "expected_decision",
        "offer_acceptance",
        "enrolment",
        "visa",
        "start_date",
    }
)


class InvalidDeadline(ValueError):
    """Deadline data cannot safely drive reminders."""


def normalize_deadline(candidate: dict[str, Any]) -> dict[str, Any]:
    """Return a scheduling-safe deadline event."""

    deadline = deepcopy(candidate)
    if deadline.get("type") not in DEADLINE_TYPES:
        raise InvalidDeadline("deadline has an unknown type")
    if not isinstance(deadline.get("rolling"), bool):
        raise InvalidDeadline("deadline rolling must be boolean")
    if not isinstance(deadline.get("verified"), bool):
        raise InvalidDeadline("deadline verified must be boolean")
    if type(deadline.get("version")) is not int or deadline["version"] < 1:
        raise InvalidDeadline("deadline version must be a positive integer")

    offsets = deadline.get("reminder_offsets")
    if not isinstance(offsets, list) or any(
        type(offset) is not int or offset < 0 for offset in offsets
    ):
        raise InvalidDeadline("reminder offsets must be non-negative integers")
    deadline["reminder_offsets"] = sorted(set(offsets), reverse=True)

    if deadline["rolling"]:
        if deadline.get("due_at") is not None:
            raise InvalidDeadline("rolling deadline cannot have due_at")
        deadline["due_at"] = None
        return deadline

    try:
        due_at = datetime.fromisoformat(str(deadline.get("due_at", "")))
    except ValueError as error:
        raise InvalidDeadline("fixed deadline requires a valid due_at") from error
    if due_at.utcoffset() is None:
        raise InvalidDeadline("fixed deadline due_at must include a UTC offset")
    try:
        timezone = ZoneInfo(str(deadline.get("timezone", "")))
    except ZoneInfoNotFoundError as error:
        raise InvalidDeadline("fixed deadline requires an IANA timezone") from error
    if due_at.astimezone(timezone).utcoffset() != due_at.utcoffset():
        raise InvalidDeadline("deadline UTC offset does not match its timezone")
    return deadline
