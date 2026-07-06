"""Convenience wrapper for the one-time Notion bootstrap."""

from prospect.cli import main


if __name__ == "__main__":
    raise SystemExit(main(["bootstrap-notion"]))
