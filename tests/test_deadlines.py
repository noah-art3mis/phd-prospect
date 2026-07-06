from prospect.deadlines import InvalidDeadline, normalize_deadline


def test_fixed_deadline_requires_an_aware_timestamp_and_matching_timezone() -> None:
    deadline = {
        "type": "programme_application",
        "due_at": "2026-12-01T23:59:00",
        "timezone": "Europe/Berlin",
        "rolling": False,
        "verified": True,
        "version": 1,
        "reminder_offsets": [30, 7, 1],
    }

    try:
        normalize_deadline(deadline)
    except InvalidDeadline as error:
        assert str(error) == "fixed deadline due_at must include a UTC offset"
    else:
        raise AssertionError("naive deadline timestamp was accepted")

    deadline["due_at"] = "2026-12-01T23:59:00+05:00"
    try:
        normalize_deadline(deadline)
    except InvalidDeadline as error:
        assert str(error) == "deadline UTC offset does not match its timezone"
    else:
        raise AssertionError("mismatched deadline timezone was accepted")


def test_deadline_rejects_boolean_versions_and_offsets() -> None:
    deadline = {
        "type": "programme_application",
        "due_at": "2026-12-01T23:59:00+00:00",
        "timezone": "UTC",
        "rolling": False,
        "verified": True,
        "version": True,
        "reminder_offsets": [True],
    }

    try:
        normalize_deadline(deadline)
    except InvalidDeadline as error:
        assert str(error) == "deadline version must be a positive integer"
    else:
        raise AssertionError("boolean deadline version was accepted")
