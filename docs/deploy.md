# Deploying Prospect

Short enough to follow from a phone, because that is when you will need it.

## Why Oracle and not GCP

GCP's Always Free tier covers the `e2-micro` and the disk but **not the external IPv4 address**, which has been charged since February 2024 at $0.005/hour – about $3.65 a month, $44 a year. The app dials out and nothing dials in, so it needs no inbound access, but a VM with no external address has no outbound access either unless you add Cloud NAT, which costs ten times more.

Oracle Cloud's Always Free tier includes the address. This project exists because the previous build stopped being free to run; paying $44/year to host a personal reminder bot would have repeated that, so the whole thing runs on Oracle instead. The trade is that Oracle's free ARM capacity is genuinely scarce in popular regions – see below.

## Provisioning, in order

Five things only an account holder can do. Do them in this order – region and shape are the two that are awkward to change afterwards.

1. **Sign up** at [signup.cloud.oracle.com](https://signup.cloud.oracle.com). Identity verification wants a real credit card whose billing country matches the address you give – prepaid and virtual cards are the usual reason a signup is rejected. Oracle authorises about a dollar and reverses it; Always Free never charges it.

   **The account starts on a 30-day trial with $300 of credits, not on Always Free.** During the trial the credits quietly absorb paid resources, and when it ends anything that is not free-tier-eligible is reclaimed. So the label to look for when creating the instance is **"Always Free-eligible"**, not the shape name. Decline the Pay As You Go upgrade it will keep offering: staying on the downgraded free account is what keeps the bill at zero.

   **Pick the home region carefully: it cannot be changed later**, and every Always Free resource must live in it – a block volume created elsewhere bills at the normal rate. Free Tier is offered in every commercial region, so the choice is not about availability, and it is not about latency either: nothing dials in to this app, so the distance to it does not matter. What the region decides is the odds of getting free ARM capacity. Mexico now has `mx-queretaro-1` and `mx-monterrey-1`; `us-ashburn-1` and `sa-saopaulo-1` are the larger, more contested pools. Any of them works.

2. **Create the instance** – shape and image below. The deploy key already exists on the laptop; paste its public half when the form asks:

   ```sh
   cat ~/.ssh/prospect_oracle.pub
   ```

   The private half stays on the laptop at `~/.ssh/prospect_oracle`, has no passphrase so `ssh` and `scp` work unattended, and is used for nothing else. Add a passphrase with `ssh-keygen -p -f ~/.ssh/prospect_oracle` if you would rather type one.

3. **Create the bucket** – Object Storage → Create Bucket → `prospect-backups`, standard tier, defaults otherwise.

4. **Issue the pre-authenticated request** on that bucket – see *The backup destination* below. Copy the URL immediately; it is shown once.

5. **Note the public IP** from the instance page, then:

   ```sh
   ssh -i ~/.ssh/prospect_oracle ubuntu@<public-ip>      # 'opc@' on Oracle Linux images
   ```

   `.env` is copied across rather than retyped, so the secrets never pass through a terminal history:

   ```sh
   scp -i ~/.ssh/prospect_oracle .env ubuntu@<public-ip>:~/phd-prospect/.env
   ```

## The box

An Always Free instance, in the home region you chose at signup:

- **`VM.Standard.A1.Flex`** (Ampere ARM) – 1,500 OCPU hours and 9,000 GB hours a month, which is 2 OCPU and 12 GB running continuously, across all your free instances. Far more than this app needs, and often answers *"Out of host capacity"*. Retry, or pick a quieter availability domain.
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

## What this costs, and what could still bill

Nothing, if it stays inside the Always Free allowances, which this workload does not come close to filling:

| Resource        | Always Free                      | This app                          |
| --------------- | -------------------------------- | --------------------------------- |
| Compute         | 2 OCPU / 12 GB Ampere, or 2 × E2.1.Micro | one instance, container capped at 512 MB |
| Block storage   | 200 GB                           | the boot volume                   |
| Object Storage  | 20 GB                            | one SQLite file per night         |
| Outbound data   | 10 TB/month                      | Telegram polling and API calls    |
| External IP     | included                         | one, ephemeral                    |

The bill that *is* real is Anthropic: measured ingests cost $0.03 to $1.84 each, and the weekly digest reports the running total. That is the number to watch, not the host.

Two things that are not costs but are the real risks: **Oracle reclaims Always Free compute it judges idle** – continuous long polling should count as activity, but it is their call and there is no warning – and **the tenancy holds both the instance and its backups**, so an account problem takes both. The mitigation for both is the same: take a manual off-box copy occasionally.

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
