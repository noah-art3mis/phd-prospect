# Seeds

Local, git-ignored data extracted from personal notes to populate a freshly bootstrapped Notion workspace. Only `seeds/*.json` is ignored; this README is tracked so the format is documented.

## `contacts.json`

A JSON array of supervisor/contact seed records. Written **directly** into the Contacts data source (contacts carry no validation invariant). Each record:

| Field                | Type   | Notes                                           |
| -------------------- | ------ | ----------------------------------------------- |
| `name`               | string | Required (page title).                          |
| `role`               | string | Optional; a Contacts `Role` select option.      |
| `institution_or_lab` | string | Optional.                                        |
| `research_topics`    | string | Optional; free text.                            |
| `email`              | string | Optional.                                        |
| `profile_url`        | string | Optional; single URL (extra links go in notes). |
| `notes`              | string | Optional; extra profile/lab links.              |

Load after bootstrap:

```bash
set -a; . ./.env; set +a; uv run prospect seed-contacts seeds/contacts.json \
  --data-sources notion-data-sources.json
```

## `opportunity-backlog.json`

Positions, fellowships, and funding schemes with their URLs/deadlines. **Not** written to Notion directly — every opportunity must enter through the ingestion workflow (extract → research → validate → confirm) so it passes deterministic validation. Use this file as the work queue of URLs to feed the Telegram ingestion path. `leads_without_url` holds institution/lab targets that still need an advert URL located before they can be ingested.
