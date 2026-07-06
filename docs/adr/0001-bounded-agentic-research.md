# ADR-0001: Bounded agentic research

## Status

Accepted

## Decision

Use deterministic ingestion and persistence workflows around a read-only research agent. Initial page extraction identifies missing or uncertain fields. The agent may search and fetch a limited number of sources, preferring official domains. It cannot write records, send arbitrary messages, execute shell commands, or access general credentials.

After research, deterministic code validates knowledge states, evidence, and the record schema. The user confirms critical findings before persistence.

## Consequences

- Prompt injection in external pages has a smaller blast radius.
- Research has explicit query, page, token, and time budgets.
- Workflow behavior remains inspectable and testable.
- Some inaccessible or ambiguous opportunities remain incomplete and require user input.
