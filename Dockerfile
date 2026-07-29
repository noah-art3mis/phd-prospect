# One container, built from this file, run by Compose. No build pipeline: the deploy is pull,
# build, restart.
#
# Node 22 is the floor because the app uses node:sqlite, which lands the SQLite backup API
# without a native dependency to compile on a small shared-core instance. The base image is
# multi-arch, so this builds unchanged on the Ampere ARM cores Oracle gives away.
FROM node:22-slim

# Long polling means nothing dials in, so the container needs no ports and no reverse proxy –
# but it does need CA certificates to dial out to Telegram, Anthropic and object storage.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, so a code change does not re-resolve the tree.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY src ./src
COPY prompts ./prompts
COPY seed ./seed
COPY tools ./tools

# Never root: the process only needs to read its own code and write one directory, which the
# bind mount grants.
USER node

# Fails the container if the configuration is incomplete or the database will not open, so a
# bad deploy shows up as a container that will not start rather than as silence.
HEALTHCHECK --interval=5m --timeout=30s --start-period=30s --retries=3 \
    CMD ["node", "src/index.cjs", "--check"]

CMD ["node", "src/index.cjs"]
