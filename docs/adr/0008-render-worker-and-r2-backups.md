# ADR-0008: A Render worker with a disk, and backups to a different vendor

The app runs as a Render background worker built from this repo's Dockerfile, with a persistent disk at `/data`, described by `render.yaml`. The nightly backup is a SigV4-signed PUT to Cloudflare R2. This replaces the Oracle Cloud "Always Free" VM and the Oracle Object Storage pre-authenticated URL that SPEC.md previously recorded.

## Considered options

**The Oracle Always Free VM.** Genuinely free, includes the external IP that made GCP cost $44/year, and it ran the same `compose.yaml` this repo still carries. Rejected after building it: provisioning is a VCN wizard, a subnet radio that greys out the public-IP checkbox, and a capacity lottery on the ARM shape — and Oracle reclaims Always Free compute it judges idle, without warning, which for a bot whose only activity is an idle long poll is not a comfortable bet. Free was not worth the afternoon or the reclaim risk. The image is unchanged, so this is reversible.

**A plain VPS (Hetzner, RackNerd, IONOS).** Cheaper than Render — a dollar a month at the low end — and runs `docker compose up -d` unchanged. Rejected for now on chores rather than cost: OS patching, SSH hardening, log rotation, and a disk that fills at 3am. Revive when the platform's constraints start costing more than the chores would, or as a deliberate exercise: a VPS is the only place the destroy-and-rebuild drill can actually be practised.

**Heroku, Render's free tier, Railway.** Rejected on shape, not price. Heroku's filesystem is ephemeral and dynos restart daily, so a SQLite file evaporates nightly; Render's free tier has no workers and spins down after idle time, which loses both the long poll and the 09:00 sweep; Railway's metered billing makes the cost of an always-on process hard to predict.

**Fly.io.** The closest competitor — cheaper, volumes, a region near Mexico. Rejected because its machines-and-volumes model is idiosyncratic enough that the habits learned there transfer less to the platforms these projects' siblings will run on.

**Keeping the pre-authenticated URL, with the bucket at Oracle and compute at Render.** Tempting, because it needs no signing code at all. Rejected: it keeps an account whose console we left, and the URL *is* the credential — it grants writes to whoever holds it until an expiry date nobody is reminded of, and an intercepted request can be replayed.

## Consequences

- **The disk is what makes SQLite viable here.** It also fixes the service at one instance and disables zero-downtime deploys, since two instances cannot share it. A polling bot does not notice the few seconds.
- **Scheduled work stays inside the process.** Render cron jobs cannot mount a disk, so the reminder sweep, the nightly backup and the weekly digest keep running on the app's own scheduler — which is where they already were, and which keeps them testable in-process.
- **Backups are signed, so the secret never leaves the process.** `aws4fetch` (about 4 KB) rather than the AWS SDK: one algorithm, no client lifecycle, no credential-file discovery. Four config keys replace one, and two of them are secrets held non-enumerably like the API keys.
- **Compute and backups are deliberately at different vendors.** The previous arrangement recorded an accepted risk — one tenancy held both the instance and its backups, so a billing problem took both. That risk is now dissolved rather than tolerated, and putting the bucket back beside the host would quietly reintroduce it.
- **Nothing R2-specific enters the code.** Any S3-compatible bucket works; the coupling is an endpoint in an environment variable.
- **Lock-in stays a Dockerfile and seven variables.** `compose.yaml` is kept and still current: it is how the app runs locally, and it is the exit — moving to a VPS is `git clone && docker compose up -d`, not a port.
- **The restore has still never been performed.** The backup path is asserted against a stub, and the signature is asserted offline, but no real bucket has ever accepted or rejected one. Prove it before trusting it.
