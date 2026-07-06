from prospect.seed import seed_contacts


def test_seed_contacts_posts_one_page_per_contact_to_the_data_source() -> None:
    calls: list[tuple[str, str, dict]] = []

    def request(method, path, payload):
        calls.append((method, path, payload))
        return {"id": f"page-{len(calls)}"}

    contacts = [
        {"name": "Arkaitz Zubiaga", "role": "Supervisor"},
        {"name": "Kalina Bontcheva", "role": "Supervisor"},
    ]

    created = seed_contacts("contacts-source", contacts, request=request)

    assert created == ["page-1", "page-2"]
    assert [method for method, _, _ in calls] == ["POST", "POST"]
    assert {path for _, path, _ in calls} == {"/v1/pages"}
    assert calls[0][2]["parent"] == {
        "type": "data_source_id",
        "data_source_id": "contacts-source",
    }
    assert calls[0][2]["properties"]["Name"]["title"][0]["text"]["content"] == (
        "Arkaitz Zubiaga"
    )
