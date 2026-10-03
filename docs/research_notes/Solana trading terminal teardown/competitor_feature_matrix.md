# Competitor Feature Matrix: Solana Memecoin Terminals and Telegram Sniping Bots vs Axiom (as of 3 Oct 2026)

> **How these notes were built.**
> - **Feature sources.** Six parallel sub-researchers read official docs (GitBook `llms.txt` / `.md` pages) and official sites. I then extended and checked their work against primary pages:
>   - Trojan Terminal: `docs.trojan.com`
>   - GMGN: `docs.gmgn.ai`
>   - Banana Pro and Banana Gun SOL: GitBook spaces
>   - pump.fun Terminal / Padre
>   - LAB, Fomo and Jupiter
> - **Traction and incidents.** DefiLlama's fees and hacks APIs, pulled directly on 2026-10-03. Market-share figures are my own monthly aggregation of DefiLlama daily data.
> - **Search limit.** The session-wide web-search quota ran out early. User-sentiment coverage is therefore thin, and some 2025–26 incidents could not be cross-checked.
> - **Source labels.** "(affiliate)" marks SEO/referral-code review sites; treat those as weak evidence.
> - **Axiom.** Mentioned only as the baseline, taken from `docs.axiom.trade` and the sibling note `axiom_feature_inventory.md`.
> - **Perps.** Per the coordinator's scope change, perps are out of scope and appear only as a yes/no column.
> - **Manipulation features.** Features whose core purpose is market manipulation are listed once, in one line, under "Implications for the build".

## 1. Which tools matter most in 2026, by volume, fees and users?

### Takeaway
DefiLlama fee data (pulled 3 Oct 2026) shows Solana memecoin trading has consolidated into a few products. In Sep 2026 the share of tracked Solana trading-app fees was:

