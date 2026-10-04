# zerofee-terminal: build spec (v2)

## What this is

A hosted website for trading Solana memecoins (pump.fun and the other launchpads) with Axiom-level speed and features, and **zero platform fees**. Anyone can use it. Users keep their own keys: login is a wallet signature, and trades are signed by a trading wallet that lives encrypted in the user's own browser. The operator never holds anyone's keys or funds.

Users still pay what the chain charges: venue fees (pump.fun takes 1.25% per side on the curve, and no terminal can remove it), network fees, tips, and refundable rent. The operator pays only shared infrastructure, about $330/month at 100 users (see [Costs](#costs-and-funding)).

Research behind every decision: [docs/reports/Solana trading terminal teardown.md](docs/reports/Solana%20trading%20terminal%20teardown.md), with raw notes in `docs/research_notes/`. The v1 spec (personal single-user terminal) is in git history.

## Decisions (2026-10-03)

| Decision | Choice | Why |
|---|---|---|
| Product shape | Hosted multi-user website | Community use without everyone running servers |
| Platform fee | 0% | The point of the project |
| Chains | Solana only | Focus |
| Perpetuals | Out of scope | User decision |
| Login | Sign-In With Solana (SIWS) with Phantom / Solflare / Backpack via Wallet Standard, like GMGN | No passwords or email accounts, no auth vendor |
| Trading keys | Generated and encrypted in the user's browser; the browser signs | $0 per signature; no custody (DEXX lost $21M to custody) |
| Embedded-wallet vendors (Privy, Turnkey) | Rejected | Privy list price ≈ $16.50/user/month at 50 trades/day, more than all other infra combined |
| Unattended orders | Pre-signed transactions on durable nonces, held by the server | Exits can run with the tab closed without custody |
| Stack | Cheapest viable option at every layer | User decision |
| Excluded features | Volume/bump bots, launch bundling, "vamp" cloning, referral/cashback/points | Manipulation, or fee mechanics we don't have |

## Priorities (in order)

1. Safety of user funds: no custody, a hardened browser vault, a signer firewall
2. Trade landing speed, with MEV protection on by default
3. Fast token discovery
4. UI polish

## Architecture

```
Browser (one per user)
  web app (React)  <->  isolated signer (own origin or worker: keystore + firewall)
       | WebSocket (live data, trade context)      | REST (signed tx bytes, actions)
       v                                           v
Backend (Bun, Hetzner Falkenstein, ~1.2 ms to Frankfurt)
  gateway   WS topics + REST, SIWS sessions, rate limits
  ingest    Yellowstone gRPC -> event decoders -> in-memory market state
  router    landing lanes: Helius Sender, Jito (+ fallback lanes)
  orders    armed pre-signed transactions, triggers, nonce slots
  storage   SQLite (market data, single writer) + Postgres (users, orders, armed txs)
```

**Trade path.** The server streams a per-token *trade context* to the browser: curve or pool reserves, fee recipients, the live creator vault, and the latest blockhash. On click, the browser builds the transaction with the shared `packages/core` code, the signer firewall checks it, the trading wallet signs it, and the signed bytes go to `POST /api/tx` with the chosen landing preset. The router fans it out to the lanes, and confirmation returns on the same gRPC stream and is pushed over the WebSocket. No remote signing hop.

**Direct mode.** The connected wallet (Phantom etc.) approves each trade in a popup instead. It's slower, but there's no hot wallet.

## Stack (cheapest viable)

| Layer | Choice | Cost/month | Upgrade path |
|---|---|---|---|
| Backend | TypeScript on Bun | $0 | n/a |
| Solana client | `@solana/kit`; own instruction encoders from the official IDLs | $0 | Official pump SDKs (web3.js v1) only as test oracles |
| Frontend | React + Vite | $0 | n/a |
| Charts | TradingView Lightweight Charts v5 (Apache-2.0; needs NOTICE and attribution) | $0 | Advanced Charts: free, but company licence only; never commit it to the repo |
| Market data | Chainstack Growth ($49) + Yellowstone gRPC add-on, 2 streams ($49) | $98 | 7 streams $149; Shyft Build $199 (unmetered) as redundant feed |
| RPC reads | Chainstack Growth (20M request units, 250 RPS) | incl. | Pro $199 |
| Tx landing | Helius Sender (no credits, free tier) + Jito direct; users pay tips | $0 | Request higher limits before launch |
| Helius extras | funded-by, priority fee estimates, DAS | $0, then $49 Developer | Overage $5 per 1M credits |
| SOL/USD | Binance spot WebSocket; Pyth Hermes (API key) as cross-check | $0 | n/a |
| Discovery cross-check | PumpPortal free new-token and migration streams | $0 | n/a |
| Risk data | DexScreener (Dex Paid, CTO, boosts), RugCheck summary | $0 | n/a |
| X monitoring | twitterapi.io account monitors, one shared deduplicated handle pool | $79 (20 handles) | $499 (500); SocialData; official X API for ToS cover |
| Storage | SQLite (`bun:sqlite`, WAL) for market data; self-hosted Postgres for user state | $0 | ClickHouse when history grows |
| Hosting | Hetzner Falkenstein, one CCX33 (~$155) at 100 users | ~$155 | Add CPX32 gateways; bare metal at 10k users |
| Alerts | Web Push (VAPID), Telegram bot, Discord webhooks | $0 | n/a |

## Repo layout

```
apps/
  server/    Bun backend: gateway, ingest, router, orders
  web/       React app
  cli/       developer harness: trade buy/sell (dry-run by default)
packages/
  core/      isomorphic TS (browser + Bun): constants, curve/AMM math, decoders,
             instruction builders, tx assembly, fee/tip policy, senders
  signer/    browser keystore + signer firewall (minimal, pinned deps, separately reviewed)
docs/
  reports/          synthesized research
  research_notes/   raw research with sources
```

`packages/core` must stay isomorphic: no `fs`, no `node:` imports, `Uint8Array` and `bigint` only.

## Verify before you code

Program IDs, IDLs, fee accounts, tip accounts, minimum tips, rent and endpoints change. pump.fun has shipped about ten interface changes since May 2025; the 2026-04-28 change broke every bot that missed it.

- Every program ID, seed, discriminator, endpoint and fallback tip account lives in `packages/core/src/constants.ts`, each with a source URL comment. Nothing is hardcoded elsewhere, with one deliberate exception: `packages/signer` embeds its own reviewed copy of the program IDs, discriminators, layouts and **tip accounts**, because the signer must not trust core or the backend at runtime. A CI test cross-checks the signer's copy against core's.
- Read live, never hardcode: rent (`getMinimumBalanceForRentExemption`; rent dropped in 2026), `bonding_curve.creator` (creator vault moves with fee sharing and holder rewards), `FeeConfig`, fee recipient lists, and the token program from the mint owner. Jito's `getTipAccounts` is read live by the backend only to detect drift; it never feeds the signer (a backend that could add a "tip account" could drain up to the tip cap per trade).
- Use pump's unified `buy_v2` / `sell_v2` / `buy_exact_quote_in_v2`. PumpSwap pricing uses effective reserves (vault + signed `virtual_quote_reserves`); pricing from the raw vault underquotes boost pools by about 18%.
- Golden tests: our account lists and quotes must match `@pump-fun/pump-sdk` and `@pump-fun/pump-swap-sdk` in CI (Raydium's: `@raydium-io/raydium-sdk-v2`, with the documented SDK deviations).
- A daily job diffs pump's IDLs and SDK versions and alerts on change (about a week of devnet notice is typical). It also covers Raydium: the IDLs pinned in `packages/core/idl/RAYDIUM_SOURCE.json`, the CPMM program and LaunchLab CPI-crate sources our layouts also come from (the IDL repo lags the programs), and `@raydium-io/raydium-sdk-v2`.
- Sources of truth: https://github.com/pump-fun/pump-public-docs, https://www.helius.dev/docs/sending-transactions/sender, https://docs.jito.wtf, https://developers.jup.ag

## Security rules (non-negotiable)

**Custody**
- The operator never holds user keys. No endpoint ever accepts a private key, seed or keystore.
- The trading key is generated in the browser (WebCrypto CSPRNG) and encrypted at rest with Argon2id (at least m=19 MiB, t=2, p=1) or a passkey (WebAuthn PRF). It is decrypted into memory only after unlock and auto-locks when idle (default 15 min).
- Onboarding forces a backup/export step. The trading wallet is a float; profits can auto-sweep to the connected wallet.

**Signer firewall**
- Every transaction is decoded and checked before signing, and anything that fails is refused:
  - Every top-level instruction belongs to an allowlisted program (pump, PumpSwap, Raydium LaunchLab/CPMM, Jupiter, ComputeBudget, System, Token, Token-2022, ATA, Nonce).
  - SOL and token transfers go only to the user's own token accounts, the user's own WSOL account, the connected wallet, or known tip accounts (with a per-preset tip cap).
  - No `Approve` or `SetAuthority` instructions.
  - Every buy variant's amount argument stays under the user's per-trade cap; the daily cap is tracked in the browser.
  - Raydium venues (neither program checks who owns the output token account, so the firewall must):
    - LaunchLab `LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj`: only `buy_exact_in`, `buy_exact_out`, `sell_exact_in`, `sell_exact_out`. Require exactly 18 accounts and `share_fee_rate` (3rd u64) = 0, so no referral account can take up to 1% of the trade. Account 0 is the signer. Accounts 5 and 6 are the signer's ATAs for accounts 9/10 (base/quote mint) under token programs 11/12. Account 1 is the vault authority `WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh`, 13 the event authority, 15 the System program. Account 4 is PDA `["pool", base, quote]`. Account 16 is PDA `[platform_config (3), quote]`.
    - CPMM `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C`: only `swap_base_input` and `swap_base_output`, 13 accounts. Accounts 4 and 5 are the signer's ATAs for mints 10 and 11 under programs 8 and 9. Account 1 is the authority `GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL`. Accounts 6, 7 and 12 are PDAs `["pool_vault", pool, mint]` and `["observation", pool]`.
    - Caps apply to the quote spent: LaunchLab `buy_exact_in` arg 1 and `buy_exact_out` arg 2; CPMM `swap_base_input` arg 1 and `swap_base_output` arg 1 (`max_amount_in`) when the input mint is wSOL; and the System transfer that funds the wSOL ATA. Buys with non-SOL quotes (xStocks, USD1) need a non-SOL cap or should be refused.
- The firewall and keystore live on an isolated origin, iframe or worker with minimal pinned dependencies and no analytics or third-party scripts. **A Web Worker alone is not enough for launch:** compromised app JavaScript on the same origin could capture the vault password, reset the daily-spend record, or bind the vault to its own "connected wallet" during onboarding. Public launch requires the signer on its own origin (iframe + strict `postMessage` origin checks); the worker RPC is shaped to move there unchanged.
- Venue programs are refused unless they have a firewall rule (fail closed). Every new venue (Raydium LaunchLab/CPMM, Jupiter) ships with its rule and malicious-corpus tests; Jupiter needs a route decoder that proves the output lands in the user's own token account.
- PumpSwap trades are limited to the canonical, LP-burned pool by default (anyone can create a second pool for a pair and take tokens sold into it at min-out 0). PumpSwap `extend_account` is allowed only for that pool, paid by the trading wallet.
- Sell min-out must be above zero and within the user's slippage of the quote the browser computed itself. Residual risk: a malicious backend can still lie about reserves in the trade context; an optional independent-RPC reserve check in the browser closes it.
- Armed buy variants each count against the daily cap (they can't be proven mutually exclusive offline), so armed buy grids stay small (≤ 3 variants by default). Sells never consume the buy cap.

**Front-end integrity** (the main threat once keys are in the browser)
- Strict CSP and Subresource Integrity.
- No git dependencies; lockfile committed; dependency updates reviewed.
- Reproducible builds with published hashes.
- Registrar lock and DNSSEC; one published canonical domain.

**Sessions**
- SIWS messages bind our domain, a server nonce, issued-at and expiry.
- Sessions are short-lived and tied to the wallet address; the WebSocket authenticates on connect.

**Money movement**
- Withdraw to the connected wallet in one click.
- Any other destination needs a connected-wallet signature plus a 24-hour delay. (Not built yet; until then the signer refuses every other destination.)
- Nonce slots are created with `CreateAccountWithSeed` (base = trading wallet) so the trading wallet stays the only signer; funding per slot is capped (default 0.002 SOL).

**Limits**
- Per-user max SOL per trade and per day, enforced by the firewall in the browser and re-checked on the server.
- Server-side caps on total armed notional per user, a cap on how far below the arming price an armed grid may reach, per-user rate limits, and a per-leader cap on copy volume per slot.

**Kill switches**
- Admin: `POST /api/halt` stops all submissions and fires every pre-signed cancel.
- User: a "Panic" button cancels that user's armed orders and locks the keystore.

**Insider risk** (Axiom's Feb 2026 lesson)
- Store the main-wallet-to-trading-wallet mapping minimally.
- Admin tools are role-gated, and every lookup is logged.

**Development**
- `DRY_RUN=true` by default (build, sign, simulate, never send) for the CLI and the dev server.
- The CLI's dev key comes from local `.env` only. Never paste a key into chat. `.env`, `*.db` and `keypair*.json` stay gitignored.

## Speed checklist

- The browser builds and signs locally from the streamed trade context, then POSTs signed bytes. No build round trip and no remote signer.
- Blockhash comes from the gRPC `blocks_meta` stream. Check `lastValidBlockHeight`, not wall time (validity is about 40–45 s at current slot times).
- Cache ATAs and use idempotent ATA creation; detect Token vs Token-2022 from the mint owner.
- Local instruction builders only; no quote API on the hot path.
- CU limit = simulated CU × 1.1, cached per route (a pump buy with ATA creation is about 100k CU, a sell about 60k). Priority fee comes from the Helius estimator, clamped to the user's max.
- Send with `skipPreflight: true` and `maxRetries: 0`; rebroadcast ourselves until `lastValidBlockHeight`.
- Keep Sender connections warm (ping at least every 5 s when idle).
- Host in Hetzner Falkenstein; far-away users get Helius Sender's browser HTTPS endpoint as a fallback lane.
- Optimistic UI: show the pending trade instantly, reconcile on confirmation.
- Log latency for every trade: click → built → signed → received by server → sent per lane → landed (slot + ms). Store it, show it in the UI, and track changes in NOTES.md.

### Landing presets

| Preset | Route | Tip | Notes |
|---|---|---|---|
| Reduced (default) | Helius Sender `?swqos_only=true&mev-protect=true` | 0.000005 SOL + Helius priority fee estimate, clamped | Verify the two query params combine |
| Secure | Jito `bundleOnly=true` with a read-only `jitodontfront…` account | max(1,000 lamports, live Jito p50–p75) | Protection only works when the tx actually goes through Jito (98.5% of sandwiched Axiom txs had the flag but only 16.5% paid a Jito tip) |
| Fast | Sender Max (all lanes) | 0.001 SOL | Shows a sandwich warning; optional durable-nonce race across relays |

Terminal default gas (0.002–0.022 SOL per side) is 100–1,000× what calm markets need. Default lean and show every cost per trade.

## Data layer

- **Feed:** one Yellowstone gRPC stream at processed commitment, filtered to the launchpad and AMM programs.
- **Decoding:** Anchor self-CPI events first (event tag `e445a52e51cb9a1d` + 8-byte discriminator), instruction decoding as fallback, token-balance diffs for the long tail. Decoders read known leading fields and tolerate new trailing fields.
- **Derived state** is computed from events, with no RPC calls:
  - price, market cap and volume;
  - bonding progress = `1 − real_token_reserves_now / real_token_reserves_initial`, which handles mayhem coins with 2B supply and non-SOL quotes.
- **Holders:** tracked incrementally from token balances and reconciled periodically (the program-filtered stream misses wallet-to-wallet transfers).
- **Metadata:** from `CreateEvent`, JSON fetched from the URI's own IPFS gateway or the configured ones (ipfs.io and dweb.link retired on 2026-09-21; pump.fun launches are served by pump.mypinata.cloud), cached by CID forever. Images and socials are normalized server-side; token images reach the browser only through the same-origin image proxy (`GET /api/img`, packages/protocol `media.ts`).
- **Wallet tracking and copy detection:** match signers in the firehose in memory against the deduplicated union of all users' lists. No per-wallet subscriptions for trades.
- **Storage:**
  - SQLite holds tokens, trades for 24–72 h, and candles.
  - Postgres holds identities, trading-wallet public keys, presets, orders, armed txs, nonce slots, fills and alerts.
- **Streaming:** Bun WS topics per view; snapshot, then sequenced deltas. Lists coalesce at 4–10 Hz, the focused token's tape at 50–100 ms. Send correction messages for late or dead-slot events.
- **Capacity check in week one:** count gRPC messages against throughput estimates (5–20M vs ~44M successful pump.fun + PumpSwap txs/day; the research conflicts).

### Token metric definitions (published in-app, configurable)

| Metric | Definition |
|---|---|
| Snipers | Non-dev buyers whose first buy landed within 3 slots of creation |
| Bundlers | Creation-slot co-buyers; or 4+ distinct buyers in one slot who also share a funder or a tight size band; or several wallets in one tx |
| Insiders | Holders who received tokens by transfer and never bought, plus wallets the creator funded within two hops |
| Top 10 | Excludes the bonding-curve PDA, AMM vaults, burn addresses and lockers |
| Dev holding | Creator wallet balance (from the live `bonding_curve.creator`) as % of supply |
| Dex Paid | DexScreener `/orders/v1/solana/{mint}` has an approved `tokenProfile` |
| Token-2022 danger | `permanentDelegate`, `transferHook`, `pausable`, `nonTransferable`, or frozen-by-default |

Clustering evidence, strongest first: shared non-exchange funder (Helius `funded-by`, cached forever), direct transfers, shared fee payer, shared rent-refund destination, same-slot near-identical buys, recurrence across one dev's launches.

PnL uses weighted-average cost in SOL and USD, with base fee, priority fee and tip in the basis. Win rate counts closed positions only.

## Armed orders (unattended automation without custody)

The browser pre-signs transactions against a **durable nonce** (first instruction `nonceAdvance`). They never expire, and once one lands, every other transaction on that nonce is dead. The server holds them and submits only when the trigger fires.

**Patterns**
- **Min-out grid:** variants at stepped minimum outputs and 2–3 tip levels; the server submits the one just below the live quote.
- **OCO:** a TP and its SL share one nonce.
- **Independent orders:** separate nonces (each DCA tranche or TP level).
- **Cancel:** a pre-signed cancel (nonce advance only) is stored with every order.

| Runs with the tab closed | Needs the browser open |
|---|---|
| Limit buy/sell on a known token, TP ladder + SL, stop-loss grid, trailing stop (within the grid's range), DCA tranches, dev-sell exits, pump.fun migration snipe (canonical pool address is deterministic), copy-trade sells after the buy fills | Copy-trade buys, AFK filter snipes, X contract-address snipes, dev-wallet snipes (the mint isn't known in advance), re-arming, creating nonce slots, withdrawals, key export |

**Constraints**
- Size, minimum output, fee, tip, lane and account list are frozen at signing. pump.fun upgrades, migrations, creator changes and ALT closures strand orders, so the UI needs a re-arm flow and the IDL-diff alarm must notify affected users.
- Nonce slots cost about 0.00106 SOL rent each on mainnet ((80 + 128) bytes × 5,080 lamports/byte), refundable; default pool is 10 per user.
- Submit armed orders via Jito bundle-only with `jitodontfront`, keep variants tight, and fire the cancel if an attempt misses within a few slots (a leaked nonce tx is a permanent option).
- Transactions can exceed `PACKET_DATA_SIZE`. Use v0 transactions with operator-owned ALTs (never closed while referenced), or v1 transactions where relays accept them. Arm against new table entries only once their extension is finalized: on the mainnet fork, a transaction using fresher entries landed 30 slots late.
- Before submitting, the server checks the wallet still holds the SOL or tokens; the UI shows reserved balances.
- **Tested 2026-10-03 on a local Agave 4.3.0 validator:** a nonce transaction that lands but fails during execution **still advances the nonce** and pays the base fee. Replaying the same signed transaction is rejected. So each nonce gets **one landed attempt**: a failed attempt (e.g., slippage) kills every variant on that nonce.
  - Submit only when the live quote clears the chosen variant's minimum output with margin. On failure, mark the order "consumed, re-arm" and push-notify the user.
  - **Full-exit sells** (stop-loss, final TP, dev-sell exit) may be armed as an attempt ladder across several nonces. Once one fills, the rest fail harmlessly: there are no tokens left, so they cost only the base and priority fee, and tips aren't paid because failed transactions revert.
  - **Never ladder buys or partial sells across nonces** (double-fill risk). If those need retries, later attempts need an on-chain guard such as a balance assertion (e.g., Lighthouse). That would have to be added to the firewall allowlist; evaluate later.
  - Repro: [docs/experiments/nonce-failure](docs/experiments/nonce-failure/README.md).
  - Re-verified with mainnet's pump and PumpSwap binaries on a mainnet fork (`bun run e2e`, [docs/dev/FORK_TESTING.md](docs/dev/FORK_TESTING.md)). A full-exit stop-loss attempt that landed after its min-out was out of reach failed, consumed its nonce and cost base + priority fee, with the tip reverted. The ladder's next nonce filled, and a leftover attempt failed harmlessly. TP, OCO, cancel, PumpSwap stop-loss and the migration snipe all landed as armed.

## Feature checklist

P0 = Axiom parity, P1 = next, P2 = later. Sources are in the report's feature table.

**Discovery**
- [ ] P0 Pulse: New Pairs / Final Stretch / Migrated, each column with its own search, quick-buy amount, preset and filters
- [ ] P0 Filters:
  - Keyword search/exclude
  - Protocols (launchpads) and Quote Tokens (SOL, USDC, USD1, other)
  - Audit metrics: Age, Top 10 %, Dev %, Snipers %, Insiders %, Bundle %, Holders, Pro Traders
  - Money metrics: Liquidity, Volume, MC, Txns, Buys, Sells
  - Socials
  - Three presets with import/export/share and Apply All
- [ ] P0 Blacklists: tokens, devs, funding wallets, X accounts
- [ ] P0 Pause feed on hover; keyboard buys from the feed; sound alerts
- [ ] P1 Trending with time windows, watchlist, ⌘K search (name/ticker/CA/wallet/dev), similar tokens
- [ ] P1 Display options: metric colours, mini charts, PnL on rows, toast position

**Trading**
- [ ] P0 Instant Trade window: P1/P2/P3, wallet picker, 4 buy buttons, 4 sell % buttons, %/SOL toggle, Sell Initials, hotkeys, no confirm
- [ ] P0 Presets: slippage, priority fee, tip, landing preset (Reduced/Secure/Fast)
- [ ] P0 Paste/clipboard buy bar, optional auto-buy on paste
- [ ] P0 Instant mode (browser wallet) and direct mode (connected wallet)
- [ ] P1 Multi-wallet: up to 25 trading wallets, groups, split buys, transfers, Claim Rent

**Orders**
- [ ] P0 Limit orders by MC or price (slider and draggable chart line), armed
- [ ] P0 TP/SL ladder at entry, armed
- [ ] P0 Migration buy/sell (pump.fun → PumpSwap), armed
- [ ] P1 Trailing stop (grid), DCA, dev-sell exit
- [ ] P2 OCO/OTOCO smart orders

**Token page**
- [ ] P0 Chart: MC/Price and USD/SOL toggles, 1s candles, own avg entry/exit lines, own/dev/tracked-wallet markers, click candle to filter trades
- [ ] P0 Info: Top 10, Dev H., Snipers, Insiders, Bundlers, LP Burned, Holders, Pro Traders, Dex Paid, Token-2022 flags
- [ ] P0 Tables: Trades (YOU/dev/tracked tags, size filters), Holders, Top Traders, Positions, Orders
- [ ] P1 Event bubbles (Dex Paid, migration, snipers), top-holder avg lines, KOL lines, Trader Scan popover

**Trackers and alerts**
- [ ] P0 Wallet tracker: manager, live trades feed with quick-buy, emoji labels, import/export (BullX/GMGN formats), up to 10,000 wallets
- [ ] P1 Alerts off-app: Web Push, Telegram, Discord, for wallets, X, fills and price; "tap to copy"
- [ ] P1 X tracker: My List / Top Tracked, tweets, profile changes, follows, keyword alerts (Axiom has promised these since Mar 2025)
- [ ] P2 Telegram/Discord call-channel ingestion with caller leaderboards

**Automation (our wedge over Axiom)**
- [ ] P1 Copy trading: fixed or % sizing, max per buy, spend limit, MC/liquidity/age filters, exclude curve, no duplicates, copy-sell, TP/SL on copies, drift guard, per-leader caps
- [ ] P2 AFK filter sniper, X CA sniper (author allowlist, fresh-mint audit, size cap, kill switch), dev-wallet sniper (browser open)
- [ ] P2 Public API with capped, revocable agent keys

**Portfolio and account**
- [ ] P0 Portfolio: balance, PnL chart (7d/30d/max), performance buckets, positions, history, activity, search other wallets
- [ ] P0 Fund from connected wallet, deposit QR, withdraw to connected wallet
- [ ] P1 PnL cards (Satori + resvg), CSV export
- [ ] P1 Settings: presets, hotkeys, theme, default mode, auto-lock, export key, withdrawal destinations, nonce slots and rent reclaim, sessions

**Platform**
- [ ] P2 Mobile PWA (bottom tabs, single-column Pulse, sticky buy/sell bar)
- [ ] P2 Paper trading and filter backtesting
- [ ] P2 Shreds pro tier (DoubleZero Edge $450–1,500/IP), Advanced Charts (company licence), bubble maps, KOL discovery

## Phases

Build in order. Each phase ends with something runnable and testable.

### Phase 1: trade engine core + CLI *(in progress)*
- `packages/core`: constants, pump curve math, PumpSwap math (effective reserves), decoders, `buy_v2`/`sell_v2`/`buy_exact_quote_in_v2` and PumpSwap builders, compute budget, tips, v0 assembly, fee/tip policy, Sender and Jito senders, latency records
- `apps/cli`: `bun run trade buy <mint> <sol>` and `bun run trade sell <mint> <percent>` for curve and PumpSwap tokens; dry-run by default
- **Done when:**
  - unit tests reproduce real mainnet trades to the lamport and match the official SDKs;
  - dry-run simulations are clean for curve and PumpSwap buys and sells;
  - a real 0.001 SOL buy and sell land from a dev wallet, with both in the latency log.

### Phase 2: market data feed
- Chainstack gRPC ingest, event decoders (pump, PumpSwap; LaunchLab TradeEvent/PoolCreateEvent and CPMM SwapEvent also decode in `packages/core/src/events`, attributed to the emitting program because LaunchLab's TradeEvent shares pump's discriminator, but the feed does not track those venues yet), derived state, SQLite, Bun WS gateway with topics, SOL/USD feed
- **Done when:** new launches appear in a debug view within about 1 s and counts reconcile against PumpPortal's free stream.

### Phase 3: identity and trading wallet
- SIWS login; browser keystore (generate, encrypt, unlock, auto-lock, backup/export); signer firewall with a malicious-transaction test corpus; fund from and withdraw to the connected wallet; direct mode
- **Done when:** a user can sign in, create and back up a trading wallet, fund it, and the firewall blocks every drain test case.

### Phase 4: web UI parity
- Pulse with full filters, token page, Instant Trade window, presets, landing presets, clipboard buy, search, portfolio/PnL, hotkeys
- **Done when:** a full buy → sell loop works from the UI on mainnet, with the optimistic UI and the latency breakdown visible.

### Phase 5: armed orders
- Nonce failure semantics: resolved 2026-10-03 (one landed attempt per nonce; see Armed orders).
- Nonce slots, armed limit/TP/SL/migration orders, armed-orders view, re-arm flow, pre-signed cancels, admin halt and user Panic.
- **Done when:** a small mainnet TP/SL fires correctly with the tab closed.

### Phase 6: trackers and alerts
- Wallet tracker on the shared stream, chart markers, price/wallet alerts over Web Push, Telegram and Discord.

### Phase 7: more venues
- Raydium LaunchLab and CPMM builders (LaunchLab is about 38% of launchpad revenue via StonkFun), Jupiter `/build` as the long-tail fallback (never `/order`, which charges up to 50 bps on new tokens). Meteora DBC/DAMM v2 later.
- **Done 2026-10-03 (dry-run):** LaunchLab and CPMM decoders, math, builders, event decoders and venue resolution in `packages/core/src/raydium`, replayed against mainnet trades and golden-tested against `@raydium-io/raydium-sdk-v2` (measurements in NOTES.md). Notes for the next steps:
  - StonkFun coins are Token-2022 with a 3% transfer fee, and many StonkFun pairs are quoted in Token-2022 xStocks rather than SOL. Quotes apply the transfer fee, and slippage limits apply to what the user receives.
  - Graduation is signed by Raydium's migration wallet. The CPMM pool is the canonical PDA on the launchpad's `PlatformConfig.cpswap_config`, so migration orders can be armed in advance.
  - The signer firewall rules for both programs (Security rules → Signer firewall) are built and in `createSignerPolicy`; pairs quoted in anything other than wSOL/USDC stay refused until the user sets a cap for that quote mint. Armed Raydium orders still need core's static-position tables extended (Raydium authority PDAs must stay out of the operator lookup table).

### Phase 8: the wedge
- Copy trading, trailing stops, DCA, dev-sell exits, X tracker with keyword alerts, browser-open snipers with hard caps, public API.

### Phase 9: launch hardening
- Relay limits in writing (Helius Sender above the 50 TPS default; Jito UUID).
- Signer on its own origin (iframe + `postMessage` origin checks), not just a Web Worker. Launch blocker.
- Front-end integrity checklist; DDoS/CDN; backups; monitoring; admin access logs; bug bounty.
- Read each data provider's terms on serving many users from one plan.
- Legal review before public launch (ToS, risk disclosures, sanctions screening/geo-blocking). This spec is not legal advice.

## Costs and funding

| Monthly (estimates, 2026-10-03, SOL = $119.50) | 100 users | 1,000 users | 10,000 users |
|---|---|---|---|
| Chainstack gRPC + RPC | $98 | $98 | $348 |
| Redundant feed (Shyft) | n/a | n/a | $199 |
| Helius | $0 | $49 | $49 |
| Hetzner hosting | ~$155 | ~$235 | ~$705 |
| X data | $79 | $499 | ~$1,100 |
| **Total** | **~$330** | **~$880** | **~$2,400** |
| **Per user** | **~$3.30** | **~$0.88** | **~$0.24** |

Not included: bandwidth beyond host allowances (about 0.5 / 5.2 / 52 TB egress), DDoS/CDN, backups, and ops time.

For comparison, a heavy user trading 0.5 SOL per side 1,500 times a month pays Axiom about $851/month.

Funding: free to use, with an optional tip jar that defaults to zero, so the zero-fee claim stays true. If needed later, a flat membership (about $9/month at 1,000 users with 10% paying).

## Open questions to verify

| Question | Status |
|---|---|
| Nonce advance on failed execution | **Resolved 2026-10-03:** yes, it advances; one landed attempt per nonce (local Agave 4.3.0 test) |
| Nonce vs MEV protection | Mitigated by Jito bundle-only + tight variants + fast cancel; measure landing rate |
| Armed tx size | **Resolved 2026-10-03:** v0 + one operator ALT of shared accounts (the firewall keeps mints, token programs, user accounts, pool, tips static) fits every armed shape, worst case 1,053 of 1,232 B; v1 not needed (NOTES.md) |
| Direct-mode arming | Can a connected wallet approve a batch of variants in one popup? |
| Chainstack capacity | Streams 2/7 (blog) vs 1/5 (pricing page); replay buffer of about 100 slots |
| Helius limits | Sender 15 vs 50 TPS; whether the Reduced preset's two query params combine |
| Jupiter `/build` | Whether routes still go through `JUP6…` (matters for the firewall allowlist) |
| Slot time | 250 ms vs 300 ms; Alpenglow's next window is 9 Nov 2026 (`confirmed` and `finalized` merge) |
| X data terms | Third-party provider legality under X's terms |

## Working style

- One feature at a time, small commits.
- Unit tests for all curve and AMM math; golden tests against the official SDKs.
- When unsure about an on-chain detail, simulate before sending.
- Keep NOTES.md with measured latencies and what changed them.
- Never commit secrets; never put TradingView Advanced Charts in the repo.
