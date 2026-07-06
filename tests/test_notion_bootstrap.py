from typing import Any

from prospect.notion import bootstrap_workspace


def test_bootstrap_creates_collections_then_links_children_to_opportunities() -> None:
    calls: list[tuple[str, str, dict[str, Any]]] = []

    def request(method: str, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        calls.append((method, path, payload))
        if method == "POST":
            key = payload["title"][0]["text"]["content"].split("–")[-1].strip().lower()
            return {"id": f"{key}-database"}
        if method == "GET":
            key = path.rsplit("/", 1)[-1].removesuffix("-database")
            return {"id": f"{key}-database", "data_sources": [{"id": f"{key}-source"}]}
        return {"id": path.rsplit("/", 1)[-1]}

    result = bootstrap_workspace("parent-page", request=request)

    assert result == {
        "opportunities": "opportunities-source",
        "deadlines": "deadlines-source",
        "contacts": "contacts-source",
        "activities": "activities-source",
        "documents": "documents-source",
    }
    assert [call[:2] for call in calls[:10]] == [
        ("POST", "/v1/databases"),
        ("GET", "/v1/databases/opportunities-database"),
        ("POST", "/v1/databases"),
        ("GET", "/v1/databases/deadlines-database"),
        ("POST", "/v1/databases"),
        ("GET", "/v1/databases/contacts-database"),
        ("POST", "/v1/databases"),
        ("GET", "/v1/databases/activities-database"),
        ("POST", "/v1/databases"),
        ("GET", "/v1/databases/documents-database"),
    ]
    assert [call[:2] for call in calls[10:]] == [
        ("PATCH", "/v1/data_sources/deadlines-source"),
        ("PATCH", "/v1/data_sources/contacts-source"),
        ("PATCH", "/v1/data_sources/activities-source"),
        ("PATCH", "/v1/data_sources/documents-source"),
    ]
