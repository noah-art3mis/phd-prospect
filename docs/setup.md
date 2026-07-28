# First run

Getting Prospect from a fresh checkout to a bot that answers. `docs/deploy.md` covers the VM; this is the checklist before and around it.

Your `.env` already carries `TELEGRAM_ALLOWED_USER_ID` across from the n8n build, along with the four settings that are preferences rather than secrets. Three credentials are outstanding, and none of them can be recovered from anywhere – they have to be created.

## Credentials still needed

- [ ] **`TELEGRAM_BOT_TOKEN`** – message [@BotFather](https://t.me/BotFather), `/newbot`, follow the prompts. He hands back a token of the form `<digits>:AA<letters>`. Paste it into `.env`.
- [ ] **`ANTHROPIC_API_KEY`** – [console.anthropic.com](https://console.anthropic.com) → API keys. Ingest costs roughly $0.11 per opportunity, bounded near $0.31 by the content cap, so a small spend limit on the key is reasonable belt-and-braces on top of the caps already in the code.
- [ ] **`GCS_BACKUP_BUCKET`** – create a bucket in the same GCP project as the VM. The name alone goes in `.env`; there is no key to store, because the instance's own service account is used.

Check them with `node src/index.cjs --check`, which names anything still missing and exits non-zero.

## Local shakedown

Do this before touching the VM – it exercises everything except the container.

- [ ] `npm ci`
- [ ] `node src/index.cjs --check` – expect "config ok", "database ready", "tracking 7 opportunities" (the Notion seed)
- [ ] `npm run ingest-url -- <a real PhD advert URL>` – one live model call, prints the validated record, writes nothing. The cheapest way to see whether the prompt does what you want before any of it is wired to Telegram.
- [ ] `node src/index.cjs` in one terminal, then send that same link to the bot. Expect an acknowledgement within a second or two, then a card a minute or two later. Press Approve.
- [ ] `npm run remind -- --dry` – lists what is due without sending
- [ ] `npm run digest` – prints this week's digest without sending
- [ ] `npm run backup -- --local` – writes a file under `data/backups/`; open it with any SQLite client to confirm it restores

## The VM

Follow `docs/deploy.md`. In order:

- [ ] Create the `e2-micro` in a free-tier region (`us-west1`, `us-central1`, `us-east1`)
- [ ] Attach a service account with `devstorage.read_write` **at creation time** – adding it later means recreating the instance
- [ ] `git clone`, `cp .env.example .env`, fill in the same three credentials
- [ ] `docker compose up -d --build`
- [ ] Send a link from Telegram and confirm the round trip works on the box
- [ ] Verify restart-on-failure: `docker compose exec prospect kill 1`, then confirm it comes back
- [ ] `docker compose exec prospect npm run backup` – confirm the upload reaches the bucket

## Known-unverified

Carried forward from the rebuild so it does not get lost. Each is a stub that has never met the real thing:

- [ ] **The container has never been built.** Docker was unavailable in the environment this was written in, so the first `docker compose up --build` is genuinely the first one.
- [ ] **The GCS upload has only run against a stub.** The metadata-server token fetch and the bucket write are untested against the real API.
- [ ] **The Telegram round trip has only run against a stub.** Long polling, `getFile`, and inline buttons are unexercised against the live API.

## Then

- [ ] Watch for the first Sunday digest. Its arrival is the signal the whole alerting design rests on – if it does not come, something is wrong regardless of how healthy the container looks.
- [ ] Take one manual off-box backup (`npm run backup -- --local`, then copy it somewhere that is not GCP). Primary and backup share a project, so a billing problem takes both; this is the mitigation, and it only works as a habit.
