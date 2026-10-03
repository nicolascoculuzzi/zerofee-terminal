# Zero-fee Axiom runs on browser-held keys

A zero-platform-fee Axiom equivalent can be built in 2026 as a hosted website whose operator never touches user keys. Users log in the way GMGN users do: they connect Phantom, Solflare or Backpack through Wallet Standard and sign a Sign-In With Solana message. They then trade in one of two modes. Instant mode uses a trading wallet that is generated, encrypted (Argon2id or passkey) and signed entirely inside their own browser, with no popup. Direct mode has the connected wallet approve each trade. The backend ingests one Yellowstone gRPC stream, decodes Anchor event-CPI data from about ten launchpad and AMM programs, builds transactions with local pump.fun, PumpSwap, Raydium LaunchLab and CPMM builders, and lands them through Helius Sender and Jito with MEV protection on by default.

Because signing happens in the browser, **signatures cost nothing**. Privy's server-signer model was evaluated in depth and rejected: its public pay-as-you-go price (a $2,000 base plus $0.01 per signature above 50,000) comes to about **$16.50 per user per month at 50 trades a day**, which is more than the entire infrastructure bill. Even its Enterprise price ("as low as $0.001/signature") would be about $1.50 per user. The cheapest viable stack in the notes costs roughly **$330 a month at 100 users, $880 at 1,000 and $2,400 at 10,000**, or $3.30 down to $0.24 per user. That stack is Chainstack gRPC plus RPC ($98), Helius Sender (free), Hetzner servers next to Frankfurt, self-hosted SQLite and Postgres, Lightweight Charts, and a curated twitterapi.io handle pool.

Keeping keys in the browser costs flexibility in automation. Limit orders, TP/SL, trailing stops, DCA, dev-sell exits, pump.fun migration snipes and copy-trade sells can keep running with the tab closed, as pre-signed transactions on durable nonces that the server holds ready to submit. Anything that needs a token chosen after the tab closed needs an open browser: copy-trade buys, filter snipes on new launches, X contract-address snipes.

Three problems remain hard:

- **pump.fun's interface churn.** There have been about ten changes since May 2025, the last breaking one on 2026-04-28, and each one also invalidates armed orders.
- **Sandwiching.** Axiom users are hit 18.9 times more than their share of trades predicts.
- **Front-end integrity.** This replaces custody as the main security risk, because malicious JavaScript is what steals browser-held keys.

Axiom still leaves openings in automation, off-app alerts, X keyword alerts, published metric definitions and a public API. All figures are as of 2026-10-03 unless dated otherwise, with SOL at $119.50 ([CoinGecko API](https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd)) and €1 = $1.1225 ([ECB via Frankfurter](https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD)).

## Six products split a $57M monthly fee pool that Axiom still leads

