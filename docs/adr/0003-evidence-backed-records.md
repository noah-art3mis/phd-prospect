# ADR-0003: Evidence-backed records

## Status

Accepted

## Decision

Represent extracted values as findings with explicit knowledge states. Critical findings marked `found` require evidence containing a source URL, retrieval timestamp, and excerpt. Conflicting sources remain visible and require confirmation.

## Consequences

- The system can explain where deadlines, funding, eligibility, and requirements came from.
- The user can distinguish absence of evidence from evidence of absence.
- Flat table views contain normalized values while detailed evidence remains attached to the opportunity.
