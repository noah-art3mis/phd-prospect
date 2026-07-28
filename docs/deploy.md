# Deploying Prospect

Short enough to follow from a phone, because that is when you will need it.

## The box

A GCP "Always Free" `e2-micro` in a free-tier region (`us-west1`, `us-central1` or `us-east1`), with a service account attached that can write to the backup bucket. Nothing else — no domain, no static IP, no firewall rule. Long polling means the app dials out and nothing dials in.

Attach the service account at instance creation, with scope `https://www.googleapis.com/auth/devstorage.read_write`. That is the whole credential story: the app reads a token from the metadata server, so there is no key file to expire, rotate, or leak.

## First deploy

```sh
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 git
sudo usermod -aG docker $USER && newgrp docker

git clone https://github.com/noah-art3mis/phd-prospect.git && cd phd-prospect
cp .env.example .env && nano .env          # fill in every key; the app refuses to start otherwise
mkdir -p data

docker compose up -d --build
docker compose logs -f                     # expect "config ok", "database ready", "tracking N opportunities"
```

Then send the bot a link from Telegram. An acknowledgement within a second or two means the round trip works.

## Deploy a change

Intentionally boring — the absence of a build pipeline is a feature, not an omission.

```sh
cd phd-prospect && git pull && docker compose up -d --build
```

The database is in `./data` on the host, so it survives the rebuild.

## Checking it is alive

Three signals, in increasing order of how long you have to wait:

- `docker compose ps` — the container should be `running`, not restarting.
- `node src/index.cjs --check` inside the container boots and exits, proving config and database.
- The Sunday digest. Its absence is the alarm; that is the whole reason it exists.

```sh
docker compose exec prospect node src/index.cjs --check
docker compose exec prospect npm run digest        # print this week's digest without sending
```

## Backups

The nightly job copies the database off-box at 04:00 local. To take a copy by hand:

```sh
docker compose exec prospect npm run backup            # local copy + upload
docker compose exec prospect npm run backup -- --local # local copy only
docker compose cp prospect:/data/backups ./backups     # pull them to wherever you are
```

**Accepted risk, recorded rather than discovered later:** the instance and the backup bucket live in the same GCP project, so a billing problem or an account suspension takes both. It is mitigated by making a manual off-box copy trivial — the commands above — not by adding a second vendor. Run them occasionally.

To restore: stop the container, drop a backup file at `data/prospect.db`, start it again.

```sh
docker compose down
cp backups/prospect-2026-07-28T04-00-00-000Z.db data/prospect.db
docker compose up -d
```

## Verifying restart-on-failure

Worth doing once, so you know the `restart: unless-stopped` line is real:

```sh
docker compose exec prospect kill 1
sleep 15 && docker compose ps      # should be running again, with a newer start time
```

A host reboot is the same story: `restart: unless-stopped` brings it back with Docker.

## Timezone

`TZ` in `.env` is what the app resolves deadlines and schedules jobs against. The container's own clock stays UTC; that is fine and deliberate — a deadline is stored as a UTC instant resolved with the zone in force at ingest, so changing `TZ` moves *when* reminders arrive without reinterpreting any date already approved.
