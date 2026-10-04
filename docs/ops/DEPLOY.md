# Deploying zerofee-terminal

One server runs everything at 100 users, and one command deploys it. This page covers what to buy, then the first deploy end to end. Day-to-day operations and incidents are in [RUNBOOK.md](RUNBOOK.md).

```
Internet ── 80/443 ──> Caddy (TLS, static web build, security headers, kill switches)
                         ├─ /api/*, /ws ──> server  127.0.0.1:8787 (Bun: gateway, ingest, SQLite)
                         │                    ├─> Chainstack Yellowstone gRPC + RPC
                         │                    ├─> Helius Sender, Jito (trade landing)
                         │                    └─> Postgres (internal network only)
                         └─ everything else ──> /opt/zerofee/web/current (the Vite build)
Uptime Kuma (127.0.0.1:3001, reached over SSH) ── polls /metrics every 20 s, alerts you
Host timers: nightly encrypted backup ──> Storage Box / S3;  health ping every minute ──> healthchecks.io
```

The pieces live in [`deploy/`](../../deploy): the image ([`server.Dockerfile`](../../deploy/docker/server.Dockerfile)), the stack ([`docker-compose.yml`](../../deploy/docker/docker-compose.yml) and [`Caddyfile`](../../deploy/docker/Caddyfile)), host bootstrap ([`hetzner/`](../../deploy/hetzner)), [backups](../../deploy/backup), the [health ping](../../deploy/monitoring/health-ping.sh) and the [ops scripts](../../deploy/scripts).

## 1. Buy and sign up

