# ADR-0004: n8n hosting — self-host Prospect off n8n Cloud

## Status

Never accepted. Drafted 2026-07-06 as a proposal, left uncommitted, and overtaken by ADR-0006 (2026-07-20), which removes n8n entirely. The hosting decision below is therefore moot: there is no n8n instance to host, self-hosted or otherwise.

It is recorded here anyway because the threat analysis is not moot. The standalone app fetches user-submitted URLs from its own host, which is the same SSRF surface this ADR was written to close — and it no longer has n8n Cloud's managed protection sitting in front of it. Read the sections below as a threat model and a design sketch, not as a decision:

- **What carries forward:** the fetch-hop analysis in *Context*, the whole of *The SSRF egress control* (per-hop DNS re-resolution, manual redirect walking, connecting to the validated IP to close the TOCTOU window, port/scheme/userinfo rejection, size and redirect caps, network isolation), and the residual-risk note that the resolver logic needs its own unit tests before anything is published.
- **What does not:** everything about n8n Cloud versus Community Edition, the MCP build/test loop, `N8N_ENCRYPTION_KEY`, credential rebinding, and the `n8n_data` volume backup runbook.
- **Where it is live:** `SPEC.md`, "Still to specify" → Security → SSRF / fetch safety. That item is unresolved; this document is its prior art.

Relates to ADR-0001 (bounded agentic research), ADR-0006 (which supersedes it), and issues #5 (security review) and #7 (both now answered by ADR-0006).

## Context

Prospect runs three n8n workflows (ingest, deadline reminders, recheck) that process untrusted external web content and hold Telegram, Notion, and Anthropic credentials. Today the live instance is n8n Cloud (`noah-art3mis.app.n8n.cloud`); the repo already carries a self-hosted stack (`compose.yaml`, `.env.example`, n8n 2.25.7 Community Edition). Setup steps 1–4 are done on Cloud — Notion bootstrapped, Telegram bot gated, ingest admission + fetch slice verified live — and Step 5 (extract → research → validate → approve → persist) plus the two schedulers are still to build. The n8n MCP that drives the build/test loop is currently pointed at the Cloud instance's `/mcp-server/http` endpoint over OAuth.

Four forces pull toward self-hosting, and they are not equal:

