"""Seed Notion data sources from local, git-ignored seed files."""

from __future__ import annotations

from typing import Any

from prospect.notion import NotionRequest
from prospect.notion_pages import contact_page_payload


def seed_contacts(
    data_source_id: str,
    contacts: list[dict[str, Any]],
    *,
    request: NotionRequest,
) -> list[str]:
    """Create one contact page per seed record; return the created page IDs."""

    created: list[str] = []
    for contact in contacts:
        payload = contact_page_payload(data_source_id, contact)
        page = request("POST", "/v1/pages", payload)
        created.append(page["id"])
    return created
