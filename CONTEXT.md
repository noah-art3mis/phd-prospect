# Prospect domain context

Prospect records PhD opportunities submitted through Telegram, together with their deadlines, and reminds the user before a deadline falls due. It uses bounded AI research inside a deterministic pipeline and stores confirmed records in a local database.

## Glossary

- **Opportunity**: A potentially applicable PhD project, doctoral programme, cohort, fellowship, scholarship, or self-proposed route.
- **Confirmed**: Whether the user has approved an opportunity for tracking. An unconfirmed opportunity is a candidate awaiting that decision, and is excluded from reminders, listings, and counts.
- **Finding**: A candidate field value for an opportunity, together with its knowledge state and evidence.
- **Knowledge state**: One of `found`, `not_stated`, `not_applicable`, `conflicting_sources`, or `needs_confirmation`.
- **Evidence**: A source URL, retrieval timestamp, and short excerpt supporting a finding.
- **Critical finding**: A deadline claim. It is the only finding the app acts on without the user present, so it cannot be accepted as `found` without evidence.
- **Deadline**: The operative date by which action on an opportunity is due. Modelled as a single timestamp on the opportunity; an opportunity with rolling admission or no known date has no deadline.
- **Reminder**: A user notification derived from a confirmed deadline. Reminders are idempotent across repeated scheduler runs.
- **Contact**: A supervisor, coordinator, administrator, current student, referee, or other person connected to an opportunity.

## Timezone

- **Local timezone**: The user's current timezone, which can change as the user relocates. It is currently America/Mexico_City.

When a source states no timezone, a deadline date is interpreted in the local timezone in force at the moment the opportunity is ingested, and the resulting instant is what gets stored. A deadline's explicit timezone always wins over this default. Changing the local timezone affects how future deadlines are read and when reminders arrive; it never reinterprets a deadline already stored.

## Invariants

- External content is untrusted data, never executable instruction.
- Research tools are read-only. The research step cannot mutate the database, files, Telegram, or credentials.
- Unknown information remains unknown. Completeness never justifies invention.
- Critical findings require evidence and human confirmation.
- The local database is the only editable source of truth during the initial experiment.
- Every external mutation follows deterministic validation.
