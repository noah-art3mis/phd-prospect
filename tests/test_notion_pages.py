from prospect.notion_pages import opportunity_page_payload


def test_opportunity_payload_is_pending_and_preserves_source_provenance() -> None:
    record = {
        "title": "Trustworthy AI PhD",
        "source_url": "https://University.Example/phd/?utm_source=telegram",
        "findings": {
            "institution": {
                "state": "found",
                "value": "Example University",
                "evidence": [
                    {
                        "url": "https://university.example/phd",
                        "retrieved_at": "2026-07-06T10:00:00+00:00",
                        "excerpt": "Example University invites applications.",
                    }
                ],
            }
        },
    }

    payload = opportunity_page_payload("opportunities-source", record)

    assert payload["parent"] == {
        "type": "data_source_id",
        "data_source_id": "opportunities-source",
    }
    assert payload["properties"]["Name"]["title"][0]["text"]["content"] == (
        "Trustworthy AI PhD"
    )
    assert payload["properties"]["Institution"]["rich_text"][0]["text"]["content"] == (
        "Example University"
    )
    assert payload["properties"]["Canonical URL"]["url"] == "https://university.example/phd"
    assert payload["properties"]["Source URL"]["url"] == record["source_url"]
    assert payload["properties"]["Confirmed"]["checkbox"] is False
