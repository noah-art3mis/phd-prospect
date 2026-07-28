# ADR-0007: Ingest is a single agentic call using Anthropic's server-side tools

Ingest submits the user's URL to one Anthropic call that uses the server-side `web_fetch` and `web_search` tools to fetch the page, extract the opportunity, and fill gaps, returning a candidate record that deterministic validation and Telegram approval then gate. The app never fetches a user-submitted URL itself: the only hosts it makes outbound requests to are `api.anthropic.com` and `api.telegram.org`.

## Considered options

**A fetch service we own** (ADR-0004's design — per-hop DNS re-resolution, manual redirect walking, connecting to the validated IP to close the TOCTOU window). Rejected: it puts the highest-risk code in the system in our hands to write and keep correct, in exchange for control we don't need. Server-side fetching removes the SSRF surface rather than defending it — no user-controlled hostname is ever resolved or connected to by our host, so the class of bug stops being representable.

**Two stages — extract, compute missing fields, then research only those.** This is what the n8n build did (`missing_fields.js` → `build-research-request.js` → `merge-research.js`), and it made "research fills only fields the page didn't state" a pure function rather than a prompt instruction. Rejected for one call on simplicity grounds: for a single-user tool where every record passes a human approval gate before storage, the extra stage buys a guarantee the human was already providing.

**A source-primacy rule** — requiring a critical finding's evidence to cite the submitted URL before it can be `found`. Considered and declined for the same reason: Telegram approval is the backstop, and an invariant nothing enforces is worse than no invariant.

## Consequences

- The SSRF threat model in ADR-0004 no longer applies to this design. Keep that document for its analysis, not its plan.
- No search-provider account, key, or vendor decision: `web_search` is part of the model call.
- Telegram-uploaded PDFs are the one thing we still fetch, from Telegram's own API, and are passed to the model as base64 `document` blocks rather than parsed locally. Never hand a Telegram file URL to `web_fetch` — the bot token is embedded in its path.
- Research bounds are `max_uses` on the tool definitions (3 searches, 8 fetches, carried over from the n8n build), not a loop we write. There is no agent loop on our side to bound, instrument, or test.
- **The call can stop with `stop_reason: "pause_turn"`** when Anthropic's tool loop hits its iteration limit. This returns HTTP 200 with a partial result and no error. A single call doing fetch plus searches makes this materially likely, so ingest must check `stop_reason` and re-send to resume; treating the first response as final produces truncated candidates that look successful.
- We never hold the page's raw bytes. Evidence excerpts come from the model's reading of the page. Citations are **not** used: the response is constrained by structured outputs, and Anthropic returns a 400 if citations and structured outputs are combined. Trading verifiable spans for a record that cannot be malformed is a deliberate choice — human approval against the source URL is what verifies the record.
- Fetch failures, bot-blocking, and JS-rendered pages become a reported failure ("couldn't read that page") rather than an engineering problem to solve locally.
