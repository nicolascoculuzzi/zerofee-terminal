# Solana Trading Terminal (personal, Axiom-style)

## What this is

A personal, single-user web terminal for trading Solana memecoins, mainly pump.fun tokens, with Axiom-like speed. One user (me), one hot wallet, one server. NOT a public product: no multi-user accounts, no custody of anyone else's funds.

## Priorities (in order)

1. Safety of the hot wallet
2. Trade landing speed
3. Fast token discovery
4. UI polish

## Stack

- Backend: TypeScript on Bun (Node 20+ acceptable), @solana/web3.js v1 (most pump.fun / Jupiter examples use it)
- Frontend: React + Vite, TradingView Lightweight Charts
- Backend <-> frontend: one WebSocket for live data, REST for actions
- Storage: SQLite
- Config: .env (never committed)

## Suggested layout

```
src/
  config/    env loading, limits, constants (program IDs, endpoints)
  chain/     rpc client, blockhash cache, sender, confirmation
  pump/      IDL, bonding curve math, buy/sell instruction builders
  feed/      token + trade ingest (PumpPortal now, gRPC later)
  orders/    limit / TP / SL engine
  server/    http + websocket
  db/        sqlite schema + queries
web/         react app
scripts/     CLI entry points
```

## External services

| Purpose | Service | Notes |
|---|---|---|
| Reads / RPC | Helius RPC | Paid plan recommended |
| Tx landing | Helius Sender | https://sender.helius-rpc.com/fast or a regional endpoint near the server. Requires a tip to a Sender tip account + priority fee |
| New tokens & trades | PumpPortal websocket | wss://pumpportal.fun/api/data to start |
| Faster detection (later) | Helius LaserStream or Yellowstone gRPC | Paid |
| Migrated tokens | PumpSwap directly, or Jupiter Swap API | |
| Perps (optional) | Hyperliquid API | |

## Verify before you code

Program IDs, IDLs, fee/creator-vault accounts, tip accounts, minimum tips and API endpoints change.

- Pull the current pump.fun / PumpSwap IDLs from the official repo: https://github.com/pump-fun/pump-public-docs
- Read current Sender docs (tip accounts, minimums, endpoints): https://www.helius.dev/docs/sending-transactions/sender
- Read current Jupiter Swap API docs before using it.
- Do not hardcode any of this from memory. Put every program ID and endpoint in src/config/constants.ts.

## Security rules (non-negotiable)

- DRY_RUN=true by default. In dry-run: build, sign, simulateTransaction, never send. Only send when .env has DRY_RUN=false.
- Hot wallet key comes from .env (WALLET_PRIVATE_KEY, base58). Never log it, never send it to the frontend, never write it anywhere else.
- .env, *.db, keypair*.json go in .gitignore in the first commit.
- Hard limits in config: MAX_BUY_SOL, MAX_DAILY_SPEND_SOL. The backend rejects anything above them, including from automated orders.
- Server binds to 127.0.0.1 by default. If it is ever exposed, require an auth token on every request and WebSocket connection.
- Kill switch: POST /api/halt stops all automated orders immediately.
- Never ask me to paste a private key into chat. Keep the hot wallet funded with only what I'm willing to lose.

## Speed checklist

- Sign on the server. A click sends a prepared request; no wallet popup.
- Keep a fresh blockhash cached (refresh every few seconds).
- Cache associated token accounts; include idempotent ATA creation in buys.
- Build pump.fun bonding-curve buy/sell instructions locally from cached curve state. No external quote API on the hot path.
- Set a tight compute unit limit, a priority fee, and the Sender tip.
- skipPreflight: true when sending.
- Host the backend in the same region as the Sender endpoint used.
- Optimistic UI: show the pending trade instantly, reconcile on confirmation.
- Log latency for every trade: request received -> tx built -> sent -> landed (slot + ms). Store in SQLite and show in the UI.

## Phases

Build in order. Each phase ends with something I can run and test.

### Phase 1: Trade engine (CLI)

- `bun run trade buy <mint> <sol>` and `bun run trade sell <mint> <percent>` for bonding-curve tokens
- Fetch bonding curve state; price/amount math with slippage (pure, unit-tested functions)
- Send via Sender with tip + priority fee; confirm via signature subscription
- Latency log per trade
- Done when: dry-run simulates cleanly, then a real 0.001 SOL buy and sell land and the latency log shows both

### Phase 2: Token feed

- Subscribe to new tokens and trades
- Track per token: market cap, volume, bonding curve progress, dev wallet + dev holding, top-10 holder %, age
- Store in SQLite; push updates to the frontend over WebSocket
- Done when: new launches appear within about 1s of creation

### Phase 3: Web UI

- Pulse-style three columns: New / Almost bonded / Migrated
- Filters: min market cap, min volume, max dev holding, max top-10 %, age
- Token page: candle chart built from trades, recent trades, quick-buy preset buttons, sell 25 / 50 / 100%
- Positions panel with live PnL
- Keyboard shortcuts for buy and sell

### Phase 4: Wallet tracker

- Add wallets with labels; stream their trades; alerts in the UI; mark their buys/sells on charts

### Phase 5: Orders

- Limit buy/sell, take profit, stop loss, trailing stop
- Backend loop watches price and fires through the Phase 1 engine
- Respects limits and the kill switch

### Phase 6: Migrated tokens

- Buy/sell after migration via PumpSwap or Jupiter

### Later / optional

- Switch detection to gRPC
- Hyperliquid perps tab
- X/Twitter account tracker
- Rust hot path, only if latency logs show tx building is the bottleneck

## Working style

- One feature at a time, small commits
- Unit tests for all bonding curve math
- When unsure about an on-chain detail, simulate before sending
- Keep NOTES.md with measured latencies and what changed them
