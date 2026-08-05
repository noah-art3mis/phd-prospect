# First run

Getting Prospect from a fresh checkout to a bot that answers. `docs/deploy.md` covers the VM; this is the checklist before and around it.

`.env` carries `TELEGRAM_ALLOWED_USER_ID` and four settings that are preferences rather than secrets. Of the three credentials, two are in place.

## Credentials

- [x] **`TELEGRAM_BOT_TOKEN`** – set, and the bot answers `getMe`. No webhook is registered on it, so long polling works; if that ever changes, `getUpdates` starts failing with `409 Conflict` and the app looks broken for a reason that has nothing to do with it:

    ```bash
    set -a; . ./.env; set +a
    curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo"          # is one set?
    curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/deleteWebhook?drop_pending_updates=true"
    ```

    Only one consumer can read a bot's updates at a time. If you swap to a fresh bot with `/newbot`, re-check `TELEGRAM_ALLOWED_USER_ID` – you have to message the new bot before it can see you.

- [x] **`ANTHROPIC_API_KEY`** – set and working. Measured ingests cost $0.03 to $1.84 each, and a failed one can cost as much as a record (see `docs/findings-live-ingest.md`); the code bounds an ingest at ten minutes and 1M billed input tokens, which is roughly $2.50 at introductory rates. Set a spend limit in the console anyway – it is the only ceiling that holds when the ones in the code do not.

- [ ] **`BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`** – Cloudflare R2: 10 GB free and no egress charge. Create a bucket (`prospect-backups`), then an **API token scoped to that bucket** with object read and write. The endpoint is `https://<account-id>.r2.cloudflarestorage.com`. Any S3-compatible bucket works – nothing in the code is R2-specific.

  The URL is shown once, at creation, and never again. It ends in `/o/`. Paste it into `.env`.

  It is write-only and scoped to one bucket, which is what limits the damage – but it *is* a credential, so treat it like a password. When it expires the nightly upload starts failing, which raises the Telegram alert and shows as a stale backup in the Sunday digest. Nothing else will remind you.

## Local shakedown

Do this before touching the VM – it exercises everything except the container.

- [ ] `npm ci`
- [x] `node src/index.cjs --check` – expect "config ok", "database ready", "tracking N opportunities"
- [ ] `npm run ingest-url -- <a real PhD advert URL>` – one live model call, prints the validated record, writes nothing. The cheapest way to see whether the prompt does what you want before any of it is wired to Telegram.
- [ ] `node src/index.cjs` in one terminal, then send that same link to the bot. Expect an acknowledgement within a second or two, then a card a minute or two later. Press Approve.
- [ ] `npm run remind -- --dry` – lists what is due without sending
- [ ] `npm run digest` – prints this week's digest without sending
- [ ] `npm run backup -- --local` – writes a file under `data/backups/`; open it with any SQLite client to confirm it restores

## The VM

Follow `docs/deploy.md` – *Provisioning, in order* covers the account, the region, the key and the bucket. In short:

- [ ] Create the Render service from `render.yaml` and the R2 bucket it backs up to
- [ ] Create an Always Free instance – `VM.Standard.A1.Flex` if capacity allows, otherwise `VM.Standard.E2.1.Micro`, which is nearly always available and enough
- [ ] `git clone`, `cp .env.example .env`, fill in the same three credentials
- [ ] `docker compose up -d --build`
- [ ] Send a link from Telegram and confirm the round trip works on the box
- [ ] Verify restart-on-failure: `docker compose exec prospect kill 1`, then confirm it comes back
- [ ] `docker compose exec prospect npm run backup` – confirm the upload reaches the bucket

## Known-unverified

Carried forward from the rebuild so it does not get lost. Each is a stub that has never met the real thing:

- [ ] **The container has never been built.** Docker was unavailable in the environment this was written in, so the first `docker compose up --build` is genuinely the first one.
- [ ] **The backup upload has only run against a stub.** The signed PUT is untested against a real bucket; the signature is asserted offline, but R2 has never rejected or accepted one.
- [x] **The Telegram round trip.** Done: long polling, the acknowledgement, an ingest, the approval card and the alert path have all run against the live API. `getFile` (PDF submissions) and the inline buttons under load are still unexercised.

## Then

- [ ] Watch for the first Sunday digest. Its arrival is the signal the whole alerting design rests on – if it does not come, something is wrong regardless of how healthy the container looks.
- [ ] Take one manual off-box backup (`npm run backup -- --local`, then copy it somewhere that is neither Render nor R2) and restore it once. Host and bucket are already different vendors, so this guards against the remaining case: a copy nobody has ever proved restores.
