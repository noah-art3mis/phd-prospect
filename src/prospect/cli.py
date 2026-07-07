"""Command-line entry points for validation and one-time setup."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Sequence

from prospect.notion import NotionClient, bootstrap_workspace
from prospect.workflows import build_all
from prospect.notion_schema import database_specs
from prospect.records import normalize_opportunity
from prospect.seed import seed_contacts


def main(argv: Sequence[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)

    if args.command == "validate":
        candidate = json.loads(Path(args.record).read_text())
        print(json.dumps(normalize_opportunity(candidate), indent=2, sort_keys=True))
        return 0

    if args.command == "bootstrap-notion":
        parent_page_id = args.parent_page_id or os.environ.get("NOTION_PARENT_PAGE_ID")
        if not parent_page_id:
            parser.error("set NOTION_PARENT_PAGE_ID or pass --parent-page-id")
        if args.dry_run:
            print(json.dumps(database_specs(parent_page_id), indent=2, sort_keys=True))
            return 0
        token = os.environ.get("NOTION_TOKEN")
        if not token:
            parser.error("set NOTION_TOKEN before bootstrapping Notion")
        client = NotionClient(token)
        identifiers = bootstrap_workspace(parent_page_id, request=client.request)
        print(json.dumps(identifiers, indent=2, sort_keys=True))
        return 0

    if args.command == "seed-contacts":
        contacts = json.loads(Path(args.contacts).read_text())
        data_source_id = args.data_source_id or _data_source_id(
            args.data_sources, "contacts"
        )
        if not data_source_id:
            parser.error("pass --data-source-id or a --data-sources file with a contacts id")
        token = os.environ.get("NOTION_TOKEN")
        if not token:
            parser.error("set NOTION_TOKEN before seeding Notion")
        client = NotionClient(token)
        created = seed_contacts(data_source_id, contacts, request=client.request)
        print(f"Seeded {len(created)} contacts into {data_source_id}")
        return 0

    if args.command == "build-workflows":
        written = build_all(Path(args.root))
        for path in written:
            print(f"Wrote {path}")
        return 0

    parser.error("a command is required")


def _data_source_id(path: str | None, key: str) -> str | None:
    if not path:
        return None
    return json.loads(Path(path).read_text()).get(key)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="prospect")
    subcommands = parser.add_subparsers(dest="command")

    validate = subcommands.add_parser("validate", help="validate an extracted opportunity JSON file")
    validate.add_argument("record")

    notion = subcommands.add_parser(
        "bootstrap-notion", help="create Prospect's five related Notion data sources"
    )
    notion.add_argument("--parent-page-id")
    notion.add_argument("--dry-run", action="store_true")

    seed = subcommands.add_parser(
        "seed-contacts", help="create Notion contact pages from a local seed file"
    )
    seed.add_argument("contacts", help="path to a JSON array of contact seed records")
    seed.add_argument(
        "--data-sources",
        help="path to the bootstrap output JSON holding the contacts data source id",
    )
    seed.add_argument("--data-source-id", help="contacts data source id (overrides --data-sources)")

    build = subcommands.add_parser(
        "build-workflows",
        help="inline n8n/code and n8n/prompts payloads into the workflow templates "
        "and emit deployable copies under n8n/import/",
    )
    build.add_argument("--root", default=".", help="repository root (default: cwd)")
    return parser


if __name__ == "__main__":
    raise SystemExit(main())
