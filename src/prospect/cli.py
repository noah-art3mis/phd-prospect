"""Command-line entry points for validation and one-time setup."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Sequence

from prospect.notion import NotionClient, bootstrap_workspace
from prospect.notion_schema import database_specs
from prospect.records import normalize_opportunity


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

    parser.error("a command is required")


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
    return parser


if __name__ == "__main__":
    raise SystemExit(main())
