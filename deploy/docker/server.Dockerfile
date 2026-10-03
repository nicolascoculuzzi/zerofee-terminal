# syntax=docker/dockerfile:1
#
# zerofee-terminal server (apps/server): WebSocket/REST gateway, ingest, SQLite market data.
#
#   docker build --platform linux/amd64 -f deploy/docker/server.Dockerfile -t zerofee-server .
#
# The build context is the repo root, filtered by server.Dockerfile.dockerignore.
#
# linux/amd64 only. The Yellowstone gRPC client ships native bindings for linux-x64 but not for
# linux-arm64, and the server imports it at start-up, so this image cannot run on ARM hosts
# (Hetzner CAX).
#
# Runtime contract: uid 10001, read-only root filesystem. It needs a writable /data (SQLite) and
# /tmp. /backups (nightly SQLite snapshots) and /flags (kill-switch flags, read-only) are optional.

# oven/bun 1.3.14 on Debian slim, pinned by its multi-arch index digest. Bump the tag and the digest
# together, and keep them in step with bun-version in .github/workflows/ci.yml.
ARG BUN_IMAGE=oven/bun:1.3.14-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04

# Collect every workspace manifest. `bun install --frozen-lockfile` refuses a partial workspace, and
# copying only manifests means the install layer rebuilds only when a manifest or the lockfile changes.
FROM --platform=linux/amd64 ${BUN_IMAGE} AS manifests
WORKDIR /src
COPY . .
RUN mkdir -p /out \
 && cp package.json bun.lock /out/ \
 && find apps packages -mindepth 2 -maxdepth 2 -name package.json -exec cp --parents {} /out/ \;

# Production dependencies of @zerofee/server and its workspace packages, exactly as locked.
FROM --platform=linux/amd64 ${BUN_IMAGE} AS deps
WORKDIR /app
COPY --from=manifests /out/ ./
RUN bun install --frozen-lockfile --production --filter @zerofee/server

FROM --platform=linux/amd64 ${BUN_IMAGE}
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.title="zerofee-server" \
      org.opencontainers.image.description="zerofee-terminal gateway, ingest and market-data server" \
      org.opencontainers.image.revision="${GIT_SHA}"
ENV NODE_ENV=production \
    HOME=/tmp \
    BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
    SERVER_HOST=0.0.0.0 \
    SERVER_PORT=8787 \
    DB_PATH=/data/market.db \
    ZEROFEE_GIT_SHA=${GIT_SHA}
# A dedicated high uid, so it never matches a host user (the host's deploy user is 1000, like the
# image's own `bun` user).
RUN groupadd --system --gid 10001 zerofee \
 && useradd --system --uid 10001 --gid 10001 --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin zerofee \
 && mkdir -p /data /backups \
 && chown 10001:10001 /data /backups \
 && chmod 0750 /data /backups
WORKDIR /app
# Code stays root-owned and read-only for the server process.
COPY --from=deps /app/ ./
COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/server/ apps/server/
COPY deploy/backup/sqlite-snapshot.ts deploy/backup/sqlite-snapshot.ts
USER 10001:10001
EXPOSE 8787
STOPSIGNAL SIGTERM
# Liveness only (the HTTP server answers). Feed health is monitored separately through /metrics, so a
# provider outage doesn't mark the container unhealthy.
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 \
  CMD ["bun", "-e", "const r = await fetch(`http://127.0.0.1:${process.env.SERVER_PORT || 8787}/api/health`); process.exit(r.ok ? 0 : 1)"]
CMD ["bun", "apps/server/src/main.ts"]
