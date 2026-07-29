# Deploying Prospect

Short enough to follow from a phone, because that is when you will need it.

## Why Oracle and not GCP

GCP's Always Free tier covers the `e2-micro` and the disk but **not the external IPv4 address**, which has been charged since February 2024 at $0.005/hour – about $3.65 a month, $44 a year. The app dials out and nothing dials in, so it needs no inbound access, but a VM with no external address has no outbound access either unless you add Cloud NAT, which costs ten times more.

Oracle Cloud's Always Free tier includes the address. This project exists because the previous build stopped being free to run; paying $44/year to host a personal reminder bot would have repeated that, so the whole thing runs on Oracle instead. The trade is that Oracle's free ARM capacity is genuinely scarce in popular regions – see below.

## The box

An Always Free instance, in the home region you chose at signup:

- **`VM.Standard.A1.Flex`** (Ampere ARM) – up to 4 OCPU and 24 GB across all your free instances. Far more than this app needs, and often answers *"Out of host capacity"*. Retry, or pick a quieter availability domain.
- **`VM.Standard.E2.1.Micro`** (AMD, 1 OCPU, 1 GB) – two are free, and they are almost always available. This is the fallback, and it is enough: the container is capped at 512 MB.

Ubuntu 22.04 or later. Everything below is identical on either shape; the container image is multi-arch.

Nothing needs to reach the instance, so leave the default security list alone – no ingress rule, no load balancer, no domain, no certificate.

## The backup destination

Object Storage, 20 GB free. Create a **standard bucket** (`prospect-backups`), then issue a **pre-authenticated request** on it:

- Target: *Objects with prefix* — leave the prefix empty
- Access: **Permit object writes** (not reads – a backup mover has no reason to read)
- Expiry: pick a date you will renew. Oracle will not warn you.

Copy the URL once, at creation; it is never shown again. It ends in `/o/`. That URL goes in `.env` as `BACKUP_UPLOAD_URL`, and it **is** the credential – anyone holding it can write to that bucket until it expires. Write-only and single-bucket is what limits the damage, not secrecy alone.

**Renewal is a manual job with no reminder.** When the PAR expires the nightly upload starts failing, which raises the Telegram alert and shows as a stale backup in the Sunday digest. That is the signal; act on it rather than waiting for a bill.

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

Ubuntu images on Oracle ship iptables rules that block most outbound ports beyond SSH. Only 443 is needed here and it is open by default, but if the first poll hangs, that is where to look.

## Deploy a change

Intentionally boring – the absence of a build pipeline is a feature, not an omission.

```sh
cd phd-prospect && git pull && docker compose up -d --build
```

The database is in `./data` on the host, so it survives the rebuild.

## Checking it is alive

Three signals, in increasing order of how long you have to wait:

- `docker compose ps` – the container should be `running`, not restarting.
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

**Accepted risk, recorded rather than discovered later:** the instance and the backup bucket live in the same Oracle tenancy, so a billing problem or an account suspension takes both. Oracle is also known for reclaiming idle Always Free compute. It is mitigated by making a manual off-box copy trivial – the commands above – not by adding a second vendor. Run them occasionally.

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

`TZ` in `.env` is what the app resolves deadlines and schedules jobs against. The container's own clock stays UTC; that is fine and deliberate – a deadline is stored as a UTC instant resolved with the zone in force at ingest, so changing `TZ` moves *when* reminders arrive without reinterpreting any date already approved.
