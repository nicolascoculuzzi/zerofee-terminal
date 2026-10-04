# zerofee-terminal

An Axiom-style Solana memecoin trading terminal with **zero platform fees**. You keep your keys.

- **Log in with your wallet.** Sign one message with Phantom, Solflare or Backpack. No email or password.
- **Trade instantly.** A trading wallet is created and encrypted in your browser, and it signs trades with no popup. Your keys never touch our servers.
- **All the terminal features:** a three-column live token feed with filters, one-click and hotkey trading, limit/TP/SL and migration orders that keep running with the tab closed, wallet and X trackers, copy trading, PnL.
- **MEV protection on by default,** sent through routes where it actually applies.

**What you still pay:** what the chain charges. That's venue fees (pump.fun takes 1.25% per side on the bonding curve; no terminal can remove it), network fees and tips (usually tiny), and refundable rent. Other terminals add 0.75–1% on every buy and sell on top of that.

## Status

Early build. Phase 1, the trade engine, works in dry-run: pump.fun bonding-curve, PumpSwap, Raydium LaunchLab (the curves behind BONK.fun, StonkFun and TRiX) and Raydium CPMM (where LaunchLab coins graduate) buys and sells, built locally and simulated against mainnet, with fills matching our quotes exactly. Phase 2, the market data feed, decodes every pump.fun and PumpSwap launch, trade and migration, derives token metrics, and streams them over a WebSocket gateway. The backend also has wallet sign-in, per-user settings, the wallet tracker, server-side price alerts with Web Push / Telegram / Discord delivery, and an admin kill switch. The web UI is next. See [SPEC.md](SPEC.md) for the full plan, feature checklist and phases.

## Quick start (developers)

Requires [Bun](https://bun.sh) 1.3+.

```bash
bun install
```

```bash
bun test
```

```bash
cp .env.example .env
```

Dry-run a trade. This builds and simulates against mainnet and **never sends** while `DRY_RUN=true`, which is the default. `SIMULATE_AS` lets you simulate as any address that holds SOL, with no key needed:

```bash
SIMULATE_AS=<address-with-SOL> bun run trade buy <mint> 0.01
```

```bash
SIMULATE_AS=<address-holding-the-token> bun run trade sell <mint> 50
```

**Sending real trades:** put a throwaway dev wallet's key in `.env` (`WALLET_PRIVATE_KEY`), keep only what you'd lose on it, and set `DRY_RUN=false`. `MAX_BUY_SOL` and `MAX_DAILY_SPEND_SOL` are hard caps. Latency measurements go in [NOTES.md](NOTES.md).

Run the market data server (Phase 2). By default it reads the public RPC's `logsSubscribe` stream, binds to 127.0.0.1 and keeps `POST /api/tx` in simulate-only mode (`DRY_RUN=true`):

```bash
bun apps/server/src/main.ts
```

Then open http://127.0.0.1:8787/debug for live launches and trades with detection latency, or connect to `ws://127.0.0.1:8787/ws` (protocol in [packages/protocol](packages/protocol/src/messages.ts)). To watch the feed alone, printing launches and per-minute counts:

```bash
bun run --cwd apps/server feed
```

For production set `INGEST_SOURCE=yellowstone` with `YELLOWSTONE_ENDPOINT` and `YELLOWSTONE_X_TOKEN`. All server settings are in [.env.example](.env.example).

### Accounts, settings and alerts (server)

The same server handles wallet sign-in (Sign-In With Solana), per-user settings, the wallet tracker and off-app alerts. User state goes to Postgres when `DATABASE_URL` is set; without it the server keeps it in PGlite, an in-process Postgres stored in `data/pglite` (development only). The REST and WebSocket contract is in [packages/protocol](packages/protocol/src/user.ts).

- **Sessions.** A successful sign-in sets the `__Host-zf_session` cookie (HttpOnly, Secure, SameSite=Strict); only its SHA-256 is stored. Requests that carry the cookie and change something must come from `PUBLIC_ORIGIN` or `ALLOWED_ORIGINS` (CSRF check).
- **Local development over http.** Browsers treat `http://127.0.0.1` and `http://localhost` as secure contexts, so Chromium and Firefox keep the Secure cookie over plain http there. Other plain-http hosts can't hold the session, and the server refuses to start with one. With a Vite dev server, proxy `/api` and `/ws` to the backend and set `PUBLIC_ORIGIN` to the Vite origin.
- **Try sign-in end to end** with a throwaway, never-funded key, against a running server:

```bash
SERVER_URL=http://127.0.0.1:8787 bun run --cwd apps/server signin-e2e
```

- **Alerts.** Price and market-cap alerts run on the server, so they fire with the tab closed. They go out over Web Push (`bun run --cwd apps/server vapid-keys` prints the key pair), a Telegram bot (`TELEGRAM_BOT_TOKEN`; users link a chat with a one-time `/start` code) and Discord webhooks (stored encrypted with `CHANNEL_ENCRYPTION_KEY`). A channel without its setting stays off.
- **Kill switch.** With `ADMIN_TOKEN` set, `POST /api/admin/halt` stops every transaction submission until `POST /api/admin/resume`, and the halt is published to all clients. Every admin call, failed ones included, goes into an append-only audit log.

## Docs

- [SPEC.md](SPEC.md): architecture, security rules, stack, feature checklist, phases
- [Deploying](docs/ops/DEPLOY.md) and the [operations runbook](docs/ops/RUNBOOK.md): what to buy, the Hetzner host, the Docker stack with TLS, backups, monitoring, kill switch and incident response
- [Mainnet-fork testing](docs/dev/FORK_TESTING.md): `bun run fork:start` + `bun run e2e` lands every trade path on a local validator running mainnet's programs and state, no real money
- [Research report](docs/reports/Solana%20trading%20terminal%20teardown.md): how Axiom and its competitors work, pump.fun internals, transaction landing and MEV, data feeds, token analytics, costs
- [Raw research notes](docs/research_notes/): every claim with its source

## Safety

- The operator never holds user keys.
- Every transaction your browser signs goes through a signer firewall first.
- Keep only what you're willing to lose in the trading wallet.
- Never paste a private key into chat, support DMs or a site that isn't the canonical domain.
