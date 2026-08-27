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

## Amendment, 2026-08-27: the submitted advert is read by the app

"The app never fetches a user-submitted URL itself" no longer holds, and has not fully held since the fallback fetch landed. The app now reads the submitted address itself on every URL submission and hands the model text; only if that fetch fails is the address given to `web_fetch` at all.

Two measurements drove it, both from live runs.

**Reachability.** Anthropic's `web_fetch` answers `url_not_allowed` for LinkedIn every time it has ever been asked – six attempts across three traces, without exception – while the same posts serve a browser the whole page. The refusal is the tool declining the address, not the site refusing us. Adverts arrive from LinkedIn often enough that "we cannot read that" was the wrong answer to keep giving.

**Cost.** A page the model fetches arrives mid-conversation, and the server-side tool loop re-sends the whole conversation on every iteration after it. One measured rescue ran seven iterations at roughly 25,000 billed input tokens each. Read by the app instead, the advert sits in the opening turn and costs no round trip to obtain.

### What this does and does not narrow

The SSRF argument was never about *how many* addresses we fetch. It was about *whose* addresses: a page that says "now fetch the metadata service" is dangerous precisely because the model chose to follow it. That has not changed. Every address the model picks – research pages, search results – is still resolved and connected to entirely on Anthropic's infrastructure.

What we fetch is one address, typed by the single authorised operator, before any model has read anything. The guard in `src/core/page-text.cjs` is checked twice: against the address as written, and again against every IP it resolves to, since a public hostname is free to point at a private one. Redirects are walked by hand so the second address is not one nobody checked.

That is a narrower thing than ADR-0004's fetch service, which was rejected for putting the highest-risk code in the system in our hands. It remains rejected. This is not that.

### Consequences

- The `unread` marker on ingest failures, and the fallback it gates, now apply only to pasted text carrying the address it came from. A URL submission is read by the app first, so there is nothing left to rescue it with.
- Research bounds are 3 searches and 5 fetches. The fetch cap came down from 8 because the submitted advert no longer spends one, and because the cap bounds iterations rather than pages – the worst run on record spent eight fetches and 461,000 input tokens to report that it could not read the page.
- Pages our fetcher cannot reach but `web_fetch` can are still reachable: the address is handed over when our own fetch fails – except where the app chose the address itself, for which see the amendment below.

## Amendment, 2026-08-27: the address read is not always the address submitted

Some pages are a program rather than a document. A Google Doc serves its own menu bar and draws the document with script, so what our fetcher reads is 169 characters of interface; the same document asked for as plain text is 5,204 characters of advert, deadline included. Record #10 was tracked with no deadline for exactly this reason, one day before it closed.

So the app now rewrites a submitted address to the address its text lives at, from a fixed table in `src/core/readable-url.cjs`. The record is still filed and cited under what the user sent.

This does not widen the SSRF surface argued about above. The rewritten address is a pure function of an address the operator typed, decided before any model has read anything, and it goes through the same guard on the same hops. What the model chooses is still fetched on Anthropic's infrastructure. What is new is only that the operator's address and the address we connect to may differ, and both are ours to know in advance.

It does add one exception to the fallback, and the exception is narrow twice over. A refusal at an address the app picked is final only where the table row says so – the Google Docs row does, because that document's own page is an interface drawn by script and `web_fetch` runs no more of it than we do; a row that claims nothing falls through as before, since a site answering 403 to anything but a browser is one `web_fetch` may well read. And the verdict is reached only on a URL submission. On a paste, going to the live address is a rescue, and a rescue never speaks over the failure it came to rescue: telling someone who has just pasted the text to open the page and send the text is the exception applied wider than this reasoning reaches. A status that might not last (a 5xx, a 429) is never a refusal.