| Product | Share of Sep 2026 Solana fees |
|---|---|
| Axiom | ~53% |
| Fomo (fast-rising mobile/social app) | ~23% |
| GMGN | ~11% (85% of GMGN's fees are now earned on Robinhood Chain and BSC) |
| pump.fun's Terminal (ex-Padre) | ~9% |
| Trojan | ~2% |

The 2024 to early-2025 leaders (Photon, BullX, Banana Gun, Moonshot, BONKbot) have collapsed to near zero. The tracked Solana fee pool shrank from ~$289M/month (Jan 2025) to ~$57M/month (Sep 2026).

### Cited Findings

**DefiLlama fee ranking, all chains (pulled 2026-10-03; "30d" ≈ 3 Sep–2 Oct 2026).** Sources: [overview API](https://api.llama.fi/overview/fees?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true&dataType=dailyFees) plus each product's `summary/fees/<slug>` endpoint linked in the table. The Solana share is my sum of DefiLlama's per-chain daily breakdown over the last 30 days.

| # | Product (DefiLlama category) | 30d fees | 1y fees | All-time | Solana share, last 30d | Source |
|---|---|---|---|---|---|---|
| 1 | GMGN (Trading App) | $44.96M | $230.4M | $334.9M | 14.7% (Robinhood Chain $21.2M, BSC $12.8M, Solana $6.2M) | [DefiLlama](https://api.llama.fi/summary/fees/gmgn?dataType=dailyFees) |
| 2 | Axiom (Trading App) | $38.22M | $301.1M | $760.3M | 82.5% (Solana $30.7M, Robinhood Chain $6.0M, BSC $0.6M) | [DefiLlama](https://api.llama.fi/summary/fees/axiom?dataType=dailyFees) |
| 3 | fomo Wallet (Trading App) | $34.01M | $79.3M | $81.1M | 41.3% (Robinhood Chain $13.8M, Solana $13.5M, BSC $3.4M) | [DefiLlama](https://api.llama.fi/summary/fees/fomo-wallet?dataType=dailyFees) |
| 4 | Phantom Wallet (Wallets; swaps/bridging) | $7.13M | $94.0M | $566.7M | 98.1% | [DefiLlama](https://api.llama.fi/summary/fees/phantom-wallet?dataType=dailyFees) |
| 5 | Terminal, pump.fun's ex-Padre (filed as Telegram Bot) | $5.32M | $44.8M | $44.8M | 99.9% | [DefiLlama](https://api.llama.fi/summary/fees/terminal?dataType=dailyFees) |
| 6 | Jupiter Aggregator (context only) | $3.77M | $34.6M | n/a | 100% | [overview API](https://api.llama.fi/overview/fees?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true&dataType=dailyFees) |
| 7 | Maestro (Telegram Bot) | $1.68M | $18.9M | $144.6M | 23.7% (Robinhood Chain $0.83M) | [DefiLlama](https://api.llama.fi/summary/fees/maestro?dataType=dailyFees) |
| 8 | Trojan, bot + Terminal (Telegram Bot) | $1.05M | $18.4M | $227.7M | 100% | [DefiLlama](https://api.llama.fi/summary/fees/trojan?dataType=dailyFees) |
| 9 | Photon (Trading App) | $0.34M | $13.4M | $441.9M | 100% | [DefiLlama](https://api.llama.fi/summary/fees/photon?dataType=dailyFees) |
| 10 | Bloom Trading Bot (miscategorised as "Gaming") | $0.21M | $7.5M | $62.8M | 100% | [DefiLlama](https://api.llama.fi/summary/fees/bloom-trading-bot?dataType=dailyFees) |
| 11 | moonshot.money | $0.21M | $5.0M | $64.7M | 100% | [DefiLlama](https://api.llama.fi/summary/fees/moonshot.money?dataType=dailyFees) |
| 12 | copyfomo (Telegram copy bot) | $0.19M | $0.19M | $0.19M | 5.4% | [DefiLlama](https://api.llama.fi/summary/fees/copyfomo?dataType=dailyFees) |
| 13 | LAB Terminal | $0.11M | $6.3M | $12.5M | 100% | [DefiLlama](https://api.llama.fi/summary/fees/lab-terminal?dataType=dailyFees) |
| 14 | BONKbot | $0.11M | $5.1M | $95.0M | 100% | [DefiLlama](https://api.llama.fi/summary/fees/bonkbot?dataType=dailyFees) |
| 15 | o1.exchange Trading Terminal | $0.06M | $2.3M | $2.4M | ~0% (mostly Base) | [DefiLlama](https://api.llama.fi/summary/fees/o1.exchange-trading-terminal?dataType=dailyFees) |
| 16 | Telemetry (BONKbot's web terminal) | $0.04M | $0.65M | $0.84M | 100% | [DefiLlama](https://api.llama.fi/summary/fees/telemetry?dataType=dailyFees) |
| 17 | MEVX | $0.04M | $1.0M | $8.8M | 100% | [DefiLlama](https://api.llama.fi/summary/fees/mevx?dataType=dailyFees) |
| — | SolTradingBot / Pepeboost / RayBot / Ave.ai | $0.03M / $0.03M / $0.03M / $0.04M | $1.37M / $1.09M / $0.39M / $0.83M | $53.9M / $9.2M / $5.6M / $1.2M | ~100% / 100% / 100% / 75% | [overview API](https://api.llama.fi/overview/fees?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true&dataType=dailyFees) |
| — | Collapsed or dormant: Banana Gun (all chains), BullX, Looter, Padre (legacy listing), Shuriken, TradeWiz, Nova, Unibot | Banana Gun ~$6K; BullX $753; Looter, Shuriken, TradeWiz, Nova, Unibot $0; Padre n/a | Banana Gun $2.54M; BullX $1.46M; Looter $0.36M; Padre $1.10M; Shuriken $25.6K; TradeWiz ~$0; Nova $2.7K; Unibot $0.02M | Banana Gun $87.1M; BullX $203.0M; Looter $18.8M; Padre $10.4M; Shuriken $6.55M; TradeWiz $4.96M; Nova $0.33M; Unibot $29.3M | — | [overview API](https://api.llama.fi/overview/fees?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true&dataType=dailyFees) |

**Monthly share of Solana-chain fees among tracked Solana trading apps and bots (Phantom wallet excluded).**
- Method: my aggregation of DefiLlama daily Solana-chain fees for 27 products. Data: the summary endpoints above, e.g. [Axiom](https://api.llama.fi/summary/fees/axiom?dataType=dailyFees) and [Photon](https://api.llama.fi/summary/fees/photon?dataType=dailyFees).
- **Jan 2025 (pool $288.9M):** Photon 29.3%, BullX 18.9%, Trojan 12.0%, Moonshot 12.0%, GMGN 9.8%, Bloom 7.0%, BONKbot 3.2%, Maestro 2.6%. Axiom earned only $0.12M that month.
- **May 2025 (pool $141.7M):** Axiom 65.4%, Photon 10.4%, Trojan 5.4%, Bloom 4.6%, GMGN 4.2%, BullX 3.7%.
- **Jul 2025 (pool $114.8M):** Axiom 72.6%, Photon 7.4%, GMGN 4.9%, Trojan 4.9%, Padre 1.7%, Bloom 1.6%.
- **Jan 2026 (pool $58.9M):** Axiom 57.1%, Terminal (pump.fun) 10.7%, GMGN 9.1%, Trojan 5.5%, Photon 4.6%, Fomo 4.0%.
- **Sep 2026 (pool $56.8M):** Axiom 52.8%, Fomo 22.7%, GMGN 10.7%, Terminal 9.2%, Trojan 1.8%, Maestro 0.6%, Photon 0.6%, Moonshot 0.4%.

**Trajectories (DefiLlama monthly Solana-chain fees).**
- Axiom peaked at $92.7M (May 2025), fell to $13.6M (Jun 2026) and rebounded to $30.0M (Sep 2026) — [DefiLlama](https://api.llama.fi/summary/fees/axiom?dataType=dailyFees).
- Photon fell from $84.6M (Jan 2025) to $0.35M (Sep 2026) — [DefiLlama](https://api.llama.fi/summary/fees/photon?dataType=dailyFees).
- BullX fell from $54.7M (Jan 2025) to ~$0 from Jun 2026 — [DefiLlama](https://api.llama.fi/summary/fees/bullx?dataType=dailyFees).
- Fomo's Solana fees grew from $0.73M (Oct 2025) to $3.8M (Jul 2026), $8.6M (Aug) and $12.9M (Sep 2026). Its all-chain total for Sep 2026 is $35.0M — [DefiLlama](https://api.llama.fi/summary/fees/fomo-wallet?dataType=dailyFees).
- Terminal went from $0.97M in its first month (Oct 2025) to $6.3M (Jan 2026) and $5.2M (Sep 2026) — [DefiLlama](https://api.llama.fi/summary/fees/terminal?dataType=dailyFees).
- GMGN's all-chain fees were $44.6M in Oct 2025, of which $41.8M came from BSC. In Sep 2026 they were $48.7M: Robinhood Chain $27.7M, BSC $12.7M, Solana $6.1M — [DefiLlama](https://api.llama.fi/summary/fees/gmgn?dataType=dailyFees).

**Third-party corroboration.**
- SolanaFloor, using Dune data (Jan–Jul 2025):
  - Photon's share of Solana trading-platform volume fell from 30.7% to under 10%.
  - Axiom's rose from 4.41% (Feb) to 57.33% (Jul).
  - Axiom reached $100M revenue in 129 days and $200M in 202 days.
  - [SolanaFloor](https://solanafloor.com/news/solana-trading-bot-axiom-becomes-the-fastest-application-to-reach-200-m-in-revenue)
- May 2025: Solana bots passed $1B cumulative revenue. Photon (>$386M), BullX (>$188M) and Trojan (~$177M) made up over 75% of it — [Bitget, citing SolanaFloor](https://www.bitget.com/news/detail/12560604757184).
- Blockworks' Dan Smith (Breakpoint, Dec 2025): about 60% of Solana transaction fees come from trading, with terminals and wallets a core category. He gave no per-app figures — [Solana Compass](https://solanacompass.com/learn/breakpoint-25/the-state-of-revenue-on-solana-blockworks-dan-smith).

**Self-reported users and volume** (marketing figures, undated unless noted).

| Product | Claim | Source |
|---|---|---|
| Trojan | $25B lifetime volume, 2M users, 140M trades | [trojanonsolana.com](https://trojanonsolana.com/) |
| Banana Gun | 26M+ trades, $16B+ volume, 1.5M+ users | [bananagun.io](https://bananagun.io/) |
| BONKbot | 69.3M trades, $10.1B volume, 452K users (page dated 17 Mar 2026) | [bonkbot.io](https://bonkbot.io/) |
| Sol Trading Bot | $5.2B volume, 1.2M users | [soltradingbot.com](https://soltradingbot.com/) |
| Fomo | 625K+ users, $4B+ volume, 68K first-time Apple Pay buyers (22 Jun 2026) | [Fomo Series B post](https://fomo.family/blog/fomo-series-b) |
| Fomo | "2,500,000 traders" (Oct 2026) | [fomo.family](https://fomo.family/) |
| Moonshot | 2M+ users | [moonshot.com](https://moonshot.com/) |
| Moonshot | ~$400M volume around the TRUMP launch; #1 in US App Store Finance; >1M DAU (Jan 2025) | [Bitget/Grafa](https://www.bitget.com/news/detail/12560604528488) |
| Padre (pre-acquisition page) | $500M+ volume, 35K+ users | [padre.gg](https://padre.gg/) |
| TradeWiz | $432.3M lifetime volume, 45.5K users; peaked at $4–5M/day (Nov 2024–Jan 2025), ~$1.7K/day by Jan 2026 | [coincodecap (affiliate)](https://coincodecap.com/tradewiz-review) |
| Looter | $115M+ volume, 9K+ users | [looter.ai](https://www.looter.ai/) |
| Uxento | 20,000 extension users, 4.4★ from 58 ratings | [Chrome Web Store](https://chromewebstore.google.com/detail/uxtension/pljeffieceahpjcgldlglfidenecjloh) |

**Acquisitions, shutdowns and pivots.**
- **pump.fun bought Padre** (announced 24 Oct 2025) — [Cryptobriefing](https://cryptobriefing.com/pump-fun-acquires-padre-trading-terminal-multi-chain-expansion/).
  - The PADRE token lost all utility. It fell 67% per [DL News](https://www.dlnews.com/articles/defi/pump-fun-placates-padre-tokenholders-with-airdrop-promise/), or 80% per [BeInCrypto](https://beincrypto.com/pump-fun-padre-terminal-acquisition-token-crash/). Holders were promised a PUMP airdrop.
  - DefiLlama now lists "Terminal … Pump.fun's advanced memecoin trading terminal … previously known as Padre" at terminal.pump.fun — [DefiLlama](https://api.llama.fi/summary/fees/terminal?dataType=dailyFees).
  - The login page there still shows the Padre logo and Padre terms of service — [terminal.pump.fun](https://terminal.pump.fun/).
- **pump.fun then bought the Vyper terminal** (early 2026) and is shutting its core functions, redirecting users to Terminal — [Cointelegraph via TradingView](https://www.tradingview.com/news/cointelegraph:38b828f1a094b:0-pump-fun-moves-deeper-into-trading-infrastructure-with-vyper-acquisition/).
- **Coinbase bought Vector.fun** (Tensor Labs' Solana social memecoin app) on 21 Nov 2025 and said it would close the apps — [Fortune](https://www.fortune.com/2025/11/21/coinbase-buys-solana-vector-fun-acquisition-spree); [The Block](https://www.theblock.co/post/379964/coinbase-vector-fun-tensor-solana-everything-exchange-vision).
- **Jupiter took a majority stake in Moonshot** (25 Jan 2025) — [Bitget/Grafa](https://www.bitget.com/news/detail/12560604528488).
- **Fasol is suspended.** Its official site shows "service suspended … Fasol has been compromised". The notice is undated (fetched 3 Oct 2026) — [fasol.trade](https://fasol.trade/).
- **BullX NEO looks dormant.** As of 16 Sep 2026 it was "wallet-only … no chains are active for trading" ([solanatradingbots (affiliate)](https://solanatradingbots.com/bullx-how-to-use/)), consistent with $753 in 30-day fees ([DefiLlama](https://api.llama.fi/summary/fees/bullx?dataType=dailyFees)).
- **Shuriken pivoted** to alpha-call trading and AI agents (MCP server, scoped agent keys) — [Shuriken docs](https://docs.shuriken.trade/introduction).
- **Nova's docs** still describe "Phase 1", and their web-access link points to `axiom.trade/@tradenova` — [Nova docs](https://docs.tradeonnova.net/llms-full.txt).
- **Trojan launched a web "Trojan Terminal"** at trojan.com (Privy self-custody) alongside its Telegram bot. DefiLlama counts "Trojan bot and Terminal fee wallets (Terminal also collects USDC)" — [trojan.com](https://trojan.com/); [DefiLlama](https://api.llama.fi/summary/fees/trojan?dataType=dailyFees).
- **BONKbot** split out the Telemetry web/mobile terminal — [BONKbot docs](https://docs.bonkbot.io/); [DefiLlama](https://api.llama.fi/summary/fees/telemetry?dataType=dailyFees).
- **Ape Pro** is absent from current Jupiter docs, and ape.pro returned HTTP 403. DefiLlama's "Ape Jupiter" earned $0 in 30 days and $6.9K in a year. Jupiter Spot now has "Classic mode and Trench mode (pro UX)" — [Jupiter Spot](https://docs.jup.ag/user-docs/trade/spot/index.md); [overview API](https://api.llama.fi/overview/fees?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true&dataType=dailyFees).

### Inferences
- **The real competitive set is small.** For a Solana web terminal in Oct 2026 it is:
  - Axiom (dominant on Solana)
  - GMGN (most features; its growth is now off Solana)
  - pump.fun Terminal (integrated with the launchpad)
  - Trojan (bot plus new web terminal)
  - Fomo (mobile/social; fastest growth)
  - Phantom (wallet-native swaps)

  Photon, BullX and Banana Gun now matter mainly as feature references.
- **The fee pool shows what a zero-fee pitch is worth.** About $57M/month in Solana trading-app fees (Sep 2026) is what users currently pay. A trader doing $100K/month in volume pays roughly $650–1,000/month at the 0.65–1% net fees typical of these tools.
- **Fee share is not volume share.** Fomo's per-trade fee is undisclosed and variable. Axiom's counted fees include referral payouts. Banana Pro and BullX NEO may be under-tracked by their DefiLlama listings.
- **Feature breadth did not protect incumbents.** Photon and BullX had broad feature sets but lost most of their share within roughly two quarters of Axiom's launch (DefiLlama series above). Execution speed, UX and referral economics seem to matter more than having the longest feature list. This is interpretation, not measured.

### Gaps
- **Volume.** Per-app trading volume (as opposed to fees), DAU/MAU and retention for 2026 were not obtained.
  - Dune dashboards could not be fetched.
  - Blockworks Research and Artemis per-app data were not accessible.
- **Messari Q1 2026 (unverified).** A search snippet from "State of Solana Q1 2026" said Q1 2026 revenue was Pump.fun $123M, Axiom $58M, Phantom $33M and Jupiter $14M, and that the trading-app sector grew from $56.5M to $79.0M quarter on quarter. The page returned 429, so this is unverified — [Messari](https://messari.io/report/state-of-solana-q1-2026).
- Phantom's memecoin-specific features (trending, trench-style views) were not researched.
- Whether Fomo's Robinhood Chain fees come from memecoins or tokenized stocks was not checked.

## 2. Per-tool feature profiles (what each tool offers)

### Takeaway
Most tools now share a core: a three-column launch feed, quick-buy presets, MEV modes, limit/TP-SL orders, and wallet and X trackers. They differ mainly in automation depth.
- **Deepest automation: GMGN, Trojan (bot plus new web Terminal), Bloom and MevX.** These offer migration snipes, X-contract-address auto-snipes, dev-sell-triggered orders, trailing/DCA orders and detailed copy trading.
- **Execution-first products.** Banana Pro, BONKbot/Telemetry and Nova focus on execution, presets and MEV routing.
- **Consumer apps.** Fomo and Moonshot compete on mobile onboarding (Apple Pay, gasless) and social features, not tooling.

### Cited Findings

#### 2a. Web terminals

**GMGN.ai.** Web terminal, Telegram bots and mobile app; 11 chains; fee 1%; perps: none found.
- **Fee:** 1% per transaction, "no additional charges" — [GMGN fees](https://docs.gmgn.ai/index/gmgn-fees-settings).
- **Trenches (discovery):** three columns, New / Almost bonded / Migrated — [Trenches hotkeys](https://docs.gmgn.ai/index/trenches-hotkeys.md).
  - Pause the live feed on hover.
  - X preview hotkey (`X`), and web preview (`V`) that auto-plays linked YouTube, TikTok or Instagram videos.
  - Keyboard-only quick-buy: hover a column, hold `Z`, press a row number; or hold `Space` + column key + row key.
- **Signal page:** Dex Paid / Boost / Bar paid; social updates; Price Up, ATH and Key-MC alerts; Pump Live; CTO. Filters by Age, MC and Total Fees. The app adds an "AI Signal" tab — [GMGN alerts/orders](https://docs.gmgn.ai/index/alert-sniper-new-following-limit-orders.md).
- **Wallet Radar:** scans up to 10 tokens at once for wallets that are Most Bought, Highest Profit, Earliest Bought or Shared Holdings, then exports them to tracking or sets up a one-click copy trade — [Wallet Radar](https://docs.gmgn.ai/index/wallet-radar.md).
- **Smart-money feed** with red-bubble and sound alerts — [Track smart money](https://docs.gmgn.ai/index/track-smart-money).
- **Sniping:**
  - **Migrated Snipe:** a pre-set buy that fires when DEX liquidity is added. One task per token; TP/SL including trailing — [Migrated Snipe](https://docs.gmgn.ai/index/auto-trading-migrated-snipe.md).
  - **SnipeX** — [SnipeX](https://docs.gmgn.ai/index/snipex.md):
    - Watches chosen X accounts and auto-buys contract addresses found in new tweets, replies, profile updates or reposts.
    - Filters: mcap, liquidity, token age, minimum burn ratio; "Skip Holdings".
    - Up to 10 TP/SL conditions.
    - Limits: 10 tasks, each lasting 7 days.
  - **Telegram auto-buy on contract-address paste** — [GMGN TG Sniper Bot](https://docs.gmgn.ai/index/gmgn-tg-sniper-bot-sol).
  - A filter-based launch auto-sniper is not documented. An "Auto Trading" order type exists, but its details are unverified — [GMGN alerts/orders](https://docs.gmgn.ai/index/alert-sniper-new-following-limit-orders.md).
- **Orders:**
  - Limit orders with 1h, 24h or 3d expiry — [TG Sniper Bot](https://docs.gmgn.ai/index/gmgn-tg-sniper-bot-sol).
  - Multi-level TP/SL; sells by amount or %; triggers on ±% or price — [Auto-sell](https://docs.gmgn.ai/index/auto-sell-auto-sell-take-profit-stop-loss).
  - Trailing SL (stop = peak × (1 − drawdown)) and trailing TP — [Trailing stop](https://docs.gmgn.ai/index/trailing-stop-loss.md).
  - The Orders tab covers Limit, Auto Trading, Migrated Snipe, **Sell on Dev Sell**, **Buy on Dev Sell** and Advanced strategies, plus "Close All Orders" in the app — [GMGN alerts/orders](https://docs.gmgn.ai/index/alert-sniper-new-following-limit-orders.md).
  - DCA: not found.
- **Anti-rug, "CA Security Checks"** — [CA checks](https://docs.gmgn.ai/index/ca-security-checks.md):
  - Solana: MintDisable; Top-10 holding under 30%; Blacklist ("your wallet is frozen"); burnt LP %; **Rug probability** (based on holders who often buy rugs); **Rug History** (the creator's earlier rugs).
  - ETH: honeypot (via GoPlus), verified source, renounced, LP locked/burned, buy/sell tax.
- **Holder tags:** Insider, Sniper, First 70 buyers, Scammer wallets; holder statuses (Hold / Buy More / Sell Part / Sell All / Transferred) — [Insider tags](https://docs.gmgn.ai/index/insider-traders-snipers-first-70-buyers.md).
- **Copy trading** — [Copy Trade](https://docs.gmgn.ai/index/copy-trade-copy-smart-money-automatically-earn-sol.md):
  - Sizing: fixed buy, or "maximum follow-buy" (match the source wallet up to a cap). Min/max size of the source's buy; a limit on repeat buys of the same token.
  - Filters: mcap, liquidity, age, minimum burn ratio, platform.
  - Sells: proportional follow-sell, no follow-sell, TP/SL, or tiered TP/SL.
  - Per-task priority fee, anti-MEV and slippage.
  - Limits: 10 tasks, 20-token blacklist.
  - No copy-delay setting found.
- **Multi-wallet:** up to 10 SOL wallets. One buy fires across the selected wallets; sells are proportional per wallet. Moving funds between wallets needs 2FA — [Multi-wallet](https://docs.gmgn.ai/index/tg-wallet-connect-tg-multi-wallet-system.md).
- **MEV:** anti-MEV off / reduced / secure; anti-MEV needs at least 0.002 SOL priority fee; priority fee and tip are each at least 0.0001 SOL, with a 2 SOL combined cap — [GMGN fees](https://docs.gmgn.ai/index/gmgn-fees-settings).
- **Tracking and alerts:**
  - Wallet tracker with web notifications, a Telegram **"0-Delay Bot"** for real-time trade alerts, and app push notifications — [GMGN alerts/orders](https://docs.gmgn.ai/index/alert-sniper-new-following-limit-orders.md).
  - **X Tracker** — [X Tracker](https://docs.gmgn.ai/index/x-tracker.md):
    - 2,000+ curated Master/Trader/KOL accounts.
    - Event types: Tweet, Reply, Retweet, Quote, Bio update.
    - A contract-address-only filter, and a ⚡ quick-buy button next to detected CAs.
    - Up to 5 custom accounts outside the curated list.
  - **Telegram group bots** — [TG alert bots](https://docs.gmgn.ai/index/gmgn-tg-alert-channel-bot.md):
    - Contract Query bot: paste a CA or wallet in a group and get an analysis card.
    - Smart Money Tracking bot.
    - Group owners earn commissions.
    - Official channels were made private "to avoid scam ads".
- **Mobile and API:**
  - GMGN App with Monitor, Track and Assets tabs and push notifications — [GMGN alerts/orders](https://docs.gmgn.ai/index/alert-sniper-new-following-limit-orders.md).
  - Agent API and `npx gmgn-cli` for AI agents (Claude Code, OpenClaw). Trading needs an API key plus a private key — [Agent API](https://docs.gmgn.ai/index/gmgn-agent-api.md).
- **Custody (conflict):**
  - Telegram wallets support key export — [TG Sniper Bot](https://docs.gmgn.ai/index/gmgn-tg-sniper-bot-sol).
  - The docs call a Phantom-login account a "multi-chain custodial wallet account" where key export is "prohibited" — [Multi-wallet](https://docs.gmgn.ai/index/tg-wallet-connect-tg-multi-wallet-system.md).
  - That contradicts the "non-custodial" marketing. Security extras: Google Authenticator 2FA, a withdrawal whitelist, and a 3-hour wait before the first withdrawal — [solbotrank](https://solbotrank.com/guides/is-gmgn-safe).
- **Rewards:** 30% referral, plus commissions for adding GMGN bots to Telegram groups — [GMGN docs](https://docs.gmgn.ai).
- **Incidents** (secondary source, [solbotrank](https://solbotrank.com/guides/is-gmgn-safe)):
  - 25 Oct 2025: an anti-MEV node failed, and 729 BNB Chain transactions were sandwiched. Users were reimbursed automatically.
  - 28 Oct 2025: phishing through a forged third-party token site hit ~107 users, who were reimbursed the same day.
  - Jul 2025: a fake GMGN drainer site.
  - The docs warn about clipboard-stealing malware and fake admins — [GMGN Q&A](https://docs.gmgn.ai/index/q-a.md).

**pump.fun Terminal (formerly Padre).** Web terminal; SOL/ETH/BNB/Base; ~1% fee with up to 35% cashback; perps unconfirmed.
- **Status:**
  - Acquired 24 Oct 2025. pump.fun said trading "continue[s] as usual" — [Bitget](https://www.bitget.com/news/detail/12560605030072).
  - The login page reads "Up to 35% cashback. Fastest execution. Full control." — [terminal.pump.fun](https://terminal.pump.fun/).
  - **Conflict:** one affiliate site (29 Sep 2026) says the live URL is trade.padre.gg, not terminal.pump.fun — [solanatradingbots (affiliate)](https://solanatradingbots.com/padre-gg-how-to-use/).
- **Fee:** 1% per code analysis. Direct signups get 10% cashback (0.90% net); referred signups up to 35% (0.65% net) — [solbotrank](https://solbotrank.com/guides/padre-terminal-explained).
- **Features advertised on the Padre homepage** (likely written before the acquisition) — [padre.gg](https://padre.gg/):
  - "Every transaction is simulated to minimize number of reverts".
  - Copy trading, and limit orders with automatic exits (buy-the-dip, TP, SL).
  - Multi-chain portfolio with historical PnL and balance charts, including imported wallets; "know the expected payout before the swap".
  - 2FA, Turnkey keys, and private keys encrypted with a user-chosen password.
  - bloXroute MEV protection.
  - "Trenches and Alpha Tracker".
- **2026 descriptions:**
  - Alpha Tracker aggregates Discord, Telegram and X callouts. Up to five exit conditions (TP, SL, trailing SL, buy-the-dip, dev-sell, DCA). Copy-trade automation "removed" (only a legacy tag remains). No native mobile app as of Aug 2026 — [solbotrank](https://solbotrank.com/guides/padre-terminal-explained).
  - Another source says MEV off/secure modes, multi-wallet execution, and wallet plus X tracking are confirmed, while the dev-sell rules and copy trading are "unresolved" — [solanatradingbots (affiliate)](https://solanatradingbots.com/padre-gg-how-to-use/).
- **Token:** PADRE "will no longer have utility"; the community called it a "rug pull" — [Bitget](https://www.bitget.com/news/detail/12560605030072).

**Trojan: Telegram bot plus the new web "Trojan Terminal".** Solana; 1% fee with SOL cashback by rank; perps: yes (Terminal, via Hyperliquid).
- **Terminal basics** — [Trojan FAQs](https://docs.trojan.com/faqs.md); [trojan.com](https://trojan.com/):
  - Non-custodial; "think CEX + DEX + screener".
  - Log in with a Solana wallet or a passkey.
  - 1% per trade, with SOL cashback that rises with rank.
  - Wallets on Privy infrastructure ("Trusted Hardware").
- **The bot still runs** as 10 interchangeable instances (Main, Achilles, …) that share wallets and settings — [bot quick start](https://docs.trojanonsolana.com/overview/quick-start-guide).
- **Trenches:** New Tokens / About to Migrate / Migrated — [Trojan Trenches](https://docs.trojan.com/terminal-overview/meme-coin-trenches.md).
  - Can be docked, floating, or opened in a new window.
  - Quick-buy amount set per column; buy by % of supply; a second quick button that sells a set %.
  - Blacklist with import/export.
  - Dev token stats (migrated / launched); colour thresholds for mcap, volume and holders.
  - "Migration Sell and Snipe icons appear on the card as a token begins to migrate."
- **Other discovery:**
  - Token Audits (contract functions, sniped and bundled %, top holders), watchlists and an Explorer with DEX filters — [trojan.com](https://trojan.com/); [docs index](https://docs.trojan.com/llms.txt).
  - The bot has New Pairs Scanner channels — [bot docs](https://docs.trojanonsolana.com/llms-full.txt).
- **Sniping** — [bot docs](https://docs.trojanonsolana.com/llms-full.txt):
  - Bot **Auto Sniper**. Filters: mint/freeze authority, socials, whitelist/blacklist of tickers, addresses and dev wallets, liquidity, pool supply %, mcap, dev holding %.
  - Bot **Migration Sniper**: buy or sell on migration.
  - Auto-buy when a CA is pasted.
  - The Terminal's **Clipboard Buy** buys whatever CA is on the clipboard in one click — [Clipboard Buy](https://docs.trojan.com/trading-on-trojan/trojan-swaps/clipboard-buy.md).
  - X auto-sniping: not found. The X Tracker highlights CAs and opens the trade page on click — [X Tracker](https://docs.trojan.com/terminal-overview/tools-and-widgets/trojan-x-tracker.md).
- **Orders:**
  - Limit orders by price or mcap %, across one or several wallets — [Limit orders](https://docs.trojan.com/trading-on-trojan/trojan-swaps/limit-orders.md).
  - **Auto-Sell** creates limit orders the moment you buy, with triggers set relative to entry. The docs' example: 50% at 2x, 10% at 3x, 10% at 4x, SL −25% — [Auto-Sell](https://docs.trojan.com/trading-on-trojan/trojan-swaps/auto-sell.md).
  - DCA buy and sell: interval, duration, mcap range, multi-wallet, SOL/USD1/USDC — [DCA](https://docs.trojan.com/trading-on-trojan/trojan-swaps/dca-crypto.md).
  - Order tabs: Limit / DCA / **Event** — [Orders](https://docs.trojan.com/terminal-overview/tools-and-widgets/orders.md).
  - Instant Trade floating window with hotkeys — [Instant Trade](https://docs.trojan.com/trading-on-trojan/trojan-swaps/instant-trade.md).
  - The bot adds a trailing SL measured from the highest price — [bot docs](https://docs.trojanonsolana.com/llms-full.txt).
- **Copy trading (Terminal)** — [Copy Trading](https://docs.trojan.com/terminal-overview/tools-and-widgets/copy-trading-bot.md):
  - Size as a % of the target's buy or as fixed SOL; choose the execution wallet.
  - Priority fee, bribe, slippage and MEV protection set per copy.
  - **Copy Sell** sells the same % the target sells. **Auto Sell** attaches TP/SL.
  - Mcap range; minimum liquidity; **Max Spend Per Buy**; **Exclude Launchpad Platforms**; **Prevent Duplicate Buys**; batch pause/resume.
  - The docs warn that copying snipers makes you their exit liquidity, and that wallets buying through custom programs cannot be copied.
- **Multi-wallet:** 10 active wallets (archive old ones for more); deposit (including MoonPay), withdraw, consolidate, distribute, groups, and key import/export — [Wallet management](https://docs.trojan.com/trading-on-trojan/wallet-management.md).
- **Execution:**
  - Profiles set priority fee, bribe, slippage, snipe slippage and MEV protection.
  - **Spam Buy/Sell** fires up to 10 rapid-fire transactions, presented as a way to "reduce MEV risk" — [Profiles/Settings](https://docs.trojan.com/trading-on-trojan/profiles-settings.md).
  - Bot gas presets: Fast 0.0015 SOL and Turbo 0.0075 SOL. "Waits for a MEV protected slot." A Confirm Trades toggle — [bot quick start](https://docs.trojanonsolana.com/overview/quick-start-guide); [bot docs](https://docs.trojanonsolana.com/llms-full.txt).
- **Tracking:**
  - Wallet Tracker — [Wallet Tracker](https://docs.trojan.com/terminal-overview/wallet-tracker.md):
    - Emoji markers on charts.
    - Per-wallet toast and alert toggles, action types and custom sounds.
    - JSON import/export; groups (imports default to "KOLs").
    - **Tracked dev wallets show as tags on Trenches cards.**
    - Alert filters: First Buy, Buy More, Sell Partial, Sell All, Transfer, Token Launch, plus mcap, size and age ranges.
    - A Monitor dashboard.
  - X Tracker with CA and cashtag highlighting, sounds, and toggles for replies, reposts, quotes and Truth Social posts — [X Tracker](https://docs.trojan.com/terminal-overview/tools-and-widgets/trojan-x-tracker.md).
  - **Alpha** — [Alpha](https://docs.trojan.com/terminal-overview/alpha.md):
    - Telegram and Discord group calls pulled in through the TokenScan bot (`/connect`).
    - A global group and caller leaderboard.
    - An anti-spam cap of 40 calls per group per day.
- **Analytics:** Wallet Analyzer; custom PnL cards with a "fees included" toggle and a PnL mode of Default or Lifetime — [Settings](https://docs.trojan.com/trojan-basics/settings.md).
- **Mobile:** a mobile web app installable to the home screen, with orders and wallets synced to desktop — [Trojan Mobile](https://docs.trojan.com/additional-info/trojan-mobile.md).
- **Bot security and links** — [bot docs](https://docs.trojanonsolana.com/llms-full.txt):
  - Keys are encrypted server-side and exportable.
  - An optional **Secure Action Password**, which cannot be recovered.
  - Deep link `t.me/solana_trojanbot?start=r-{refcode}-{tokenCA}`.

**Photon.** Web terminal; only Solana live; fee 1% (conflicting reports); perps: no.
- **Status:** active, run by Tiny Astro Inc. — [solbotrank](https://solbotrank.com/guides/is-photon-safe).
  - ETH, Base and BNB trading disabled as of 16 Sep 2026 — [solanatradingbots (affiliate)](https://solanatradingbots.com/photon-how-to-use/).
- **Fee:** 1% per buy and sell — [solbotrank](https://solbotrank.com/guides/how-to-use-photon). The affiliate site says no fee is disclosed.
- **Features** — [solbotrank](https://solbotrank.com/guides/how-to-use-photon):
  - Live Pairs, Trending and the Memescope screener.
  - Limit orders including TP/SL; DCA; auto-buy/auto-sell triggered by mcap % change.
  - Up to 5 wallets active at once.
  - "Smart-MEV" Fast/Secure modes via Jito or **bloXroute**; presets S1/S2/S3.
- **Not found:** copy trading, migration sniping, X tracking, trailing stops — [solanatradingbots (affiliate)](https://solanatradingbots.com/photon-how-to-use/).
- **Custody:** the generated wallet's key is shown only once — [solbotrank](https://solbotrank.com/guides/is-photon-safe).
- **Sentiment:** Trustpilot 2.0/5 from 20 reviews, mostly fees and failed sells. A phishing clone, photon-sol.com, was flagged in Nov 2025, and drainer campaigns impersonated Photon in Feb 2026 (Recorded Future) — [solbotrank](https://solbotrank.com/guides/is-photon-safe).

**BullX NEO.** Web terminal with Telegram login; fee 1%; perps: no; status: likely dormant.
- **Status:** "Wallet-only … no chains are active for trading" (16 Sep 2026) — [solanatradingbots (affiliate)](https://solanatradingbots.com/bullx-how-to-use/). DefiLlama shows $753 in 30-day fees — [DefiLlama](https://api.llama.fi/summary/fees/bullx?dataType=dailyFees).
- **Historic features** — [boxmining](https://boxmining.com/bullx-tutorial/); [solanatradingbots (affiliate)](https://solanatradingbots.com/bullx-how-to-use/):
  - Pump Vision, a board for pump.fun launches.
  - Limit orders placed on the chart.
  - Multiple wallets per chain.
  - Non-custodial key, shown once.
  - Access by referral code only.

**Banana Pro (web) plus the Banana Gun Telegram bots.** Solana, ETH, BSC, Base, Robinhood, Stable, HyperEVM, MegaETH. Fee: 0.5% for manual trades on ETH and 1% elsewhere and for snipes (sources conflict). Perps: no; prediction markets via Banana Predict.
- **Fee conflict:** the homepage says 0.5% manual and 1% snipes, without naming chains — [bananagun.io](https://bananagun.io/). The docs say 0.5% only for ETH manual/limit trades — [Banana docs](https://docs.bananagun.io/llms-full.txt).
- **Live Pairs Feed** — [Banana Pro docs](https://banana-gun.gitbook.io/banana-pro/):
  - Columns: New Deploys / Close to Migration / New Pairs.
  - Card shows holders, dev %, bundled %, sniper %, top-10 %, mcap, volume, and a search of X for the CA.
  - Filters apply globally or per column: launchpad, socials, min/max metrics.
- **Widgets** — [Banana Pro docs](https://banana-gun.gitbook.io/banana-pro/):
  - Bubble Map of holder clusters (InsightX).
  - Top Traders: the top 50 by PnL, labelled developer, bundler, pump.fun buyer, sniper, dev-connected or cluster. Hovering shows a PnL card with a copy button.
  - Watchlist, customizable layouts.
- **Sniping:**
  - **Snipe widget** fires when liquidity is added or when a token migrates from pump.fun or another launchpad to Raydium — [Banana Pro docs](https://banana-gun.gitbook.io/banana-pro/):
    - Min/max liquidity in SOL; min/max liquidity in tokens.
    - "Min Token": the transaction reverts if the price has moved too high.
  - **Quick Snipe** for migrating tokens, with a bundle-fee toggle and a duration — [Banana Pro docs](https://banana-gun.gitbook.io/banana-pro/).
  - **SOL bot Auto Sniping:** paste a CA that is not yet live; a "Banana SOL Deployer" channel posts new deploys — [Banana Gun SOL docs](https://banana-gun.gitbook.io/banana-gun-solana/).
  - **Telegram Scraper** (desktop tool): buys or auto-snipes CAs that bots or admins post in channels you choose — [Banana docs](https://docs.bananagun.io/llms-full.txt).
- **Orders:**
  - Limit orders with a duration; pending-order management; a **Quick Sell Limit** for tokens bought while still on the bonding curve — [Banana Pro docs](https://banana-gun.gitbook.io/banana-pro/).
  - SOL bot: TP/SL triggered by mcap or price % — [Banana Gun SOL docs](https://banana-gun.gitbook.io/banana-gun-solana/).
  - DCA is mentioned on the homepage — [bananagun.io](https://bananagun.io/).
- **Anti-rug:** "built-in antirug" that "automatically attempts to front-run" malicious contract activity — [bananagun.io](https://bananagun.io/). Price-impact limit — [Banana Pro docs](https://banana-gun.gitbook.io/banana-pro/).
- **Copy trading:**
  - Pro offers Simple, Advanced and Advanced-with-presets setups — [Banana Pro docs](https://banana-gun.gitbook.io/banana-pro/):
    - MAX BUY; a **SPEND LIMIT** across all copies of one target.
    - Slippage, duration, MEV tip.
    - Warns that target wallets "may become malicious" and use copiers as exit liquidity.
  - SOL bot: `/copytrade`, with an active-time window and a spending limit — [Banana Gun SOL docs](https://banana-gun.gitbook.io/banana-gun-solana/).
- **Execution:**
  - Every widget offers "MEV Protection" (Jito only) or "Public" (fastest, uses both gas and tip).
  - The docs explain priority fee vs MEV tip and suggest a 70/30 split — [Banana Pro docs](https://banana-gun.gitbook.io/banana-pro/).
  - SOL bot: Anti-MEV / Off / "Anti-MEV + Public"; Auto Gas; backup bots, where "all settings and wallets remain identical" — [Banana Gun SOL docs](https://banana-gun.gitbook.io/banana-gun-solana/).
  - Claims "50% faster execution speeds vs. other terminals" — [bananagun.io](https://bananagun.io/).
- **Security:**
  - Pro's Security PIN — [Banana Pro docs](https://banana-gun.gitbook.io/banana-pro/):
    - Auto-locks after a session of 1 hour to 7 days.
    - A new PIN activates after 8 hours, and PIN changes also take 8 hours.
    - Resetting a forgotten PIN takes 7 days.
  - SOL bot PIN, with `/refresh` to extend the session — [Banana Gun SOL docs](https://banana-gun.gitbook.io/banana-gun-solana/).
  - Privy login; key shown once — [solanatradingbots (affiliate)](https://solanatradingbots.com/banana-gun-terminal-how-to-use/).
- **Token:** BANANA holders get 40% of revenue after referrals — [Banana docs](https://docs.bananagun.io/llms-full.txt).
- **Incident:** 19 Sep 2024, $3.0M. DefiLlama classifies it as "Frontend & Infrastructure — Frontend Compromise", with $3.0M returned — [DefiLlama hacks](https://api.llama.fi/hacks).

**LAB Terminal (lab.pro).** Solana trading terminal plus a mobile "social crypto app"; fee 0.5%; perps: no (the app offers tokenized stocks).
- **Fee:** 0.5%, marketed as "50% less than most other platforms" — [LAB features](https://docs.lab.pro/intro/introducing-lab-terminal-your-new-way-to-trade/unique-features-and-benefits.md).
- **Smart Order** — [How it works](https://docs.lab.pro/smart-order/how-does-it-work.md); [Customizable features](https://docs.lab.pro/smart-order/customizable-features.md):
  - Spreads orders across a price or mcap range, with an adjustable number of levels.
  - The range can be set manually or chosen automatically.
  - Three closing strategies: close at the level; wait for a confirmed reversal; or re-range dynamically when price leaves the range.
- **Boost Mode:** paste a CA to open a panel with three speed presets and Jito MEV protection — [Boost](https://docs.lab.pro/boost-mode/boost-your-trades.md).
- **Extension:** "works on top of any terminal you already use". It detects the token pair, places the trade through LAB, and links to a LAB Telegram bot — [LAB Extension](https://docs.lab.pro/browser-extension/meet-the-lab-terminal-extension.md).
- **Other:**
  - PnL token cards; 4-level referral; $LAB airdrop points — [LAB docs index](https://docs.lab.pro/llms.txt).
  - "Track smart wallets"; iOS and Android app; backers include Lemniscap, OKX Ventures, KuCoin Ventures, GSR and Animoca — [lab.pro](https://lab.pro/).

#### 2b. Telegram-first bots

**BONKbot (with the Telemetry terminal and the Nighthawk sniper).** Solana; fee 1%; perps: no.
- **Products:** BONKbot (Telegram), Telemetry (web terminal), Telemetry Mobile, and Nighthawk (a separate sniping bot) — [BONKbot docs](https://docs.bonkbot.io/); [docs full](https://docs.bonkbot.io/llms-full.txt).
- **Discovery** — [docs full](https://docs.bonkbot.io/llms-full.txt):
  - Telemetry "X-Ray" columns: New Creations / About to Graduate / Graduated, across launchpads. Pauses on hover; filters persist.
  - Discovery module: trending, whale moves, launchpad volume.
  - Token Alerts channels: New Pools over $500, Renounced, Burned.
- **Sniping** — [docs full](https://docs.bonkbot.io/llms-full.txt):
  - Auto-buy on paste (BONKbot "will NOT ask" for confirmation).
  - Nighthawk **Precision** snipes cap the mcap, with a fixed loss if exceeded. **Speed** snipes accept any mcap but cap fee plus bribe.
  - Tracks launchpad-to-DEX migrations.
- **Orders:** limit triggers by mcap, USD price, multiple or % change; Buy Dip, Buy Breakout, TP, SL, Trailing SL; DCA; partial fills with "off-chain concealment"; Telemetry Auto Strat — [docs full](https://docs.bonkbot.io/llms-full.txt).
- **Token card:** mint/freeze authority, LP burnt, top-10 %, dev holding %, dev address and **dev funding source** — [docs full](https://docs.bonkbot.io/llms-full.txt).
- **Copy trading:** not found.
- **MEV:**
  - Turbo mode uses Jito when Jito is fastest and otherwise sends unprotected. Secure mode "guarantees protection at all costs".
  - Priority tiers; P1–P4 presets.
  - [Turbo mode](https://docs.bonkbot.io/telemetry/trading/turbo-mode); [Presets](https://docs.bonkbot.io/telemetry/trading/presets).
- **Tracking:** Telemetry Wallet Tracker. Sounds: "Buys = plink. Sells = plonk". Chart overlays show dev and tracked-wallet trades — [docs full](https://docs.bonkbot.io/llms-full.txt).
- **Security:** 2FA with a backup key that BONKbot "physically cannot recover or disable"; passkeys — [docs full](https://docs.bonkbot.io/llms-full.txt).
- **Rewards:** up to 25% cashback by rank — [BONKbot docs](https://docs.bonkbot.io/).

**Maestro.** Telegram bot family plus a desktop Scraper; 12 chains; fee 1%, Premium $200/month; perps: no.
- **Discovery:**
  - Signals / Call Channels can auto-buy and auto-sell on channel calls — [Maestro docs](https://docs.maestrobots.com/llms-full.txt).
  - Premium adds `/trending`, a "Hits indicator" and a Launch Simulator — [Premium](https://docs.maestrobots.com/sniper/premium-subscription.md).
- **Sniping:**
  - Auto Snipe on ETH, BSC, Base and Solana — [Maestro docs](https://docs.maestrobots.com/llms-full.txt):
    - Method and deadblock detection.
    - Tax thresholds; dynamic max-buy.
    - Block-0 tipping (ETH).
  - Auto-buy on a pasted contract — [Maestro docs](https://docs.maestrobots.com/llms-full.txt).
  - 5 auto-snipes per chain on the base tier, 10 on Premium — [Premium](https://docs.maestrobots.com/sniper/premium-subscription.md).
- **Orders:** TP, SL and trailing SL by price or mcap, lasting up to 168h; buy limits; 60 or 120 orders depending on tier. DCA: not found — [Maestro docs](https://docs.maestrobots.com/llms-full.txt); [Premium](https://docs.maestrobots.com/sniper/premium-subscription.md).
- **Anti-rug:**
  - Auto-buy is blocked on detected honeypots, blacklist risk, taxes that cannot be estimated, or liquidity under 1%, unless Degen Mode is on — [Maestro docs](https://docs.maestrobots.com/llms-full.txt).
  - Revoke-approvals button — [Token report](https://docs.maestrobots.com/sniper/pasted-contracts/token-report-menu.md).
- **Copy trading** — [Maestro docs](https://docs.maestrobots.com/llms-full.txt):
  - Follows 5 wallets per chain on the base tier, 12 on Premium.
  - Max Buy plus Buy % (up to 1000%); MC, liquidity and tax filters.
  - Copy Sell; Track Only; Blind Follow.
  - **Frontrun** on EVM chains (outbids the target's gas).
- **Multi-wallet:** 8 or 10 wallets per chain; Multi Buy/Sell — [Premium](https://docs.maestrobots.com/sniper/premium-subscription.md); [Token report](https://docs.maestrobots.com/sniper/pasted-contracts/token-report-menu.md).
- **Execution:** Solana "Anti-MEV" routes through private relays. Premium adds a faster "Pro Bot" and 30 concurrent trades — [Maestro docs](https://docs.maestrobots.com/llms-full.txt); [Premium](https://docs.maestrobots.com/sniper/premium-subscription.md).
- **Incident:** 23 Oct 2023, router "Arbitrary External Call". DefiLlama records $500K lost and $465K returned — [DefiLlama hacks](https://api.llama.fi/hacks). crypto.news instead says "Sept 2023" and "~$280,000" ([crypto.news](https://crypto.news/what-are-telegram-trading-bots-unibot-banana-gun-how-they-work/)); the $280K is likely 280 ETH misread as dollars.
- **Sentiment:** one affiliate review rates it "High-Risk — Not Recommended", citing confusing setup, wrong-token buys and "drained wallet" reports — [coinspot (affiliate)](https://coinspot.io/en/telegram-trading-bots/maestro-trading-bot/).

**Bloom.** Telegram bot, "Manager" web hub and Chrome extension. Chains: Solana, ETH, BSC, Base and others (the docs and FAQ disagree on the full list). Fee 1% (0.9% with a referral); perps: no.
- **Surfaces:** one account across all three. The extension injects a trade panel into Axiom, Photon, BullX, GMGN and DexScreener — [Bloom docs](https://docs.bloombot.app/); [extension](https://docs.bloombot.app/extension).
- **Sniping:**
  - **Sniper tasks** — [Sniper](https://docs.bloombot.app/solana/solana-bot/sniper.md):
    - Settings: wallets, platforms, amount, fee, tip, slippage, minimum out, deployer filter.
    - "Insta Dump" sells as soon as the pool is live.
  - **AFK mode** (auto-buys new launches) — [AFK](https://docs.bloombot.app/solana/solana-bot/afk.md):
    - Quote-pair filter.
    - Dev filters: creator buy size; tokens the dev has created; tokens the dev has migrated.
    - Max tax; a third-party "Safe Deployer" check.
    - Whitelisted deployers; blacklisted words and deployers.
    - Max buy count.
  - **Twitter tasks:** trigger on a tweet, retweet or reply; keyword match; **OCR** to read CAs from images; tasks expire after 7 days — [docs full](https://docs.bloombot.app/llms-full.txt); [FAQ](https://docs.bloombot.app/solana/miscellaneous/faqs.md).
- **Copy trading** — [docs full](https://docs.bloombot.app/llms-full.txt):
  - Size as Exact, Percentage or Fixed.
  - Max buy count; max trades per token.
  - Follow Sells.
  - **Reverse Mode**: buy only when the target sells.
  - Mcap, age and max-dev-holdings filters; deployer lists with mass import.
  - Copy limit orders.
- **Orders:** limit buy/sell; auto orders that can attach to Copy, Sniper, AFK and Twitter tasks; a strategies builder — [docs index](https://docs.bloombot.app/llms.txt).
- **Execution:** anti-MEV processors; automatic Jito tip; "the fastest processor is selected automatically" for dev-sell execution; a "Locations" setup page — [docs full](https://docs.bloombot.app/llms-full.txt); [docs index](https://docs.bloombot.app/llms.txt).
- **Tracking:** a Twitter Tracker feed, also injected into X; Discord and Telegram scrapers in the extension — [docs full](https://docs.bloombot.app/llms-full.txt).
- **Analytics:** PnL cards, a PnL Calendar, Live Stream PnL / Banner overlays, a leaderboard — [Bloom docs](https://docs.bloombot.app/); [docs index](https://docs.bloombot.app/llms.txt).
- **Security:** changes to the withdraw address take effect only after a **24-hour cooldown** — [FAQ](https://docs.bloombot.app/solana/miscellaneous/faqs.md). An API key is available — [docs index](https://docs.bloombot.app/llms.txt).
- **Attribution note:** DefiLlama's "Bloom" exploit (9 May 2024, $540K, Blast) is a different protocol, DefiLlama ID 3466. Bloom Trading Bot is ID 5806 — [DefiLlama hacks](https://api.llama.fi/hacks); [overview API](https://api.llama.fi/overview/fees?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true&dataType=dailyFees).

**Nova (TradeOnNova).** Solana Telegram bot; fee 1%; perps: no; DefiLlama 30-day fees $0.
- **Sniping** — [Nova docs](https://docs.tradeonnova.net/llms-full.txt):
  - pump.fun launch sniper that matches by ticker (exact or contains), **dev wallet**, or mint.
  - Filters: mcap, LP burn %, supply, top-10 %, dev buy size.
  - A migration / new-pool sniper.
  - Processors: "Ultra", "Ultra V2" and **"Demon Mode"**, which submits through several processors at once.
- **Orders:** limits triggered by mcap, by price in SOL, or **when the dev sells** (a limit *buy*); TP/SL — [Nova docs](https://docs.tradeonnova.net/llms-full.txt).
- **Copy trading:** exact, % or fixed sizing; mcap filter; Follow Sells; Buy Once — [Nova docs](https://docs.tradeonnova.net/llms-full.txt).
- **Execution:** send via Jito (protected), a plain Node (unprotected) or both; separate buy and sell tips; a **user-selectable server region** — [Nova docs](https://docs.tradeonnova.net/llms-full.txt).
- **Nova Click extension:** buys from Photon and BullX pages while executing through Nova. Last updated Feb 2025 — [Nova docs](https://docs.tradeonnova.net/llms-full.txt).
- **Fee and referrals:** 1% fee; referral 30% / 3% / 2% — [Nova referrals](https://docs.tradeonnova.net/earning-with-nova/referrals).

**Sol Trading Bot (STBot).** Solana Telegram bot plus a Chrome extension; fee page removed; perps: no.
- **Snipers** — [STBot docs](https://soltradingbot.gitbook.io/docs/llms-full.txt):
  - By CA; a pump.fun & Moonshot sniper keyed on symbol plus **dev wallet**; a LaunchLab sniper.
  - A **Sell Sniper** that auto-sells on migration.
  - Auto-buy on paste.
- **Orders:**
  - Limit buy/sell with TP/SL.
  - DCA with interval, duration and min/max price.
  - **Order Sell** auto-sells on a %, a delay, **migration**, or a **dev sell**.
  - CA Sell.
- **Copy trading:** fixed SOL per copied buy and a % for sells; no filters.
- **Multi-wallet:** generate 5 or 10 wallets at once; multi-buy/sell.
- **MEV:** anti-MEV toggles and Jito tips.
- **Security:** 2FA plus a password are required for transfers, key export and wallet deletion.

**Shuriken (pivoted).** Web terminal plus a plain-English Telegram bot; Solana, BSC, Monad (Base appears on one page); fee 1% in older docs; perps: yes, via API.
- **Alpha calls:** the terminal turns Discord, Telegram and X calls into trades, filterable by mcap, mention frequency and **sender reputation** — [Shuriken intro](https://docs.shuriken.trade/introduction).
- **Agent keys** — [Shuriken docs](https://docs.shuriken.trade/llms-full.txt):
  - Templates: "Sniper Bot" ($25 per trade / $250 per day) and "Auto-Buyer" ($50 / $500), with limits enforced on Shuriken's servers.
  - Scoped permissions; can be paused or revoked instantly.
  - Exposed through an MCP server, a REST API and a Rust CLI.
- **Plain-English trading:** "ape 2 SOL into WIF", executed with no confirmation step — [Shuriken intro](https://docs.shuriken.trade/introduction).
- **Orders and wallets:** limit orders with TP/SL "Exit Strategies"; wallet groups — [Telegram bot](https://docs.shuriken.trade/telegram-bot/overview).
- **Not found** on current pages: copy trading and classic launch sniping.

**Looter (looter.ai).** ETH-first Telegram bot with Solana support; fee not found; perps: no (NFT derivatives on ETH only).
- **Solana snipes** — [Looter docs](https://docs.looter.ai/llms-full.txt):
  - Fire when liquidity is detected.
  - A **max-mcap failsafe** cancels and reverts if the cap is exceeded.
  - A **"First Bundle"**-only option.
  - Auto-sell at a % gain.
- **Limit orders.**
- **Five wallets** usable together.
- **Execution:** public or private (anti-MEV) mode; tip presets Low / Auto (75th percentile) / High (95th percentile).
- **Exportable PnL cards.**
- **One-message "Expert mode":** address, amount, tip.
- **Token:** $LOOTER revenue share.

**MevX.** Web app, Chrome extension and Telegram bot; 12 chains; fee 0.7–0.9% depending on rank (affiliate source); perps: not documented.
- **Discovery** — [MevX docs](https://docs.mevx.io/llms-full.txt):
  - "Meme Zone": New Creations / About to Graduate / Graduated.
  - "Degen Zone" flags volume spikes.
  - Covers many launchpads.
- **Orders** — [MevX docs](https://docs.mevx.io/llms-full.txt):
  - Sniper mode; limit orders by price or mcap; automatic TP/SL; trailing SL; DCA with mcap bounds.
  - **Dev Sell Config:** when the dev sells all or part of their holding, respond with a fixed sell, a matching %, or a % of your own holdings.
- **Copy trading:** exists; parameters are not documented.
- **Wallet tracker:** categories Smart Money, Top PnL, KOL and Whale, with Telegram alerts.
- **KOL tracker:** follows X posts and token mentions, with community voting.
- **Extension:** adds buy/sell buttons on Photon, BullX NEO, GMGN, DEX Screener, Dextools, pump.fun, Solscan, X, Discord and Telegram — [MevX docs](https://docs.mevx.io/llms-full.txt).
- **Demo Mode:** trade with virtual SOL (10 V-SOL) — [MevX blog](https://blog.mevx.io/features/mevx-demo-mode-on-solana).
- **Fee tiers:** 0.90% at the lowest rank down to 0.70% at the top — [solanatradingbots (affiliate)](https://solanatradingbots.com/mevx-how-to-use/).

**TradeWiz.** Solana Telegram bot; dormant; fee 1% (affiliate source).
- **Copy-trade-centric:** proportional or fixed sizing; filters for mcap, token age, liquidity and target wallet balance; **reverse copy trading** — [coincodecap (affiliate)](https://coincodecap.com/tradewiz-review).
- **Orders:** limit, TP/SL and trailing stops.
- **Wallets:** one auto-generated wallet.
- **Status:** DefiLlama 1-year fees are $51 — [DefiLlama](https://api.llama.fi/summary/fees/tradewiz?dataType=dailyFees).

**Fasol.** Solana Telegram bot plus a web terminal; **suspended after a compromise**.
- **Suspension notice:** the site reads "Fasol has been compromised"; the team says it is investigating and compiling a list of affected users. Undated — [fasol.trade](https://fasol.trade/).
- **Features before suspension** (affiliate sources, [fasolbot.com](https://fasolbot.com/); [defipill](https://defipill.xyz/telegram-trading-bots/fasol_bot_review/)):
  - Live scanner with 30+ filters, including dev history and bot activity.
  - Claimed ~20ms filter checks.
  - **Backtesting** of filter sets (historical 2x / 5x / 10x hit rates).
  - Dev-sell protection; TP/SL; MEV protection.
  - No copy trading.

#### 2c. Consumer, social and aggregator products

**Fomo (FOMO Labs Inc.).** iOS, Android and web; Solana, Base, BNB, Monad, ETH, Robinhood Chain, Arc. Fee undisclosed and variable (perps 0.05%); perps: yes.
- **What it is:** "a social trading app that enables self-custodial, gasless token swaps on mobile, combining social feeds and copy-trading features" — [DefiLlama](https://api.llama.fi/summary/fees/fomo-wallet?dataType=dailyFees).
- **Homepage features** — [fomo.family](https://fomo.family/):
  - Leaderboards.
  - A feed to "discover and follow top traders".
  - "Real time notifications for what the best are buying".
  - "Multichain & gasless"; "fund with apple pay".
  - Positions sync between phone and desktop.
- **Fees:** the Fomo fee "depends on factors including the size and type of the transaction, the token involved, and how the transaction is routed". Perps cost 0.05% — [Fomo terms](https://fomo.family/terms).
- **Custody:** wallets are "generated and managed by Privy … non-custodial" — [Fomo terms](https://fomo.family/terms).
- **Funding:**
  - $17M Series A led by Benchmark (6 Nov 2025) — [Fomo blog](https://fomo.family/blog).
  - $75M Series B led by Index Ventures (22 Jun 2026) — [Fomo Series B post](https://fomo.family/blog/fomo-series-b).
- **Spin-off:** a separate Telegram copy bot, **copyfomo**, charges a "2% service fee" plus gas it fronts and bills back. Its $COPY token trades on Robinhood Chain. Affiliation with Fomo is unverified — [DefiLlama](https://api.llama.fi/summary/fees/copyfomo?dataType=dailyFees).

**Jupiter (Spot/Ultra, Trigger, Mobile, Studio).** Solana; Ultra fee 0–0.5%; perps: yes.
- **Ultra fees:** 0% on stable/LST/JUP pairs, 0.02% SOL↔stable, 0.1% on other swaps and 0.5% on tokens under 24h old — [Ultra Mode](https://docs.jup.ag/user-docs/trade/spot/ultra-mode.md).
- **Discovery** — [AlphaScan](https://docs.jup.ag/user-docs/trade/spot/alphascan.md):
  - AlphaScan columns: New / Soon / Bonded.
  - Audit data: top-10 %, dev %, snipers (first 3 blocks), insiders, bundlers, and **"Pro Traders %" (wallets that trade via Axiom or GMGN)**.
  - A dev-history pop-up: tokens migrated, tokens created, launches in the last 7 days, dev SOL balance.
- **Orders:** Trigger V2 offers limit, stop-loss, **trailing stop**, **OCO** (TP and SL sharing one deposit), **OTOCO** (entry that activates a TP/SL pair) and DCA by time or price band — [Trigger](https://developers.jup.ag/docs/trigger).
  - **Note:** Trigger V2 orders sit in a "Privy-managed custodial" per-wallet vault.
- **Safety:** JupShield warnings; Organic Score (0–100); VRFD token verification — [VRFD](https://docs.jup.ag/user-docs/launch/vrfd/token-verification.md); [Tokens API](https://developers.jup.ag/docs/tokens).
- **Execution:** Ultra V3's private landing engine, "Jupiter Beam", lands in 0–1 block (~50–400ms). Jupiter claims MEV protection "34x better than the top trading terminals", based on sandwiched.me data — [Ultra V3 blog](https://developers.jup.ag/blog/ultra-v3).
- **Tracking:** SmartMoney leaderboards and a wallet tracker with per-wallet sounds and chart markers — [SmartMoney](https://docs.jup.ag/user-docs/trade/spot/smart-money.md).
- **Mobile:** push notifications ("Radar") and **Magic Scan**, which reads CAs or QR codes from images — [Mobile features](https://docs.jup.ag/user-docs/global/mobile/app-features.md).
- **Not offered:** copy trading and automated sniping.

**Moonshot.** iOS/Android app; Solana, Base, Polygon. Fee 2.5% on trades under $250 and 1% above (from an explainer, not official). Perps: yes, via Jupiter Perps, geo-restricted.
- **Product:** fiat-first; Apple Pay, Venmo and card on-ramps; self-custodial Turnkey MPC wallet; market buys only — [Datawallet](https://www.datawallet.com/crypto/moonshot-app-solana-explained); [PR](https://www.prnewswire.com/news-releases/moonshot-international-integrates-jupiter-perpetuals-to-power-mobile-leverage-trading-for-2m-users-302713923.html).
- **Ownership conflict:** a Jul 2026 explainer does not mention Jupiter's ownership — [Datawallet](https://www.datawallet.com/crypto/moonshot-app-solana-explained).

**Vector (defunct).** Solana-only social memecoin app from Tensor Labs whose core feature was following other traders. Acquired by Coinbase; apps shut down — [Fortune](https://www.fortune.com/2025/11/21/coinbase-buys-solana-vector-fun-acquisition-spree); [The Block](https://www.theblock.co/post/379964/coinbase-vector-fun-tensor-solana-everything-exchange-vision).

#### 2d. Extensions and other newer entrants

**Uxento.** Chrome extension ("uxtension") plus a "Vision" tracker dashboard; Solana, Base, ETH, Monad; fee 0.75%; perps: no.
- **What it does** — [uxento.io](https://www.uxento.io/):
  - Monitors X/Twitter and Discord feeds, with custom keyword sounds.
  - "Auto-Snipe any CA Detection within feeds" and buys triggered by keywords.
  - Auto-sell after a set time or at a chosen mcap.
  - "Enhanced Axiom integration" (an overlay on Axiom).
  - Turnkey wallets.
- **Other tools:** a sandbox for testing snipers and trackers; the uTek sniper — [Uxento docs](https://docs.uxento.io/).
- **Traction:** 20,000 users and 4.4★, extension updated 27 Sep 2026 — [Chrome Web Store](https://chromewebstore.google.com/detail/uxtension/pljeffieceahpjcgldlglfidenecjloh).

**Other entrants seen in DefiLlama data:**
- **o1.exchange:** an "onchain trading aggregator for spot, perpetuals, and prediction markets" letting users "compose and automate advanced strategies". 1% fee; most recent fees on Base — [DefiLlama](https://api.llama.fi/summary/fees/o1.exchange-trading-terminal?dataType=dailyFees).
- **Phantom:** wallet swaps earned $7.1M in 30 days, 98% on Solana. Phantom Perps run on Hyperliquid — [DefiLlama](https://api.llama.fi/summary/fees/phantom-wallet?dataType=dailyFees).

### Inferences
- **The feature core is commoditised.** A three-column feed, quick-buy presets, MEV modes and limit/TP-SL are the minimum. Differentiation comes from automation (SnipeX-style social sniping, dev-sell triggers, copy-trade controls), data (rug history, Wallet Radar, Organic Score, dev funding), and where the product lives (mobile, Telegram, an extension overlaid on rival terminals).
- **Two new waves since mid-2025:**
  - **AI-agent access:** GMGN's Agent API and CLI, Shuriken's MCP server with capped agent keys, and Jupiter's CLI/MCP.
  - **"Bring-your-own-execution" overlays:** Bloom, MevX, LAB, Uxento and Nova Click inject buy buttons into rival UIs. LAB explicitly markets its overlay as a way to pay lower fees while keeping Axiom or GMGN as the front end. A zero-fee open-source terminal could ship the same kind of overlay.
- **Copy-trading controls have converged.** The common set is fixed or %-of-target sizing, a per-buy cap, a total spend limit, mcap/liquidity/age filters, an exclude-bonding-curve option, duplicate-buy prevention, copy-sell, and TP/SL on copied buys. No tool documents a configurable copy delay, and every major tool warns about exit-liquidity attacks from copied wallets.

### Gaps
- **Photon:** the official site and FAQ block automated fetches (Cloudflare), so Memescope's columns and filters, PnL cards and trackers are unverified.
- **BullX NEO:** Pump Vision details and the sniper/copy settings were not verified.
- **Banana Pro:** trailing-stop and DCA specifics, and how the "front-run" anti-rug works on Solana, were not verified.
- **pump.fun Terminal:** sources conflict on the feature set after the acquisition (copy trading removed or not; the live URL).
- **Fomo:** the fee rate, whether copy trading is automated, and whether Solana is its main chain for memecoins were not verified.
- **User sentiment:** thin for every tool because of the search quota. Reddit/X sweeps were not possible.

## 3. Consolidated comparison matrix, and what Axiom lacks

### Takeaway
Competitors offer many features that Axiom's docs and recent coverage do not show. These are the main gaps:
- automatic copy trading
- automated sniping (filter-based, X-contract-address, dev-wallet)
- dev-sell-triggered orders
- trailing, DCA and OCO orders
- Telegram trading and off-app tracker alerts
- ingestion of Telegram/Discord call channels
- browser-extension overlays
- a native mobile app
- API/agent access
- paper trading and backtesting
- stronger account controls (withdraw-address cooldowns, time-delayed PIN changes, 2FA)

Axiom does already have mcap limit orders, TP/SL brackets (Oct 2025), migration snipe/sell, Pulse hotkeys, a 10,000-wallet tracker, an X tracker that covers Truth Social, rich PnL cards and calendar, and 8 chains.

### Cited Findings

**Legend:** Y = documented. P = partial or limited. N = not found in the official docs reviewed (likely absent; for Axiom, "N" means not in Axiom's docs or recent coverage). ? = not verifiable. — = not applicable or defunct.

Cell values summarise the sourced profiles in section 2. The Axiom row comes from:
- [Axiom docs](https://docs.axiom.trade/llms-full.txt)
- the sibling `axiom_feature_inventory.md`, which cites [Axiom limit orders](https://docs.axiom.trade/axiom/swap/limit-orders), [migration actions](https://docs.axiom.trade/axiom/swap/migration-actions), [TP/SL (Meme Coin Navigator, Oct 2025)](https://memecoinnavigator.com/how-to-set-a-stop-loss-and-take-profit-on-axiom-pro/), [apebrief wallet tracker](https://apebrief.com/axiom/wallet-tracker/), ["Copy Trading: Absent" (AXL, Aug 2026)](https://www.axltoken.com/trading-bots/gmgn-vs-axiom/), [price alerts to Telegram/Discord](https://x.com/watchingmarkets/status/1959147280025473448) and [apebrief pulse ("8 Chains")](https://apebrief.com/axiom/pulse/)

**Table A: discovery, sniping, orders, copy trading**

| Tool | 3-column launch feed | Filter auto-snipe | Migration snipe | X-CA auto-snipe | Dev-wallet snipe | Paste / clipboard buy | Limit (price / mcap) | TP/SL ladder | Trailing | DCA | Dev-sell order | Copy trading |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Axiom (baseline)** | Y (Pulse) | N | Y | N (monitor only) | N | ? | Y / Y | Y (Adv. Strategy, Oct 2025) | N | N | N | N |
| GMGN | Y (Trenches) | P (Auto Trading, unverified) | Y (Migrated Snipe) | Y (SnipeX) | N | Y (TG) | Y / P (±% triggers) | Y (≤10 levels) | Y (SL + TP) | N | Y (Sell / Buy on Dev Sell) | Y |
| pump.fun Terminal (ex-Padre) | Y | ? | ? | N | ? | ? | Y | Y (≤5 exits) | P (conflict) | P | P (dev-sell exit; unconfirmed) | P (conflict: removed?) |
| Trojan (bot + Terminal) | Y | Y (bot) | Y | N | P (dev white/blacklist) | Y (Clipboard Buy) | Y / Y | Y (Auto-Sell ladder) | Y (bot) | Y (+ mcap band) | N | Y |
| Photon | P (Memescope) | N | ? | N | N | ? | Y | Y | N | Y | N | N |
| BullX NEO (dormant) | P (Pump Vision) | ? | ? | ? | ? | ? | Y | ? | ? | ? | ? | ? |
| Banana Pro + bots | Y | P (per-CA liquidity snipe) | Y | N | N | Y | Y | P | ? | Y | P ("front-run" anti-rug) | Y (+ spend limit) |
| BONKbot / Telemetry / Nighthawk | Y (X-Ray) | P (Nighthawk) | Y | N | N | Y (no confirm) | Y / Y | Y | Y | Y | N | N |
| Maestro | N | Y | ? | N (call channels) | N | Y | Y / Y | Y | Y | N | N | Y (+ Track Only) |
| Bloom | N (overlays rivals) | Y (AFK) | P | Y (Twitter tasks + OCR) | Y (deployer lists) | ? | Y | Y | ? | ? | P | Y (+ Reverse) |
| Nova | N | Y | Y | N | Y | Y | Y / Y | Y | N | N | N (dev-sell-triggered *buy*) | Y |
| Sol Trading Bot | N | P | P (sell on migration) | N | Y | Y | Y | Y | N | Y | Y (Order Sell) | Y (basic) |
| Shuriken (pivoted) | N | P (agent auto-buy on signals) | ? | P (X calls) | N | Y (plain English) | Y | Y | N | N | N | N |
| Looter | N | P (per-CA liquidity snipe) | ? | N | N | Y | Y | P | N | N | N | N |
| MevX | Y (Meme Zone) | Y | Y | P (manual popup on tweets) | N | ? | Y / Y | Y | Y | Y | Y (Dev Sell Config) | Y |
| TradeWiz (dormant) | N | ? | ? | N | N | ? | Y | Y | Y | N | N | Y (+ Reverse) |
| Fasol (suspended) | P (scanner) | Y | ? | N | N | ? | Y | Y | ? | ? | Y | N |
| Jupiter Spot / Trigger | Y (AlphaScan) | N | N | N | N | P (Magic Scan) | Y / Y | Y (OCO / OTOCO) | Y | Y | N | N |
| Moonshot | N | N | N | N | N | ? | N | N | N | N | N | N |
| Fomo | N | N | N | N | N | ? | ? | ? | ? | ? | N | P (follow + alerts) |
| Uxento (extension) | N | P (feed / keyword auto-snipe) | N | Y | N | ? | N | P (time / mcap exit) | N | N | N | N |
| LAB Terminal | ? | N | N | N | N | Y (Boost Mode) | Y | Y (presets) | P (Smart Order) | N | N | N |

**Table B: tracking, analytics, platform, security**

| Tool | Wallet tracker + alerts | X tracker | TG/Discord call ingestion | Holder tags (insider / sniper / bundler / dev) | PnL cards | Multi-wallet bulk | MEV modes | Telegram bot / alerts | Mobile | Extension | API / agent | Perps | Chains | Headline fee |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Axiom (baseline)** | Y (10k wallets; in-browser alerts) | Y (+ Truth Social) | N | Y | Y (custom / video / calendar) | Y | Y (Off / Reduced / Secure) | P (price alerts only) | N | N | N | Y | 8 | 1% (0.75–0.95% net) |
| GMGN | Y (web, app push, 0-Delay TG) | Y | N | Y (+ rug probability / history) | ? | Y (10) | Y (off / reduced / secure) | Y | Y (app) | ? | Y (Agent API / CLI) | N | 11 | 1% |
| pump.fun Terminal | Y | Y | Y (Alpha Tracker) | ? | ? | Y | Y (off / secure; bloXroute) | ? | N (browser) | ? | ? | ? | 4 | ~1% (cashback to 0.65–0.90%) |
| Trojan | Y (sounds, emoji, groups, dev tags) | Y (+ Truth Social) | Y (TokenScan Alpha) | Y (audits) | Y | Y (10 active) | Y | Y (bot; 10 instances) | P (PWA) | N | N | Y | 1 | 1% |
| Photon | ? | ? | N | ? | ? | Y (5) | Y (Fast / Secure; Jito / bloXroute) | N | N | N | N | N | 1 (EVM off) | 1% |
| BullX NEO | ? | ? | N | ? | ? | Y | ? | P (TG login) | N | N | N | N | trading disabled | 1% |
| Banana Pro + bots | Y | ? | Y (TG Scraper) | Y (Top Traders labels) | Y | Y | Y (Jito-only vs Public) | Y (+ backup bots) | N | N | N | N (predictions: Y) | 8+ | 0.5% / 1% (conflict) |
| BONKbot / Telemetry | Y (plink / plonk) | N | N | P (dev %, dev funding) | N | P | Y (Turbo / Secure, P1–P4) | Y | P (Telemetry Mobile) | N | N | N | 1 | 1% |
| Maestro | P (Whale bot, Trade Monitor) | N | Y (call channels, Scraper) | N | N | Y (8–10 / chain) | P (Anti-MEV) | Y | N | N | N | N | 12 | 1% + $200/mo Premium |
| Bloom | ? | Y | Y (scrapers) | P | Y (+ calendar, stream overlay) | Y | Y | Y | P | Y (overlay on rivals) | Y (API key) | N | 5–8 | 1% |
| Nova | N | N | N | N | N | Y | Y (Jito / Node / both; Demon) | Y | N | Y (Nova Click) | N | N | 1 | 1% |
| Sol Trading Bot | N | N | N | N | P | Y | Y | Y | N | Y | N | N | 1 | ? |
| Shuriken | N | P | Y (reputation-weighted) | N | P | Y (groups) | P (Jito) | Y (plain English) | N | N | Y (REST / MCP / CLI) | Y (API) | 3–4 | 1% (old docs) |
| Looter | N | N | N | N | Y | Y (5) | Y (public / private) | Y | N | N | N | N | 6–8 | ? |
| MevX | Y (categories, TG alerts) | P (KOL tracker) | N | P | Y (widget) | Y | Y | Y | N | Y (12 sites incl. X) | N | ? | 12 | 0.7–0.9% (affiliate) |
| TradeWiz | ? | N | N | N | ? | N | P | Y | N | N | N | N | 1 | 1% (affiliate) |
| Fasol | ? | N | N | P (dev history) | Y | ? | Y | Y | N | N | N | N | 1 | unclear |
| Jupiter | Y (SmartMoney) | N | N | Y (AlphaScan, incl. Pro Traders %) | P (PnL calendar) | N | Y (Beam; manual Jito) | N | Y | Y (wallet ext.) | Y | Y | 1 | 0–0.5% |
| Moonshot | N | N | N | N | N | N | ? | N | Y | N | N | Y | 3 | 2.5% / 1% (explainer) |
| Fomo | P (follow + alerts) | N | N | N | ? | N | ? | N | Y | N | N | Y | 7 | undisclosed |
| Uxento | N | Y (+ Discord) | Y (Discord) | N | P (widget) | ? | ? | N | N | Y | N | N | 4 | 0.75% |
| LAB Terminal | P | N | N | ? | Y | P | Y (Jito) | Y | Y (app) | Y (overlay) | N | N | 1+ | 0.5% |

**Speed and landing claims** (none independently benchmarked):
- Jupiter Beam lands "0–1 block (~50–400ms)" — [Jupiter Ultra V3](https://developers.jup.ag/blog/ultra-v3).
- Banana: "50% faster execution speeds vs. other terminals" — [bananagun.io](https://bananagun.io/).
- Trojan bot: price feed refreshes every 0.04s — [trojanonsolana.com](https://trojanonsolana.com/).
- Padre: "every transaction is simulated to minimize number of reverts" — [padre.gg](https://padre.gg/).
- Fasol: filter checks in ~20ms — [fasolbot.com](https://fasolbot.com/).
- Telemetry wallet tracker: "sub-millisecond precision" — [BONKbot docs](https://docs.bonkbot.io/llms-full.txt).
- Axiom: "Turbo", "Fastest Submission Engine" and "Katana Mode" — see `axiom_feature_inventory.md`.
- A Padre affiliate measured Padre at 127 ms vs Axiom at 310 ms over 47 trades. Unverified — [DegenSpaced (affiliate)](https://degenspaced.vercel.app/).

**Features competitors document that Axiom does not** (each item lists the tools that have it):
- **Automatic copy trading:** GMGN, Trojan, Banana Pro, Bloom, Maestro, MevX, Nova, STBot, TradeWiz. Reverse copy: Bloom, TradeWiz. Track-only: Maestro. Total spend limit per target: Banana. Exclude bonding-curve tokens and prevent duplicate buys: Trojan.
- **Automated sniping:**
  - Filter-based AFK/auto-sniper: Trojan, Bloom, Nova, Maestro, Fasol.
  - X-contract-address auto-snipe: GMGN SnipeX, Bloom (with OCR), Uxento.
  - Dev-wallet snipe: Nova, STBot, Bloom deployer lists.
  - Snipe guards: max-mcap failsafe (Looter, BONKbot Precision); first-bundle-only (Looter); min/max liquidity and min tokens out (Banana Pro).
- **Dev-sell triggers:** GMGN Sell/Buy on Dev Sell, MevX Dev Sell Config, STBot Order Sell, Padre dev-sell exit, Fasol.
- **Order types:** trailing stop (GMGN, Trojan bot, BONKbot, Maestro, MevX, Jupiter, TradeWiz); DCA (Trojan, BONKbot, Jupiter, STBot, MevX, Photon, Banana); OCO/OTOCO (Jupiter); range "Smart Order" (LAB); Event orders (Trojan); Spam Buy split transactions (Trojan).
- **Off-app channels:** Telegram trading bots (Trojan, BONKbot, Banana, Maestro, Bloom, GMGN, Nova, STBot, Looter, MevX, LAB); real-time tracked-wallet alerts via Telegram (GMGN 0-Delay Bot, MevX); group-chat contract-query bots (GMGN). Axiom's tracker alerts work only while the browser is open; only price alerts reach Telegram/Discord (sibling Axiom note).
- **Call-channel ingestion:** Trojan Alpha (TokenScan, with caller leaderboard), Padre Alpha Tracker, Maestro call channels, Bloom scrapers, Banana Telegram Scraper, Shuriken (reputation-weighted).
- **Distribution surfaces:**
  - Native mobile apps: GMGN, Fomo, LAB, Jupiter, Moonshot; Telemetry Mobile; Trojan PWA.
  - Browser extensions overlaying rival UIs: Bloom, MevX, LAB, Uxento, Nova Click, STBot.
- **Programmatic access:** GMGN Agent API/CLI, Shuriken MCP with capped agent keys, Jupiter APIs/CLI/MCP, Bloom API key.
- **Practice and testing:** paper trading (MevX Demo Mode); sniper sandbox (Uxento); filter backtesting (Fasol).
- **Token-risk extras:** rug probability and creator rug history (GMGN); Organic Score / JupShield (Jupiter); Wallet Radar shared-holder scans (GMGN); bubble map (Banana Pro, MevX).
- **Account security:** withdraw-address change with a 24h cooldown (Bloom); PIN with an 8h activation delay and 7-day reset (Banana Pro); 2FA (BONKbot with backup key, GMGN, STBot, Padre); an action password (Trojan); a 3-hour wait before the first withdrawal plus a whitelist (GMGN); simulation before sending (Padre).
- **Execution routing:** multi-processor "Demon Mode" and a user-selectable region (Nova); bloXroute as an alternative route (Photon, Padre); Jito-only vs Public modes (Banana Pro).

### Inferences
- **Axiom's lead is not a features lead.** Its gaps line up with the automation and off-app features that GMGN, Trojan and Bloom lead on. By DefiLlama fees, Axiom still holds ~53% of tracked Solana fees, so its advantage looks like execution speed, UX polish and incentives. A competitor needs Axiom-grade speed and UX first; automation alone is not enough.
- **Some gaps are cheap for a self-hosted build.** Copy trading, dev-sell triggers, trailing/DCA/OCO and Telegram alerts run fine in a local daemon. X auto-sniping and holder tags such as "rug history" or "Pro Traders" need data pipelines: a paid X data source, plus an indexer of wallet histories.
- **Server-side automation is the hard part.** Self-hosted automation (snipes, copy trades, limit orders) only works while the user's own machine or server is online. Trojan's FAQ raises the same question ("What happens to my trades if I'm offline?"). Hosted products keep orders on their servers, or in Jupiter's case in a Privy custodial vault.

### Gaps
- Axiom's 2026 mobile app and extension status are covered by the Axiom researcher. Treat this matrix's "N" for Axiom as "not documented".
- Many "?" cells, especially Photon, BullX, Terminal, Fomo and LAB, could not be resolved without logged-in access or working web search.

## 4. Telegram bot UX patterns worth borrowing

### Takeaway
A few Telegram patterns have proved durable:
- paste a contract address and get a risk card with preset buy/sell buttons
- one-tap execution presets (MEV/slippage/fee bundles)
- an explicit "confirm trades" toggle
- deep links that carry the CA
- interchangeable backup bot instances
- alert channels and group bots
- plain-English or one-message order entry

For a web terminal, the best ports are a global paste/clipboard buy bar, P1–P4 presets, and a Telegram companion bot for alerts and quick commands with deep links back to the terminal's token page.

### Cited Findings
- **Paste a CA, get a token card:**
  - BONKbot's card shows name, ticker, image, copyable CA, age, mcap, price, 24h volume, liquidity, supply and quick links. Its safety panel shows mint/freeze authority, LP burnt, top-10 %, dev holding %, dev address and dev funding source — [BONKbot docs](https://docs.bonkbot.io/llms-full.txt).
  - Maestro's Token Report adds Track (watch without buying), wallet multi-select, approve/revoke, buy presets (X SOL / Ape Max / X Tokens), sell rows (Sell All / X% / X amount / Max TX), per-trade slippage and gas, Snipe, and Buy/Sell Limit — [Maestro token report](https://docs.maestrobots.com/sniper/pasted-contracts/token-report-menu.md).
  - Trojan accepts either a CA or a link — [Trojan quick start](https://docs.trojanonsolana.com/overview/quick-start-guide).
  - Banana's SOL bot accepts a CA or URL (e.g., Defined) to open the sell menu — [Banana Gun SOL docs](https://banana-gun.gitbook.io/banana-gun-solana/).
- **Auto-buy on paste and confirmation:**
  - Trojan's "Confirm Trades": green means you must click buy/sell first, red sends immediately — [Trojan bot docs](https://docs.trojanonsolana.com/llms-full.txt).
  - BONKbot's auto-buy "will NOT ask" for confirmation — [BONKbot docs](https://docs.bonkbot.io/llms-full.txt).
  - Maestro blocks auto-buy on risk warnings unless Degen Mode is on — [Maestro docs](https://docs.maestrobots.com/llms-full.txt).
- **Presets:**
  - BONKbot P1–P4 switch whole MEV, slippage and fee bundles — [BONKbot presets](https://docs.bonkbot.io/telemetry/trading/presets).
  - Trojan's gas tiers are Fast 0.0015 / Turbo 0.0075 SOL / Custom — [Trojan quick start](https://docs.trojanonsolana.com/overview/quick-start-guide).
  - Banana's toggle defaults: Anti-MEV (on / off / Anti-MEV + Public), Auto Gas (off / Medium / Fast), Allow USDC, and a simplified or advanced PnL card — [Banana Gun SOL docs](https://banana-gun.gitbook.io/banana-gun-solana/).
- **Commands:**
  - BONKbot: `/start`, `/home`, `/settings`, `/reset` — [BONKbot docs](https://docs.bonkbot.io/llms-full.txt).
  - Maestro: `/start`, `/premium`, `/trending`, `/bridge`, `/relay`, `/debridge`, `/private`, `/cashback`, `/competition` — [Maestro docs](https://docs.maestrobots.com/llms-full.txt).
  - Banana: `/copytrade`, and `/refresh` to extend a PIN session — [Banana Gun SOL docs](https://banana-gun.gitbook.io/banana-gun-solana/).
  - Bloom: `/sniper` — [Bloom sniper](https://docs.bloombot.app/solana/solana-bot/sniper.md).
- **Deep links:** Trojan's `t.me/solana_trojanbot?start=r-{refcode}-{tokenCA}` opens the token card with referral attribution and works on every backup bot — [Trojan bot docs](https://docs.trojanonsolana.com/llms-full.txt).
- **Resilience:**
  - Trojan runs 10 interchangeable bots that share wallets and settings — [Trojan quick start](https://docs.trojanonsolana.com/overview/quick-start-guide).
  - Banana's backup bots keep "all settings and wallets … identical", and tokens move over when you press Start — [Banana Gun SOL docs](https://banana-gun.gitbook.io/banana-gun-solana/).
- **Group bots and channels:**
  - GMGN's Contract Query bot answers a CA pasted in a group with a full analysis; its Smart Money bot posts wallet moves. GMGN made official channels private to avoid scam ads — [GMGN TG bots](https://docs.gmgn.ai/index/gmgn-tg-alert-channel-bot.md).
  - Trojan Alpha uses TokenScan's `/connect` to pipe group calls into the terminal, with a 40-calls/day anti-spam cap — [Trojan Alpha](https://docs.trojan.com/terminal-overview/alpha.md).
  - BONKbot Token Alerts channels: New Pools over $500, Renounced, Burned — [BONKbot docs](https://docs.bonkbot.io/llms-full.txt).
  - GMGN's "0-Delay Bot" pushes tracked-wallet trades — [GMGN alerts](https://docs.gmgn.ai/index/alert-sniper-new-following-limit-orders.md).
- **Fast entry:**
  - Shuriken's plain-English "ape 2 SOL into WIF", with no confirmation step — [Shuriken intro](https://docs.shuriken.trade/introduction).
  - Looter's one-message Expert mode: address, amount, tip — [Looter docs](https://docs.looter.ai/llms-full.txt).
- **Cross-surface sync:**
  - Bloom: one account across the bot, web hub and extension — [Bloom docs](https://docs.bloombot.app/llms-full.txt).
  - LAB: the extension and Telegram bot share presets and wallet tracking — [LAB extension](https://docs.lab.pro/browser-extension/meet-the-lab-terminal-extension.md).
  - Trojan: orders and wallets sync between mobile and desktop — [Trojan Mobile](https://docs.trojan.com/additional-info/trojan-mobile.md).
- **Security inside bots:**
  - Trojan's Secure Action Password — [Trojan bot docs](https://docs.trojanonsolana.com/llms-full.txt).
  - Banana's PIN sessions — [Banana Gun SOL docs](https://banana-gun.gitbook.io/banana-gun-solana/).
  - BONKbot 2FA with a backup key — [BONKbot docs](https://docs.bonkbot.io/llms-full.txt).
  - STBot requires 2FA plus a password for key export — [STBot docs](https://soltradingbot.gitbook.io/docs/llms-full.txt).
- **Already ported to web terminals:**
  - Trojan's Clipboard Buy — [Clipboard Buy](https://docs.trojan.com/trading-on-trojan/trojan-swaps/clipboard-buy.md).
  - GMGN's keyboard-only Trenches quick-buy — [GMGN hotkeys](https://docs.gmgn.ai/index/trenches-hotkeys.md).
  - Trojan's Instant Trade hotkeys — [Instant Trade](https://docs.trojan.com/trading-on-trojan/trojan-swaps/instant-trade.md).
  - Axiom's Pulse hotkeys (sibling note).

### Inferences
What to port, in rough priority order:
1. A global paste/clipboard buy bar (Cmd-K) that opens a token card: safety panel first, then preset buy and sell buttons. Include per-user "auto-buy on paste" and "confirm trades" toggles.
2. P1–P4 execution profiles with clear MEV semantics: Secure (Jito/bundle only) vs Turbo/Public (fastest).
3. A self-hosted Telegram companion bot, linked to the user's own instance:
   - pushes fills, TP/SL triggers, copy-trade events, tracked-wallet trades and migrations
   - every message links to `/token/<CA>` on the terminal
   - optional `/buy` and `/sell` behind a PIN

   With no platform fee, deep links need only the CA, not a referral code.
4. Failover across several RPC and landing endpoints, the web equivalent of Trojan's backup bots.
5. A "track without buying" monitor, as in Maestro.
6. An optional group-chat contract-query bot, as in GMGN.

### Gaps
- Exact message formats for fill and TP/SL notifications were not captured from any bot's docs.
- Banana Gun's command list was not found.
- None of the reviewed bots documents a Telegram Mini App.

## 5. What traders complain about, security incidents, and lessons for protecting a hot wallet

### Takeaway
Losses at trading bots and terminals have come from six sources:
- **centralised key custody and infrastructure:** DEXX $21M; Thunder Terminal's leaked key
- **insiders:** Solareum; pump.fun
- **router/approval contract bugs:** Maestro; Unibot
- **front-end compromise:** Banana Gun $3M, refunded; BONK.fun DNS hijack
- **supply-chain malware:** @solana/web3.js; fake GitHub sniper bots
- **MEV-protection failures and phishing clones:** GMGN, Photon

Self-hosting removes the operator's honeypot (all users' keys and data in one place) and the risk of operator insiders. It concentrates risk on the user's machine and dependencies instead.

### Cited Findings

**Incident timeline**

| Date | Product | What happened | Loss | Response | Source |
|---|---|---|---|---|---|
| 23 Oct 2023 | Maestro (ETH) | Router "Arbitrary External Call" (access control) | $500K | $465K returned | [DefiLlama hacks](https://api.llama.fi/hacks); conflicting "Sept 2023 / ~$280,000" in [crypto.news](https://crypto.news/what-are-telegram-trading-bots-unibot-banana-gun-how-they-work/) |
| 31 Oct 2023 | Unibot (ETH) | "Token Approval Abuse" | $640K | not recorded | [DefiLlama hacks](https://api.llama.fi/hacks) |
| 27 Dec 2023 | Thunder Terminal (ETH + Solana) | "Key Leaked via Infrastructure" | $240K | not recorded | [DefiLlama hacks](https://api.llama.fi/hacks) |
| 29 Mar 2024 | Solareum (Solana bot) | DPRK IT worker hired Dec 2023 drained 6,045 SOL; DefiLlama classifies it as social engineering | $1.4M (Decrypt headline: $523K) | Project shut; FBI seized ~$950K USDT | [DL News](https://www.dlnews.com/articles/regulation/how-a-dprk-developer-tricked-solareum-and-stole-14m/); [Decrypt](https://decrypt.co/224371/solana-telegram-trading-bot-shut-down-users-drained-523k); [DefiLlama hacks](https://api.llama.fi/hacks) |
| 16 May 2024 | pump.fun | "Private Key Compromised" | $1.9M | none recorded | [DefiLlama hacks](https://api.llama.fi/hacks) (ex-employee attribution not verified here) |
| 19 Sep 2024 | Banana Gun (ETH) | "Frontend & Infrastructure — Frontend Compromise" (widely reported as a Telegram message-oracle flaw; unverified here) | $3.0M | $3.0M returned | [DefiLlama hacks](https://api.llama.fi/hacks) |
| 16 Nov 2024 | DEXX (Solana) | "Private Key Compromised" (centralised wallet custody) | $21M | not recorded | [DefiLlama hacks](https://api.llama.fi/hacks) |
| 3 Dec 2024 | @solana/web3.js | npm versions 1.95.6/1.95.7 exfiltrated private keys; "bots that handle private keys directly" at risk | not stated | Upgrade to 1.95.8; rotate keys | [GitHub advisory](https://github.com/solana-labs/solana-web3.js/security/advisories/GHSA-jcxm-7wvp-g6p5) |
| Jul 2025 | Fake GitHub "solana-pumpfun-bot" | Malicious git-hosted dependency `crypto-layout-utils` scanned for wallet files and keys; stars and forks faked | n/a | SlowMist analysis | [Cointelegraph](https://cointelegraph.com/news/solana-trading-bot-github-malware-scam) |
| Jul 2025 | GMGN | Fake GMGN drainer site | n/a | n/a | [solbotrank](https://solbotrank.com/guides/is-gmgn-safe) |
| Oct 2025 | Solana-wide | Sandwiching: >18,000 SOL taken from >202K victims (Sandwiched data); Jito banned 15 validators (article figures internally inconsistent) | ~$3.2M | Validator bans | [Yahoo Finance](https://finance.yahoo.com/news/sandwich-attacks-spiraling-control-solana-112345764.html) |
| 25 Oct 2025 | GMGN | Anti-MEV node failure; 729 BNB Chain txs sandwiched | n/a | Auto-reimbursed | [solbotrank](https://solbotrank.com/guides/is-gmgn-safe) |
| 28 Oct 2025 | GMGN | Phishing via a forged third-party token site (~107 users) | n/a | Reimbursed same day | [solbotrank](https://solbotrank.com/guides/is-gmgn-safe) |
| Nov 2025 / Feb 2026 | Photon | Clone domain photon-sol.com flagged; drainer campaigns impersonating Photon (Recorded Future) | n/a | n/a | [solbotrank](https://solbotrank.com/guides/is-photon-safe) |
| 26 Feb 2026 | Axiom | ZachXBT alleged that a staffer abused internal support tools to look up user wallets and influencers' private wallets; Axiom removed access and opened an investigation | alleged ~$400K gains (headline) | Investigation | [The Block](https://www.theblock.co/post/391423/zachxbt-investigation-into-alleged-employee-insider-trading); [Yahoo Finance](https://finance.yahoo.com/news/axiom-crypto-exposed-zachxbt-alleges-122625589.html) |
| 11 Mar 2026 | BONK.fun (launchpad) | DNS hijack | $30K | n/a | [DefiLlama hacks](https://api.llama.fi/hacks) |
| undated (seen 3 Oct 2026) | Fasol | "Fasol has been compromised"; service suspended | n/a | Investigating; compiling affected users | [fasol.trade](https://fasol.trade/) |

**Most common complaints**
- **Fees:**
  - Users paid Axiom $301M and GMGN $230M in fees over the past year — [DefiLlama Axiom](https://api.llama.fi/summary/fees/axiom?dataType=dailyFees); [DefiLlama GMGN](https://api.llama.fi/summary/fees/gmgn?dataType=dailyFees).
  - Photon's Trustpilot complaints centre on fees and failed sells — [solbotrank](https://solbotrank.com/guides/is-photon-safe).
- **Failed or slow transactions and slippage:**
  - MevX warned of slow transactions and high slippage during congestion (Oct 2024) — [MevX on X](https://x.com/MEVX_Official/status/1849051132976582736).
  - Jupiter's featured support topics are swap failures, slippage, "No routes found" and failed limit/recurring orders — [Jupiter support](https://support.jup.ag/hc/en-us).
- **Sandwiching:**
  - The Oct 2025 wave and GMGN's node failure (above).
  - Banana Pro's docs warn that Public mode needs tight slippage "to mitigate potential sandwich attacks" — [Banana Pro docs](https://banana-gun.gitbook.io/banana-pro/).
- **Custodial risk:** a bot that "generates the private key and stores it on its servers" exposes every wallet in a single compromise. Users are advised to keep only limited funds in such hot wallets — [crypto.news](https://crypto.news/what-are-telegram-trading-bots-unibot-banana-gun-how-they-work/).
- **Copy-trading exit liquidity:**
  - Banana: targets "may become malicious and try to drain your funds by aping into pump and dumps or honeypots" — [Banana Pro docs](https://banana-gun.gitbook.io/banana-pro/).
  - Trojan: copying snipers makes you their exit liquidity — [Trojan copy trading](https://docs.trojan.com/terminal-overview/tools-and-widgets/copy-trading-bot.md).
- **Platform and token "rugs" through acquisitions:** PADRE lost all utility ([Bitget](https://www.bitget.com/news/detail/12560605030072)); Vyper is shutting down ([Cointelegraph via TradingView](https://www.tradingview.com/news/cointelegraph:38b828f1a094b:0-pump-fun-moves-deeper-into-trading-infrastructure-with-vyper-acquisition/)); Vector's apps were closed ([Fortune](https://www.fortune.com/2025/11/21/coinbase-buys-solana-vector-fun-acquisition-spree)).
- **Phishing and impersonation:**
  - GMGN warns about clipboard-stealing malware and fake admins — [GMGN Q&A](https://docs.gmgn.ai/index/q-a.md).
  - Lookalike Fasol marketing domains use different bot handles — [fasolbot.com](https://fasolbot.com/).
- **Tool-specific:**
  - Maestro: confusing setup, wrong-token buys, "drained wallet" reports — [coinspot (affiliate)](https://coinspot.io/en/telegram-trading-bots/maestro-trading-bot/).
  - Fasol: noisy alerts, 10+ a day — [defipill (affiliate)](https://defipill.xyz/telegram-trading-bots/fasol_bot_review/).
  - Axiom: "trust concern" after the insider allegation (Jun 2026) — [Coin Bureau](https://coinbureau.com/review/axiom-trade-review).

**Security patterns already used by competitors and worth copying**
- **Delay changes to security settings:**
  - Withdraw-address changes take 24h to apply — [Bloom FAQ](https://docs.bloombot.app/solana/miscellaneous/faqs.md).
  - New PINs activate after 8h and resets take 7 days — [Banana Pro docs](https://banana-gun.gitbook.io/banana-pro/).
- **Withdrawal controls:** a whitelist plus a 3h wait before the first withdrawal; 2FA for fund consolidation — [solbotrank on GMGN](https://solbotrank.com/guides/is-gmgn-safe); [GMGN multi-wallet](https://docs.gmgn.ai/index/tg-wallet-connect-tg-multi-wallet-system.md).
- **Protect key export:**
  - 2FA plus a password to export keys — [STBot docs](https://soltradingbot.gitbook.io/docs/llms-full.txt).
  - Private keys encrypted with a user-chosen password — [padre.gg](https://padre.gg/).
  - An action password — [Trojan bot docs](https://docs.trojanonsolana.com/llms-full.txt).
- **Cap automated spending:** server-enforced per-trade and per-day caps, with keys that can be revoked instantly — [Shuriken docs](https://docs.shuriken.trade/llms-full.txt). A copy-trade spend limit per target — [Banana Pro docs](https://banana-gun.gitbook.io/banana-pro/).
- **Simulate before sending** — [padre.gg](https://padre.gg/).
- **Revoke approvals** — [Maestro token report](https://docs.maestrobots.com/sniper/pasted-contracts/token-report-menu.md).

### Inferences (hot-wallet lessons for a self-hosted terminal)
Each lesson is my design inference, tied to the incidents and patterns above.
- **Never centralise keys.** DEXX and Thunder Terminal show what one key store costs.
  - Store keys encrypted at rest: an OS keychain or a passphrase-derived keystore.
  - Never keep plaintext keys in `.env` files.
  - Expose no network-reachable key-export endpoint.
- **Isolate signing.** Run a minimal-dependency signer process, separate from the UI and from indexer code. The web3.js backdoor specifically hit bots holding raw keys, and the fake sniper bot scanned local files for keys.
- **Supply-chain hygiene.**
  - Pin exact dependency versions with lockfile hashes.
  - Ban git/URL dependencies; this is how `crypto-layout-utils` got in.
  - Flag obfuscated code in CI.
  - Ship reproducible, signed releases and name one canonical repo, since stars and forks can be faked.
- **Limit the blast radius.**
  - Keep a small hot balance and auto-sweep to a cold address.
  - Use a withdraw allowlist with a 24h time-lock on changes (Bloom) and delay security-setting changes (Banana).
  - Cap per-trade and per-day spend for every automation: copy trades, snipers and agent keys (Shuriken, Banana).
- **No standing approvals or arbitrary calls.** Allowlist program IDs and simulate and decode every transaction before signing. These are the lessons of the Maestro and Unibot router/approval exploits.
- **Avoid DNS and front-end hijack.** Serve the UI locally (localhost or a pinned build) rather than from a domain, to remove the BONK.fun-style DNS hijack and phishing-clone risk. Build an in-app check of the canonical release signature, since Photon and GMGN clones show that users get phished through search ads and lookalike domains.
- **Make MEV protection the default and monitor it.** The GMGN node failure shows a single protection endpoint can fail silently. Run several protected routes and alert when fills show sandwich signatures.
- **Keep the operator out of user data.** Self-hosting removes the Axiom- and Solareum-style insider vector. Telemetry should stay off by default so that no wallet-to-identity mapping leaves the user's machine.

### Gaps
- **Not opened directly:** primary post-mortems for Banana Gun (2024), DEXX, Unibot and Thunder Terminal. Amounts and classifications come from DefiLlama's hacks database; mechanisms beyond its labels are unverified.
- **Fasol:** the incident date, attack vector and losses are unknown.
- **Not cross-checked:** further 2025–26 incidents, such as malicious extensions and Telegram "verification bot" scams.

## Implications for the build

A deduplicated superset for a self-hosted, zero-fee, open-source Solana terminal. **MUST** = needed to be competitive with Axiom/GMGN; **NICE** = differentiator or later phase. The source tools are named after each item.

**A. Discovery and token intelligence**
- **MUST.** Three-column launch feed across launchpads: New / About to graduate / Migrated.
  - Global and per-column filters: age, mcap, liquidity, volume, holders, bonding %, dev %, top-10 %, sniper %, insider %, bundler %, socials, launchpad, dev migrations / pairs created.
  - Pause-on-hover; per-column quick-buy and second-button sell.
  - Keyword and dev blacklist with import/export.
  - Dockable / floating / new-window layout.
  - From: Axiom Pulse, GMGN Trenches, Trojan Trenches, Banana Pro Live Pairs, BONKbot X-Ray, MevX Meme Zone, Jupiter AlphaScan.
- **MUST.** Token risk panel:
  - Mint/freeze authority; LP burn %; top-10 %; dev holding %.
  - Dev funding source; dev history (created / migrated / last 7d).
  - Creator rug history; insider / sniper / bundler / first-70 / dev-connected / cluster tags.
  - Blacklist (frozen-wallet) warning.
  - From: BONKbot, GMGN CA Checks, Jupiter AlphaScan, Banana Pro Top Traders, Trojan Audits.
- **NICE.** Rug probability from holders' rug-buying history (GMGN); Organic Score / wash-trading flags (Jupiter); bubble map / cluster view (Banana Pro via InsightX, MevX).
- **NICE.** Wallet Radar: shared holders, earliest buyers and top profit across up to N tokens, with export to tracking or copy (GMGN). Top-traders table with labels and hover PnL (Banana Pro).
- **NICE.** Signals page: DEX-paid, ATH, key-mcap, CTO and livestream events (GMGN); X/web preview hotkeys with video auto-play (GMGN).
- **NICE.** Backtesting of feed and sniper filter sets against history (Fasol); a sniper sandbox and paper-trading mode (Uxento, MevX Demo).

**B. Execution**
- **MUST.** Global paste/clipboard buy bar plus a token card with preset buy and sell-% buttons, "auto-buy on paste" and "confirm trades" toggles, and "Sell Init." From: Trojan Clipboard Buy, BONKbot, Maestro, Axiom Instant Trade.
- **MUST.** Execution presets (P1–P4) that bundle slippage, priority fee, tip and MEV mode, with Secure (Jito/bundle-only) vs Turbo/Public semantics. From: BONKbot, Banana Pro, Axiom, Trojan profiles, Photon S1–S3.
- **MUST.** Guards: price-impact limit, min-tokens-out revert, max slippage, and simulation before send. From: Banana Pro, Padre.
- **MUST.** Multi-wallet: at least 10 wallets; bulk buy/sell across selected wallets with per-wallet amounts; proportional sells; distribute and consolidate; groups. From: Trojan, GMGN, Banana Pro, Maestro, Nova.
- **MUST.** Keyboard hotkeys for feed and trade, including column + row buys. From: GMGN, Axiom, Trojan Instant Trade.
- **NICE.** Multi-route submission with failover (Jito + staked RPC + bloXroute) and region choice. From: Nova Demon Mode / Regions, Photon / Padre bloXroute, Trojan / Banana backup bots.
- **NICE.** Cost-capped snipes (max fee + bribe) and split ("spam") buys. From: BONKbot Nighthawk Speed, Trojan Spam Buy.

**C. Sniping and automation** (runs in an always-on local daemon)
- **MUST.** Migration snipe (a pre-set buy that fires on bonding-curve completion) and migration sell. From: GMGN Migrated Snipe, Axiom Migration Actions, Trojan, Banana Pro Quick Snipe, Nova, STBot Sell Sniper.
- **MUST.** Filter-based auto-sniper (AFK mode) for new launches.
  - Settings: dev-history filters, max buy count, deployer and keyword blacklists or whitelists, per-task wallets and fees.
  - Guards: max-mcap failsafe; first-bundle-only option; min/max liquidity.
  - From: Bloom AFK, Trojan Auto Sniper, Nova, Maestro, Looter, BONKbot Precision, Banana Pro.
- **NICE (needs a paid X data feed).** X/Twitter CA auto-snipe on chosen accounts, by tweet type, keyword match and OCR of images, with filters and attached TP/SL. From: GMGN SnipeX, Bloom Twitter tasks, Uxento.
- **NICE.** Dev-wallet snipe: auto-buy a watched creator's next launch. From: Nova, STBot, Bloom deployer lists.
- **NICE.** Telegram/Discord call ingestion, through a bot the user adds to their own groups. Shows a live feed with caller stats and optional capped auto-buy. From: Trojan Alpha (TokenScan), Padre Alpha Tracker, Maestro call channels, Bloom and Banana scrapers, Shuriken reputation weighting.

**D. Orders and exits**
- **MUST.** Limit orders by price, mcap or % with expiry; multi-wallet. From: all tools.
- **MUST.** Auto-sell ladders attached at buy time (several TP levels plus SL, sized from entry). From: Trojan Auto-Sell, GMGN, Axiom Advanced Trading Strategy, Banana Quick Sell Limit.
- **MUST.** Trailing stop (and trailing TP). From: GMGN, Trojan bot, BONKbot, Maestro, MevX, Jupiter.
- **MUST.** Dev-sell triggers: auto-sell when the dev sells (fixed, matching % or % of position), plus an optional "buy on dev sell". From: GMGN, MevX Dev Sell Config, STBot Order Sell, Padre.
- **MUST.** DCA buy/sell with interval, duration and an mcap/price band. From: Trojan, Jupiter, STBot, BONKbot, MevX.
- **NICE.** OCO / OTOCO brackets (Jupiter Trigger V2); range "Smart Orders" with reversal-confirmed closes (LAB); event orders on migration (Trojan); breakout buys (BONKbot).

**E. Copy trading** (an Axiom gap)
- **MUST.** Per target:
  - Sizing: fixed or % of the target's buy; max per buy; **total spend limit**; active-time window.
  - Filters: mcap / liquidity / age; exclude bonding-curve tokens; prevent duplicate buys; token blacklist.
  - Copy-sell (same %) and auto TP/SL on copied buys.
  - Its own fee, tip, slippage and MEV settings; batch pause/resume.
  - From: Trojan Terminal, GMGN, Banana Pro, Bloom, Maestro.
- **NICE.** Track-only mode (Maestro); reverse mode (Bloom, TradeWiz); a configurable copy delay (not offered by any tool reviewed).

**F. Tracking and alerts**
- **MUST.** Wallet tracker:
  - Groups (KOL, dev, etc.); per-wallet alert types and sounds; emoji chart markers.
  - Dev-wallet tags on feed cards.
  - Alert filters by event type, mcap, size and age; JSON import/export; a Monitor dashboard.
  - From: Trojan, Axiom, Jupiter SmartMoney, BONKbot Telemetry.
- **MUST.** Self-hosted Telegram companion bot: fills, TP/SL, copy events, tracked-wallet trades and migrations, each deep-linking to `/token/<CA>`; optional PIN-gated `/buy`. This closes Axiom's off-app alert gap. From: GMGN 0-Delay Bot, MevX, Trojan deep links, BONKbot alert channels.
- **NICE (needs an X data source).** X tracker: chosen accounts; tweet, reply, repost, quote and bio-change events; CA highlighting that opens a trade; Truth Social. From: GMGN, Trojan, Axiom.
- **NICE.** Group-chat contract-query bot (GMGN).

**G. Analytics**
- **MUST.** Positions and PnL: realized/unrealized; PnL mode (per-position vs lifetime); fees-in-PnL toggle; shareable PnL cards. From: Trojan, Axiom, Bloom, Looter, Banana.
- **NICE.** PnL calendar (Bloom, Jupiter, Axiom); streamer overlay (Bloom); Wallet Analyzer (Trojan, GMGN).

**H. Platform**
- **MUST.** Local-first web UI with dockable widgets and multi-chart (Trojan, GMGN, Banana Pro). Mobile-friendly PWA that syncs to the user's own instance (Trojan Mobile).
- **NICE.** Browser extension that injects quick-buy into DexScreener, GMGN, Axiom, X and pump.fun pages, executing through the local engine. From: Bloom, MevX, LAB, Uxento, Nova Click.
- **NICE.** Local REST API and MCP server with scoped "agent keys" carrying hard per-trade and per-day caps and instant revoke. From: Shuriken, GMGN Agent API, Jupiter CLI/MCP.

**I. Hot-wallet security**
- **MUST.** Encrypted keystore (OS keychain or passphrase KDF), a separate signer process, no plaintext key files. Key export gated by password plus TOTP. From: STBot, Padre, Trojan Secure Action Password.
- **MUST.** Withdraw-address allowlist with a 24h time-lock on changes; security-setting changes delayed. From: Bloom, Banana Pro PIN delays.
- **MUST.** Per-automation spend caps and a global daily loss/spend limit. From: Shuriken agent caps, Banana copy spend limit.
- **MUST.** Program-ID allowlist, no standing token approvals, simulate-and-decode before signing. Lessons from Maestro and Unibot.
- **MUST.** Supply-chain controls: pinned dependencies, no git dependencies, signed reproducible releases, a canonical repo. Lessons from the web3.js and GitHub sniper-bot malware.
- **NICE.** Auto-sweep profits to a cold or hardware wallet (Ledger and Trezor are supported in the Jupiter wallet extension); session PIN lock (Banana).

**Out of scope or not to copy**
- **Perps:** out of scope per the coordinator; kept only as a matrix column.
- **Referral, cashback, points and tokens:** irrelevant to a zero-fee tool. These are Arena/jackpot-style gamification (Trojan), BANANA revenue share, the $LAB airdrop and cashback tiers.
- **Not recommended:**
  - Maestro's copy-trade "Frontrun" (outbids the target's gas on EVM) and "Blind Follow" (skips origin checks; spoofing risk).
  - Default auto-buy without confirmation, as BONKbot does. Ship it off by default.
- **Excluded (manipulation):** Uxento uDev "bundle and snipe your coins" launch bundling; token cloning / "vamp" deployers (Uxento uDupe / Insta Vamp; Bloom's "Deploy/Vamp" pages, not reviewed). No volume or bump bots appeared in the sources reviewed.