| What | Why | Plan | Monthly cost |
|---|---|---|---|
| [Hetzner Cloud](https://www.hetzner.com/cloud) | The server | CCX33 (8 dedicated vCPU, 32 GB, x86) in Falkenstein (FSN1) | €138.49 (about $155)¹ |
| [Chainstack](https://chainstack.com) | Market-data stream and RPC reads | Growth ($49) + Yellowstone gRPC add-on with 2 streams ($49) | $98 |
| [Helius](https://www.helius.dev) | Transaction landing (Sender) | Free tier: Sender works on it, with no credits used | $0, then $49 (Developer) around 1,000 users |
| A domain registrar | The one canonical domain | Must offer registrar lock, DNSSEC and hardware-key 2FA; registry lock if available | not in the report: a .com is roughly $10–20 a year |
| Off-site backup storage | Encrypted nightly backups | A Hetzner Storage Box (BX11, 1 TB), or any S3-compatible bucket | not in the report: a few euros; check the current price |
| [healthchecks.io](https://healthchecks.io) | Alerts that still fire when the whole server is dead | Free Hobbyist plan (20 checks) | $0 |
| Uptime Kuma | Alerting with 20-second checks | Self-hosted in the stack | $0 |

¹ Price after Hetzner's 15 June 2026 increase, from the [research report](../reports/Solana%20trading%20terminal%20teardown.md#the-cheapest-viable-stack-costs-about-330-to-2400-a-month). The order page also adds a small fee for the primary IPv4 address and lists the included traffic. Check both at checkout: the report has neither.

**Total today: about $253 a month** (Hetzner + Chainstack), plus the domain and backup storage. The report's ~$330 at 100 users also includes twitterapi.io for the X tracker ($79), which isn't needed until Phase 8.

What to set up at each provider:

- **Chainstack.** Create a Solana mainnet node on the Growth plan in an EU region (Frankfurt is next door to Falkenstein), then add Yellowstone gRPC. Note four values: the gRPC endpoint, its x-token, and the node's HTTPS and WSS endpoints. If Chainstack offers password-protected endpoints (`https://user:pass@host`), use those: the server redacts that form in its logs but prints a key that sits in the URL path. In week one, run the capacity check from the SPEC: count gRPC messages against the throughput estimates.
- **Helius.** An account is enough for Sender. Before launch, ask for limits above the default 50 TPS (SPEC, Phase 9). `HELIUS_SENDER_API_KEY` is only for accounts approved for higher limits.
- **Jito.** No account needed. A UUID (`JITO_UUID`) raises rate limits; request one before launch.
- **Registrar.** Turn on 2FA with a hardware key, registrar lock (transfer lock) and DNSSEC. Registry lock (changes need out-of-band confirmation with the registry) is the strongest defense against a DNS hijack (BONK.fun lost $30K to one in March 2026). Fewer registrars offer it, sometimes for a fee; it's worth it for a site where the front end is the vault.
- **Storage Box.** Order one in Germany. Enable SSH key login, create a sub-account restricted to one directory for the server, and **turn on automatic snapshots**. The server can delete files over SFTP but not snapshots, so a compromised server can't destroy your backup history.
- **healthchecks.io.** Create three checks and connect e-mail plus Telegram, Discord or Slack:

  | Check | Period | Grace | Fed by |
  |---|---|---|---|
  | `zerofee-health` | 1 minute | 2 minutes | `deploy/monitoring/health-ping.sh`, every minute |
  | `zerofee-backup` | 1 day | 2 hours | `deploy/backup/backup.sh`, nightly |
  | `zerofee-drill` | 35 days | 3 days | `deploy/backup/restore-drill.sh`, monthly by hand |

## 2. Values you will need

Everything goes into `deploy/docker/.env.production` on the server ([template](../../deploy/docker/.env.production.example)). Keep a copy in your password manager: rebuilding a lost server starts from it.

| Variable | Where it comes from |
|---|---|
| `APP_DOMAIN`, `ACME_EMAIL` | Your domain, e.g. `app.example.com`, and the e-mail for Let's Encrypt notices |
| `POSTGRES_PASSWORD`, `METRICS_TOKEN` | Generate each: `openssl rand -hex 32` |
| `YELLOWSTONE_ENDPOINT`, `YELLOWSTONE_X_TOKEN` | Chainstack, Yellowstone gRPC add-on |
| `RPC_URL`, `RPC_WS_URL` | Chainstack node, HTTPS and WSS endpoints |
| `BACKUP_REMOTE` | The rclone remote you create in step 5, e.g. `zerofee-backup:zerofee` |
| `BACKUP_AGE_RECIPIENT` | The public key from `age-keygen` (step 5) |
| `HC_HEALTH_URL`, `HC_BACKUP_URL`, `HC_DRILL_URL` | The three healthchecks.io ping URLs |
| `HELIUS_SENDER_API_KEY`, `JITO_UUID` | Optional, once granted |

## 3. Provision the server

Follow [deploy/hetzner/README.md](../../deploy/hetzner/README.md): SSH key, Cloud Firewall, CCX33 with the cloud-init file, the checks, cloning the repo to `/opt/zerofee/app`, installing the timers. Then come back here.

## 4. DNS

At your DNS host (often the registrar), using the server's addresses:

| Name | Type | Value | Notes |
|---|---|---|---|
| `app.example.com` | A | server IPv4 | TTL 300 for the first days, then 3600 |
| `app.example.com` | AAAA | server IPv6 | |
| `example.com` | CAA | `0 issue "letsencrypt.org"` | Only Let's Encrypt may issue certificates. Add `0 issue "sectigo.com"` too if you want Caddy's ZeroSSL fallback. |
| `example.com` | CAA | `0 issuewild ";"` | No wildcard certificates at all |
| `example.com` | CAA | `0 iodef "mailto:you@example.com"` | Where CAs report refused requests |

Turn on DNSSEC and check it at [dnsviz.net](https://dnsviz.net). Check the records from outside:

```bash
dig +short A app.example.com @1.1.1.1
dig +short AAAA app.example.com @8.8.8.8
```

The signer origin (`signer.example.com`) gets its own A/AAAA records later, when the signer build exists (see the bottom of the Caddyfile).

## 5. Configure the server

As `deploy` on the server:

```bash
cd /opt/zerofee/app
cp deploy/docker/.env.production.example deploy/docker/.env.production
chmod 600 deploy/docker/.env.production
openssl rand -hex 32
openssl rand -hex 32
nano deploy/docker/.env.production
```

The two random values are `POSTGRES_PASSWORD` and `METRICS_TOKEN`. Fill in everything from step 2. Keep `DRY_RUN=true` until the go-live checklist at the end.

**Backup encryption key.** Make it on your laptop, never on the server:

```bash
age-keygen -o zerofee-backup.key
```

It prints `Public key: age1...`. That goes into `BACKUP_AGE_RECIPIENT`. Store `zerofee-backup.key` in your password manager, plus an offline copy such as a USB stick in a drawer. The server can only encrypt. Without this file nobody can read the backups, including you.

**Backup storage (rclone).** For a Storage Box, give the server its own SSH key and install it on the box (Hetzner's `install-ssh-key` command):

```bash
ssh-keygen -t ed25519 -N '' -C zerofee-1-backup -f ~/.ssh/storagebox
cat ~/.ssh/storagebox.pub | ssh -p 23 uXXXXXX-sub1@uXXXXXX.your-storagebox.de install-ssh-key
rclone config create zerofee-backup sftp host=uXXXXXX.your-storagebox.de port=23 user=uXXXXXX-sub1 key_file=/home/deploy/.ssh/storagebox
rclone mkdir zerofee-backup:zerofee
rclone lsd zerofee-backup:
```

For an S3-compatible bucket, run `rclone config` and choose `s3` (provider, endpoint, access key, secret key) instead. Either way the remote is called `zerofee-backup` and `BACKUP_REMOTE=zerofee-backup:zerofee`.

## 6. First deploy and TLS

Deploy a tag, or a commit while there are no tags yet:

```bash
cd /opt/zerofee/app
deploy/scripts/deploy.sh v0.2.0
```

[`deploy.sh`](../../deploy/scripts/deploy.sh) checks the env file, builds `zerofee-server:<sha>` (and the web release once `apps/web` exists), starts the stack, waits for the server's healthcheck, reloads Caddy and runs the smoke tests. On later deploys it also rolls back by itself if the smoke tests fail.

**TLS is automatic.** On first start Caddy requests certificates from Let's Encrypt, then renews them, staples OCSP and redirects HTTP to HTTPS. This needs DNS already pointing at the server and ports 80 and 443 open. Watch it happen:

```bash
dc logs -f caddy
```

Look for `certificate obtained successfully`. If issuance fails, the cause is almost always DNS that hasn't propagated, a CAA record that excludes Let's Encrypt, or the Cloud Firewall missing port 80. Caddy retries with backoff on its own; Let's Encrypt limits failed attempts per hostname per hour, so fix the cause before restarting anything.

**First boot of the server:**

```bash
dc logs -f server
```

You should see `listening on http://0.0.0.0:8787` and, within seconds, launches and trades. `dc` is the alias for [`deploy/scripts/dc`](../../deploy/scripts/dc): `docker compose` with the production env file. On a big SQLite database the server first replays recent trades, which can take a minute or two; the healthcheck allows three.

## 7. Smoke tests

The deploy runs [`smoke.sh`](../../deploy/scripts/smoke.sh): the API over TLS through Caddy, every security header, CSP strength, `/metrics` closed to the internet but open on the host, and the front end against its hash manifest. Run it any time:

```bash
deploy/scripts/smoke.sh
```

Then from your laptop:

```bash
curl -sSI https://app.example.com/ | grep -iE '^(strict-transport|content-security|x-frame|referrer|permissions|cross-origin)'
curl -s https://app.example.com/api/health | jq '{ok, dryRun, version, connected: [.sources[].connected]}'
```

Check the WebSocket with Bun (no extra tools):

```bash
bun -e 'const ws = new WebSocket("wss://app.example.com/ws"); ws.onopen = () => ws.send(JSON.stringify({ type: "subscribe", topic: "chain" })); ws.onmessage = (e) => { console.log(String(e.data).slice(0, 300)); process.exit(0); }'
```

- Scan the site with [SSL Labs](https://www.ssllabs.com/ssltest/) (expect A+) and the [Mozilla HTTP Observatory](https://developer.mozilla.org/en-US/observatory).
- Open the site with the browser console open. There should be no CSP violations. Trusted Types messages are expected: that policy is report-only until it's promoted.
- The live debug view stays private. Reach it through an SSH tunnel with `ssh -N -L 8787:127.0.0.1:8787 deploy@<server-ip>`, then open http://127.0.0.1:8787/debug.
- Rehearse the kill switch once: `deploy/scripts/kill-switch.sh halt "drill"` (status shows `/api/tx -> 503`), then `deploy/scripts/kill-switch.sh resume`.

## 8. Alerts

**healthchecks.io.** With the three URLs in `.env.production`:

```bash
sudo systemctl start zerofee-health.service
journalctl -u zerofee-health -n 5
```

The `zerofee-health` check turns green within a minute. It goes red on a stalled feed, a stale blockhash, a stopped container or a disk above 85 %, and when the server itself is gone.

**Uptime Kuma.** Open a tunnel, then browse to http://localhost:3001:

```bash
ssh -N -L 3001:127.0.0.1:3001 deploy@<server-ip>
```

Create the admin account (long random password; turn on 2FA under Settings → Security), add a notification (Telegram bot, Discord webhook or SMTP), then these monitors. The `/metrics` ones need the header `{"Authorization": "Bearer <METRICS_TOKEN>"}`:

| Monitor | Type | URL | Keyword | Interval |
|---|---|---|---|---|
| Feed stall | HTTP(s) - Keyword | `http://server:8787/metrics` | `zerofee_feed_stalled 0` | 20 s, 0 retries |
| Blockhash | HTTP(s) - Keyword | `http://server:8787/metrics` | `zerofee_blockhash_stale 0` | 20 s, 1 retry |
| Trading not halted | HTTP(s) - Keyword | `http://server:8787/metrics` | `zerofee_halted{scope="tx"} 0` | 60 s (red while halted, as a reminder) |
| API | HTTP(s) - Keyword | `https://app.example.com/api/health` | `"ok":true` | 60 s |
| Site and certificate | HTTP(s) | `https://app.example.com/` | | 60 s, certificate expiry notification on |
| DNS canary | HTTP(s) - Keyword | `https://dns.google/resolve?name=app.example.com&type=A` | `"data":"<server IPv4>"` | 5 min |
| DNSSEC | HTTP(s) - Keyword | same URL | `"AD":true` | 1 h |

`zerofee_feed_stalled` turns 1 when no transaction has been ingested for 30 seconds (`METRICS_FEED_STALL_SEC`). With 20-second polling you hear about a dead feed within about 50 seconds. Every other metric is described in [`apps/server/src/metrics.ts`](../../apps/server/src/metrics.ts); any Prometheus can scrape `http://server:8787/metrics` with the same bearer token.

**Certificate Transparency.** Sign up for a free CT monitor such as [Cert Spotter](https://sslmate.com/certspotter/). It e-mails you about every certificate issued for your domain. One you didn't request means DNS hijack or mis-issuance ([RUNBOOK](RUNBOOK.md#dns-hijack-or-registrar-compromise)).

## 9. Backups

Run the first backup by hand and look at the result:

```bash
deploy/backup/backup.sh
rclone ls zerofee-backup:zerofee | head
```

From then on it runs nightly at 03:30 UTC. Do the first [restore drill](RUNBOOK.md#restore-drill-monthly) now and put the next one in your calendar every month.

## 10. Before going live

`DRY_RUN=true` keeps POST /api/tx in simulate-only mode. Turn it off only when all of this is done ([SPEC](../../SPEC.md), Phase 9):

- [ ] The signer runs on its own origin (iframe + `postMessage` origin checks): a launch blocker. Enable the commented signer block in the Caddyfile.
- [ ] SIWS sessions are wired in, so POST /api/tx refuses anonymous senders. Keep `ALLOW_ANONYMOUS_TX=false`.
- [ ] The web build ships Subresource Integrity attributes, and each release's hashes are published (`/SHA256SUMS` plus the git tag).
- [ ] Relay limits are in writing: Helius Sender above 50 TPS, a Jito UUID.
- [ ] You have read each data provider's terms on serving many users from one plan.
- [ ] Legal review: terms of service, risk disclosures, sanctions screening and geo-blocking.
- [ ] One backup and one restore drill have succeeded. Every alert path is tested: stop the server for two minutes and confirm healthchecks.io and Uptime Kuma both alert.
- [ ] Registrar lock, DNSSEC and CAA are in place. After a week of clean HTTPS, submit the domain at [hstspreload.org](https://hstspreload.org): the HSTS header already asks for preload.

Then set `DRY_RUN=false` in `.env.production` and recreate the server:

```bash
dc up -d server
curl -s -H "Authorization: Bearer $(sed -n 's/^METRICS_TOKEN=//p' deploy/docker/.env.production)" http://127.0.0.1:8787/metrics | grep '^zerofee_dry_run'
```

It must print `zerofee_dry_run 0`.
