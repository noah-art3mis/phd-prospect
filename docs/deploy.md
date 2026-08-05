# Deploying Prospect

Short enough to follow from a phone, because that is when you will need it.

## Where it runs, and why not a VM

A **Render background worker**, built from the Dockerfile in this repo, with a persistent disk at `/data`. Backups go to **Cloudflare R2**, a different vendor from the host on purpose.

Not a web service: nothing dials in. Long polling means the app opens a connection outward and keeps it, so there is no port to bind, no health-check URL to answer, no domain and no certificate. Render's free tier has no workers and spins services down after idle time, which would be fatal twice over – a sleeping bot misses both the long poll and the 09:00 sweep.

The predecessor of this document described an Oracle Always Free VM. It was free and it worked, but provisioning it is a VCN wizard, a subnet radio, a capacity lottery on ARM, and an instance Oracle may reclaim for idleness without warning. The Render worker costs about $7 a month and is a blueprint file. Free was not worth the afternoon.

The choice is deliberately shallow. Render holds a container and a set of environment variables; `render.yaml` describes both. Moving to Fly, Northflank, or a plain VPS running `docker compose` is a redeploy, not a port – the same image, the same variables, the same disk at `/data`.

## What you need before deploying

Three accounts and four minutes each.

1. **Telegram bot** – `@BotFather`, `/newbot`, keep the token. Your numeric user id comes from `@userinfobot`.
2. **Anthropic API key** – console.anthropic.com.
3. **Cloudflare R2 bucket** – see below.

## The backup destination

R2 gives 10 GB free and charges nothing for egress, which matters when you are pulling a copy down.

- Create a bucket named `prospect-backups`.
- Create an **API token scoped to that bucket**, with object read and write. Not an account-wide token: scoping is what limits the damage if the box is lost.
- The endpoint is `https://<account-id>.r2.cloudflarestorage.com`.

Those give the four `BACKUP_S3_*` values. Nothing in the code is R2-specific – any S3-compatible bucket works, so this is one environment variable's worth of lock-in.

The upload is signed with SigV4, so the secret never leaves the process and what travels is a signature over that one request and its bytes. The predecessor design used a pre-authenticated URL that carried its own authority: simpler, but it *was* the credential, it expired on a date nobody would remember, and anyone who intercepted it could write to the bucket until it did.

## First deploy

1. **Render → New → Blueprint**, pointed at this repository. `render.yaml` describes the worker, the disk, and which variables are secrets, so the only manual step is pasting the seven values it prompts for.
2. Watch the first deploy log for `config ok`, `database ready`, `tracking N opportunities`. The app validates its whole configuration before it connects to anything, so a missing key is a failed boot rather than a silent afternoon.
3. Send the bot a link from Telegram. An acknowledgement within a second or two means the round trip works.

The container runs as `node` and the disk mounts at `/data`. If the first boot cannot write `prospect.db`, that is a mount ownership problem, not a configuration one.

## Deploy a change

`autoDeploy` is off, so a push does not become a deploy. Trigger it from the dashboard, or turn it on once you trust the suite.

A service with a disk cannot run two instances, so deploys stop the old one before starting the new one. Expect a few seconds of downtime. That is a property of the disk, not a misconfiguration – and for a bot that polls, nobody notices.

## Checking it is alive

Three signals, in increasing order of how long you have to wait:

- The Render dashboard says the service is live, not restarting.
- `node src/index.cjs --check` boots and exits, proving config and database.
- The Sunday digest. Its absence is the alarm; that is the whole reason it exists.

```sh
npm run digest        # print this week's digest without sending
```

## Backups

The nightly job copies the database off-box at 04:00 local. By hand:

```sh
npm run backup            # local copy + upload
npm run backup -- --local # local copy only
```

The last few copies also stay on the disk, so recovering from a bad write does not depend on the network.

To restore: stop the service, put a backup file at the disk's `prospect.db`, start it again.

**Do this once before you need it.** An untested backup is a hope. Pull a copy from R2, open it locally with `node src/index.cjs --check` against a `DB_PATH` pointing at it, and confirm the counts match what the digest last reported.

## Timezone

`TZ` is what the app resolves deadlines and schedules jobs against. The container's own clock stays UTC; that is deliberate – a deadline is stored as a UTC instant resolved with the zone in force at ingest, so changing `TZ` moves *when* reminders arrive without reinterpreting any date already approved.

## What this costs

| | |
| ---------------------- | ------------------------------- |
| Render worker, Starter | ~$7/month |
| Persistent disk, 1 GB  | $0.25/month |
| Cloudflare R2          | $0 – well inside the free 10 GB |

The bill that is real is Anthropic: measured ingests cost $0.03 to $1.84 each, and the weekly digest reports the running total. That is the number to watch, not the host.
