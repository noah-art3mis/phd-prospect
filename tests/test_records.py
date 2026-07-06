from prospect.records import InvalidRecord, normalize_opportunity


def test_critical_findings_require_evidence() -> None:
    candidate = {
        "title": "Trustworthy AI PhD",
        "source_url": "https://university.example/phd",
        "findings": {
            "funding": {
                "state": "found",
                "value": "2026-12-01T23:59:00+01:00",
                "evidence": [],
            }
        },
    }

    try:
        normalize_opportunity(candidate)
    except InvalidRecord as error:
        assert str(error) == "critical finding 'funding' requires evidence"
    else:
        raise AssertionError("unsupported funding claim was accepted")


def test_found_findings_require_a_value() -> None:
    candidate = {
        "title": "Trustworthy AI PhD",
        "source_url": "https://university.example/phd",
        "findings": {
            "department": {
                "state": "found",
                "value": "",
                "evidence": [
                    {
                        "url": "https://university.example/phd",
                        "retrieved_at": "2026-07-06T10:00:00+00:00",
                        "excerpt": "Department of Computer Science",
                    }
                ],
            }
        },
    }

    try:
        normalize_opportunity(candidate)
    except InvalidRecord as error:
        assert str(error) == "finding 'department' marked found without a value"
    else:
        raise AssertionError("empty finding was accepted")


def test_findings_reject_unknown_knowledge_states() -> None:
    candidate = {
        "title": "Trustworthy AI PhD",
        "source_url": "https://university.example/phd",
        "findings": {"funding": {"state": "probably", "value": None, "evidence": []}},
    }

    try:
        normalize_opportunity(candidate)
    except InvalidRecord as error:
        assert str(error) == "finding 'funding' has unknown state 'probably'"
    else:
        raise AssertionError("unknown knowledge state was accepted")


def test_evidence_requires_a_web_source_timestamp_and_excerpt() -> None:
    candidate = {
        "title": "Trustworthy AI PhD",
        "source_url": "https://university.example/phd",
        "findings": {
            "funding": {
                "state": "found",
                "value": "Fully funded",
                "evidence": [
                    {
                        "url": "https://university.example/funding",
                        "retrieved_at": "not-a-timestamp",
                        "excerpt": "Includes tuition and stipend.",
                    }
                ],
            }
        },
    }

    try:
        normalize_opportunity(candidate)
    except InvalidRecord as error:
        assert str(error) == "finding 'funding' has evidence with an invalid retrieved_at"
    else:
        raise AssertionError("malformed evidence was accepted")


def test_conflicting_sources_require_at_least_two_sources() -> None:
    candidate = {
        "title": "Trustworthy AI PhD",
        "source_url": "https://university.example/phd",
        "findings": {
            "deadlines": {
                "state": "conflicting_sources",
                "value": None,
                "evidence": [
                    {
                        "url": "https://university.example/phd",
                        "retrieved_at": "2026-07-06T10:00:00+00:00",
                        "excerpt": "Applications close on 1 December.",
                    }
                ],
            }
        },
    }

    try:
        normalize_opportunity(candidate)
    except InvalidRecord as error:
        assert str(error) == "finding 'deadlines' marked conflicting with fewer than two sources"
    else:
        raise AssertionError("unsupported conflict was accepted")


def test_opportunity_requires_a_title_and_public_web_source() -> None:
    candidate = {"title": " ", "source_url": "file:///tmp/phd.html", "findings": {}}

    try:
        normalize_opportunity(candidate)
    except InvalidRecord as error:
        assert str(error) == "opportunity requires a title"
    else:
        raise AssertionError("untitled opportunity was accepted")

    candidate["title"] = "Trustworthy AI PhD"
    try:
        normalize_opportunity(candidate)
    except InvalidRecord as error:
        assert str(error) == "opportunity requires an http or https source_url"
    else:
        raise AssertionError("local source URL was accepted")


def test_deadline_collection_is_a_critical_finding() -> None:
    candidate = {
        "title": "Trustworthy AI PhD",
        "source_url": "https://university.example/phd",
        "findings": {
            "deadlines": {
                "state": "found",
                "value": [{"type": "programme_application", "due_at": "2026-12-01"}],
                "evidence": [],
            }
        },
    }

    try:
        normalize_opportunity(candidate)
    except InvalidRecord as error:
        assert str(error) == "critical finding 'deadlines' requires evidence"
    else:
        raise AssertionError("unsupported deadline collection was accepted")


def test_findings_must_be_an_object_of_objects() -> None:
    candidate = {
        "title": "Trustworthy AI PhD",
        "source_url": "https://university.example/phd",
        "findings": [],
    }

    try:
        normalize_opportunity(candidate)
    except InvalidRecord as error:
        assert str(error) == "opportunity findings must be an object"
    else:
        raise AssertionError("malformed findings were accepted")


def test_evidence_must_be_an_object() -> None:
    candidate = {
        "title": "Trustworthy AI PhD",
        "source_url": "https://university.example/phd",
        "findings": {
            "funding": {
                "state": "found",
                "value": "Fully funded",
                "evidence": ["unsupported claim"],
            }
        },
    }

    try:
        normalize_opportunity(candidate)
    except InvalidRecord as error:
        assert str(error) == "finding 'funding' has malformed evidence"
    else:
        raise AssertionError("non-object evidence was accepted")


def test_evidence_collection_must_be_a_list() -> None:
    candidate = {
        "title": "Trustworthy AI PhD",
        "source_url": "https://university.example/phd",
        "findings": {
            "funding": {
                "state": "found",
                "value": "Fully funded",
                "evidence": {"url": "https://university.example/funding"},
            }
        },
    }

    try:
        normalize_opportunity(candidate)
    except InvalidRecord as error:
        assert str(error) == "finding 'funding' evidence must be a list"
    else:
        raise AssertionError("non-list evidence collection was accepted")


def test_evidence_timestamp_must_include_a_utc_offset() -> None:
    candidate = {
        "title": "Trustworthy AI PhD",
        "source_url": "https://university.example/phd",
        "findings": {
            "funding": {
                "state": "found",
                "value": "Fully funded",
                "evidence": [
                    {
                        "url": "https://university.example/funding",
                        "retrieved_at": "2026-07-06T10:00:00",
                        "excerpt": "Includes tuition and stipend.",
                    }
                ],
            }
        },
    }

    try:
        normalize_opportunity(candidate)
    except InvalidRecord as error:
        assert str(error) == "finding 'funding' retrieved_at must include a UTC offset"
    else:
        raise AssertionError("naive evidence timestamp was accepted")
