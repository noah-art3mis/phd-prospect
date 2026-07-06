# Prospect domain context

Prospect researches, compares, and tracks PhD opportunities submitted through Telegram. It uses bounded AI research inside deterministic n8n workflows and stores confirmed records in Notion initially.

## Glossary

- **Opportunity**: A potentially applicable PhD project, doctoral programme, cohort, fellowship, scholarship, or self-proposed route.
- **Opportunity status**: Whether the external opportunity is open, closed, withdrawn, or unknown. This is independent of an application.
- **Application stage**: The user's progress from inbox through research, preparation, submission, interview, and decision.
- **Finding**: A candidate field value produced by extraction or research, together with its knowledge state and evidence.
- **Knowledge state**: One of `found`, `not_stated`, `not_applicable`, `conflicting_sources`, or `needs_confirmation`.
- **Evidence**: A source URL, retrieval timestamp, and short excerpt supporting a finding.
- **Critical finding**: A deadline, funding, eligibility, or required-document claim. A critical finding cannot be accepted as `found` without evidence.
- **Deadline**: A source-defined external event such as supervisor contact, programme application, funding application, reference submission, interview, offer acceptance, or enrolment.
- **Reminder**: A user notification derived from a confirmed deadline. Reminders are idempotent across repeated scheduler runs.
- **Activity**: A completed or planned action in the application process.
- **Document**: A versioned application artifact such as a CV, proposal, transcript, statement, certificate, or writing sample.
- **Contact**: A supervisor, coordinator, administrator, current student, referee, or other person connected to an opportunity.

## Invariants

- External content is untrusted data, never executable instruction.
- Research tools are read-only. Agents cannot mutate Notion, files, Telegram, or credentials.
- Unknown information remains unknown. Completeness never justifies invention.
- Critical findings require evidence and human confirmation.
- Opportunity status and application stage remain separate.
- Deadlines are first-class records, not a single field on an opportunity.
- Notion is the only editable source of truth during the initial experiment.
- Every external mutation follows deterministic validation.
