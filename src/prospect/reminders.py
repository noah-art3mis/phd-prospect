"""Pure reminder scheduling for n8n and local verification."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Iterable

from prospect.deadlines import normalize_deadline


def due_reminders(
    deadlines: Iterable[dict[str, Any]], *, as_of: date, sent_keys: set[str]
) -> list[dict[str, Any]]:
    """Return unsent reminders due on ``as_of`` for confirmed deadlines."""

    due: list[dict[str, Any]] = []
    for candidate in deadlines:
        deadline = normalize_deadline(candidate)
        if deadline["verified"] is not True:
            continue
        if deadline["due_at"] is None:
            continue
        due_at = datetime.fromisoformat(deadline["due_at"])
        days_remaining = (due_at.date() - as_of).days
        if days_remaining not in deadline["reminder_offsets"]:
            continue
        key = ":".join(
            (
                deadline["opportunity_id"],
                deadline["deadline_id"],
                str(deadline["version"]),
                str(days_remaining),
            )
        )
        if key in sent_keys:
            continue
        due.append(
            {
                "key": key,
                "opportunity_id": deadline["opportunity_id"],
                "deadline_id": deadline["deadline_id"],
                "deadline_type": deadline["type"],
                "days_remaining": days_remaining,
                "due_at": deadline["due_at"],
            }
        )
    return due
