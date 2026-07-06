from prospect.notion_schema import database_specs, relation_updates


def test_notion_bootstrap_defines_the_five_linked_domain_collections() -> None:
    specs = database_specs("parent-page-id")

    assert set(specs) == {
        "opportunities",
        "deadlines",
        "contacts",
        "activities",
        "documents",
    }
    for spec in specs.values():
        assert spec["parent"] == {"type": "page_id", "page_id": "parent-page-id"}
        title_properties = [
            property_schema
            for property_schema in spec["initial_data_source"]["properties"].values()
            if "title" in property_schema
        ]
        assert title_properties == [{"title": {}}]


def test_child_collections_link_back_to_opportunities_bidirectionally() -> None:
    updates = relation_updates(
        {
            "opportunities": "opportunities-id",
            "deadlines": "deadlines-id",
            "contacts": "contacts-id",
            "activities": "activities-id",
            "documents": "documents-id",
        }
    )

    assert set(updates) == {"deadlines", "contacts", "activities", "documents"}
    for update in updates.values():
        assert update == {
            "properties": {
                "Opportunity": {
                    "relation": {
                        "data_source_id": "opportunities-id",
                        "dual_property": {},
                    }
                }
            }
        }
