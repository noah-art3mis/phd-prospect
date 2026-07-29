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
