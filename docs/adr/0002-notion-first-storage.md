# ADR-0002: Notion-first storage

## Status

Superseded by ADR-0006 (2026-07-20): storage moved from Notion to a local SQLite database in the standalone app. Originally "Accepted for the initial experiment".

## Decision

Use Notion as the sole editable source of truth while validating the workflow. Model opportunities, deadlines, contacts, activities, and documents as related data sources.

Do not maintain bidirectional synchronization with Obsidian. A later migration may replace Notion persistence with Markdown notes and Obsidian Bases once the extraction and reminder workflow is proven.

## Consequences

- n8n can create and update records through supported APIs.
- The experiment avoids file synchronization and conflict resolution.
- Data portability requires an explicit export or later migration.
