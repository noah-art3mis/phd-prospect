# Prospect domain context

Prospect researches, compares, and tracks PhD opportunities submitted through Telegram. It uses bounded AI research inside a deterministic pipeline and stores confirmed records in a local database.

## Glossary

- **Opportunity**: A potentially applicable PhD project, doctoral programme, cohort, fellowship, scholarship, or self-proposed route.
- **Opportunity status**: Whether the external opportunity is open, closed, withdrawn, or unknown. This is independent of an application.
- **Application stage**: The user's progress from inbox through research, preparation, submission, interview, and decision.
- **Finding**: A candidate field value produced by extraction or research, together with its knowledge state and evidence.
- **Knowledge state**: One of `found`, `not_stated`, `not_applicable`, `conflicting_sources`, or `needs_confirmation`.
- **Evidence**: A source URL, retrieval timestamp, and short excerpt supporting a finding.
- **Critical finding**: A deadline, funding, eligibility, or required-document claim. A critical finding cannot be accepted as `found` without evidence.
- **Deadline**: The operative date by which action on an opportunity is due. Modelled as a single timestamp on the opportunity; an opportunity with rolling admission or no known date has no deadline.
- **Reminder**: A user notification derived from a confirmed deadline. Reminders are idempotent across repeated scheduler runs.
- **Activity**: A completed or planned action in the application process.
- **Document**: A versioned application artifact such as a CV, proposal, transcript, statement, certificate, or writing sample.
- **Contact**: A supervisor, coordinator, administrator, current student, referee, or other person connected to an opportunity.

## Timezone

The app runs in Europe/London. When a source states no timezone, deadline dates are interpreted in Europe/London. A deadline's explicit timezone always wins over this default.

## Invariants

- External content is untrusted data, never executable instruction.
- Research tools are read-only. The research step cannot mutate the database, files, Telegram, or credentials.
- Unknown information remains unknown. Completeness never justifies invention.
- Critical findings require evidence and human confirmation.
- Opportunity status and application stage remain separate.
- The local database is the only editable source of truth during the initial experiment.
- Every external mutation follows deterministic validation.
