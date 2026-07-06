from datetime import date, datetime, time, timedelta, timezone

from prospect.reminders import due_reminders


def test_reminders_are_due_once_per_deadline_version_and_offset() -> None:
    today = date(2026, 7, 6)
    due_at = datetime.combine(today + timedelta(days=7), time(17, 0), tzinfo=timezone.utc)
    deadline = {
        "opportunity_id": "opp-1",
        "deadline_id": "funding-1",
        "version": 2,
        "type": "funding_application",
        "due_at": due_at.isoformat(),
        "timezone": "UTC",
        "rolling": False,
        "reminder_offsets": [30, 7, 1],
        "verified": True,
    }

    reminders = due_reminders([deadline], as_of=today, sent_keys=set())

    assert reminders == [
        {
            "key": "opp-1:funding-1:2:7",
            "opportunity_id": "opp-1",
            "deadline_id": "funding-1",
            "deadline_type": "funding_application",
            "days_remaining": 7,
            "due_at": due_at.isoformat(),
        }
    ]
    assert due_reminders(
        [deadline], as_of=today, sent_keys={reminders[0]["key"]}
    ) == []


def test_unverified_deadlines_do_not_generate_reminders() -> None:
    today = date(2026, 7, 6)
    due_at = datetime.combine(today + timedelta(days=1), time(17, 0), tzinfo=timezone.utc)
    deadline = {
        "opportunity_id": "opp-1",
        "deadline_id": "programme-1",
        "version": 1,
        "type": "programme_application",
        "due_at": due_at.isoformat(),
        "timezone": "UTC",
        "rolling": False,
        "reminder_offsets": [1],
        "verified": False,
    }

    assert due_reminders([deadline], as_of=today, sent_keys=set()) == []


def test_rolling_deadlines_without_a_date_do_not_generate_reminders() -> None:
    deadline = {
        "opportunity_id": "opp-1",
        "deadline_id": "rolling-1",
        "version": 1,
        "type": "programme_application",
        "rolling": True,
        "reminder_offsets": [30, 7, 1],
        "verified": True,
    }

    assert due_reminders([deadline], as_of=date(2026, 7, 6), sent_keys=set()) == []