The Solana terminal market has consolidated hard. My researchers aggregated DefiLlama's daily Solana-chain fees for 27 trading apps and bots. In September 2026 **Axiom took about 52.8% of a $56.8M pool, Fomo 22.7%, GMGN 10.7%, pump.fun's Terminal (ex-Padre) 9.2% and Trojan 1.8%**. In January 2025 the pool was $288.9M, five times larger, and the leaders were Photon (29.3%) and BullX (18.9%) ([DefiLlama Axiom](https://api.llama.fi/summary/fees/axiom?dataType=dailyFees); [DefiLlama Photon](https://api.llama.fi/summary/fees/photon?dataType=dailyFees)). Photon fell from $84.6M of monthly Solana fees to $0.35M. BullX NEO now reads "wallet-only … no chains are active for trading" ([solanatradingbots (affiliate)](https://solanatradingbots.com/bullx-how-to-use/)).

Over the trailing 30 days, Solana trading apps and Telegram bots collected **$59.0M in fees; over the past year, $476.1M**. Platforms kept $38.0M and $294.8M respectively after cashback and referrals ([DefiLlama Solana overview](https://api.llama.fi/overview/fees/solana?dataType=dailyFees)). Axiom alone has **$760.3M of all-time fees and $460.3M of revenue**, peaking at $92.7M of fees in May 2025 ([DefiLlama Axiom](https://defillama.com/protocol/axiom)).

Three structural shifts matter for a new entrant:

- **pump.fun now owns a terminal.** It bought Padre on 24 Oct 2025 and rebranded it Terminal. In early 2026 it bought Vyper, which it is shutting down ([Cryptobriefing](https://cryptobriefing.com/pump-fun-acquires-padre-trading-terminal-multi-chain-expansion/); [Cointelegraph via TradingView](https://www.tradingview.com/news/cointelegraph:38b828f1a094b:0-pump-fun-moves-deeper-into-trading-infrastructure-with-vyper-acquisition/)).
- **GMGN's growth has moved off Solana.** Of its $48.7M in September 2026 fees, $27.7M came from Robinhood Chain and $12.7M from BSC, against $6.1M from Solana ([DefiLlama GMGN](https://api.llama.fi/summary/fees/gmgn?dataType=dailyFees)).
- **The fastest-growing product is a mobile social app.** Fomo raised a $75M Series B led by Index Ventures on 22 Jun 2026. It charges a fee that "depends on factors including the size and type of the transaction" ([Fomo Series B](https://fomo.family/blog/fomo-series-b); [Fomo terms](https://fomo.family/terms)).

Custody across the field is hosted. Axiom runs on Turnkey, while Trojan's web Terminal and Fomo run on Privy ([Axiom FAQ](https://docs.axiom.trade/faqs); [trojan.com](https://trojan.com/)). GMGN's own docs describe a Phantom-login account as a "multi-chain custodial wallet account" where key export is "prohibited" ([GMGN multi-wallet](https://docs.gmgn.ai/index/tg-wallet-connect-tg-multi-wallet-system.md)). A design that copies GMGN's wallet-connect login but keeps the trading key in the user's browser is therefore a real differentiator, not just a cost saving.

Platform fees are close to uniform. Almost everyone lists **1% per buy and per sell**, reduced by cashback and referrals:

- **Axiom** nets 0.95% (Wood tier) down to 0.75% (Champion), and pays referrers 30% / 3% / 2% of its net fee across three levels ([Axiom fees](https://docs.axiom.trade/getting-started/fees/axiom-fees); [Axiom referrals](https://docs.axiom.trade/getting-started/referral-program)).
- **Trojan** returns 10–45% cashback, **Maestro** 15–30% and **BONKbot Telemetry** 5–25% ([Trojan ranks](https://docs.trojan.com/trojan-arena/ranks-and-rewards); [Maestro cashback](https://docs.maestrobots.com/sniper/cashback); [BONKbot cashback](https://docs.bonkbot.io/rewards/cashback)).
- **The low end** is LAB at 0.5%, PumpPortal's Local API at 0.5%, Uxento at 0.75%, and Jupiter Ultra at 10 bps (50 bps on tokens under 24 hours old) ([LAB](https://docs.lab.pro/intro/introducing-lab-terminal-your-new-way-to-trade/unique-features-and-benefits.md); [PumpPortal](https://pumpportal.fun/fees/); [uxento.io](https://www.uxento.io/); [Jupiter Ultra fees](https://developers.jup.ag/docs/ultra/fees)).

A trader doing $100K a month pays roughly $650–1,000 a month at these rates. That is the zero-fee pitch.

Every serious terminal runs the same pipeline:

1. A streaming feed (gRPC with transaction metadata, optionally shreds) delivers every launchpad and AMM transaction.
2. A parser decodes create, trade, complete and migrate events.
3. A derivation layer computes price, market cap, bonding progress, volume, holders and risk tags, and pushes changes to the browser.
4. When the user clicks, a transaction is built from in-memory state, signed and fanned out to landing services.
5. Confirmation comes back on the same stream.

Feature breadth did not protect Photon or BullX. Both lost most of their share within about two quarters of Axiom's launch. That suggests execution speed, UX polish and referral economics matter more than feature count, though this is my reading of the DefiLlama series, not a measurement.

## The feature superset is Axiom's core loop plus the automation it never shipped

Axiom ships two to four named features every one or two weeks. The best record of what exists is a release log kept by an affiliate, Market Watcher, from March 2025 to 30 Jul 2026 ([Market Watcher thread](https://x.com/watchingmarkets/status/1905592261251137932)). Most releases are small, compounding data and display improvements, so parity depends more on the data pipeline underneath than on the long tail.

The table merges the Axiom inventory with the documented features of ten competitors. In the Axiom column, "Y" reflects official docs plus September 2026 screenshots from apebrief.com, and "N" means not documented, which is weaker than proven absent. The last column marks what can keep running with the browser closed under the chosen wallet model.

| Area | Feature (exact labels where known) | Axiom, Oct 2026 | Who else documents it | Priority / tab-closed? |
|---|---|---|---|---|
| Discovery | Three-column live board: New Pairs / Final Stretch / Migrated, with per-column search, quick-buy amount, P1–P3 presets and Filters | Y ([apebrief pulse](https://apebrief.com/axiom/pulse/)) | GMGN Trenches, Trojan Trenches, Banana Live Pairs, Telemetry X-Ray, MevX Meme Zone, Jupiter AlphaScan | P0 |
| Discovery | Filter panel: Search/Exclude Keywords; Protocols (27 launchpads); Quote Tokens (SOL, USDC, USD1, STOCK, OTHER); Audit; $ Metrics; Socials. Three presets, Apply All, import/export/share | Y ([apebrief filters](https://apebrief.com/axiom/pulse-filters/)) | Most terminals | P0 |
| Discovery | The 14 documented filters: Age (mins), Top 10 Holders %, Dev Holding %, Snipers %, Insiders %, Bundle %, Holders, Pro Traders, Liquidity, Volume, Market Cap, Txns, Num Buys, Num Sells | Y ([Axiom Pulse](https://docs.axiom.trade/axiom/finding-tokens/pulse)) | Mobula and Codex expose the same counts | P0 |
| Discovery | Blacklists for tokens (Master Pulse), devs, X accounts and funding wallets (Jun 2026) | Y | Trojan, Bloom deployer lists | P0 |
| Discovery | Pause the feed on hover | N | GMGN, Telemetry | P0 (cheap win) |
| Discovery | Keyboard buys from the feed | Y (Pulse Hotkeys, Jan 2026) | GMGN (hold Z + row; Space + column + row) | P0 |
| Discovery | Sound alerts; row and metric colours; decimals; "Ultra Glow"; toast position; mini charts; PnL on rows | Y | Trojan colour thresholds | P1 |
| Discovery | Trending with a time window, Watchlist, global search (name/ticker/CA/wallet/dev), Similar Tokens "OG Mode", Pump Live, Surge alerts, Vision (KOL wallets), Lighthouse | Y | GMGN Signal page (Dex Paid, ATH, Key-MC, CTO, AI Signal) | P1–P2 |
| Trading | Instant Trade: P1/P2/P3, wallet picker, buys of 0.01/0.1/1/10 SOL, sells of 10/25/50/100%, "Adv.", "Sell Init.", no confirmation | Y ([apebrief instant trade](https://apebrief.com/axiom/instant-trade/)) | Trojan Instant Trade, BONKbot P1–P4 | P0 |
| Trading | Presets holding slippage, priority fee, bribe and MEV mode (Off / Reduced / Secure); defaults 0.001 / 0.001 | Y ([Axiom Solana fees](https://docs.axiom.trade/getting-started/fees/solana-fees)) | GMGN off/reduced/secure; Banana Jito-only vs Public | P0 |
| Trading | Paste/clipboard buy bar, "auto-buy on paste", "Confirm Trades" toggle | ? | Trojan Clipboard Buy, BONKbot (no confirm), Maestro | P0 |
| Trading | Speed modes ("Turbo", "Fastest Submission Engine", "Katana Mode" V2) | Y, mechanism unpublished | Nova "Demon Mode", Trojan Spam Buy (up to 10 txs) | P0 (landing engine) |
| Trading | Multi-wallet: up to 25 wallets, groups, split supply, randomized buys, transfers, Claim Rent | Y | GMGN 10, Trojan 10 active, Maestro 8–10 per chain | P1 (no signature cost in the browser) |
| Orders | Limit orders by MC or price; ±100% slider; draggable "Limit Order Target" line | Y ([apebrief limits](https://apebrief.com/axiom/limit-orders/)) | All | P0 / yes, pre-signed |
| Orders | TP/SL ladder set at entry ("Advanced Trading Strategy") | Y (Oct 2025) | Trojan Auto-Sell, GMGN (up to 10 levels) | P0 / yes, pre-signed |
| Orders | Migration buy/sell ("Sniper Buy"; Sell → Advanced → Migration) | Y ([Axiom migration](https://docs.axiom.trade/axiom/swap/migration-actions)) | GMGN Migrated Snipe, Banana Quick Snipe, STBot Sell Sniper | P0 / yes for pump.fun |
| Orders | Trailing stop / trailing take-profit | N | GMGN, Trojan bot, BONKbot, Maestro, MevX, Jupiter | P1 / partly (price grid) |
| Orders | DCA (interval, duration, MC band) | N (one review claims it; docs silent) | Trojan, Jupiter, STBot, BONKbot, MevX | P1 / yes, one tranche per nonce |
| Orders | Dev-sell triggers (sell, or buy, when the dev sells) | N | GMGN, MevX Dev Sell Config, STBot, Padre | P1 / sells yes |
| Orders | OCO / OTOCO, range "Smart Orders", event orders | N | Jupiter Trigger V2, LAB, Trojan | P2 / OCO via shared nonce |
| Automation | Filter-based auto-sniper (AFK) with max-MC failsafe, first-bundle-only, liquidity bounds | N | Bloom AFK, Trojan, Nova, Maestro, Looter, BONKbot Nighthawk | P2 / browser open |
| Automation | Auto-snipe on contract addresses posted on X (with OCR) | N | GMGN SnipeX (10 tasks × 7 days), Bloom, Uxento | P2 / browser open |
| Automation | Dev-wallet snipe (buy a dev's next launch) | N | Nova, STBot, Bloom | P2 / browser open |
| Copy trading | Fixed or % sizing, max per buy, total spend limit, MC/liquidity/age filters, exclude bonding curve, prevent duplicates, copy-sell, TP/SL on copies | N ("Copy Trading: Absent", [AXL](https://www.axltoken.com/trading-bots/gmgn-vs-axiom/)) | Trojan, GMGN (10 tasks), Banana (spend limit), Bloom (Reverse mode), Maestro (Track Only) | P1 / buys need browser open; sells pre-signed |
| Token page | Chart toggles MarketCap/Price and USD/SOL, 1s candles; lines for own avg entry/exit, top-holder avg, migration MC, KOL holdings; bubbles for DEX paid, migration, snipers, clusters; click a candle to filter trades | Y | Telemetry, Jupiter markers | P0 core, P1 bubbles |
| Token page | Token info: Top 10 H., Dev H., Snipers H., Insiders, Bundlers, LP Burned, Holders, Pro Traders, Dex Paid; fresh/shared wallets, fees paid, dev funding, Streamflow locks | Y ([apebrief metrics](https://apebrief.com/axiom/token-metrics/)) | GMGN rug probability and creator rug history; Jupiter Organic Score | P0 |
| Token page | Trader Scan (per-wallet buys, sells, balance, realized PnL, hold time) | Y ([Axiom Trader Scan](https://docs.axiom.trade/trader-scan)) | Banana Top Traders labels | P1 |
| Trackers | Wallet tracker: Wallet Manager / Live Trades / Monitor; emoji + name; import from BullX and GMGN; 10,000 wallets; transfers | Y | Trojan (groups, dev tags on cards), Jupiter SmartMoney | P0 / server-side |
| Trackers | X tracker: My List / Top Tracked / Tracking; Truth Social; follows; profile changes. Keyword/trend filters "Coming Soon" since Mar 2025 | Partial ([apebrief twitter](https://apebrief.com/axiom/twitter-tracker/)) | GMGN (Tweet/Reply/Retweet/Quote/Bio), Trojan, Uxento | P1 / server-side |
| Trackers | Ingesting calls from Telegram/Discord groups, with caller leaderboards | N | Trojan Alpha (TokenScan), Padre Alpha Tracker, Shuriken | P2 |
| Alerts | Off-app alerts for wallets, X and fills | Price alerts only, to Discord/Telegram (Aug 2025) | GMGN 0-Delay Bot, MevX, every Telegram bot | P1 / server-side |
| Portfolio | Balance, PnL chart, performance buckets, positions, activity; PnL cards (custom, multi-wallet, video), PnL calendar, fees included in PnL | Y | Bloom stream overlay, Trojan Lifetime mode | P0 core, P1 cards |
| Platform | Native mobile app | N (PWA since Sep 2025) | GMGN, Fomo, LAB, Jupiter | P2 (PWA first) |
| Platform | Public API / agent keys with caps | N | GMGN Agent API, Shuriken MCP with capped keys, Jupiter | P2 |
| Platform | Browser extension over rival UIs | N | Bloom, MevX, LAB, Uxento, Nova Click | P2 |
| Platform | Paper trading, sniper sandbox, filter backtesting | N | MevX Demo, Uxento, Fasol | P2 |
| Security | 2FA, withdrawal allowlist, delayed security changes | Not documented | GMGN (2FA, whitelist, 3h wait before first withdrawal), Bloom (24h cooldown on withdraw-address changes), Banana (PIN activates after 8h, 7-day reset), BONKbot (2FA with backup key) | P0, rebuilt around wallet signatures |

Perpetuals are out of scope; Axiom offers them on Hyperliquid at up to 50x leverage with a 0.01% fee ([Axiom perps](https://docs.axiom.trade/perpetuals/deposit)). Axiom's other non-core products are peripheral to the trading loop: an axiSOL liquid-staking token (5% of earnings, 0.1% withdrawal fee) and prediction markets powered by Polymarket or Kalshi ([Axiom staking](https://docs.axiom.trade/staking)).

The gaps Axiom leaves are consistent across sources ([Axiom FAQ](https://docs.axiom.trade/faqs); [axiompedia troubleshooting](https://axiompedia.com/troubleshooting)):

- No automatic copy trading, despite tracking 10,000 wallets.
- No DCA or trailing stops.
- No off-app alerts except price alerts.
- No X keyword alerts, which were promised in the March 2025 docs.
- No public API and no native app.
- No documented 2FA or withdrawal allowlist.
- No published definitions for snipers, insiders or pro traders. Only bundles are defined: "4+ transactions in the same block".

Its recurring complaints are failed transactions and slippage, the 1% fee on small trades, an undocumented cap on open limit orders, and Discord-only support. Two incidents shaped its reputation. A Pump.fun API change on 28–29 Aug 2025 left Axiom users unable to sell for hours. In February 2026 an employee abused internal support tools ([axiompedia](https://axiompedia.com/security/is-axiom-trade-safe); [@AxiomExchange](https://x.com/AxiomExchange/status/2027018976929423583)).

Copy-trading controls have converged across competitors. Every major tool warns that copied wallets can turn followers into exit liquidity, and none documents a configurable copy delay ([Trojan copy trading](https://docs.trojan.com/terminal-overview/tools-and-widgets/copy-trading-bot.md); [Banana Pro](https://banana-gun.gitbook.io/banana-pro/)).

### Screens and flows to build

Mobbin has no Axiom, Hyperliquid, Jupiter, Moonshot or Fomo screens. The Axiom UI was therefore reconstructed from screenshots in Axiom's own docs, which appear to date from early-to-mid 2025. Comparable patterns come from Coinbase Advanced, Kraken Pro, OKX, Binance, Phantom and OpenSea ([Axiom docs index](https://docs.axiom.trade/llms.txt)). Axiom's power features (Instant Trade, wallet tracker, Twitter alerts) are draggable floating windows that pop out rather than separate pages, so the web app needs a small window manager. The chosen wallet model changes four screens from Axiom's pattern: onboarding, settings, wallets/funding, and a new armed-orders view.

| Screen | Contents | Borrow from |
|---|---|---|
| Global shell | Top nav (Discover, Pulse, Trackers, Portfolio); ⌘K or "/" search by name, ticker or CA; Quick Buy amount and P1; trading-wallet selector with SOL balance and lock state; mode switch (Instant/Direct); Fund; MEV status; bottom bar with wallet-tracker and "Social" toggles | OpenSea chord shortcuts, Kraken status bar |
| Pulse | Three columns of about nine three-line cards each. A card shows: avatar with launchpad badge; ticker, name and copy-CA; age in green; socials; holder counters; five coloured risk chips; MC / V / TX; and a purple "⚡ 2.0 SOL" quick-buy pill. Each column has its own filter button ([Axiom Pulse](https://docs.axiom.trade/axiom/finding-tokens/pulse)) | Contra/Wellfound range-filter modals, Neon column toggles |
| Token page | Header (MC headline, Price, Liquidity, Supply, star). Chart with "USD/SOL", "MarketCap/Price" and "Limit Order Target". Right rail: Buy/Sell with Market / Limit / Advanced tabs; presets 1/2/3/5; settings line; "Advanced Trading Strategy"; position strip Bought / Sold / Holding / PnL ([Axiom Market](https://docs.axiom.trade/axiom/swap/market)) | Coinbase Advanced order form, Kraken on-chart preview line |
| Bottom tables | Trades (with "YOU", tracked and dev tags), Holders, Top Traders, Positions, Orders; Trader Scan popover. Axiom's docs don't show these, so design them from the Uniswap and OpenSea tables | Uniswap Transactions, OpenSea Holders |
| Instant Trade window | Hotkey toggle, P1/P2/P3, drag handle, wallet selector, four buys, four sells with a %/SOL toggle, settings rows, "Sell Init." ([Axiom Instant Trade](https://docs.axiom.trade/axiom/swap/instant-trade)) | — |
| Armed orders (new) | Every pre-signed order with status (armed / submitted / filled / stale, needs re-arm), its "safe to close tab" badge, the SOL reserved for it, nonce slots in use, Re-arm and Cancel | Kraken conditional-orders tab |
| Trackers | Wallet Manager (Created; Name with emoji; bell; trash; Import / Export / Add Wallet); Live Trades feed with quick-buy; Twitter Alerts; Customize Feed (Handle, Tweets, Profile Updates, Follows) ([Axiom wallets](https://docs.axiom.trade/wallet-tracking/adding-wallets); [Axiom tweet monitor](https://docs.axiom.trade/tweet-monitor)) | Binance Smart Money cards |
| Copy trading (new) | Task list with per-target caps, filters, copy-sell, pause/resume, PnL per target, and a clear "copy buys need this tab open" state | Binance copy-trading grid |
| Portfolio | Spot tab; "Search for other wallets"; 7d / 30d / Max; balance, PnL chart, five performance buckets (from >500% to <−50%), Active Positions / History, Activity with Solscan links ([Axiom portfolio](https://docs.axiom.trade/axiom/portfolio)) | Binance assets, Public share-card carousel |
| Wallets and funding | Trading wallets (create, label, archive, export); "Fund from connected wallet" (one popup); deposit QR for exchange withdrawals; one-click withdraw back to the connected wallet; drag-to-distribute SOL ([Axiom multi-wallet](https://docs.axiom.trade/multi-wallet)) | OKX deposit stepper, Binance withdraw confirm |
| Alerts | Price/MC alert drawer (±% chips, once or repeating, channels) and a notification centre | Gemini "Create alert", Kraken draggable target |
| Onboarding | Connect wallet (Wallet Standard), sign the Sign-In With Solana message, create a trading wallet in the browser and set a passkey or password, back up the key, fund from the connected wallet, pick the default mode | Phantom onboarding |
| Settings | Presets, hotkeys, display/theme, default mode, unlock method and auto-lock timer, export key, withdrawal destinations (non-default ones need a connected-wallet signature and a delay), nonce slots and rent reclaim, sessions | Uniswap settings drawer |
| Mobile PWA | Bottom tabs, single-column Pulse with New/Final/Migrated segments, sticky Buy/Sell bar | Phantom token page |

**Charts:** the cheapest choice is TradingView Lightweight Charts v5. It is Apache-2.0 licensed, takes our own candle data, and supports markers (`createSeriesMarkers`), `createPriceLine`, multiple panes and custom formatters for market-cap axes ([LWC](https://github.com/tradingview/lightweight-charts)). Its gaps are drawing tools, indicators and a draggable price line, all of which must be built as plugins. KLineChart (also Apache-2.0) ships 16 drawing overlays if those matter more. TradingView Advanced Charts, which Axiom uses, is "Free with TradingView logo" but licensed "only… to companies for use in public web projects" after an approval process ([TradingView compare](https://www.tradingview.com/free-charting-libraries/)). A hosted company site qualifies, so it is a zero-cost later upgrade that must never be committed to a public repository.

## Wallet-connect login and browser-held keys replace hosted custody

**Login works like GMGN.** There are no email or password accounts. The user connects an external wallet (Phantom, Solflare or Backpack through Wallet Standard) and signs a Sign-In With Solana message, and the server issues a session tied to that wallet address. Sign-In With Solana is a standard "direct" login method in the wallet-auth stacks the researchers reviewed ([Privy auth methods](https://docs.privy.io/authentication/user-authentication/privy-auth)). Per-user API keys and rate limits can hang off the signed-in identity ([Solana clusters (throttling model)](https://solana.com/docs/references/clusters)).

Account security now reduces to the connected wallet's security. The signed message should bind our domain, a server nonce and an expiry, so a phishing clone cannot replay it; this is standard practice, not something the notes sourced. There are two trading modes:

- **Instant mode** uses a separate trading wallet. The browser generates it, encrypts it at rest and keeps it there. The user funds it from the connected wallet with one approval popup, and it then signs every trade with no popup.
- **Direct mode** has the connected wallet approve each trade in its own popup. It is slower, but there is no hot wallet. Hardware wallets may need blind signing for some operations ([Ledger support](https://support.ledger.com/article/360016265659-zd)).

Arming automation in direct mode would need the connected wallet to sign many transactions in one approval. That is untested here.

The instant-mode keystore follows the self-hosted wallet note's design, moved from a local server into the browser. The key is decrypted into memory only after unlock, auto-locks when idle, and is never stored in plaintext. At rest it is encrypted with an Argon2id-derived key at or above OWASP's minimum of **m=19 MiB, t=2, p=1**, or unlocked with a passkey instead ([OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)).

The note's hot/cold split maps naturally onto the two wallets. The trading wallet holds only a float. The connected wallet is the default withdrawal and profit-sweep destination, and can itself be a Ledger. Withdrawals to the connected wallet are one click and need no popup. Adding any other destination needs a signature from the connected wallet plus a delay, borrowing Bloom's 24-hour withdraw-address cooldown ([Bloom FAQ](https://docs.bloombot.app/solana/miscellaneous/faqs.md)).

Multi-wallet becomes cheap again. The browser can generate Axiom's 25 wallets at no signing cost, and bundle buys across them cost only network fees and tips.

Recovery and multiple devices are the trade-offs:

- **Recovery.** A trading key lives in one browser profile. Onboarding must force a backup or export step, and the float should stay small.
- **Multiple devices.** A second device either imports the key from an encrypted export or gets its own trading wallet under the same signed-in identity.

The build-sign-land path is short. The backend holds live state (curve and pool reserves, fee recipients, creator vaults, the latest blockhash from the gRPC `blocks_meta` stream). It builds the unsigned transaction, or streams a per-token "trade context" so the browser can assemble the same transaction with shared TypeScript builder code and sign on click with no extra round trip. The browser posts the signed bytes back to the backend in Frankfurt, which fans them out to the landing lanes.

Local signing adds no remote hop. Privy's server signing, by contrast, measured 72.42 ms median even with its proxy bypass ([Privy latency](https://www.privy.io/blog/reducing-trading-latency-on-privy)). The remaining cost is the user-to-Frankfurt round trip, which matters for users in the Americas and Asia. For them, Helius Sender's browser HTTPS endpoint (`https://sender.helius-rpc.com/fast`, built "for browser-based applications") is a direct fallback lane, though it skips our multi-lane fan-out ([Helius Sender](https://www.helius.dev/docs/sending-transactions/sender.md)).

### The browser must police what it signs

Because the backend builds transactions and the browser signs without a popup, a compromised backend could hand the browser a drain transaction. Every transaction must therefore pass a **signer firewall** before signing. This is a small, separately audited module, ideally on its own origin or in an isolated iframe or worker. It decodes the transaction and enforces these rules:

- Every top-level instruction belongs to an allowlisted program.
- Tip transfers go only to known tip accounts, with a cap.
- SOL and token transfers go only to the user's own token accounts (ATAs), the user's own WSOL account, or the connected wallet.
- No `Approve` or `SetAuthority` instructions appear.
- The amount argument of every buy variant stays under the user's per-trade cap.

This replaces the TEE policy engine the Privy option would have provided. Because we write the decoder ourselves, it can also decode the WSOL `SyncNative` step that Privy's policy engine could not.

The Privy researcher drafted that allowlist from memory and marked it unverified. I checked each ID character by character against the IDs verified from the IDL and mainnet in the pump.fun and launchpad note. **All seven match**, so the list carries over to the browser firewall unchanged:

| Program | ID | Verification status |
|---|---|---|
| pump.fun bonding curve | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` | Matches (pump IDL + mainnet) |
| PumpSwap | `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` | Matches |
| Raydium AMM v4 | `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8` | Matches |
| Raydium CPMM | `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C` | Matches |
| Raydium CLMM | `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK` | Matches |
| Raydium LaunchLab | `LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj` | Matches |
| Associated Token Account program | `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` | Matches (pump IDL) |
| Jupiter v6, ComputeBudget | `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`, `ComputeBudget111111111111111111111111111111` | Documented in Privy's own policy examples; whether Jupiter `/build` routes still use `JUP6…` is unverified |

The draft needs five fixes before use:

1. **Add programs it omits.** Meteora DBC (`dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`) and DAMM v2 (`cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`) are needed for phase 2. Token-2022 (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`) and SPL Token (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`) must be decoded for WSOL wrapping, `SyncNative` and `CloseAccount`, because pump's `create_v2` coins are Token-2022 ([COIN_CREATION.md](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/COIN_CREATION.md)). System Program transfers must be decoded, never allowlisted wholesale.
2. **Don't allowlist the pump fees and mayhem programs.** They appear only as accounts invoked through cross-program calls.
3. **Cap every buy variant, not one.** The draft capped only `buy.args.max_sol_cost`. The cap must also cover `buy_v2.max_sol_cost`, `buy_exact_sol_in.spendable_sol_in`, `buy_exact_quote_in_v2.spendable_quote_in`, and PumpSwap's `buy.max_quote_amount_in` and `buy_exact_quote_in.spendable_quote_in`.
4. **Fill in the tip accounts.** Jito has 8 tip accounts: `96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5`, `HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe`, `Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY`, `ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49`, `DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh`, `ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt`, `DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL`, `3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT`. Helius Sender has 10: `4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE`, `D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ`, `9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta`, `5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn`, `2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD`, `2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ`, `wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF`, `3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT`, `4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey`, `4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or` ([Jito docs](https://docs.jito.wtf/lowlatencytxnsend/); [Helius Sender](https://www.helius.dev/docs/sending-transactions/sender)). These came from automated page extraction, so diff them against Jito's `getTipAccounts` at startup.
5. **Raise the tip cap.** The draft's 0.05 SOL cap equals the median tip the fees researcher saw going to apparent Temporal/Nozomi accounts in contested trades. Make the cap a per-preset setting.

### Privy was evaluated and rejected on cost

The Privy researcher found a mechanism that works well. A backend-held P-256 key is registered as a 1-of-1 "key quorum" signer. The user grants it with `addSigners`, or inside `createWallet({signers})`, under one override policy. The backend then signs with `privy.wallets().solana().signTransaction` from `@privy-io/node` 0.35.0 ([Privy signers](https://docs.privy.io/wallets/using-wallets/signers/overview); [Privy sign a transaction](https://docs.privy.io/wallets/using-wallets/solana/sign-a-transaction)). Its strengths are real:

- Keys sit in AWS Nitro Enclaves, split into a 2-of-2 Shamir share.
- Users can always export their keys.
- It explicitly supports executing limit orders "even while a user is offline".
- Its FullSend broadcast path reports 99.999% landing.
- It holds SOC 2 Type II, renewed April 2026 ([Privy architecture](https://docs.privy.io/security/wallet-infrastructure/architecture); [Privy landing](https://www.privy.io/blog/high-performance-solana-transaction-landing-built-into-privy)).

So are its limits on Solana:

- Its policy engine cannot enforce spend or rate limits over time; aggregations are Ethereum-only.
- It rejects address conditions on accounts loaded from Address Lookup Tables (ALTs).
- It cannot decode WSOL's `SyncNative`.
- One stolen signer key would hold trading authority over every delegated wallet ([Privy policies](https://docs.privy.io/controls/policies/overview)).

Cost decided it. The fees and Privy notes both assumed 50 trades a day, about 1,500 signatures per user per month. The table also shows a 10-trades-a-day "moderate" case, which is my own assumption ([Privy pricing](https://www.privy.io/pricing)):

| Users | Signatures/month (heavy / moderate) | Privy PAYG list price (heavy / moderate) | Privy Enterprise at $0.001 (heavy / moderate) |
|---|---|---|---|
| 100 | 150K / 30K | $3,000 / $0 within the free allowance | $150 / $30 |
| 1,000 | 1.5M / 300K | **$16,500** / $4,500 | $1,500 / $300 |
| 10,000 | 15M / 3M | **$151,500** / $31,500 | $15,000 / $3,000 |

Enterprise also carries an unpublished platform minimum. Privy publishes no rate for its "$1M transaction volume" trigger, which a trading app would exceed quickly. Other hosted signers price near Enterprise Privy: Helius's wallet API charges 200 credits ($0.001) per signature, and Turnkey (Axiom's provider) is "as low as $0.0015" on Enterprise ([Helius credits](https://www.helius.dev/docs/billing/credits); [Turnkey pricing](https://www.turnkey.com/pricing)).

Even at Enterprise rates, signing alone would cost 0.5–6 times the entire cheapest stack described below. Browser-held keys cost $0 per signature and keep the operator out of custody, so Privy stays on file only as a fallback, should an opt-in server-side automation wallet ever be offered.

## Pre-signed durable-nonce orders keep exits running with the tab closed

With keys in the browser, the server cannot create a new signature. Unattended automation therefore has to be a transaction the browser signed in advance, held by the server and submitted only when its trigger fires.

The tool is the durable nonce. The transaction's first instruction must be `nonceAdvance`. It uses the nonce account's stored value instead of a recent blockhash, so it **never expires**. And once any transaction using that nonce lands, the nonce advances and every other transaction signed against it becomes invalid ([Solana durable nonces](https://solana.com/developers/guides/advanced/introduction-to-durable-nonces)). The same property that the landing note used for multi-relay racing has a different use here: a user can sign a whole menu of variants against one nonce, knowing that at most one can ever execute.

That makes four patterns cheap, since signatures cost nothing:

- **A min-out grid.** The browser signs variants at stepped minimum-output levels and two or three tip levels. At trigger time the server submits the variant whose minimum output sits just below the live quote. That is tight enough to limit sandwich loss and loose enough to land.
- **One-cancels-other for free.** A take-profit and the stop-loss on the same tokens share one nonce.
- **Independent orders on separate nonces.** Each DCA tranche or TP level gets its own nonce account.
- **A pre-signed cancel.** Every armed order is stored with a transaction that only advances its nonce. The server can kill the order on expiry, or when the user cancels from another device.

Each nonce account needs rent of "around 0.0015 SOL" in the Solana guide. At today's 5,080 lamports per byte that should be nearer 0.001 SOL (my estimate), and it is refundable. A pool of ten nonce accounts per user therefore locks about $1.3–1.8.

| Automation | Runs with the tab closed? | How it is armed | Main caveat |
|---|---|---|---|
| Limit buy/sell on a known token | Yes | The minimum output encodes the limit price; the server submits when the price crosses, with some margin | Fixed size; invalid after migration unless a variant for the post-migration venue is also signed |
| TP ladder + SL | Yes | Each TP level on its own nonce; the SL shares a nonce with the TP it excludes | Fixed token amounts go stale after manual trades; re-arm |
| Stop-loss | Yes, with care | A grid of minimum-output variants on one nonce | Wide variants are worth stealing if the armed-order store leaks |
| Trailing stop | Partly | Min-out grid; the trigger moves server-side | The grid's range bounds the trail; re-arm higher when the browser next opens |
| DCA tranches | Yes | One nonce per tranche; the minimum output enforces the MC band | Rent per nonce; fixed amounts |
| Dev-sell exit | Yes | Sell grid triggered by the dev's sell event in the stream | Same as stop-loss |
| pump.fun migration snipe | Yes | PumpSwap buy pre-signed against the canonical pool, whose address is deterministic (`["pool", u16 0, pool_authority, mint, wSOL]`; [pump-sdk pda.ts](https://www.npmjs.com/package/@pump-fun/pump-sdk?activeTab=code)); submitted on `CompletePumpAmmMigrationEvent` | Submitting before the pool exists fails and may burn the nonce; boost reserves move the opening price |
| Migration sell / TP that survives graduation | Yes | Curve and PumpSwap variants signed on the same nonce | Bigger transactions; WSOL handling |
| Copy-trade sells | Yes, after the copy buy | The browser arms a sell grid the moment the copy buy fills | Proportional size fixed at arming time |
| Copy-trade buys | **No** | The mint is unknown in advance, so a live signature is needed | Browser open, or a "tap to copy" push; at 800 ms of lag, copies fill "18% or worse" ([RPC Fast](https://rpcfast.com/blog/how-to-build-a-solana-copy-trading-bot)) |
| AFK filter snipes, X CA snipes, dev-wallet snipes | **No** | The mint is unknown | Browser open |
| Wallet, X and price alerts | Yes | Server-only; no signing | — |

The trade-offs are concrete:

- **Every parameter is fixed at signing.** Size, minimum output, priority fee, tip and therefore landing lane, and the exact account list are all frozen. Anything that changes an account list invalidates the order. That includes a pump.fun interface upgrade (the 2026-04-28 change broke every legacy trade without new accounts), graduation to a different venue, a creator change that moves `creator_vault` (fee sharing or holder rewards), and the closing of an ALT the transaction references. pump.fun upgrades become **mass re-arm events**, which the IDL-diff alarm must surface to every affected user.
- **A nonce never expires, so leaks are permanent options.** The transaction stays valid until someone advances the nonce. An attempt that did not land can be held by whoever saw it and executed later at its worst allowed price. The landing note's protected mode therefore forbids durable nonces, and BlockRazor warns that nonces make its sandwich protection "ineffective" ([BlockRazor](https://docs.blockrazor.io/transaction-submission/transaction-sending/solana/send-transaction.md)). Nozomi says they "may reduce landing rates" ([Nozomi FAQ](https://use.temporal.xyz/nozomi/tipping-and-faq)).
- **The mitigation is to keep every submitted variant tight and burn misses fast.** Use the grid, send via Jito bundle-only with `jitodontfront`, and fire the pre-signed cancel if the attempt misses within a few slots.
- **Failed attempts may consume the nonce.** The notes could not confirm whether a fee-paying nonce transaction that fails during execution still advances the nonce. Until devnet testing settles it, design for one attempt per nonce: submit only when the live quote is safely inside the chosen variant.
- **Transactions get big.** A pump `buy_v2` has 27 accounts. Adding nonce advance, compute budget, tip and ATA creation "may exceed `PACKET_DATA_SIZE`" ([sol-trade-sdk](https://github.com/0xfnzero/sol-trade-sdk)). The fixes are v0 transactions with operator-owned ALTs for static accounts, never closed while armed orders reference them, or v1 transactions of up to 4,096 bytes where relays accept them. Only Nozomi documents v1 support.
- **The server must check before submitting.** It needs to confirm that the wallet still holds the SOL or tokens an armed order assumes, and show "reserved" balances in the UI.

The security property is strong. An armed transaction can only do exactly what the user signed. A compromised server cannot redirect funds. It can only submit armed orders at their worst allowed terms, or withhold them, for example by failing to fire a stop-loss. The defences:

- Cap how far below the arming price a grid's widest variant may reach.
- Cap total armed notional per user.
- Alert on unusual submission patterns.

Keep these things browser-only and say so in the UI: any trade on a token chosen after the tab closed; re-arming after fills, manual trades, cancels, migrations or upgrades; creating and topping up nonce slots; withdrawals; and key export. For users who want unattended copy trading or sniping, the only alternatives are a tab or PWA left open on an always-on machine, or a separate opt-in automation key held server-side. The second reintroduces exactly the custody the user rejected.

## One gRPC stream and an event decoder replace third-party data APIs

The biggest 2026 data change is that **Jito ShredStream shut down on 5 Sep 2026** ([Jito docs](https://docs.jito.wtf/lowlatencytxnfeed/)). Shred-level speed now comes from two places. DoubleZero Edge sells raw multicast shreds you decode yourself, at **$450–$1,500 per IP per month**. Managed "deshredded" streams decode them for you: Shyft RabbitStream (in the $199 plan), Triton Deshred (paid beta) and Helius preprocessed transactions ([DoubleZero](https://docs.doublezero.xyz/Edge%20Subscriber%20Connection/); [Shyft RabbitStream](https://shyft.to/solana-shreds-rabbitstream)). Raw shreds lack "logs, inner instructions, account balances, and transaction success/failure status", so they are only an early, unconfirmed signal ([Helius: shreds](https://www.helius.dev/blog/solana-shreds)).

The primary feed should be Yellowstone-compatible gRPC transactions with full metadata, at processed commitment. Triton puts gRPC account updates at about 215 ms p90, against about 374 ms for WebSockets ([Triton guide](https://blog.triton.one/complete-guide-to-solana-streaming-and-yellowstone-grpc/)). Before the sunset, RPC Fast measured shred-fed gRPC an average of 120 ms ahead of plain gRPC ([RPC Fast](https://rpcfast.com/blog/shredstream-vs-geyser-vs-standard-rpc)).

Flat-rate gRPC is now cheap:

| Provider | Price | Notes |
|---|---|---|
| Chainstack | $49/month on top of its $49 Growth plan | 2 streams, 200 accounts per filter, about a 100-slot replay buffer |
| Solana Vibe Station | $150/month | — |
| Shyft Build | $199/month | Unmetered |
| ERPC | €198/month | — |
| Alchemy | $75 per TB | Usage-priced |
| Triton | $0.08/GB | Usage-priced |

Sources: [Chainstack](https://chainstack.com/yellowstone-grpc-more-streams-same-price/); [SVS](https://docs.solanavibestation.com/introduction/purchasing); [Shyft pricing](https://shyft.to/solana-rpc-grpc-pricing); [Alchemy](https://www.alchemy.com/solana-grpc); [Triton pricing](https://triton.one/pricing).

Helius gates mainnet LaserStream behind its Business plan ($499) and meters streaming at 2 credits per 0.1 MB ([Helius plans](https://www.helius.dev/docs/billing/plans)).

Detection should key on Anchor self-CPI events, not logs. Pump.fun, PumpSwap, Raydium LaunchLab and Meteora DBC all emit events as inner instructions with this layout:

| Field | Value |
|---|---|
| Event tag | `e445a52e51cb9a1d` |
| Then | 8-byte event discriminator + Borsh body |
| pump `TradeEvent` | `bddb7fd34ee661ee` |
| pump `CreateEvent` | `1b72a94ddeeb6376` |
| PumpSwap `BuyEvent` | `67f4521f2cf57777` |

Sources: [Carbon pumpfun cpi_event.rs](https://raw.githubusercontent.com/sevenlabs-hq/carbon/main/decoders/pumpfun-decoder/src/instructions/cpi_event.rs); [Anchor events](https://www.anchor-lang.com/docs/features/events).

These events carry post-trade reserves, fee components, `quote_mint`, and the mayhem and cashback flags. Price, market cap and bonding progress are therefore pure functions of the latest event, with no RPC call. Pump's `TradeEvent` keeps gaining trailing fields, including variable-length strings and vectors, so decoders must read the known leading fields and tolerate the rest. Carbon (Rust) has current decoders for every relevant program. solana-dex-parser is the TypeScript reference ([Carbon](https://github.com/sevenlabs-hq/carbon); [solana-dex-parser](https://github.com/cxcx-ai/solana-dex-parser)).

Bonding progress is `1 − real_token_reserves_now / real_token_reserves_initial`. That matches Bitquery's 793.1M/206.9M formula for standard coins and also works for mayhem coins, which have a 2B supply ([Bitquery](https://docs.bitquery.io/docs/blockchain/Solana/Pumpfun/Pump-Fun-API/)).

The cheapest supporting sources are all free:

- **SOL/USD:** Binance's spot WebSocket ([Binance streams](https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams)), with Pyth Hermes as a cross-check. Hermes "now requires an API Key" at `https://pyth.dourolabs.app/hermes` ([Pyth docs](https://docs.pyth.network/price-feeds/core/fetch-price-updates)).
- **Token metadata:** taken straight from pump's `CreateEvent`, with the JSON fetched from public IPFS gateways (ipfs.io, dweb.link) and cached by CID forever. Cloudflare's gateways stopped serving IPFS in August 2024 ([Cloudflare](https://blog.cloudflare.com/cloudflares-public-ipfs-gateways-and-supporting-interplanetary-shipyard/)).
- **Discovery cross-check:** PumpPortal's free new-token and migration streams. They need an API key and a wallet funded with at least 0.02 SOL ([PumpPortal real-time API](https://pumpportal.fun/data-api/real-time)).

### The data design scales by ingesting once and matching in memory

The data note's storage design was single-user: `bun:sqlite` in WAL mode with one writer, hot state in memory, and compact trades kept 24–72 hours. Most of it survives the move to a hosted, multi-user product, because market data still has exactly one writer, the ingest process, however many users there are. The cheapest design splits storage two ways:

- **SQLite** holds shared market data: tokens, trades for the retention window, candles.
- **Self-hosted Postgres** holds multi-user state: SIWS identities, trading-wallet registry, orders, armed transactions, nonce slots and the fill ledger.

ClickHouse or Timescale comes in only if long trade history or heavy analytical reads justify it, which is the note's own trigger for leaving SQLite.

Throughput estimates conflict by two to four times. The data note assumed 5–20M launchpad trades a day. The fees researcher's own 30-block sample, scaled up, gives about **72M pump.fun-plus-PumpSwap transactions a day, of which 43.6M succeeded**. That means roughly 2.6–3.9 TB a month of ingress at 2–3 KB per transaction, and about 13 GB a day of trade rows at the higher figure (my estimates; [Solana RPC](https://solana.com/docs/rpc/http/getrecentperformancesamples)).

Wallet tracking and copy-trade detection need no per-wallet subscriptions for trades. The program-filtered firehose already contains every trade on the watched venues, including Jupiter routes that touch them, so tracked-wallet trades are matched in memory against the deduplicated union of all users' lists. That sidesteps Chainstack's limit of 200 accounts per filter and 5 filters per connection. Only plain transfers and deposits need wallet-level subscriptions, and those can be limited to active sessions.

Bun's built-in uWebSockets pub/sub carries snapshot-plus-sequenced-delta updates on per-view topics. List views coalesce at 4–10 Hz; the focused token's trade tape flushes every 50–100 ms ([Bun WebSockets](https://bun.sh/docs/api/websockets)). The fees researcher's capacity model assumed one gateway server per 500 concurrent users, 20% of users online at once, and about 10 KB/s per connected user. That gives roughly **0.5 TB of egress a month at 100 users, 5.2 TB at 1,000 and 52 TB at 10,000**.

## Pump.fun ships a breaking change every one to three months

Pump.fun's bonding curve (`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`) and PumpSwap (`pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`) were checked against live mainnet state at slot ~452,976,084 on 3 Oct 2026. Every formula below reproduced real transactions to the lamport ([pump-public-docs](https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_PROGRAM_README.md); [verified buy tx](https://solscan.io/tx/FpgAR3QKpjpDj6jZM8dAGZkUTjMXycnJPjrmb1QSMPbZ19X2HfLxJWDbJkUJAMSRoM8K6K4tdfhqEJZ9QYuKAjN)).

**Curve mechanics.** The curve is a constant product over virtual reserves. A new coin starts at 30 SOL and 1,073,000,000 tokens of virtual reserves, with 793.1M real tokens out of a 1B supply at 6 decimals. It completes when `real_token_reserves == 0`, at about **85.005 SOL raised and an implied market cap near 410.9 SOL**.

**Curve fees.** A flat **1.25%: 0.95% protocol plus 0.30% creator**, each rounded up. The buyback fee is half of the protocol fee, not an extra charge.

**Migration.** Anyone can then call the idempotent `migrate`. It creates the canonical PumpSwap pool, charges a `pool_migration_fee` of 15,000,001 lamports, and burns the LP tokens ([pump FeeConfig](https://solscan.io/account/8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt)).

**PumpSwap fees.** Canonical pools charge **1.25% below a 420 SOL market cap, falling in steps to 0.30% at 98,240+ SOL**. Non-canonical pools charge a flat 0.30% ([PumpSwap FeeConfig](https://solscan.io/account/5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx); [pump.fun fees](https://pump.fun/docs/fees)).

**The key live-state finding.** Canonical "boost" pools carry non-zero `virtual_quote_reserves`: 17,584,505,289 lamports on two pools checked. The README says this field "is `0` on all pools today". Pricing from the raw quote vault therefore under-quotes buys by about 18%. Effective reserves are the vault balance plus a signed 128-bit value, which may be negative since 30 Sep 2026 ([pool 5Rxfs…](https://solscan.io/account/5RxfsBsyA8t2Z1J21SkSq2gaNr8JvPFGPZBd8crXY9Ck); [NEGATIVE_VIRTUAL_QUOTE_RESERVES.md](https://github.com/pump-fun/pump-public-docs/blob/main/docs/NEGATIVE_VIRTUAL_QUOTE_RESERVES.md)).

| Date (UTC) | Change | What broke for integrators |
|---|---|---|
| 2025-05-12 | Creator fees | Account slots changed (`creator_vault`); `extend_account`; two new PumpSwap accounts |
| 2025-09-01 | Dynamic fees: `fee_config` and `fee_program` became mandatory on both programs | Missing accounts; the new fee math made `max_sol_cost` too tight |
| 2025-11-07 / 11-15 | `create_v2` (Token-2022 mints), mayhem mode, reserved fee recipients | Bots that hardcoded SPL Token failed; mayhem coins reject the normal fee recipients |
| 2026-01-09 | Creator fee sharing rewrites `bonding_curve.creator` | Caching the creator from `CreateEvent` derives the wrong `creator_vault` |
| 2026-02-17 | Cashback coins | Legacy sells need `user_volume_accumulator` at remaining-account index 0 |
| **2026-04-28 16:00** | **Buyback fee recipients (breaking, both programs)** | Legacy buys now need 18 accounts and sells 16 (17 for cashback coins); PumpSwap needs +2. Every trade failed for bots that did not append them |
| 2026-05-07 | USDC-paired coins; unified `buy_v2` / `sell_v2` / `buy_exact_quote_in_v2`; reserve fields renamed `virtual_quote_reserves` | Code-generated decoders broke; USDC coins can't be traded with legacy instructions |
| 2026-07-15 | PumpSwap `Pool.virtual_quote_reserves` (i128) | Pricing from the raw vault is wrong on boost pools |
| 2026-09-12 | Holder-reward coins; cashback deprecated; SDK 2.0.0 released 2026-09-13 | `creator_vault` is now derived from `holderRewardsPda(mint)` |
| 2026-09-30 | `virtual_quote_reserves` may be negative | Unsigned storage overflows |

Sources: [pump-public-docs commits](https://github.com/pump-fun/pump-public-docs/commits/main); [BREAKING_FEE_RECIPIENT.md](https://github.com/pump-fun/pump-public-docs/blob/main/docs/BREAKING_FEE_RECIPIENT.md); [README](https://github.com/pump-fun/pump-public-docs/blob/main/README.md); [HOLDER_REWARDS_README](https://github.com/pump-fun/pump-public-docs/blob/main/docs/HOLDER_REWARDS_README.md).

**Use the unified v2 interface.** `buy_v2` (discriminator `[184,23,238,97,103,197,211,61]`, arguments `amount` and `max_sol_cost`) takes 27 fixed accounts and `sell_v2` takes 26. Every account is in the IDL, so there are no remaining-account conventions, which changed twice in 2026 ([BUY.md](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/BUY.md)).

**What the builder must do on every trade:**

- Read `BondingCurve`, `Pool` and `FeeConfig` live.
- Derive `creator_vault` from the live `creator` field.
- Pick fee recipients at random from the lists on `Global`, using the reserved list for mayhem coins.
- Append the buyback recipients.
- Detect the token program from the mint account's owner.
- Create ATAs idempotently.
- Query rent live rather than hardcoding it.

Mainnet rent is now 5,080 lamports per byte, step 2 of SIMD-0437's five-step cut. A 165-byte token account costs **1,488,440 lamports**, and a 170-byte Token-2022 ATA costs 1,513,840 ([SIMD-0437](https://github.com/solana-foundation/solana-improvement-documents/blob/main/proposals/0437-incremental-rent-reduction.md)).

**Change detection is mandatory.** Pump gives about a week of devnet notice; the 2026-04-28 change was announced on 2026-04-22. Under the browser-key model every upgrade also strands armed orders. A daily automated IDL diff, golden-transaction tests against `@pump-fun/pump-sdk` 2.0.0 and `@pump-fun/pump-swap-sdk` 1.20.0, and a user-facing re-arm flow are therefore required, not optional. Both SDKs are still on web3.js v1 and Anchor 0.31, while `@solana/kit` 8.4.0 is the successor library ([npm pump-sdk](https://registry.npmjs.org/@pump-fun/pump-sdk); [npm @solana/kit](https://registry.npmjs.org/@solana/kit)). Building every venue directly from on-chain IDLs, with no launchpad web API in the trade path, also removes the failure mode behind Axiom's August 2025 sell outage.

**Beyond pump.fun, Raydium LaunchLab is now the number-two memecoin venue.** StonkFun (38.2% of 30-day Solana launchpad revenue), BONK.fun and Graphite all run on LaunchLab curves that graduate into Raydium CPMM, against pump.fun's 45.3%. PumpSwap is the largest Solana DEX by 30-day volume, at $13.41B ([DefiLlama launchpad revenue](https://api.llama.fi/overview/fees?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true&dataType=dailyRevenue); [DefiLlama Solana DEXs](https://api.llama.fi/overview/dexs/solana?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true)). LaunchLab graduation is not permissionless: "the migration wallet stored on GlobalConfig signs `MigrateToCpswap`" ([Raydium LaunchLab](https://docs.raydium.io/products/launchlab/overview.md)).

**Meteora DBC** (used by Bags and Jupiter Studio) earns under 1% of launchpad revenue. Its program version 0.2.1 deprecates migration to DAMM v1 for new configs, so new launches graduate to DAMM v2 ([DBC changelog](https://docs.meteora.ag/developer-guides/dbc/changelog.md)).

**For the long tail, route through aggregators carefully.** Jupiter's Swap API V2 `/build` path "does not charge swap fees" and returns raw instructions. Its `/order` path charges up to **50 bps on tokens under 24 hours old**, so a zero-fee product should avoid it. DFlow's `/order` charges "no protocol fee" ([Jupiter build](https://developers.jup.ag/docs/swap/build/index.md); [Jupiter fees](https://developers.jup.ag/docs/swap/fees.md); [DFlow](https://pond.dflow.net/spot/introduction.md)).

| Program | ID | Verified by |
|---|---|---|
| pump.fun bonding curve | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` | IDL + mainnet |
| PumpSwap AMM | `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` | IDL + mainnet |
| Pump Fees | `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ` | IDL |
| Mayhem | `MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e` | SDK |
| Raydium LaunchLab | `LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj` | Raydium SDK + Jupiter labels |
| Raydium CPMM | `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C` | Raydium SDK |
| Raydium AMM v4 | `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8` | Raydium SDK |
| Raydium CLMM | `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK` | Raydium SDK |
| Meteora DBC | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` | Meteora SDKs |
| Meteora DAMM v2 | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` | Meteora SDKs |
| Meteora DLMM | `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` | Meteora SDKs |
| Meteora DAMM v1 | `Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB` | Meteora SDKs |
| Orca Whirlpool | `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc` | Orca SDK |
| Boop.fun | `boop8hVGQGqehUK2iVEMEnMrL5RbjywRzHKBmBE7ry4` | Jupiter label map only |
| Heaven | `HEAVENoP2qxoeuF8Dj2oT1GHEnu49U5mJYkdeC8BAX2o` | Jupiter label map only |
| Moonit | `MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG` | Jupiter label map only |
| pump Global (account) | `4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf` | Mainnet decode |
| pump FeeConfig (account) | `8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt` | Mainnet decode |
| PumpSwap GlobalConfig (account) | `ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw` | Mainnet decode |
| PumpSwap FeeConfig (account) | `5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx` | Mainnet decode |

Sources: [idl/pump.json](https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json); [Jupiter program-id-to-label](https://api.jup.ag/swap/v1/program-id-to-label); [raydium-sdk-v2](https://www.npmjs.com/package/@raydium-io/raydium-sdk-v2?activeTab=code).

## Protect buys by default and race lanes only in fast mode

Sandwiching is the dominant execution risk, and memecoin terminals concentrate it. A September 2026 study counted **28,042,725 sandwich attacks by 8,631 bots from July 2023 to June 2026, for $345,185,014 of net profit**. After the validator delistings, 96% of attacks span more than one block. That means a malicious leader that merely receives a transaction early can front-run it ([arXiv 2609.28115](https://arxiv.org/html/2609.28115v1)).

Axiom's users carry an excess ratio of 18.9, against 0.7 for Jupiter Ultra. **98.5% of Axiom's sandwiched transactions carried `jitodontfront`, but only 16.5% carried a Jito tip**, so the protection rarely applied ([arXiv 2609.28115](https://arxiv.org/html/2609.28115v1); [Crypto Briefing](https://cryptobriefing.com/jupiter-ultra-sandwich-attacks-study/)). Protection only works when the transaction actually travels a protected path ([Jito docs](https://docs.jito.wtf/lowlatencytxnsend/); [Helius MEV Protect](https://www.helius.dev/docs/sending-transactions/mev-protect.md)):

- **Jito**, via `bundleOnly=true` or `sendBundle`, with a read-only `jitodontfront…` account and the tip inside the same transaction.
- **Helius**, via `?mev-protect=true`, which excludes roughly 3–4M SOL of stake statistically linked to sandwiching.
- **bloXroute** `frontRunningProtection`.
- **BlockRazor** `sandwichMitigation`.
- **Triton Shield**.

**Helius Sender** costs no API credits and works on every plan, including the free tier. Its 2026 tiers ([Helius Sender](https://www.helius.dev/docs/sending-transactions/sender)):

| Tier | Minimum tip | Routing |
|---|---|---|
| Sender Max | 0.001 SOL | Fanned out across Helius SWQoS, Jito, Harmonic and Rakurai |
| SWQoS-only (`?swqos_only=true`) | 0.000005 SOL | Single path |

Every transaction also needs a compute-unit-price instruction. The server endpoint is `http://fra-sender.helius-rpc.com/fast`, and connections should be pinged at least every 5 seconds while idle.

**Jito** takes a minimum tip of 1,000 lamports, paid to one of 8 accounts, at `https://frankfurt.mainnet.block-engine.jito.wtf`. Its default rate limit is **1 request per second per IP per region** ([Jito docs](https://docs.jito.wtf/lowlatencytxnsend/)).

Nozomi, bloXroute, NextBlock, 0slot and Falcon all require tips of 0.001 SOL or more. **No independent 2026 benchmark compares their landing rates.** BlockRazor's August 2025 test was run by the vendor, and RPC Fast's "330 ms" and "95%" claims come with no methodology ([BlockRazor benchmark](https://blockrazor.io/blog/20250801Benchmarking/); [RPC Fast Beam](https://rpcfast.com/blog/rpc-fast-beam)).

**What a zero-fee user actually pays is small in calm markets and dominated by default settings.** In the fees researcher's on-chain sample, the median successful pump.fun curve trade paid **0.000015 SOL** in network fees. Only 31.8% of curve transactions succeeded, because bots compete, and median compute was 99,837 CU (researcher's measurement, tips classified with [Jito's](https://mainnet.block-engine.jito.wtf/api/v1/bundles) and [Helius's](https://www.helius.dev/docs/sending-transactions/sender) tip-account lists). Jito's tip floor read p50 ≈ 6,146 lamports at 15:34:59 UTC and p50 = 0.00001 SOL at 15:37:53 UTC on the same day ([Jito tip_floor](https://bundles.jito.wtf/api/v1/bundles/tip_floor)).

Terminal defaults of 0.002–0.022 SOL per side are therefore 100 to 1,000 times what calm conditions need. Axiom defaults to 0.001 + 0.001 SOL; BullX to 0.01 + 0.01, plus 0.002 in MEV mode ([BullX fees](https://bullx.gitbook.io/bullx-neo-docs/fees-and-gas)). On a 0.1 SOL pump.fun round trip, Axiom's 0.95% fee plus its defaults cost **8.41%** of the trade size, against **2.72%** for a tuned zero-fee client. Pump.fun's own 1.25% per side is the floor no terminal can remove (estimates from [pump.fun fees](https://pump.fun/docs/fees) and [Axiom fees](https://docs.axiom.trade/getting-started/fees/solana-fees)).

**The cheapest safe defaults** follow from these numbers. The user pays all tips on-chain; the operator pays nothing.

| Mode | Route | Tip |
|---|---|---|
| Reduced (default) | Helius Sender `?swqos_only=true&mev-protect=true` | 0.000005 SOL, plus a priority fee from Helius's estimator ([Helius priority fee API](https://www.helius.dev/docs/priority-fee-api)), clamped to the user's maximum |
| Secure | Jito bundle-only with `jitodontfront` | max(1,000 lamports, live p50–p75 from Jito's `tip_stream`) |
| Fast | Sender Max | 0.001 SOL, with a sandwich warning |

Compute limits come from simulation: consumed CU × 1.1, cached per route. Durable-nonce racing (one variant per relay) is affordable now that signatures are free. It should stay a fast-mode-only option, because a nonce transaction never expires and the landing note's protected mode explicitly forbids it.

**The network keeps moving under every timing assumption:**

- **Slot times.** Slots went to 350 ms on 19 Aug 2026 and 300 ms on 25 Aug ([Solana reduced slot times](https://solana.com/upgrades/reduced-slot-times)). Solana Compass reports 250 ms since 18 Sep, the fees researcher measured 0.267 s slots on 3 Oct, and solana.com still lists 250 ms as "To be determined".
- **Blockhash life.** A blockhash is still valid for 150 blocks, which is now roughly 40–45 usable seconds. Code must check `lastValidBlockHeight`, not wall-clock time.
- **Version-1 transactions.** These went live on 15 Sep 2026 at epoch 1035: up to 4,096 bytes, no ALTs. `getBlock` now fails without `maxSupportedTransactionVersion: 1` ([Solana larger transactions](https://solana.com/upgrades/larger-transaction-sizes)).
- **Block compute limit.** Raised to 100M CU on 29 Jul 2026, with the per-writable-account cap unchanged at 12M ([Solana 100M CU](https://solana.com/upgrades/100m-cu-blocks)).
- **BAM.** Jito's BAM covered 34.1% of stake (383 of 665 validators) when it added preconfirmations on 9 Sep ([Solana Compass BAM](https://solanacompass.com/news/jito-bam-preconfirmations-go-live-on-solana-covering-34-of-network-stake)).
- **Alpenglow.** It missed its 28 Sep window; the next one opens 9 Nov 2026. Once it activates, `confirmed` and `finalized` merge ([CryptoTicker](https://cryptoticker.io/en/solana-alpenglow-mainnet-date-missed/)).

**Host next to Frankfurt.** Two Frankfurt data-centre entries hold about 14.7% of stake, and every relay has a point of presence there. Hetzner Falkenstein measures **1.2 ms** to Frankfurt, the cheapest option the notes found ([validators.app](https://www.validators.app/data-centers?network=mainnet); [RPC Fast co-location](https://rpcfast.com/blog/solana-trading-co-location-low-latency)).

**Scale brings three constraints a single-user app never meets:**

- **Relay rate limits bind.** 10,000 users at 50 trades a day average 5.8 transactions per second. Bursts will exceed Jito's 1 rps per IP per region and Sender's default of 50 TPS (one Helius table says 15). Higher limits must be requested before launch.
- **Hot accounts saturate.** At about 100k CU per pump.fun buy and a 12M CU cap per writable account, only about 120 buys can touch one bonding curve per block. A hosted wave of snipes or copies would collide with itself (inference).
- **Location still matters.** Browser signing removes the remote-signing hop but not the user-to-Frankfurt hop.

## Token intelligence is a data pipeline, not a feature list

No terminal publishes its formulas. Axiom documents only bundles: "4+ transactions in the same block". GMGN gives qualitative definitions. Insiders are holders "that did not buy tokens after trading opened, but hold tokens"; snipers bought "within the first few blocks" ([GMGN insiders](https://docs.gmgn.ai/index/insider-traders-snipers-first-70-buyers)).

API vendors publish usable heuristics:

- **Mobula** defines snipers as buys within 0–3 blocks and bundlers as 3+ related wallets. Its red flags are a top-10 share above 50%, snipers above 20%, or 10+ bundler wallets ([Mobula](https://docs.mobula.io/almanac/detecting-snipers-bundlers)).
- **Solana Tracker** publishes additive risk weights: freeze authority 7,500, mint authority 2,500, LP not burned 4,000, "Rugged" 20,000 ([Solana Tracker risk](https://docs.solanatracker.io/data-api/risk)).

Publishing our own configurable definitions is a transparency edge over Axiom. Recommended definitions:

| Metric | Definition |
|---|---|
| Snipers | Non-dev buyers whose first buy came within 3 slots of creation |
| Bundlers | Creation-slot co-buyers; or 4+ distinct buyers in one slot who also share a funder or a tight size band; or several wallets in one transaction |
| Insiders | Holders who received tokens by transfer and never bought, plus wallets the creator funded within two hops |
| Top 10 | Excludes the bonding-curve PDA, AMM vaults, burn addresses and lockers |

The extra condition on bundlers avoids trench.bot's warning that "two UNRELATED wallets could sometimes purchase in the same slot" ([trench.bot](https://docs.trench.bot/bundle-tools/bundle-scanner-guide)).

Other checks are cheap:

- **Authority and Token-2022 checks** cost one RPC read. `permanentDelegate`, `transferHook`, `pausable`, `nonTransferable` and frozen-by-default accounts are dangers ([Solana permanent delegate](https://solana.com/docs/tokens/extensions/permanent-delegate)).
- **"Dex Paid"** comes from DexScreener's free `/orders/v1/{chainId}/{tokenAddress}` endpoint plus its global profile, CTO, boost and ad feeds, at about 60 requests a minute ([DexScreener API](https://docs.dexscreener.com/api/reference)).
- **A second opinion** comes from RugCheck's report-summary endpoint, which responds without authentication ([RugCheck API](https://api.rugcheck.xyz/v1/tokens/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263/report/summary)).
- **"Pro traders"** are most likely traders whose swaps pay a known terminal fee wallet, such as Maestro's documented `MaestroUL88UBnZr3wfoN7hqmNWFi3ZYCGqZoJJHE36` ([Maestro monetization](https://docs.maestrobots.com/sniper/monetization)). That is an inference and needs a curated list.

Wallet intelligence is off the shelf. Helius `funded-by` returns a wallet's first incoming SOL transfer with a funder label, at 100 credits per call on paid plans ([Helius funded-by](https://www.helius.dev/docs/wallet-api/funded-by)). A first funder never changes, so results can be cached forever, which keeps the cost bounded by the number of distinct wallets.

Clustering should rank evidence in this order: a shared non-exchange funder; direct transfers between wallets; a shared fee payer; a shared rent-refund destination; same-slot near-identical buys; recurrence across one dev's launches. PnL should use weighted-average cost in SOL and USD, with base fee, priority fee and tip in the basis. Win rate should count only closed positions, which avoids the open-position overcount bug found in a GMGN-based tool ([agent-os issue](https://github.com/use-agent-os/agent-os/issues/2797)).

**Copy trading splits in two under browser keys:**

- **Detection is server-side.** Leaders' trades are matched against the firehose in memory. Competitive bots target under 60 ms from detection to submission ([RPC Fast copy-trading playbook](https://rpcfast.com/blog/how-to-build-a-solana-copy-trading-bot)). A copy only proceeds if it clears every gate: leader state, audit, market cap and liquidity, a drift guard that skips copies if price has moved too far past the leader's fill, and per-trade, per-token and per-day caps.
- **Copy buys need the user's browser open** to sign. Copy sells can then be armed automatically.

The exploitation risk is real. A dev marketed TROLL to KOLs and dumped on the bots auto-copying one of them ([Yahoo Finance](https://finance.yahoo.com/news/unlucky-trader-fumbles-36-million-180210516.html)). Because many users may follow the same leader, the product should also cap total copy volume per leader per slot.

**X monitoring is the most expensive and most legally exposed data source:**

- **Official API.** It went pay-per-use on 6 Feb 2026 at **$0.005 per post read**, capped at 3M reads a month. Its filtered stream allows one connection and 1,000 rules at "approximately 4-5 seconds of P99 latency" ([X API pricing](https://docs.x.com/x-api/getting-started/pricing); [X filtered stream](https://docs.x.com/x-api/posts/filtered-stream/introduction)).
- **twitterapi.io.** Far cheaper per handle. Account-monitor plans run $29 (6 accounts), $79 (20), $149 (50), $299 (150) and $499 (500); webhooks cost $0.00015 per matched tweet. These prices come from search snippets ([twitterapi.io](https://twitterapi.io/blog/how-to-monitor-twitter-accounts-for-new-tweets-in-real-time)).
- **SocialData.** Its monitors cost $4.99 down to $2.49 per account per month ([SocialData monitoring](https://docs.socialdata.tools/monitoring/pricing/)).
- **The legal catch.** X's terms ban scraping without "prior written consent" and set liquidated damages of $15,000 per million posts accessed in 24 hours ([X terms](https://cdn.cms-twdigitalassets.com/content/dam/legal-twitter/site-assets/terms-of-service-2025-05-08/en/x-terms-of-service-2025-05-08.pdf)).

Hosted, the cost scales with distinct handles, not users. Axiom limits it by actively tracking only handles in its "Top Subscriptions" list and by requiring 5 SOL of trading volume. The safe pattern combines a provider adapter, a shared deduplicated handle pool, base58 extraction with on-chain mint validation, and auto-buys gated by an author allowlist, a fresh-mint audit, a size cap and a kill switch. Hijacked accounts make that gating necessary ([Bitcoin.com](https://news.bitcoin.com/crypto-news/microsoft-x-account-hijacked-promote-clippy-meme-coin)).

**Alerts hit platform limits at hosted scale.** Telegram allows about 1 message per second per chat and **about 30 messages per second for bulk broadcasts**. Paid broadcasts of up to 1,000 per second require 100,000 Stars and 100,000 monthly active users ([Telegram bots FAQ](https://core.telegram.org/bots/faq)). Web Push works on iOS only for PWAs installed to the home screen on iOS 16.4+ ([WebKit](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)). Alerts therefore need priority classes and digests. Web Push and Telegram also carry the "tap to copy" prompts that partly stand in for unattended copy buys.

## The cheapest viable stack costs about $330 to $2,400 a month

With signing at $0 and all tips, priority fees, venue fees, token-account rent and nonce rent paid by users on-chain, the operator's bill is fixed infrastructure. The table picks the cheapest viable option the notes found at each layer.

| Layer | Cheapest viable choice | Monthly cost | When to upgrade | Source |
|---|---|---|---|---|
| Signing | Browser-held keys (instant mode) or connected wallet (direct mode) | $0 | Never; Privy list price was $0.01/signature above 50K plus a $2,000 base | [Privy pricing](https://www.privy.io/pricing) |
| Market-data stream | Chainstack Yellowstone add-on, 2 streams | $49 (requires Growth) | 7 streams $149, 25 streams $449; Shyft Build $199 for an unmetered feed plus RabbitStream | [Chainstack](https://chainstack.com/yellowstone-grpc-more-streams-same-price/) |
| RPC reads | Chainstack Growth: 20M request units, 250 RPS | $49 | Pro $199 (80M, 400 RPS) | [Chainstack pricing](https://chainstack.com/pricing/) |
| Submission | Helius Sender (no credits, free tier included) and Jito direct | $0 | Request >50 TPS (Sender) and a Jito UUID limit | [Helius Sender](https://www.helius.dev/docs/sending-transactions/sender) |
| Helius extras (funded-by, DAS, fee estimates, Enhanced WebSockets) | Free tier at 100 users | $0 → $49 (Developer) | Overage $5 per million credits | [Helius plans](https://www.helius.dev/docs/billing/plans) |
| Wallet tracking / copy detection | Match signers in the firehose in memory | $0 | Wallet subscriptions only for transfers | Data note |
| SOL/USD, metadata, DEX-paid, risk cross-checks | Binance WS; CreateEvent + public IPFS gateways; DexScreener; RugCheck summary; PumpPortal free streams | $0 | Pyth Hermes key as backup | Data and analytics notes |
| X data | twitterapi.io account monitors, shared handle pool | $79 (20) → $499 (500) → ~$1,100 (~1,000 handles + webhooks) | SocialData or official X API for ToS cover | [twitterapi.io](https://twitterapi.io/pricing) |
| Charts | Lightweight Charts v5 (Apache-2.0) | $0 | Advanced Charts (free with logo, company licence) | [LWC](https://github.com/tradingview/lightweight-charts) |
| Storage | SQLite (market data, single writer) + self-hosted Postgres (users, orders, armed transactions) | $0 licence | ClickHouse when history or analytics grow | [Bun SQLite](https://bun.sh/docs/api/sqlite) |
| Hosting | Hetzner Falkenstein, prices after 15 Jun 2026: CCX33 €138.49 (≈$155), CPX32 €35.49 (≈$40) | See below | Bare metal with bundled bandwidth at 10K users | [Northflank on Hetzner prices](https://northflank.com/blog/hetzner-cloud-server-price-increases) |
| Alerts | Web Push (VAPID), Telegram bot, Discord webhooks | $0 | Telegram paid broadcasts need 100K MAU | [Telegram bots FAQ](https://core.telegram.org/bots/faq) |

| Monthly line (estimates) | 100 users | 1,000 users | 10,000 users |
|---|---|---|---|
| Chainstack gRPC + RPC | $98 (Growth + 2 streams) | $98 | $348 (Pro + 7 streams) |
| Redundant feed | — | — | $199 (Shyft Build) |
| Helius | $0 (Free: Sender) | $49 (Developer) | $49 (Developer; overage as needed) |
| Hetzner hosting | ~$155 (one CCX33 runs everything) | ~$235 (CCX33 + 2× CPX32) | ~$705 (3× CCX33 + 6× CPX32) |
| X data | $79 | $499 | ~$1,100 |
| Signing, charts, storage licences, price feeds, alerts | $0 | $0 | $0 |
| **Total per month** | **~$330** | **~$880** | **~$2,400** |
| **Per user per month** | **~$3.30** | **~$0.88** | **~$0.24** |
| For comparison: Privy list PAYG signing at 50 trades/day (rejected) | +$3,000 | +$16,500 | +$151,500 |

The totals exclude bandwidth beyond what the hosts include (about 0.5 / 5.2 / 52 TB of egress a month in the capacity model; Hetzner's traffic allowance was not in the notes), DDoS protection and CDN, backups, and the engineering and on-call time to run it. The fees researcher judged that own Solana nodes at 10,000 users would need about 0.5–1 FTE of operations; this stack avoids running nodes.

Cheapest also means accepting four limits:

- **No shreds.** RPC Fast's measurement implies roughly 100+ ms behind shred-fed feeds at the median.
- **A single-vendor primary feed with a short replay buffer.** Chainstack's ring buffer is about 100 slots, or roughly 25–30 seconds at current slot times, so outages longer than that need RPC backfill.
- **A curated X pool rather than per-user handles.**
- **Self-built drawing tools.**

Validate the Chainstack feed in week one by counting messages against the throughput estimates. Keep SVS day passes ($15) or Shyft as a quick swap if it falls short.

The value gap is large even on this lean budget. A heavy user trading 0.5 SOL per side, 1,500 times a month, moves about $89,600 of notional. They would pay Axiom about **$851 a month at 0.95%** (estimate), against an operator cost of $0.24–3.30.

Funding is easy at these numbers. The fees researcher's formula is price = cost per user ÷ share of users who pay. At 1,000 users with 10% paying, that is about $9 a month; at 10,000 users, about $2.40. An optional tip jar that defaults to zero also keeps the "zero platform fee" claim intact ([fees note funding model, DefiLlama fee pool](https://api.llama.fi/overview/fees/solana?dataType=dailyFees)).

## Browser keys move the main threat from custody to the front end

The incident record sorts into five classes, and browser-held keys change which ones matter most ([DefiLlama hacks](https://api.llama.fi/hacks)):

| Class | Incidents | Effect of browser-held keys |
|---|---|---|
| Centralized custody | **DEXX lost $21M** to a private-key compromise (16 Nov 2024); Thunder Terminal's key "leaked via infrastructure" ($240K, Dec 2023) | Eliminated: no operator holds keys, and no single server key holds trading authority over every user, as a Privy signer would have |
| Insiders | **Solareum lost 6,045 SOL** to a DPRK IT worker it hired ([DL News](https://www.dlnews.com/articles/regulation/how-a-dprk-developer-tricked-solareum-and-stole-14m/)); pump.fun lost $1.9M to a key compromise (May 2024); Axiom's February 2026 support-dashboard abuse | Fund theft eliminated; data abuse remains |
| Router and approval bugs | Maestro ($500K, $465K returned) and Unibot ($640K), Oct 2023 | Unchanged; covered by the signer firewall |
| Front ends | **Banana Gun lost $3.0M** (all returned) in a "Frontend Compromise" on 19 Sep 2024; BONK.fun DNS hijack ($30K) on 11 Mar 2026 | Now the main threat |
| Supply chain | `@solana/web3.js` 1.95.6 and 1.95.7 exfiltrated private keys (Dec 2024) ([GitHub advisory](https://github.com/solana-labs/solana-web3.js/security/advisories/GHSA-jcxm-7wvp-g6p5)); a fake "solana-pumpfun-bot" pulled a malicious git dependency (Jul 2025) ([Cointelegraph](https://cointelegraph.com/news/solana-trading-bot-github-malware-scam)) | Now the main threat |

A server breach can only submit armed orders within their minimum-output bounds, or withhold them. But malicious JavaScript served from our own domain is exactly what steals a decrypted browser key or signs a drain transaction. The defences:

- **Isolate the signer.** Run the keystore and signer firewall on a dedicated origin or isolated iframe or worker with minimal, pinned dependencies. Keep analytics, chat widgets and chart libraries out of it.
- **Lock down the front end.** Use a strict CSP and Subresource Integrity, no git dependencies, reproducible builds with published hashes, and registrar lock with hardened DNS.
- **Publish a canonical domain.** Phishing clones are routine: photon-sol.com, and "auth-axiom.trade", which sits on the major blocklists ([axiompedia](https://axiompedia.com/security/is-axiom-trade-safe)).
- **Limit what a stolen key can reach.** Keep the trading wallet a float, with automatic sweeps to the connected wallet. Auto-lock the keystore. GMGN's warning about clipboard-stealing malware applies directly ([GMGN Q&A](https://docs.gmgn.ai/index/q-a.md)).

The insider lesson changes shape rather than disappearing. Sign-In With Solana links each user's main wallet to their trading wallet and their tracked-wallet and X lists in our database. That mapping is precisely what Axiom's staffer looked up: a dashboard that allowed lookup "by wallet address, referral code, or account ID" with "no logging of who accessed what" for about 10 months ([axiompedia](https://axiompedia.com/security/is-axiom-trade-safe); [The Block](https://www.theblock.co/post/391423/zachxbt-investigation-into-alleged-employee-insider-trading)). Store the mapping minimally, put admin tools behind roles, and log every lookup.

The remaining lessons still apply:

- **Router-bug lessons** live in the signer firewall: a program allowlist, no standing approvals, and simulate-and-decode before signing.
- **MEV-infrastructure lessons** apply too: GMGN's anti-MEV node failed on 25 Oct 2025 and 729 BNB Chain transactions were sandwiched. Run several protected routes, plus after-the-fact sandwich detection.
- **The kill switch** becomes two actions: the server stops submitting and fires pre-signed cancels, and the browser locks.

## Build the parity core first, then win on automation

**Phase 0: foundations**

- Wallet-connect login with Sign-In With Solana.
- Browser trading wallet: generation, Argon2id or passkey encryption, export, auto-lock.
- The isolated signer firewall, using the cross-checked allowlist and tip accounts.
- Hetzner Falkenstein servers.
- A Chainstack gRPC subscription with full metadata.
- Event-CPI decoders and local builders for the pump.fun curve (`buy_v2` / `sell_v2` / `buy_exact_quote_in_v2`), PumpSwap (with effective reserves), Raydium LaunchLab and Raydium CPMM, with Jupiter `/build` as the long-tail fallback.
- SQLite plus Postgres, and a Bun WebSocket gateway.
- A daily diff of pump.fun's IDLs and SDKs, plus golden-transaction tests.

**Phase 1: Axiom parity**

- **Pulse:** three columns; per-column filters on the 14 metrics plus the Protocols and Quote Tokens tabs; three presets with JSON import/export; blacklists; sound; pause on hover; per-column quick-buy.
- **Token page:** Lightweight Charts with MC/Price and USD/SOL toggles, entry lines and wallet markers; the published metric definitions; trades and holders tables.
- **Trading:** Instant Trade with P1–P3 presets and hotkeys; clipboard buy; instant and direct modes.
- **Landing:** Reduced/Secure/Fast landing presets with per-lane telemetry.
- **Orders:** armed limit, TP/SL and pump.fun migration orders on durable nonces, with the armed-orders view and re-arm flow.
- **Tracking and portfolio:** the wallet tracker on the shared stream; portfolio and PnL with fees in the cost basis; fund and withdraw against the connected wallet.

**Phase 2: the wedge**

- Copy trading: live buys while the browser is open, armed sells, per-leader caps.
- Trailing stops through price grids, DCA tranches, dev-sell exits.
- Telegram, Discord and Web Push alerts, including "tap to copy".
- An X tracker with keyword alerts behind a provider adapter.
- Browser-open AFK and X snipers with hard caps.
- A public API with capped, revocable agent keys.

**Phase 3: breadth**

- Meteora DBC and DAMM v2 builders.
- Bubble maps, KOL discovery and a signals page.
- Advanced Charts once licensed.
- Optional shreds (DoubleZero Edge) for a pro tier.
- A mobile-first PWA.

**Do not build:** perpetuals; referral, cashback or points mechanics tied to fees; TradingView Advanced Charts in a public repository; manipulation features (launch bundling, "vamp" token cloning).

**Before launch:** get relay limits in writing (Helius Sender above 50 TPS, a Jito UUID limit), confirm on devnet whether a failed nonce transaction advances its nonce, and read each data provider's terms on serving many end users from one plan, which none of the notes reviewed.

## Conflicts and unverified items to carry forward

| Topic | What conflicts or is unverified | Sources |
|---|---|---|
| Durable-nonce failure semantics | Whether a fee-paying nonce transaction that fails during execution still advances the nonce. This decides whether armed orders get one attempt or many | [Solana durable nonces](https://solana.com/developers/guides/advanced/introduction-to-durable-nonces) |
| Nonce vs protection | Armed orders need durable nonces; the landing note's protected mode forbids them; BlockRazor says nonces make sandwich protection "ineffective"; Nozomi says they "may reduce landing rates" | [BlockRazor](https://docs.blockrazor.io/transaction-submission/transaction-sending/solana/send-transaction.md); [Nozomi](https://use.temporal.xyz/nozomi/tipping-and-faq) |
| Nonce account rent | "Around 0.0015 SOL" in the Solana guide (older rent rate) vs ~0.001 SOL estimated at today's 5,080 lamports/byte | Solana guide; Rent sysvar |
| Pre-signed transaction size | pump V2 + ATA creation + nonce "may exceed `PACKET_DATA_SIZE`"; v1 transactions support documented only by Nozomi | [sol-trade-sdk](https://github.com/0xfnzero/sol-trade-sdk) |
| Direct-mode arming | Whether connected wallets can approve a batch of pre-signed variants in one popup is untested | — |
| Axiom market share | ~53% of Sep 2026 Solana terminal fees (DefiLlama aggregation) vs ~39% Axiom / ~36% GMGN (axiompedia, Aug 2026) vs "about 70% terminal market share in H1 2026" (Learning Pill) | [axiompedia](https://axiompedia.com/compare); [Learning Pill](https://thelearningpill.substack.com/p/the-state-of-the-trenches-h126) |
| Axiom revenue | DefiLlama all-time revenue $460.3M vs "$453+ million" cumulative (Cryptobriefing) | [Cryptobriefing](https://cryptobriefing.com/gmgn-overtakes-axiom-24-hour-revenue/) |
| Axiom sandwich share | "~70% of extracted SOL came from Axiom users" (axiompedia, Oct 2025) vs 41.4% of victims in Q2 2025 and above 37% afterwards (arXiv) | [axiompedia](https://axiompedia.com/guides/trading/axiom-mev-protection-modes-explained); [arXiv](https://arxiv.org/html/2609.28115v1) |
| Axiom details | Bribe default 0.001 (docs) vs 0.01 (one apebrief page); DCA claimed by one review but absent from docs; native withdraw UI ("SOL & USDC supported" vs "no direct withdrawal interface"); copy-trading settings on SEO sites vs "Absent"; unknown: Katana mechanism, Auto/Max Fee fields, TP/SL level limits, hotkey map, wallet-group splits, token-page tab names, prediction-market provider | [Axiom docs](https://docs.axiom.trade/getting-started/fees/solana-fees); [apebrief withdraw](https://apebrief.com/axiom/withdraw/) |
| pump.fun Terminal | Live URL terminal.pump.fun vs trade.padre.gg; whether copy trading was removed | [solanatradingbots (affiliate)](https://solanatradingbots.com/padre-gg-how-to-use/); [solbotrank](https://solbotrank.com/guides/padre-terminal-explained) |
| Competitor fees | Banana 0.5% manual fee on all chains vs ETH only; Photon referral discount yes/no; GMGN user-side referral discount unverified | [bananagun.io](https://bananagun.io/); [Banana docs](https://docs.bananagun.io/llms-full.txt) |
| PumpSwap reserves | README says `virtual_quote_reserves` is 0 on all pools; chain shows 17.58 SOL on boost pools | [PUMP_SWAP_README](https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_SWAP_README.md) |
| Market-cap basis | pump-sdk uses a fixed 1e15 supply for non-mayhem coins; pump-swap-sdk uses real supply for them | [pump-sdk](https://www.npmjs.com/package/@pump-fun/pump-sdk?activeTab=code) |
| Rent | BUY.md quotes 0.0018444 SOL for a 137-byte account; live value is 0.0013462 | [BUY.md](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/BUY.md) |
| Graduation in dollars | "~$69K market cap" in older guides vs ~85 SOL raised / ~410.9 SOL implied MC from the verified math | [Chainstack](https://docs.chainstack.com/docs/solana-listening-to-pumpfun-migrations-to-raydium) |
| Slot time and CU | 250 ms live since 18 Sep (Solana Compass) vs "To be determined" (solana.com); 37.5M CU per block at 250 ms vs a 100M baseline; whether the per-account cap scales | [Solana Compass](https://solanacompass.com/news/solana-activates-250ms-slot-time-at-epoch-1037-fourth-step-of-simd-0525) |
| Throughput | 5–20M launchpad trades/day (data note) vs 43.6M successful pump.fun + PumpSwap transactions/day (fees sample); 191M vs 152.6M non-vote transactions/day | Data and fees notes |
| Helius docs | Whether Business includes mainnet LaserStream (3 sources yes, 1 table no); replay window 48 h vs 3,000 slots vs 24 h; Sender limit 15 vs 50 TPS; Enhanced WebSockets on Developer | [Helius plans](https://www.helius.dev/docs/billing/plans); [laserstream-sdk](https://github.com/helius-labs/laserstream-sdk) |
| Cheapest-stack inputs | Chainstack streams 2/7 (blog) vs 1/5 (pricing page); Chainstack overage and replay limits; Hetzner traffic allowance not in notes; twitterapi.io monitor prices from search snippets; SVS staked-RPC prices; Alchemy $75/TB (own page) vs $0.08/GB (Triton's comparison) | Provider docs |
| Relay details | bloXroute extra tip wallet `HWEoBxYs7ssKuudEjzjmpfJVX7Dvi7wescFsVx2L5yoY`; Mobula endpoint api.mobula.io vs pulse-v2-api.mobula.io; 0slot "free" plans | Provider docs |
| Jito tip floor | Two snapshots three minutes apart: p50 ≈ 6,146 lamports (15:34:59) vs 10,000 lamports (15:37:53) | [Jito tip_floor](https://bundles.jito.wtf/api/v1/bundles/tip_floor) |
| Privy (rejected option) | Draft program IDs written from memory, now all seven confirmed; response field `signed_transaction` vs `signedTransaction`; tier names Free/Core/Scale vs Core/Scale/Growth; whether tier fees stack with the $2,000 base ($14,500 vs $16,500 at 1,000 users); unpublished volume-billing rate; whether policies see inner instructions; Stripe acquisition date (June 2025, from memory) | [Privy pricing](https://www.privy.io/pricing); [Privy docs](https://docs.privy.io/llms-full.txt) |
| Jupiter `/build` | Whether `/build` routes go through `JUP6…`, which matters for the firewall allowlist | [Jupiter build](https://developers.jup.ag/docs/swap/build/index.md) |
| Incidents | Maestro $500K (DefiLlama) vs "~$280,000" (crypto.news); Solareum $1.4M vs $523K; Oct 2025 sandwich figures internally inconsistent; Fasol incident undated | [DefiLlama hacks](https://api.llama.fi/hacks) |
| Vendor claims, unverified | Shreder's LaserStream benchmark (TLS failure); Padre 127 ms vs Axiom 310 ms (affiliate); Messari Q1 2026 revenue figures; Pyth SOL/USD feed id (search summary); a live sandwich counter (~8,700 SOL/day); TeraSwitch prices; StonkFun's $1.5M revenue day | As cited in the notes |
| X data | Whether pay-per-use filtered-stream deliveries bill per post; legal standing of third-party X providers | [X docs](https://docs.x.com/x-api/getting-started/pricing) |

## Conclusion

Keeping keys in the browser changes the business model more than any feature decision. Incumbents earn 0.75–1% of notional and run custody through Turnkey or Privy. Axiom returned about half its 2026 fees as cashback and referrals. A zero-fee entrant that signs in the browser pays nothing per trade and holds no customer keys, so its whole bill is a few hundred to a few thousand dollars of shared infrastructure, cheap enough for a small subscription or sponsorship. The saving moves into engineering in three places. The first is a signer firewall and front-end supply chain hardened like a wallet's, because the browser is now the vault. The second is an armed-order system that treats pump.fun upgrades, migrations and position changes as routine re-arm events. The third is honest UX that separates "safe to close" automation from features that need the user present.

That last split is also the product's positioning against Axiom and GMGN. Their server-held keys allow fully unattended copy trading and sniping; ours cannot without reintroducing custody. In exchange, exits run with the tab closed, no operator or breach can move user funds outside what the user signed, and Axiom's real weaknesses are attacked directly. Those weaknesses are an insider-data scandal, protection users thought they had, alerts that die with the tab, no copy trading or API, and no published metric definitions. The bar for staying in the race is surviving pump.fun's next breaking change within a day.
