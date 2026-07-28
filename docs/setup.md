# First run

Getting Prospect from a fresh checkout to a bot that answers. `docs/deploy.md` covers the VM; this is the checklist before and around it.

Your `.env` already carries `TELEGRAM_ALLOWED_USER_ID` across from the n8n build, along with the four settings that are preferences rather than secrets. Three credentials are outstanding, and none of them can be recovered from anywhere – they have to be created.

## Credentials still needed

- [ ] **`TELEGRAM_BOT_TOKEN`** – reuse the bot from the n8n build rather than making a new one: same username, same chat history, and `TELEGRAM_ALLOWED_USER_ID` stays valid. Its token lived in n8n Cloud's credential store, which masks values after saving, so reissue instead of retrieving: [@BotFather](https://t.me/BotFather) → `/mybots` → the bot → *API Token* → *Revoke current token*. Revoking breaks the old n8n workflow, which is intended. Paste the new token into `.env`.

  - [ ] **Clear the old webhook before starting the app.** The n8n build used a `telegramTrigger`, which registers a webhook, and Telegram refuses `getUpdates` while one is set – long polling fails with `409 Conflict` and the new app looks broken for a reason that has nothing to do with it. Once, after filling in the token:

    ```bash
    set -a; . ./.env; set +a
    curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo"          # is one set?
    curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/deleteWebhook?drop_pending_updates=true"
    ```

    `drop_pending_updates` discards whatever queued up while the old build was down; without it the bot replays that backlog on first poll. Only one consumer can read a bot's updates at a time, so make sure the n8n workflow is deactivated too.

  If you would rather start clean, `/newbot` gives a fresh bot – but then re-check `TELEGRAM_ALLOWED_USER_ID`, since you will need to message the new bot before it can see you.
- [ ] **`ANTHROPIC_API_KEY`** – create a new one at [console.anthropic.com](https://console.anthropic.com) → API keys. The previous project's key is not recoverable: it lived in n8n Cloud's credential store, and Anthropic shows a key once at creation and never again. Ingest costs roughly $0.11 per opportunity, bounded near $0.31 by the content cap, so a small spend limit is reasonable belt-and-braces on top of the caps already in the code.

  - [ ] Once the new app is running, revoke the old key in the console so the retired build cannot spend.

- [ ] **`GCS_BACKUP_BUCKET`** – create a bucket in the same GCP project as the VM. The name alone goes in `.env`; there is no key to store, because the instance's own service account is used. Bucket names are globally unique across all of GCS, so prefix with something of yours:

  ```bash
  gcloud config set project <your-project-id>
  gcloud storage buckets create gs://<you>-prospect-backups \
    --location=us-central1 \
    --uniform-bucket-level-access \
    --public-access-prevention
  ```

  Then grant the VM's service account write access to that bucket only – not project-wide storage admin, which would let a compromised box reach every bucket you own:

  ```bash
  gcloud storage buckets add-iam-policy-binding gs://<you>-prospect-backups \
    --member=serviceAccount:<sa-name>@<project-id>.iam.gserviceaccount.com \
    --role=roles/storage.objectCreator
  ```

  `objectCreator` lets the job write a new backup but not read or delete existing ones, so a bad actor on the box cannot quietly wipe the backup history. Use `objectAdmin` instead if you want the retention pruning to happen bucket-side later. Consider a lifecycle rule to expire objects after 90 days; the free tier is 5 GB and a backup of this database is small, but it grows forever otherwise.

  A bucket is only needed for the VM. Locally, `npm run backup -- --local` skips the upload entirely.

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
