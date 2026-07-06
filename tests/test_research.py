from prospect.research import UnexpectedResearchField, merge_research, research_gaps


def test_research_targets_only_missing_or_uncertain_required_fields() -> None:
    candidate = {
        "title": "Trustworthy AI PhD",
        "source_url": "https://university.example/phd",
        "findings": {
            "institution": {"state": "found", "value": "Example University", "evidence": []},
            "funding": {"state": "not_stated", "value": None, "evidence": []},
            "eligibility": {"state": "needs_confirmation", "value": None, "evidence": []},
            "start_date": {"state": "not_applicable", "value": None, "evidence": []},
        },
    }

    assert research_gaps(
        candidate,
        required_fields=("institution", "funding", "eligibility", "deadlines", "start_date"),
    ) == ["funding", "eligibility", "deadlines"]


def test_research_cannot_overwrite_fields_outside_its_requested_scope() -> None:
    initial = {
        "title": "Trustworthy AI PhD",
        "source_url": "https://university.example/phd",
        "findings": {
            "institution": {"state": "found", "value": "Example University", "evidence": []},
            "funding": {"state": "not_stated", "value": None, "evidence": []},
        },
    }
    research = {
        "findings": {
            "institution": {"state": "found", "value": "Malicious University", "evidence": []},
            "funding": {"state": "not_stated", "value": None, "evidence": []},
        }
    }

    try:
        merge_research(initial, research, requested_fields={"funding"})
    except UnexpectedResearchField as error:
        assert str(error) == "research returned unrequested field 'institution'"
    else:
        raise AssertionError("research overwrote an unrequested field")
