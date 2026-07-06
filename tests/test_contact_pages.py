from prospect.notion_pages import contact_page_payload


def test_contact_payload_maps_supervisor_fields_to_notion_properties() -> None:
    contact = {
        "name": "Arkaitz Zubiaga",
        "role": "Supervisor",
        "institution_or_lab": "Social Data Science Lab, Queen Mary",
        "research_topics": "Social media, disinformation, NLP",
        "profile_url": "https://www.zubiaga.org/",
        "notes": "Also Centre for Human-Centred Computing",
    }

    payload = contact_page_payload("contacts-source", contact)

    assert payload["parent"] == {
        "type": "data_source_id",
        "data_source_id": "contacts-source",
    }
    properties = payload["properties"]
    assert properties["Name"]["title"][0]["text"]["content"] == "Arkaitz Zubiaga"
    assert properties["Role"] == {"select": {"name": "Supervisor"}}
    assert properties["Institution or lab"]["rich_text"][0]["text"]["content"] == (
        "Social Data Science Lab, Queen Mary"
    )
    assert properties["Research topics"]["rich_text"][0]["text"]["content"] == (
        "Social media, disinformation, NLP"
    )
    assert properties["Profile URL"]["url"] == "https://www.zubiaga.org/"
    assert properties["Response status"] == {"select": {"name": "Not contacted"}}


def test_contact_payload_omits_absent_optional_fields() -> None:
    payload = contact_page_payload("contacts-source", {"name": "Pepa"})

    properties = payload["properties"]
    assert properties["Name"]["title"][0]["text"]["content"] == "Pepa"
    assert "Role" not in properties
    assert "Profile URL" not in properties
    assert properties["Research topics"] == {"rich_text": []}
    assert properties["Response status"] == {"select": {"name": "Not contacted"}}
