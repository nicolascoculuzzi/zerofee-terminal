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
| Wallet login (SIWS) + browser trading wallet + signer firewall | ✅ | Adversarial review: no critical bypass; 4 findings fixed. 346 tests across the repo |
| Web UI on simulated data | 🔨 | Shell done; screens in progress |
| Design system (Mobbin-grounded, "no AI slop" checklist) | 🔨 | |
| Local mainnet-fork test harness (real programs, real landed txs, no real money) | 🔨 | |
| Wire UI ↔ feed ↔ wallet ↔ engine | ⏳ | |
| UI polish rounds against the design system | ⏳ | |
| First real 0.001 SOL trade | 🙋 | Needs a throwaway dev wallet key in your local `.env` |

## Part 2: match Axiom, then beat it

| Piece | Status |
|---|---|
| Armed orders core: nonce slots, lookup tables, variant grids, triggers | 🔨 |
| Armed orders: server engine + UI | ⏳ |
| Raydium LaunchLab + CPMM (StonkFun, Bonk) | 🔨 |
| Jupiter `/build` fallback for the long tail | ⏳ |
| Wallet tracker + alerts (Web Push, Telegram, Discord) | ⏳ (Telegram bot token 🙋) |
| Copy trading, trailing stops, DCA, dev-sell exits | ⏳ |
| X tracker | ⏳ (X data key 🙋) |
| Snipers (browser-open, hard caps), public API | ⏳ |

## Part 3: go live

| Piece | Status |
|---|---|
| Deploy config (Docker, Hetzner guide), monitoring, runbook | ⏳ |
| Security review: signer firewall, front-end CSP/SRI | ⏳ (firewall reviewed once; signer must move to its own origin before launch) |
| Chainstack gRPC, Helius key, domain, Hetzner server | 🙋 |
| Legal review (ToS, risk disclosures, sanctions screening) | 🙋 |
