"""Small Notion API boundary used by the one-time workspace bootstrap."""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from prospect.notion_schema import database_specs, relation_updates


NotionRequest = Callable[[str, str, dict[str, Any]], dict[str, Any]]


def bootstrap_workspace(parent_page_id: str, *, request: NotionRequest) -> dict[str, str]:
    """Create Prospect's data sources and their opportunity relations."""

    data_source_ids: dict[str, str] = {}
    for key, payload in database_specs(parent_page_id).items():
        created = request("POST", "/v1/databases", payload)
        database = request("GET", f"/v1/databases/{created['id']}", {})
        data_source_ids[key] = database["data_sources"][0]["id"]

    for key, payload in relation_updates(data_source_ids).items():
        request("PATCH", f"/v1/data_sources/{data_source_ids[key]}", payload)
    return data_source_ids


class NotionClient:
    """Minimal authenticated client for the endpoints Prospect bootstraps."""

    def __init__(self, token: str) -> None:
        self._token = token

    def request(self, method: str, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        request = Request(
            f"https://api.notion.com{path}",
            data=None if method == "GET" else json.dumps(payload).encode(),
            method=method,
            headers={
                "Authorization": f"Bearer {self._token}",
                "Content-Type": "application/json",
                "Notion-Version": "2026-03-11",
            },
        )
        try:
            with urlopen(request, timeout=30) as response:  # noqa: S310 - fixed HTTPS origin
                return json.load(response)
        except HTTPError as error:
            detail = error.read().decode(errors="replace")
            raise RuntimeError(f"Notion API returned HTTP {error.code}: {detail}") from error
