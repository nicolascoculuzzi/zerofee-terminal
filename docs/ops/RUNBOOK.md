# Operations runbook

Run everything as `deploy` on the server, from `/opt/zerofee/app`. `dc` is the alias for `deploy/scripts/dc`: `docker compose` with the production env file. First-time setup is in [DEPLOY.md](DEPLOY.md).

## Quick reference

| Task | Command |
|---|---|
| State of the stack | `dc ps` and `deploy/scripts/smoke.sh` |
| Logs | `dc logs -f --tail 200 server` (or `caddy`, `postgres`, `uptime-kuma`) |
| Metrics | `curl -s -H "Authorization: Bearer $(sed -n 's/^METRICS_TOKEN=//p' deploy/docker/.env.production)" http://127.0.0.1:8787/metrics` |
| Deploy | `deploy/scripts/deploy.sh v0.3.0` |
| Roll back | `deploy/scripts/rollback.sh` (previous) or `deploy/scripts/rollback.sh <sha12>` |
| Halt trading | `deploy/scripts/kill-switch.sh halt "<reason>"`, then `resume` (edge flag + the server's admin halt) |
| Maintenance page | `deploy/scripts/kill-switch.sh maintenance on "<reason>"`, then `off` |
| Kill-switch state | `deploy/scripts/kill-switch.sh status` |
| Admin API (audited) | `curl -s -H "Authorization: Bearer <ADMIN_TOKEN>" http://127.0.0.1:8787/api/admin/status` (also `/api/admin/audit`; host only, the edge answers 404) |
| Backup now | `deploy/backup/backup.sh` |
| Restore drill | `deploy/backup/restore-drill.sh --identity /dev/shm/zerofee-backup.key` |
| Audit trail | `/opt/zerofee/ops.log` (who flipped what), `/opt/zerofee/deploys.log` (every deploy and rollback) |
| Live debug view | `ssh -N -L 8787:127.0.0.1:8787 deploy@<server>`, then http://127.0.0.1:8787/debug |
| Uptime Kuma | `ssh -N -L 3001:127.0.0.1:3001 deploy@<server>`, then http://localhost:3001 |

## Alerts

| Alert | What it means | First move |
|---|---|---|
| Feed stall (Kuma), or health ping "feed stalled" | No transaction ingested for 30 s or more | [Feed outage](#feed-outage) |
| Blockhash stale | The blockhash streamed to browsers is 30 s old or more, so their transactions will start failing | [Feed outage](#feed-outage); halt trading if it persists |
| Health ping "container X is ..." | A service stopped or is restarting | `dc ps`, `dc logs --tail 100 X`, `dc up -d X` |
| Health ping "server healthcheck: unhealthy" | The server process doesn't answer HTTP | `dc logs --tail 200 server`; `dc restart server`; roll back if it started with a deploy |
| Health ping "root disk N% full" | Under 15 % free | `df -h`, `docker system df`, `du -sh /opt/zerofee/backups/*`. The SQLite database grows with `TRADES_RETENTION_HOURS` |
| `zerofee-health` down with no `/fail` ping | The host, its network or Docker is dead | Hetzner Console: status, VNC console, reboot. If the host is gone, [rebuild](#host-lost) |
| `zerofee-backup` failed or late | The nightly backup broke | `journalctl -u zerofee-backup -n 100` |
| `zerofee-drill` late | Nobody ran the monthly drill | [Restore drill](#restore-drill-monthly) |
| Certificate expiry (Kuma) | Caddy couldn't renew | `dc logs caddy \| grep -iE 'acme\|certificate'`: DNS, CAA, port 80 |
| DNS canary or DNSSEC | The domain no longer resolves to us, or validation broke | [DNS hijack](#dns-hijack-or-registrar-compromise) |
| Trading not halted (red) | `HALT_TX` is on. Intended during incidents; otherwise someone forgot | `deploy/scripts/kill-switch.sh status` |
| CT monitor: unexpected certificate | Someone got a certificate for our domain | [DNS hijack](#dns-hijack-or-registrar-compromise) |

## Deploy

1. Merge to `main` with CI green: tests, typecheck, lint, and the `deploy` job, which builds the image, boots it and validates compose and the Caddyfile.
2. Tag the release, signed: `git tag -s v0.3.0 -m "v0.3.0"`, then `git push origin v0.3.0`.
3. On the server: `deploy/scripts/deploy.sh v0.3.0`.

The script refuses a dirty checkout or an incomplete env file. It takes an encrypted copy of Postgres (`/opt/zerofee/backups/<time>-local`), builds the image and the web release, restarts what changed, waits for the healthcheck, switches the web release atomically, reloads Caddy and runs the smoke tests. If they fail, it rolls back on its own.

- **Downtime.** The server restart takes a few seconds. Caddy holds API requests for up to 5 s while it comes back, and WebSocket clients reconnect and resnapshot. Avoid deploying during a market frenzy.
- **Signed tags.** Set `REQUIRE_SIGNED_TAGS=true` in `.env.production` and import your signing key on the server (`gpg --import`, or `git config gpg.ssh.allowedSignersFile` for SSH signatures). The deploy then refuses unsigned tags.
- **Front-end integrity.** Every web release has a `SHA256SUMS`, also served at `https://<domain>/SHA256SUMS`. From a machine you trust, build the same tag and run `deploy/scripts/verify-frontend.sh https://<domain> <your SHA256SUMS>`. Matching hashes mean the server serves exactly what the tag builds.

## Rollback

```bash
deploy/scripts/rollback.sh
```

That goes to the previous deploy. For an older one, list the candidates (`tail /opt/zerofee/deploys.log`, `docker image ls zerofee-server`; the last 5 deploys are kept) and pass the sha: `deploy/scripts/rollback.sh <sha12>`. It retags the kept image, checks out its commit so the compose file and Caddyfile match, restarts and runs the smoke tests. It takes seconds and rebuilds nothing.

Data: the market-data SQLite schema only migrates forward and older builds ignore what they don't know. Once Postgres holds user state, a release that migrated Postgres may need its pre-deploy copy restored along with the rollback (see [restore](#restore-from-backup), "pre-deploy copy").

## Secret rotation

The pattern: create the new secret, put it in `deploy/docker/.env.production`, run `dc up -d` (it recreates only the services whose settings changed), check, then revoke the old one at the provider. Rotate everything at once after any suspected compromise. Otherwise rotate on any change of who has access, and once a year.

| Secret | How |
|---|---|
| `METRICS_TOKEN` | `openssl rand -hex 32`, edit, `dc up -d server`, then update the header of the three `/metrics` monitors in Uptime Kuma. The health ping reads the file directly. |
| `ADMIN_TOKEN` | `openssl rand -hex 32`, edit, `dc up -d server`. With named operators (`name:token,name:token`), rotate one entry at a time; the audit log records names, never tokens. |
| `CHANNEL_ENCRYPTION_KEY` | It encrypts stored Discord webhook URLs: a new key makes the stored ones unreadable, so users must add their Discord channels again. Rotate only if it leaked, then tell users. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | A new pair (`bun run --cwd apps/server vapid-keys` on a dev machine) invalidates every browser push subscription; users re-enable Web Push. Rotate only if the private key leaked. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` | `/revoke` in @BotFather for a new bot token; a new webhook secret also needs `setWebhook` again. Edit, `dc up -d server`. |
| `POSTGRES_PASSWORD` | The env value only applies when the database is first created. Change the role: `dc exec postgres psql -U zerofee -d zerofee`, then `\password zerofee`. Then edit the env file and run `dc up -d server` (it rebuilds `DATABASE_URL`). |
| Chainstack (`YELLOWSTONE_X_TOKEN`, `RPC_URL`, `RPC_WS_URL`) | New credentials in the Chainstack console, edit, `dc up -d server`, `deploy/scripts/smoke.sh` (feed flowing), delete the old credentials. |
| `HELIUS_SENDER_API_KEY`, `JITO_UUID` | Same pattern. |
| Backup key (age) | `age-keygen` on your laptop and set the new `BACKUP_AGE_RECIPIENT`. Keep the old private key until every backup encrypted to it has aged out (14 nightly + 6 monthly sets), then destroy it. |
| Storage Box / bucket credentials | A new SSH key (or access key) for the sub-account, `rclone config` to update the remote, `rclone lsd zerofee-backup:` to check, remove the old key. |
| Your SSH key | Add the new key to `~/.ssh/authorized_keys`, test it in a second session, remove the old one. |
| healthchecks.io ping URLs | Regenerate in its UI if leaked (low impact: someone could fake "OK" pings). |
| Uptime Kuma admin | Settings → Security. |

## Kill switch

From mildest to most drastic:

1. **Halt trading:** `deploy/scripts/kill-switch.sh halt "<reason>"`. It flips two layers at once:
   - **Edge:** Caddy answers POST /api/tx with 503 immediately, with no reload, and keeps doing so even if the server process is broken.
   - **Server:** the admin kill switch (`POST /api/admin/halt`, needs `ADMIN_TOKEN`). The server refuses every submission, survives restarts in the halted state, writes the change to its audit log, and pushes it to every client so the UI disables trading. It also covers what the server submits on its own (armed orders).

   Market data keeps flowing. Use it for venue interface drift, relay misbehavior, a suspected signer-firewall bypass, or anything odd in trade outcomes.
2. **Stop all sending, belt and braces:** set `DRY_RUN=true` in `.env.production`, then `dc up -d server`. POST /api/tx then only simulates. Use it if the admin halt failed (the script says so) or you no longer trust the server's own state.
3. **Maintenance mode:** `deploy/scripts/kill-switch.sh maintenance on "<reason>"`. The whole site, API and WebSocket included, answers 503 and tells browsers to drop cached files. Use it for a front-end compromise, a DNS incident or risky maintenance.
4. **Everything off:** `dc stop caddy server`.

`kill-switch.sh status` shows both layers, what the public edge answers and what the server's metrics report. Every flip is recorded in `/opt/zerofee/ops.log`, and the server-side ones also in the admin audit log (`/api/admin/audit`). Undo with `resume`, `maintenance off` or `DRY_RUN=false`. The "Trading not halted" monitor turns green again.

What no server-side switch can stop: transactions a user's browser sends straight to Helius Sender's browser endpoint (the fallback lane). Users have their own kill switch in the product: the Panic button cancels their armed orders and locks the keystore.

## pump.fun interface drift

pump.fun ships a breaking change every one to three months; the 2026-04-28 one broke every bot that missed it. The signals:

- the daily `pump-watch` workflow opens an issue titled "pump.fun interface changed";
- `zerofee_ingest_decode_failures_total` climbs;
- dry-run simulations or users' transactions start failing.

1. **Assess within the hour.** Read the issue's diff (IDLs, SDK versions) and the [pump-public-docs](https://github.com/pump-fun/pump-public-docs) changelog. About a week of devnet notice is typical.
2. **Halt if it's live and touches the builders.** If instruction layouts or account lists changed on mainnet, run `deploy/scripts/kill-switch.sh halt "pump interface change"`. Transactions would fail and burn fees, or the firewall refuses them (it fails closed, so funds stay safe). Market data usually survives, because the decoders read known leading fields and tolerate new trailing ones.
3. **Fix.** Update `packages/core/src/constants.ts` and the IDLs in `packages/core/idl`, the builders and the decoders. Update `packages/signer`'s embedded copy too: the CI cross-check test fails until both agree. Run `bun test` (golden tests against the official SDKs), then `bun run fork:start && bun run e2e`.
4. **Ship and verify.** Tag and deploy, then dry-run a buy and a sell with the CLI (`SIMULATE_AS=<address> bun run trade buy <mint> 0.01`).
5. **Resume:** `deploy/scripts/kill-switch.sh resume`. Watch decode failures and landing outcomes for an hour.
6. **Armed orders (Phase 5 on).** Orders pre-signed against the old interface are stranded. Notify the affected users to re-arm.
7. Write it down in `NOTES.md`.

## Feed outage

The signals: the feed-stall alert, `zerofee_source_up 0`, `zerofee_source_reconnects_total` rising, `zerofee_ingest_slot_lag` growing, a stale blockhash.

1. **Look.** Run `dc logs --tail 300 server | grep -iE 'yellowstone|reconnect|error|failed'` and the metrics: `zerofee_source_up`, `zerofee_source_last_message_age_seconds`, `zerofee_feed_silence_seconds`.
2. **Is it everyone?** Check the Chainstack status page and [status.solana.com](https://status.solana.com). If the chain itself halted, wait it out with trading halted.
3. **Is it us?** In the Chainstack console: plan limits, request units, the stream count (2 on Growth; is another process holding one?), expired credentials. Rotate the token if needed ([secrets](#secret-rotation)).
4. **Short gaps heal by themselves.** The server reconnects with backoff and resumes 8 slots before the last one it saw. Chainstack's replay buffer is about 100 slots (25–30 s). A longer gap leaves a hole in trades, candles and holder counts for that window; there is no backfill yet.
5. **Degraded fallback.** Set `INGEST_SOURCE=rpc` with Chainstack's own HTTPS/WSS endpoints in `RPC_URL`/`RPC_WS_URL` (never the public endpoint: it throttles the stream), then `dc up -d server`. logsSubscribe has no account keys, so holder metrics get coarser. Switch back when Yellowstone recovers.
6. **Stale blockhash** means browser-built transactions will fail: halt trading until `zerofee_blockhash_stale` is 0 again.
7. **Repeated outages** mean it's time for the SPEC's redundant feed (Shyft Build, $199).

## Front-end compromise

This is the main threat once keys live in browsers. Malicious JavaScript served from our origin can capture vault passwords and sign drains. The signals: a `verify-frontend.sh` mismatch, unknown files under `/opt/zerofee/web`, deploys you didn't make in `deploys.log` or `ops.log`, users reporting odd signing prompts or drained trading wallets.

**Contain (minutes):**

1. `deploy/scripts/kill-switch.sh maintenance on "front-end compromise"`. No more JavaScript is served, and browsers are told to drop cached files. Tabs already running bad code keep running until they reload, but they lose our API and WebSocket.
2. `deploy/scripts/kill-switch.sh halt "front-end compromise"`. It stays on after maintenance is lifted, until you're sure.
3. **Preserve evidence before changing anything.** Create a Hetzner snapshot of the server. Copy `/opt/zerofee/web`, `ops.log` and `deploys.log`, plus the output of `dc logs --no-color > logs.txt`, `docker image ls --digests`, `last` and `journalctl --since -7d`, to a safe place.

**Eradicate:**

4. **Find the way in.** The host (SSH keys, the deploy user, `ops.log`), the supply chain (diff the deployed tag's `bun.lock` against the previous release), CI, or DNS ([next section](#dns-hijack-or-registrar-compromise)).
5. **Rotate every secret** ([rotation](#secret-rotation)), from a clean machine.
6. **Rebuild instead of cleaning.** Provision a new server from cloud-init, deploy a known-good tag whose web hashes match an independent build of the same tag, and move DNS. Lift maintenance mode only then.

**Communicate:**

7. Announce on every official channel: don't unlock the vault or sign anything on the site until the all-clear. Anyone who unlocked or signed during the window should assume the trading wallet key is exposed. After the all-clear, create a fresh trading wallet and sweep what's left of the old one to the connected wallet.
8. Write a post-mortem, and publish the clean release's hashes.

Never send `Clear-Site-Data: "storage"`. It would wipe every user's encrypted vault (and their trading wallet, if they skipped the backup).

## DNS hijack or registrar compromise

The signals: the DNS canary or DNSSEC monitor, a CT alert for a certificate you didn't request, users reporting a different-looking site or certificate warnings, registrar e-mails about changes. Maintenance mode does nothing here, because the traffic isn't reaching us.

1. **Confirm.** Compare with the server's IPs: `dig +short A app.example.com @1.1.1.1`, `dig +short A app.example.com @8.8.8.8`, `dig NS example.com`, `dig +dnssec app.example.com`.
2. **Warn users right away**, on every official channel: don't open the site, connect a wallet or sign anything until the all-clear.
3. **Take the domain back** from a clean device: log in to the registrar and restore the nameservers and records. Rotate the registrar password and 2FA (hardware key), check the account's e-mail and recovery settings, and confirm registrar lock, plus registry lock if you have it. Ask the registrar's support or abuse team to freeze changes.
4. **Certificates.** List what was issued at [crt.sh](https://crt.sh/?q=%25.example.com). Report every certificate you didn't request to its CA for revocation, using the problem-report contact in that CA's CPS.
5. **Wait out the TTLs.** Resolvers keep the bad answer until its TTL expires, and attackers set long ones. Keep the warning up for that long.
6. **Treat anyone who used the hijacked site as exposed**, as in a [front-end compromise](#front-end-compromise), step 7.
7. **Harden.** Registry lock, DNSSEC, CAA (add `accounturi=<Caddy's ACME account URL>` to pin issuance to our account), HSTS preload, and a registrar account used for nothing else.

## Restore from backup

### Restore drill (monthly)

The drill proves the newest backup actually restores, and touches nothing in production. Copy the key into memory on the server, run the drill, delete the key:

```bash
scp zerofee-backup.key deploy@<server>:/dev/shm/
ssh deploy@<server>
cd /opt/zerofee/app
deploy/backup/restore-drill.sh --identity /dev/shm/zerofee-backup.key
shred -u /dev/shm/zerofee-backup.key
```

It downloads the set, checks its hashes, decrypts it, restores Postgres into a throwaway container with no network and integrity-checks the SQLite snapshot. It then pings `zerofee-drill`, and warns if the newest set is more than 36 h old. It also runs on a laptop with Docker, rclone (same remote), age and zstd: add `--remote zerofee-backup:zerofee`.

### Restore on the same host

```bash
deploy/backup/restore.sh --identity /dev/shm/zerofee-backup.key --from latest --yes
```

Add `--only postgres` or `--only sqlite` to restore one of them, or `--from <set>` for an older set (`rclone lsf zerofee-backup:zerofee`). Before replacing anything the script halts trading, keeps an encrypted dump of the current Postgres database (`/opt/zerofee/backups/restore-<time>/`), and renames the current SQLite files to `*.pre-restore-<time>` instead of deleting them. It then restarts the server and waits for its healthcheck. A restored Postgres brings back its own admin audit log, which decides the server-side halt state after the restart; the edge halt stays on either way until you resume. Afterwards:

1. `deploy/scripts/smoke.sh`, plus a look at the data.
2. `deploy/scripts/kill-switch.sh resume`.
3. Once you're happy, delete the renamed SQLite files: `dc run --rm --no-deps --entrypoint sh server -c 'rm -v /data/*.pre-restore-*'`.

Market data is optional to restore. The server rebuilds live state from the feed; a restore brings back chart history and the token registry.

**From a pre-deploy copy** (Postgres only; `deploy.sh` keeps the last two in `/opt/zerofee/backups/*-local`):

```bash
deploy/scripts/kill-switch.sh halt "restore pre-deploy copy"
dc stop server
dc exec -T postgres psql -U zerofee -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS zerofee WITH (FORCE)" -c "CREATE DATABASE zerofee OWNER zerofee"
age -d -i /dev/shm/zerofee-backup.key /opt/zerofee/backups/<time>-local/postgres.dump.age | dc exec -T postgres pg_restore -U zerofee -d zerofee --no-owner --exit-on-error
dc up -d server
```

### Host lost

1. Provision a new server ([deploy/hetzner/README.md](../../deploy/hetzner/README.md)) and point DNS at its new addresses.
2. Restore `deploy/docker/.env.production` from your password manager, set up the rclone remote again ([DEPLOY.md](DEPLOY.md#5-configure-the-server) step 5) and run `sudo deploy/hetzner/install-units.sh`.
3. `deploy/scripts/deploy.sh <last good tag>`.
4. `deploy/backup/restore.sh --identity /dev/shm/zerofee-backup.key --from latest --yes`.

## Routine maintenance

**Weekly**

- Read the `zerofee-health` ping body on healthchecks.io: it notes "reboot required" after kernel updates. Unattended upgrades never reboot on their own. Pick a quiet hour and run `sudo reboot`. Containers come back by themselves (`restart: unless-stopped`); then run `deploy/scripts/smoke.sh`.
- Skim the alert history.

**Monthly**

- [Restore drill](#restore-drill-monthly).
- Docker engine update. `live-restore` keeps the containers running through it:

  ```bash
  sudo apt-get update
  sudo apt-get install --only-upgrade docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  ```

- Postgres minor release: `dc pull postgres && dc up -d postgres`.
- Pinned images (Bun base, Caddy, Uptime Kuma): check for new releases, then bump tag and digest together in a pull request so CI validates them. The image digest comes from Docker Hub or `docker buildx imagetools inspect <image>:<tag>`.
- `docker system df`, and `du -sh /opt/zerofee/backups`.
- Review `/opt/zerofee/ops.log` and `deploys.log`.

**Quarterly**

- Rotate `METRICS_TOKEN`. Review who holds SSH keys, registrar access, and provider accounts.
- Test every alert path end to end: stop the server for two minutes.

**Postgres major upgrade** (never just a tag bump: the data directory is version-specific):

1. Run a backup.
2. Halt trading and stop the server.
3. Dump everything: `dc exec -T postgres pg_dumpall -U zerofee | age -r <recipient> > all.sql.age`.
4. Change the image in `docker-compose.yml`.
5. Remove the old container and volume (`dc stop postgres`, `dc rm -f postgres`, `docker volume rm zerofee_postgres-data`) and start the new major with `dc up -d postgres`.
6. Restore: `age -d -i <key> all.sql.age | dc exec -T postgres psql -U zerofee -d postgres`.
7. Start the server, run the smoke tests, resume trading.
