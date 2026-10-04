# Build progress

Live status of the build. Updated as each piece is reviewed, tested and merged into `main`.

Legend: ✅ merged and verified · 🔨 building · ⏳ queued · 🙋 needs you

## Part 1: works end to end

| Piece | Status | Notes |
|---|---|---|
| Trade engine: pump.fun curve + PumpSwap, Sender/Jito lanes, dry-run CLI | ✅ | 70 tests; mainnet dry-run fills match quotes exactly |
| Armed-order nonce semantics | ✅ | Tested: one landed attempt per nonce ([experiment](experiments/nonce-failure/README.md)) |
| CI + daily pump.fun interface watch | ✅ | GitHub Actions; opens an issue on drift |
| Live data feed + backend gateway | ✅ | 6-min public-RPC run: 303 launches, 341 trades/s, 0 decode failures, ~0.5–1 s detection; Yellowstone gRPC client verified under Bun |
| Wallet login (SIWS) + browser trading wallet + signer firewall | ✅ | Adversarial review: no critical bypass. 1,061-case matrix: every engine transaction (pump, PumpSwap, Raydium LaunchLab/CPMM) passes in all 3 modes (plus 346 cases for Jupiter routes); every tampered variant refused for its named reason |
| Web UI on simulated data | ✅ | Every screen rebuilt to the design system and merged; web build in CI |
| Design system (Mobbin-grounded, "no AI slop" checklist) | ✅ | [DESIGN.md](design/DESIGN.md): 161 Mobbin references, computed AA contrast, slop checklist |
| Local mainnet-fork test harness (real programs, real landed txs, no real money) | ✅ | 10/10 e2e: curve, mayhem and PumpSwap buys/sells/exits land, exact to the lamport ([how](dev/FORK_TESTING.md)) |
| Wire UI ↔ feed ↔ wallet ↔ engine | ✅ | Live pump.fun/PumpSwap/LaunchLab/CPMM data → SIWS → browser-built trades (Raydium included) → armed orders → trackers/copy, all DRY_RUN |
| UI polish rounds against the design system | ✅ | 3 rounds: real wallet logos (any Wallet Standard wallet + Phantom/Solflare/Backpack/Coinbase/OKX/Trust), onboarding card, Axiom-style Pulse stat slots, token page, modals, phone pass |
| Coin images | ✅ | Per-host pacing, retries, pump CDN, worker pool; 100% of images served after a cold restart (was 65%), launch → image p50 0.75 s |
| Charts | ✅ | Adaptive axis, sane zoom, volume band, migration line, history paging; mini and PnL charts fixed |
| Speed | ✅ | SQLite off the event loop (lag p99 34 → 4 ms), complete first Pulse snapshot, first screen 243 → 169 KB gzip, 60 fps; public RPC stream backlog is the remaining limit |
| Strict CSP with no inline styles | ✅ | Chart attribution style allowed by hash only; build guard + test |
| Every trade on every coin (capture-rate fixes + full history backfill) | ✅ | Capture 62.7% → 100% on public RPC; gap-fill after socket stalls; full backfill from chain (FLOP 428/429 txs); paginated trades/candles; history state on charts and the Trades tab |
| Open any coin by address (on-demand resolve) | ✅ | Unknown or pruned mints load in ~0.1–2 s from chain; pasted pump.fun/DexScreener/Axiom/GMGN/Solscan links; Jupiter fallback; abuse limits. Full history speed needs a paid `HISTORY_RPC_URL` |
| First real 0.001 SOL trade | 🙋 | Needs a throwaway dev wallet key in your local `.env` |

## Part 2: match Axiom, then beat it

| Piece | Status |
|---|---|
| Armed orders core: nonce slots, lookup tables, variant grids, triggers | ✅ (validator suite 10/10; all armed txs pass the firewall; worst case 1,053 of 1,232 bytes) |
| Armed orders: server engine + UI | ✅ end-to-end on the mainnet fork (TP, OCO, SL ladder, cancel, PumpSwap SL, live migration snipe: 19/19 e2e); ✅ server engine (intake, triggers, nonce monitor, halt/Panic cancels); UI view built, wiring pending |
| Raydium LaunchLab + CPMM (StonkFun, Bonk) | ✅ engine (mainnet dry runs exact) + signer firewall rules; ✅ server feed (launches, trades, graduation to CPMM, Pulse, trade contexts) and armed orders on both venues; UI wiring pending |
| Jupiter `/build` fallback for the long tail | ✅ engine (venue fallback, no Jupiter fee; mainnet dry runs on Meteora DBC / DAMM v2 / BONK routes) + signer firewall rule with pinned hops (346-case matrix, malicious corpus on real `/build` responses) |
| Wallet tracker + alerts (Web Push, Telegram, Discord) | ✅ server: matcher (4–6M trades/s), tracked feed, alerts (Telegram bot token 🙋) |
| Copy trading, trailing stops, DCA, dev-sell exits | ✅ copy engine server + armed exits; trailing/dev-sell triggers in engine; UI wiring pending |
| X tracker | ⏳ (X data key 🙋) |
| Snipers (browser-open, hard caps), public API | ⏳ |

## Part 3: go live

| Piece | Status |
|---|---|
| Deploy config (Docker, Hetzner guide), monitoring, runbook | ✅ ([DEPLOY.md](ops/DEPLOY.md), [RUNBOOK.md](ops/RUNBOOK.md); image build runs in CI) |
| Security review: signer firewall, front-end CSP/SRI | ⏳ (firewall reviewed once; signer must move to its own origin before launch) |
| Chainstack gRPC, Helius key, domain, Hetzner server | 🙋 |
| Legal review (ToS, risk disclosures, sanctions screening) | 🙋 |