- **SSRF egress control is the load-bearing one.** The ingest workflow fetches user-submitted URLs. The current defence is a regex blocklist in the *Authorize and normalize request* Code node that rejects literal private-network, localhost, `.local`/`.internal`, credentialed, and non-standard-port URLs *before* the fetch. It does **not** re-resolve DNS, and it does **not** re-check anything after the *Fetch submitted source* HTTP Request node follows its 5 redirects — so a hostname that resolves public on first check but rebinds to `169.254.169.254`, or a public URL that `302`s to `http://10.0.0.5/`, sails straight through. n8n Cloud's managed SSRF protection covers this hop; Community Edition does not. This gap can only be closed on infrastructure we control. It directly reinforces ADR-0001's "smaller blast radius for injection" goal.
- **Data ownership.** Execution data (untrusted page text) and encrypted credentials sit on a third-party SaaS today. Self-hosting keeps them on our infrastructure.
- **Git as source of truth (#4).** The three workflows are rebuildable from tracked `n8n/workflows/*.json` on `docker compose up` + import. A self-hosted instance makes Cloud drift irrelevant and the tracked JSON authoritative.
- **Cost and dependency removal.** Drops the Cloud subscription and the cloud-OAuth dependency for the MCP.

Against these sit real new costs: a public HTTPS webhook (Telegram cannot deliver to `localhost`), availability for the daily reminder schedule, re-creating credentials and owning `N8N_ENCRYPTION_KEY`, backups of the `n8n_data` volume, verifying the MCP loop against a self-hosted instance, and building the SSRF egress control ourselves.

## Decision drivers

| Driver                          | Weight | Notes                                                                                 |
| ------------------------------- | ------ | ------------------------------------------------------------------------------------- |
| SSRF egress control on the fetch hop | High   | Only implementable self-hosted; the one force that touches an invariant (untrusted content). |
| Availability of daily scheduler | High   | Deadline reminders run daily; a laptop/WSL box that sleeps will miss runs.             |
| Not re-doing security wiring    | Medium | Fetch + research nodes are the security-sensitive ones and depend on where they run.  |
| Data ownership                  | Medium | Real but not invariant-breaking on Cloud.                                              |
| Git-as-truth alignment          | Medium | Already largely true via tracked JSON; self-host strengthens it.                       |
| Ops burden (webhook, backups)   | Medium | One-time setup cost, recurring maintenance.                                            |
| Credential re-creation cost     | Low    | Only three credentials (telegramApi, notionApi, anthropicApi).                         |

## Options considered

### Option A — Stay on n8n Cloud

Keep building on Cloud; accept managed SSRF protection and never build the egress control. Lowest ops burden, no webhook/backup work, MCP loop already connected.

Rejected as the end state: it forecloses the SSRF egress control that #5 and `n8n/README.md` both call for, leaves untrusted-content execution and secrets on a third-party SaaS, and keeps Cloud as a drift source against the tracked JSON. It remains a legitimate *fallback* if self-hosting ops prove unsustainable for a solo operator.

### Option B — Self-host, but only *after* Step 5 is built on Cloud

Finish Step 5 on Cloud (credentials wired, MCP connected today), then migrate. Attractive because momentum is on Cloud.

The flaw is what "migrate" actually costs. It is not just re-pasting three credentials. The *Fetch submitted source* node and the recheck fetches must be **re-pointed through the new egress fetch service**, and the SSRF egress control cannot even be *validated* on Cloud (there is no internal network to defend, and Cloud's managed layer masks the gap). So Step 5's most security-sensitive nodes would be built and tested once against Cloud's managed SSRF, then re-architected and re-tested against our own egress path — the security wiring is done twice. That is precisely the "re-doing" the issue warns about, concentrated in the highest-risk nodes.

### Option C — Self-host *before* completing Step 5, on an always-on VPS (recommended)

Stand up the self-hosted stack on a small always-on VPS now, re-verify the already-built admission + fetch slice against it (routed through the new egress fetch service), verify the MCP loop against the self-hosted instance, then build Step 5's remaining nodes **once**, natively behind the egress control. Credential re-creation (three credentials) happens up front while there is least to rewire.

This front-loads the webhook/tunnel/backup ops work, which is the honest cost. But it builds the fetch, research, validate, approve, and persist nodes exactly once, on the platform they will run on, with the SSRF egress control present from the moment the fetch hop exists.

## Decision

Adopt **Option C**: self-host on an always-on VPS, cutting over **before** the remaining Step 5 nodes (research → validate → approve → persist) and the schedulers are built. Concretely:

1. **Where** — a small always-on VPS (1 vCPU / 1–2 GB is enough for a single-user CE instance), not the WSL box. The daily deadline-reminder schedule needs an always-on host; a WSL box behind a tunnel sleeps with the laptop and will silently miss reminder runs. WSL + a `cloudflared` quick tunnel stays useful as a throwaway *dev-loop* target while iterating, but it is not the production home.
2. **Public HTTPS webhook** — a reverse proxy with TLS on the VPS: **Caddy in front of n8n**, automatic Let's Encrypt certificate on a real subdomain, `WEBHOOK_URL`/`N8N_HOST`/`N8N_PROTOCOL=https` set to that origin. This gives a stable public HTTPS origin with no third-party tunnel dependency and no per-restart URL churn. (`cloudflared` named tunnel is the acceptable alternative if no domain is available; the plain `ngrok`/quick-tunnel free tier is dev-only because its URL rotates.)
3. **SSRF egress control** — a dedicated fetch service sidecar (see plan below), wrapping only the outbound fetch of user-submitted URLs. The in-workflow regex blocklist stays as a cheap first gate but is no longer the last line.
4. **MCP loop** — verify the n8n MCP can drive the self-hosted instance via an n8n API key before building further (steps below); keep the Cloud OAuth config only until that is confirmed.
5. **Fallback** — if solo-operator ops (patching, cert renewal, backups) prove unsustainable, Option A (Cloud) is the documented retreat. This ADR does not burn that bridge.

The three tracked workflow JSONs remain the source of truth; the Cloud instance is decommissioned only after the self-hosted instance passes the Step 6 test matrix in `docs/setup.md`.

## Rationale

- The only force that touches a **CONTEXT.md invariant** ("external content is untrusted data") is the SSRF fetch hop, and it is unaddressable on Cloud. Building Step 5 on Cloud first would build and test the fetch/research nodes against a protection we are about to remove, then rebuild them — doubling exactly the security-sensitive work the issue flags.
- Credential re-creation is cheap here (three credentials, tokens re-pasted), so the usual "build where the credentials already are" pull is weak.
- The scheduler availability requirement settles the WSL-vs-VPS question independently: daily reminders demand an always-on host regardless of the SSRF argument.
- Doing the MCP-against-self-hosted verification up front means the build/test loop is proven on the target platform before the bulk of the work, not after.

## The SSRF egress control (ties to #5)

**Scope it correctly first.** There are two outbound-fetch surfaces, and only one is ours to defend:

- **Ours:** the *Fetch submitted source* HTTP Request node (and the recheck workflow's source re-fetch). These run from our instance and can reach our internal network — this is the SSRF surface.
- **Not ours:** the research step uses Claude's server-side `web_fetch`/`web_search` tools, which execute on Anthropic's infrastructure, not ours, and are already domain-bounded (`allowed_domains`, `max_uses`). No egress from our network happens there, so it needs no proxy — only its domain bounds.

So the egress control wraps *only* our own fetch of untrusted URLs.

**Design — a dedicated fetch service sidecar** (preferred over a plain forward proxy, because it can re-resolve per hop and pin the connection):

- A tiny HTTP service (Python/Node) in its own container on the compose network. n8n's fetch nodes call `http://fetch-svc:PORT/fetch?url=...` instead of fetching the target directly.
- The service **disables automatic redirect following** and walks redirects manually. On **every hop** it:
  - resolves the hostname to all A/AAAA records and rejects if *any* resolved IP falls in loopback / private (RFC1918) / link-local (`169.254/16`, `fe80::/10`) / CGNAT (`100.64/10`) / ULA (`fc00::/7`) / unspecified / multicast ranges — this catches DNS rebinding and public-to-internal redirects that the literal-string blocklist misses;
  - rejects non-80/443 ports, userinfo, and non-http(s) schemes;
  - **connects to the validated IP directly** (with the original `Host` header) so a rebind between the DNS check and the TCP connect cannot swap the address — closes the TOCTOU window;
  - enforces a redirect cap, total-size cap, and timeout, and returns text only.
- **Network isolation:** run the fetch service on an egress-only Docker network with no route to the n8n management port or other internal services, so even a logic bug in the resolver check cannot reach the instance's own control plane.
- The existing in-workflow regex blocklist stays as a cheap pre-filter; the fetch service is the authoritative gate.

An egress forward proxy (n8n `HTTP_PROXY`/`HTTPS_PROXY` → a filtering proxy) is a weaker alternative: it still needs the same re-resolution and IP-pinning logic to be safe, and gives less control over per-hop redirect inspection, so it is not preferred.

## MCP against self-hosted (survival of the build/test loop)

The Cloud MCP endpoint (`/mcp-server/http`) authenticates via cloud OAuth, which does not exist on CE. Two viable paths, in order of preference:

1. **n8n API key against the instance MCP/REST surface.** Create an API key in the self-hosted UI (Settings → n8n API), ensure the public API is enabled, and point the MCP client at the self-hosted origin authenticating with `X-N8N-API-KEY` instead of OAuth.
2. **Standalone n8n MCP server process** configured with the self-hosted REST base URL + API key, if the instance does not expose an equivalent hosted MCP endpoint.

**Honest residual uncertainty:** whether CE 2.25.7 exposes an OAuth-free `/mcp-server/http` equivalent at instance level is not confirmable from the repo alone and must be checked live (verification steps in the runbook). If it does not, fall to path 2. Either way the loop survives; the shape of the auth is the open item, not whether it works.

## Consequences

- The SSRF fetch hop gets a real, testable defence for the first time — the one change that closes an invariant gap rather than a convenience gap.
- Execution data and encrypted credentials move onto controlled infrastructure; the tracked JSON becomes unambiguously authoritative and Cloud drift disappears.
- We take on recurring ops: OS/n8n patching, TLS renewal (automated via Caddy), nightly volume backups, and monitoring that the daily scheduler actually fires. For a solo operator this is the main ongoing cost, and the honest failure mode is a silently-missed reminder run on an unattended box — mitigate with an uptime/heartbeat check on the reminder workflow.
- `N8N_ENCRYPTION_KEY` becomes our responsibility: lose it and every stored credential in `n8n_data` is unrecoverable; rotate it and existing credentials break. It must be backed up **separately** from the volume.
- Losing Cloud's managed SSRF is now a deliberate, mitigated tradeoff (the fetch service) rather than an accepted risk.
- Residual risk: a bug in the fetch service's resolver logic re-opens the SSRF surface — so it needs its own unit tests (private-range, rebind, redirect-to-internal, non-standard-port cases) before the ingest workflow is published. The recheck workflow's re-fetch must route through the same service, or it becomes a second unguarded hole.

## Migration / ops runbook (checklist)

**Provision and webhook**

- [ ] Provision the always-on VPS; install Docker + Compose.
- [ ] Point a subdomain (e.g. `n8n.<domain>`) at the VPS.
- [ ] Add Caddy (or a reverse proxy) fronting n8n with automatic Let's Encrypt TLS.
- [ ] Set `.env`: `N8N_HOST=n8n.<domain>`, `N8N_PROTOCOL=https`, `N8N_WEBHOOK_URL=https://n8n.<domain>/`, keep `GENERIC_TIMEZONE=America/Mexico_City`.
- [ ] `docker compose up -d`; confirm the UI loads over HTTPS.

**Encryption key + credentials**

- [ ] Generate `N8N_ENCRYPTION_KEY` (`openssl rand -hex 32`); store it in `.env` (git-ignored) **and** in a password manager off-box.
- [ ] Recreate the three credentials in the new instance by re-pasting the same tokens: `telegramApi`, `notionApi`, `anthropicApi`. Expect new credential IDs (the ones in the HANDOFF are Cloud IDs); the tracked JSON deliberately carries no credential IDs, so rebinding is expected.
- [ ] Rebind credentials to every node (UI or MCP `setNodeCredential` with `credentialKey`/`credentialId`/`credentialName`).

**MCP loop**

- [ ] Enable the n8n public API; create an API key (Settings → n8n API).
- [ ] Smoke-test the API: `curl -H "X-N8N-API-KEY: <key>" https://n8n.<domain>/api/v1/workflows` returns the workflow list.
- [ ] Re-point the MCP client at the self-hosted instance with `X-N8N-API-KEY` auth; if no instance `/mcp-server/http`, run the standalone n8n MCP server against the REST base URL + key.
- [ ] Confirm a read-only MCP tool (e.g. `search_workflows`) works before building further.

**Import + SSRF egress + build**

- [ ] Import the three tracked `n8n/workflows/*.json`; replace `REPLACE_WITH_TELEGRAM_USER_ID`; set the workflow timezone.
- [ ] Add the fetch-service sidecar container (egress-only network) and its resolver/redirect/IP-pinning tests; re-point *Fetch submitted source* and the recheck re-fetch at it.
- [ ] Re-verify the existing admission + fetch slice end-to-end through the fetch service.
- [ ] Build Step 5 nodes (extract → classify → research → validate → approve → persist) once, natively, per the HANDOFF plan.

**Backups + retention**

- [ ] Nightly backup of the `n8n_data` volume with the instance stopped for SQLite consistency (`docker compose stop n8n && docker run --rm -v <proj>_n8n_data:/data -v $PWD/backups:/backup alpine tar czf /backup/n8n-$(date +%F).tgz -C /data . && docker compose start n8n`), or use SQLite's online backup.
- [ ] Store the encryption-key backup **separately** from the volume backup (a backup holding both is a single point of compromise).
- [ ] Test a restore into a scratch instance at least once.
- [ ] Confirm execution retention (`EXECUTIONS_DATA_PRUNE=true`, `MAX_AGE=168`, save-on-error only) is active — already tuned in `compose.yaml`.
- [ ] Note the DR truth: workflows rebuild from tracked JSON + import; the volume backup covers only credentials (encrypted), execution history, and instance settings.

**Cut over**

- [ ] Pass the Step 6 test matrix (`docs/setup.md`) on the self-hosted instance: university page, PDF listing, no-deadline page, conflicting-dates page, duplicate listing, inaccessible page; no Notion mutation before Telegram approval; repeated reminder runs do not resend a prior key.
- [ ] Add an uptime/heartbeat check on the daily reminder workflow.
- [ ] Only then decommission the Cloud instance; update `docs/setup.md` and `n8n/README.md` to make self-hosted the primary path.
