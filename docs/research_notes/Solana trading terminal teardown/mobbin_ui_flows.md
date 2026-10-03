# Axiom UI and user flows (Mobbin + public sources), comparable crypto screens, and charting-library options

Research date: 2026-10-03. Scope note: the coordinator later ruled perpetuals out of scope for the build, so perps screens and flows (Axiom's, Hyperliquid's, and other apps') are left out below. The only exceptions are a few patterns from perp screens that carry straight over to spot trading (order-lifecycle toasts, an on-chart entry-price label), and those are labeled.

How the sources work: every Mobbin reference links to its `mobbin_url`, and every description comes from looking at the returned screenshot, not from metadata. Axiom is not on Mobbin, so the Axiom descriptions come from screenshots embedded in Axiom's official docs (docs.axiom.trade). I opened those images in a browser and examined them visually, and they are cited to the docs page where each one appears. Some Axiom details are from docs text only, and those are marked "(docs text)". No images are embedded here.

## Which Axiom flows and screens exist on Mobbin (web and iOS)?

### Takeaway
Mobbin has no Axiom screens or flows on either web or iOS. It also lacks Hyperliquid, Jupiter, Moonshot and Fomo. It does have Phantom (iOS) and other Solana-related apps (Solflare, Glow, Believe), plus the main centralized pro-trading UIs: Coinbase Advanced, Kraken Pro, OKX, Binance and Gemini, alongside OpenSea, Uniswap and Base. That means Axiom's UI has to be rebuilt from its official docs screenshots (old but primary) and reviews, and Mobbin is useful for comparable patterns.

### Cited Findings
- Name-filtered Mobbin searches for Axiom returned only other apps on both platforms. On web, "Axiom token trading page…", "Axiom pulse screen with new pairs, final stretch and migrated…" and "Axiom crypto memecoin trading terminal…" surfaced Kraken, OpenSea, OKX, Uniswap, Binance, Base, Airtable and others. The top result for the terminal query was a [Base token page](https://mobbin.com/screens/2439249c-3665-4ba4-b7e2-602b39aa8df8). On iOS, "Axiom trading app onboarding…" and "Axiom memecoin token list…" surfaced Binance, Coinbase, Base, OKX, Wealthsimple, Revolut, Crypto.com, Kraken, Uniswap and Solflare. An example is [Binance Meme Rank](https://mobbin.com/screens/5fb08bd4-fd7c-4a78-8ca9-77bf63a3a1a8). — Mobbin MCP searches, 2026-10-03
- Hyperliquid is not on Mobbin. A Hyperliquid-named query returned only Coinbase, Binance, OKX, Gemini and Kraken trading screens, for example [Coinbase Advanced spot](https://mobbin.com/screens/4ed27744-549c-4cb7-894f-e2bc1f04c623). — Mobbin search, 2026-10-03
- Jupiter is not on Mobbin. A Jupiter-named query returned Uniswap, Coinbase, Revolut Business, Square, Binance and OpenSea, for example [Uniswap settings drawer](https://mobbin.com/screens/debc076d-b186-42b2-8c23-b1fae356c2d1). — Mobbin search, 2026-10-03
- A query naming "Moonshot or Fomo" (iOS, standard mode) returned zero screens, and a broader query for "memecoin trading app like Moonshot or Pump.fun…" returned none of Moonshot, Fomo or Pump.fun. — Mobbin search, 2026-10-03
- Phantom iOS is on Mobbin, including token pages such as the [BTC token page](https://mobbin.com/screens/76e93b20-0652-4758-8e2d-4925312a1fba) and the [Onboarding flow](https://mobbin.com/flows/ff2e342f-69cb-4a47-ae09-b869822dfdff). Other Solana-related iOS apps on Mobbin include [Solflare](https://mobbin.com/screens/d5381cd7-2727-46d0-b1ce-8e12787be5a3) (a Market tab with SOL, JitoSOL and others), [Glow](https://mobbin.com/screens/3d4867b1-ec0c-4a19-8f6e-69df43150a47) (SOL-priced collectibles and coins) and [Believe](https://mobbin.com/screens/93de3ae6-f4e6-45ce-80d6-7c463ff76e96). Believe is an "All Beliefs" token list with Projects/People/Beliefs tabs, holder-avatar stacks with counts, prices and a "New Belief" button; its chain isn't visible on the screen. — Mobbin
- Axiom's official docs index lists these pages: Signup, Referral Program, Reward System, Point System, Fees, Buy Crypto, Explore Tokens, Pulse, Similar Tokens, Market, Limit Orders, Convert, Migration Actions, Instant Trade, Staking, Multi-wallet, Perpetuals (Deposit, Trading on Hyperliquid, Withdraw), Wallet Tracking (Adding Wallets, Monitor Wallets), Tweet Monitor, Twitter Preview Popup, Trader Scan, Portfolio and TradingView. — [Axiom docs index (llms.txt)](https://docs.axiom.trade/llms.txt)
- Axiom calls itself a "hybrid crypto trading app **and** wallet" with non-custodial wallet infrastructure from Turnkey. — [Axiom FAQs](https://docs.axiom.trade/faqs)
- Axiom's charts come through a "partnership with TradingView". — [Axiom docs: TradingView](https://docs.axiom.trade/tradingview)
- Coin Bureau's Axiom review is dated June 9, 2026. In the extract I pulled, it covers Pulse, trading settings, wallet tracking, X monitoring, staking and fees, and says nothing about a mobile app. — [Coin Bureau review](https://coinbureau.com/review/axiom-trade-review)
- One Axiom docs screenshot (the Twitter preview popup over Pulse) shows a tweet dated "Mar 19, 2025". The Pulse docs still name the third column "Migrated to Raydium". — [Axiom docs: Twitter Preview Popup](https://docs.axiom.trade/twitter-preview-popup); [Axiom docs: Pulse](https://docs.axiom.trade/axiom/finding-tokens/pulse)

### Inferences
- The Axiom docs screenshots look like they date from around early-to-mid 2025. Treat them as a structural reference (layout, components, data fields), not as a pixel-accurate picture of Axiom in October 2026, whose labels, launchpads and colors may have changed.
- Because no Axiom flow is on Mobbin, the step order of flows has to come from the docs' text steppers (Signup, Buy Crypto, Convert, Adding Wallets, Migration Actions). Mobbin flows from Phantom, OKX, Coinbase, Base and Binance can fill in the screen-to-screen interaction details.

### Gaps
- Photon, GMGN and BullX were not searched by name. None of them appeared in roughly 25 crypto-related Mobbin queries, so they are probably absent, but this is unconfirmed.
- I could not verify whether Axiom ships an official native iOS app. Search results only surfaced third-party "download Axiom app" pages (for example axiompro.app and Medium posts) and an AppBrain Android listing titled "Axiom Trade" ([appbrain.com/app/axiom-trade/com.uptrd.sloot](https://www.appbrain.com/app/axiom-trade/com.uptrd.sloot)). I did not trust or open them, and some may be affiliate or phishing pages.
- I did not inspect the live axiom.trade app, which would require an account and sign-in. Current (Oct 2026) layouts, Pulse display settings and filter-modal visuals are therefore unverified.

## Pulse/discovery screens: card layout, columns, filters, display settings

### Takeaway
Axiom Pulse is a three-column, real-time board: New Pairs, Final Stretch and Migrated. Each column is a dense scrolling list of three-line token cards, about nine visible per column on a laptop-height screen. A card shows the avatar with a launchpad badge, ticker and name with a copy-CA icon, age, social and search icons, holder counts, five colored risk-percentage chips, MC/V/TX on the right, and a one-click purple quick-buy pill whose size comes from a global "Quick Buy" amount and preset (P1). Each column header has its own filter button, which opens 14 min/max metric filters. A display-settings modal is not documented anywhere I could reach.

### Cited Findings
#### Axiom (primary: docs screenshots viewed directly, plus docs text)
- **Page layout.** The title "Pulse" sits top-left. Three equal columns are headed "New Pairs", "Final Stretch" and "Migrated", each with a filter (sliders) icon button at the right of its header; the docs screenshot highlights these with boxes under the caption "How to Access Filters!". At top-right are two small icon buttons, a "Quick Buy" numeric input (showing "2.00000…" with a SOL icon) and a "P1" preset control. — [Axiom docs: Pulse](https://docs.axiom.trade/axiom/finding-tokens/pulse)
- **Card anatomy** (from the New Pairs and Final Stretch column screenshots). — [Axiom docs: Pulse](https://docs.axiom.trade/axiom/finding-tokens/pulse)
  - Left: a square token image with a thin colored border and a small round launchpad badge at its bottom-right corner.
  - Line 1: the ticker in bold white, the token name in grey, and a copy icon.
  - Line 2: age in green (for example "25s", "32s", "1m", "13h"), then icon links (X, website, Telegram, a pill-shaped launchpad link, a magnifier search), then three counters: a person icon with the holder count (for example "40", "505"), a second icon with a count (for example "14"), and a crown-style icon with a count (for example "0").
  - Line 3: a row of five icon-plus-percentage chips, colored red or green by value (for example "25%", "DS", "0%", "0%", "30%"). The second chip sometimes reads "DS" instead of a percentage.
  - Right block: "MC: $11K" (market cap, colored), "V: $5K" (volume), "TX: 52" with a thin two-color bar beneath, and a purple pill button "⚡ 2.000000000 SOL".
- Roughly nine cards are visible per column in the 1660×948 three-column screenshot. — [Axiom docs: Pulse](https://docs.axiom.trade/axiom/finding-tokens/pulse)
- In the Migrated column some cards carry a small green "Paid" chip. In Final Stretch, one card (COKE) shows small protocol icons with an arrow where the quick-buy pill would normally be. — [Axiom docs: Pulse](https://docs.axiom.trade/axiom/finding-tokens/pulse)
- **Column semantics (docs text).** New Pairs are newly created tokens. Final Stretch are tokens "close to completing their bonding curve and migrating to Raydium". Migrated to Raydium has "the newest ones at the top". Pulse is for "pump.fun and [REDACTED] tokens", and "you can Quick Buy on these tables by simply clicking on the lightning bolt". — [Axiom docs: Pulse](https://docs.axiom.trade/axiom/finding-tokens/pulse)
- **The 14 Pulse filters (docs text):** Age (mins), Top 10 Holders %, Dev Holding %, Snipers %, Insiders %, Bundle %, Holders, Pro Traders, Liquidity ($) with min and max, Volume ($), Market Cap ($), Txns, Num Buys and Num Sells. — [Axiom docs: Pulse](https://docs.axiom.trade/axiom/finding-tokens/pulse). Coin Bureau's list matches and adds "Buy/Sell Activity". — [Coin Bureau](https://coinbureau.com/review/axiom-trade-review)
- **Bundle detection (docs text).** A bundle is flagged when "4 or More Transactions [are] in the Same Block". Wallets whose next transaction is not bundled are dropped, and detection has no time limit (unlike tools that rely only on Pump.fun's launch flag). — [Axiom FAQs](https://docs.axiom.trade/faqs)
- **Explore page (docs text, screenshots not viewed).** It has "New Pairs" and "Trending" sections, and Trending has a selectable time frame. Filters are "Dex Paid", "Top 10 Holders %", "Liquidity ($)", "Volume ($)", "Market Cap ($)", "Txns" and "Search". A star icon adds a token to the Watchlist, which opens from a star at the top right. — [Axiom docs: Explore Tokens](https://docs.axiom.trade/axiom/finding-tokens/explore-tokens)
- **Similar Tokens / "OG Mode" (docs text).** It "Filters for highest MC and the Oldest Coin". — [Axiom docs: Similar Tokens](https://docs.axiom.trade/axiom/finding-tokens/similar-tokens)
- **Hover previews in Pulse.** Hovering a tweet link opens an X-styled card over the column, showing avatar, name, verified badge, handle, Follow, text, image, timestamp, like count, Reply, Copy link and "Read 554 replies". Behind it, Pulse rows show "⚡ 2.108 SOL" quick-buy pills. The popup "only works for tweets and not actual twitter handles". — [Axiom docs: Twitter Preview Popup](https://docs.axiom.trade/twitter-preview-popup)
- Users can "track what your wallets that you added to the tracker are buying in real time while looking at Pulse". — [Axiom docs: Monitor Wallets](https://docs.axiom.trade/wallet-tracking/monitor-wallets)
- A third-party guide (axiompedia.com, not official) repeats the three columns, says there are "Fourteen filters", and states that a lightning-bolt Quick Buy "executes a preset amount in one click without leaving the feed". It documents no filter-modal tabs, launchpad toggles, display settings or pause-on-hover. — [Axiompedia (third-party)](https://axiompedia.com/guides/trading/axiom-pulse-explained)

#### Comparable discovery patterns on Mobbin
- **[Binance Meme Rank (iOS)](https://mobbin.com/screens/5fb08bd4-fd7c-4a78-8ca9-77bf63a3a1a8)** is the closest mobile analog to a Pulse card. Each card has an avatar, name, score pill (for example "4.96") and badge icons, then age ("20h"), "Liq. $896.47K", holder count, "Mcap $3.03M" and a 24h % change. Below that is a chip row ("B.Vol", "B.Txn", holders, a red % chip) and an "AI Analysis: What is …?" link, with a yellow "Buy" button on every card.
- **[OKX Wallet Market (iOS)](https://mobbin.com/screens/afd911c1-6455-47f4-afee-ef2843bd423f)** has a "Search symbol, contract address" field, tabs for Favorites, Hot, Memes and Solana, sortable "Token / 24h turnover", "Last price" and "24h change" columns, change shown as solid red or green pills, and chain badges on avatars.
- **[OpenSea Tokens table (web, dark)](https://mobbin.com/screens/a2072a4d-d59f-4b22-92be-ddcc3100db61)** has Trending, Top and New tabs and green "NEW" badges next to tickers. Columns are Price, 1h, 1D, 30D change, 1D Vol, Market Cap, Supply and FDV, with a sparkline. A left filter rail offers chain chips (including Solana) and market-cap bucket chips ("< $100K", "$100K–$500K"… "$1B+"), and there is a table/grid toggle.
- **[Uniswap Explore tokens (web)](https://mobbin.com/screens/835e558d-781f-438e-9d81-4431388786e1)** has #, token, price, 1 hour, 1 day, FDV and Volume (sorted descending) columns, an inline sparkline, a network filter, a "1D volume" dropdown and a token search.
- **[OKX Rankings (web)](https://mobbin.com/screens/5a85b7c6-778f-4701-bcf0-8307895edc78)** leads with category cards (Hot crypto, New listings, Top gainers, Top losers, Largest market cap, Highest turnover). Its table has a star column, a "Last 24h" sparkline and a "24h range" low-to-high bar with a position marker.
- **[Base "Trading a token" flow (iOS)](https://mobbin.com/flows/cd900f42-0e79-4b75-a637-fa7145625ef3)** shows a Trending list with filter chips (Apps, Memes, Social, New). Each row has an age with a clock icon ("1y", "11h"), market cap with a chart icon, and 24h %. The review step lists Network, Fee, "Network fee: Paid by Base" and "Total including fees", then a "Trade now" confirm button.
- **Filter-modal patterns** (non-crypto but directly reusable for 14 min/max filters):
  - [Contra](https://mobbin.com/screens/c09833dd-c898-4f52-9178-b8bb75aa0861): a two-column modal with a dual-handle slider plus min/max number inputs, "Clear all filters" and "Save filters".
  - [Wellfound](https://mobbin.com/screens/cf9f9476-04ad-4123-8f82-d733fd122ed6): grouped range sliders with a "Clear" per section, removable active-filter chips at the top, and a "22 results / View results" footer.
  - [Klook](https://mobbin.com/screens/22184785-4f8b-4fed-b6d4-abb5ed7103e3): "Clear" plus a live-count button, "See 4276 results".
  - [Dribbble](https://mobbin.com/screens/040c543c-56aa-4361-91b3-fa9cf114a8a2): a budget slider with Minimum/Maximum inputs and "Apply".
- **Display-settings / column-toggle patterns:** [Neon "Toggle columns" popover](https://mobbin.com/screens/37bf80a5-ed4b-4394-9293-04b6877fb085) (checkbox list with "Select all") and [Dovetail "Fields" popover](https://mobbin.com/screens/832e5719-7133-4733-a7d2-87061364df60) (drag handles with on/off switches).

### Inferences
- **Chip mapping.** The five chips most likely map to the risk filters, in order: top-10 holders %, dev holding % ("DS" probably meaning the dev sold), snipers %, insiders % and bundle %. The two unlabeled counters on line 2 probably correspond to "Pro Traders" and another holder-quality metric. This is inferred from the icons and the docs filter list, since the screenshots carry no labels. A build should add tooltips to every chip.
- The colored avatar border is probably a bonding-curve progress indicator (the border colors differ between columns). This is unconfirmed.
- The "Paid" chip probably means Dex Paid, which matches the Explore filter of that name.
- **Density targets.** Use three lines per token, roughly 64–70 px per card at 1x, independent scroll per column, numbers abbreviated to K/M, color-coded values, and icons rather than words. The quick-buy pill is the only large touch target on the card.
- Column-scoped filters (one filter button per column), as opposed to one global filter, are a key Axiom pattern worth copying.

### Gaps
- No source shows Axiom's filter modal itself (tabs, launchpad/protocol toggles, keyword include/exclude), its display-settings modal (metric sizes, which fields show, themes), sorting, pause-on-hover, or row hiding.
- Which launchpads Pulse covers in Oct 2026 is unknown. The docs redact the second launchpad's name.

## Token/trade page: chart area, trade panel, presets, advanced settings, tables, token info, density

### Takeaway
Axiom's token page is built around a TradingView Advanced Charts chart with Axiom-specific toolbar toggles: "USD/SOL" and "MarketCap/Price", 1-second candles, and a "Limit Order Target" line you drag on the chart. Above the chart is a compact token header (MC as the headline number, then Price, Liquidity, Supply, socials and a watchlist star). The right rail is a compact Buy/Sell panel with Market, Limit and Advanced tabs, preset SOL amounts (1/2/3/5, editable), and a one-line settings summary (slippage, priority fee, tip, MEV). A Bought/Sold/Holding/PnL strip sits beneath it. Separately, a draggable "Instant Trade" popup carries presets P1/P2/P3, a wallet selector, four buy amounts, four sell percentages and hotkeys (Space plus a key). Wallet-level drill-down ("Trader Scan") opens from the trades/orderbook table.

### Cited Findings
#### Axiom (primary: docs screenshots viewed directly)
- **Token header strip** (in the limit-order screenshot): avatar, ticker "MLG" with the full name and a copy icon, age "9mo", icon links (X, web, Telegram, search), a large "$126M" (market cap), then Price $0.126, Liquidity $4.26M, Supply 998M, a small icon counter, and a star at the far right. — [Axiom docs: Limit Orders](https://docs.axiom.trade/axiom/swap/limit-orders)
- **Chart toolbar and canvas.** Toolbar: timeframe "1s", a candle-style selector, "Indicators", "Display Options", a "USD/SOL" toggle, a "MarketCap/Price" toggle, undo/redo, "Save" with a dropdown, a settings gear, fullscreen and a camera (snapshot).
  - The legend reads "MLG/USD on Raydium V4 · 1s · axiom.trade" with O/H/L/C values in market-cap units (for example "O126M H126M L126M C126M −612K (−0.48%)") and Volume.
  - A TradingView-style vertical drawing toolbar runs down the left edge, and the price axis is labeled in market cap (120M–130M).
  - A dashed horizontal line labeled "Limit Order Target" carries a "125M" axis tag, and the TradingView logo sits bottom-left. — [Axiom docs: Limit Orders](https://docs.axiom.trade/axiom/swap/limit-orders)
- Limit orders can be set with "the slider bar in the trading menu or drag and drop the price line directly on the chart". — [Axiom docs: Limit Orders](https://docs.axiom.trade/axiom/swap/limit-orders)
- **Tracked-wallet signal on the chart.** A round avatar/emoji bubble appears on the price series where a tracked wallet traded, under the docs heading "Enjoy Fast Signals on Charts" ("See live alerts while influencers and smart money wallets are buying"). — [Axiom docs: Adding Wallets](https://docs.axiom.trade/wallet-tracking/adding-wallets)
- **Trade panel.** — [Axiom docs: Market](https://docs.axiom.trade/axiom/swap/market)
  - A Buy/Sell segmented toggle (Buy in solid green), then sub-tabs "Market", "Limit" and "Advanced".
  - An "AMOUNT 0.0" input with a SOL icon, and preset buttons "1", "2", "3", "5" with a pencil (edit presets) icon.
  - A one-line settings summary: a slippage icon "40%", a priority-fee icon showing "0.006" in red with an info/warning icon, a coin icon "0.006" (tip/bribe), and an icon reading "On".
  - A checkbox "Advanced Trading Strategy" and a full-width green CTA "Buy MLG".
- **Position strip:** "Bought" (SOL icon, green 0), "Sold" (red 0), "Holding" (0), and "PnL" with a currency/percent toggle icon ("+0 (+0%)"). The docs text says you can check SOL bought, sold, holding "and the amount you are up". — [Axiom docs: Market](https://docs.axiom.trade/axiom/swap/market)
- **Token search modal:** a "Search by name, ticker, or CA..." field with an "Esc" keycap, then a "History" list. Each result shows avatar, ticker, name, copy icon, age ("4d", "11mo"), social icons and three right-aligned metrics: "MC:", "V:" and "L:" (liquidity). — [Axiom docs: Market](https://docs.axiom.trade/axiom/swap/market)
- **Settings definitions (docs text).** Priority Fee is "Additional fees… to increase the speed and likelihood of your transaction confirming". Slippage is the allowed % price change. MEV Protection means you "pay an additional fee" against sandwich attacks, and "The hand-and-coin icon at the top right corner of Axiom displays the current minimum MEV Bribe amount", so your MEV fee should exceed it. MEV protection "is only necessary for buy transactions". — [Axiom docs: Market](https://docs.axiom.trade/axiom/swap/market)
- Coin Bureau (June 2026) gives the defaults as Priority Fee "0.001 SOL" and Bribe/Tip "0.001 SOL", with MEV Protection modes "Off", "Reduced" and "Secure". Order types are market, limit and "Quick Buy". — [Coin Bureau](https://coinbureau.com/review/axiom-trade-review)
- **Instant Trade popup** ("a popup next to your chart which allows you to buy and sell with one click"). — [Axiom docs: Instant Trade](https://docs.axiom.trade/axiom/swap/instant-trade)
  - Header: a keyboard (hotkeys) toggle icon, preset tabs "P1 P2 P3", a pencil (edit), a drag handle at top center, a wallet selector showing "1" with a chevron, and a close X.
  - Buy section: "Buy" with the SOL balance "0.249" at right, four green outlined pills ".00001", ".0001", ".001" and "1", and a settings row "20% | 0.001 | 0.0₃1 ⚠ | [robot icon] Off" with an "Adv." checkbox.
  - Sell section: "Sell" with a "%" toggle and a swap-arrows icon, holdings "0 $SNSEKR • $0 • ≡ 0", four red outlined pills "10%", "25%", "50%" and "100%", a settings row, and a pink "Sell Init." action.
- Hotkeys are switched on with a keyboard button; "press 'Space' and the respective hotkey to do that specific action (Buy x Sol, Sell x%, etc!)". — [Axiom docs: Instant Trade](https://docs.axiom.trade/axiom/swap/instant-trade)
- **Trader Scan popover**, opened from the orderbook/trades table: a truncated wallet address with a copy icon, a "USD" toggle, and three tiles ("↓ $0.38 / 4 Buys" in green, "↑ $0.28 / 9 Sells" in red, "PnL −$0.1"). Below those are "$0.26 / 0.0₂2% (16.6K)" (holding value, % of supply, token amount) and "5m Holder Since", with footer icons for chart, external link and filter.
  - Behind the popover, table rows carry a "YOU" tag and a "Last TX: 8mo" label, and the chart corner shows "log" and "auto" scale toggles.
  - Docs text: it shows each trader's buys, sells, balance, realized PnL and hold time "embedded directly within the orderbook interface". — [Axiom docs: Trader Scan](https://docs.axiom.trade/trader-scan)
- **Migration Actions (docs text).** "Axiom Sniper Buy" means you set sniper fees and click "Snipe". "Axiom Sniper Sell" is reached via Sell → "Advanced" → "Migration", where you type in the sell details. — [Axiom docs: Migration Actions](https://docs.axiom.trade/axiom/swap/migration-actions)

#### Comparable trade-page patterns on Mobbin (spot)
- **[Coinbase Advanced spot](https://mobbin.com/screens/4ed27744-549c-4cb7-894f-e2bc1f04c623)** is a full pro layout.
  - Frame: a left icon rail (Spot, Derivatives, Portfolio, Orders, Referral, API, Earn, More, plus an "Advanced" toggle) and a top ticker bar (pair pill, last price with 24h %, 24h volume, high, low). The center has "Price chart / Depth chart" tabs with a TradingView chart, and an open chart-type menu lists Bars, Candles, Hollow candles, Line, Line with markers, Step line, Area, HLC area, Baseline, Columns, High-low and Heikin Ashi.
  - Order book and trade history: "Order book / Trade history" with a spread row.
  - Order form (right rail): "Available to trade", Buy/Sell, Limit/Market/Stop limit, a limit price with MID/BID/1%/5% chips, an amount with 25%/50%/MAX, "Execution: Allow taker", "Time in force", and Subtotal/Fee/Total.
  - Orders area: an Orders table with "Cancel all", "View all", "All markets" and "All statuses" filters, and a "No orders" empty state.
- **[Coinbase Advanced with fee tooltip](https://mobbin.com/screens/9b76c57a-9ae9-408f-bbd1-f4955a00d544)** explains the fee tier inline next to "Est. fee (includes taxes)", which is a good model for explaining platform fee and priority fee before submit.
- **[Kraken Pro trade](https://mobbin.com/screens/7cef61a7-167f-4abd-ab8a-effc2538da6f)** has modular panels with tabs and a "+" to add panels ("Market chart | Favorites | +", "Order book | Market +2"). An on-chart order preview line is labeled "Preview – Buy – Limit". The order form has an "Order form | Alerts" tab pair, a % slider, "Post only", TP/SL and "Est. trading fee". Bottom tabs are Balances, Positions, Open orders, Conditional orders, Closed orders, Trades and "+", and a status bar shows "● Online" and a favorites ticker.
- **[OKX spot (demo)](https://mobbin.com/screens/433e97cd-b631-497b-9ccb-5d1d70095954)** puts a markets list on the left (search plus quote tabs) and offers timeframes from "1s" to 1D. It has an "Original / TradingView / Depth" chart-engine toggle, side-by-side Buy and Sell forms each with a 0–100% slider, and a "Quick start" helper chip. A [text-tool tooltip variant](https://mobbin.com/screens/f8b9edc8-dc9e-4cf6-ab03-a802e3112275) shows the TradingView drawing toolbar labels.
- **[Binance spot](https://mobbin.com/screens/be13d39d-afc1-4ede-ac82-0ed90db46dc3)** puts the order book left and a pair list (quote tabs) plus "Market Trades / My Trades" right. The chart has tabs Chart, Info, Trading Data, Trading Analysis and Square, MA(7/25/99) legends, and user-drawn shapes with a floating drawing-style toolbar.
- **[Gemini trade page](https://mobbin.com/screens/a3627701-27ac-45e3-a105-e3e93036b9ef)** is captured under its derivatives account, but its patterns are generic. Hovering the price axis offers "Draw Horizontal Line at 0.02799". Price chips run MID/BID/1%/5%/10% and quantity chips 25/50/75/100%/Custom. A widget shows the error state "Something went wrong, please try again later", and a ticker tape runs along the footer.
- **[OpenSea token page (PENGU on Solana)](https://mobbin.com/screens/d07a9d5b-cd19-4c4b-a600-0ba26e29c68c)** has a header stats row, a price with % change, timeframe chips All/1y/30d/7d/1d, and a line/candle toggle. Below the chart is a "Chain / Market cap / FDV / 1D volume / 1D price / 1D market cap" row. A right Swap card (Swap/Buy tabs and gear) has a "Connect Solana Wallet" CTA.
  - Variants: [area](https://mobbin.com/screens/52822748-0cbc-4991-a805-4c6b9295bc3c) (copy/contract and X/Telegram icons in the header), [candles](https://mobbin.com/screens/91fc33c8-313a-4ff6-87dc-fe1132f26960), and [scrolled](https://mobbin.com/screens/3e759970-e844-4ccc-84b9-0cc8afb52173), which shows "About" plus "Powered by CoinGecko API and TradingView" and Trending Tokens cards with NEW badges.
- **[Base token page (web)](https://mobbin.com/screens/2439249c-3665-4ba4-b7e2-602b39aa8df8)** makes market cap the headline ("221.68B") with a toggle icon and shows Price and 24h Vol underneath. A "Your Position" card lists Average Cost $1.19 and PnL +$0.01 (0.73%). This is an analog for both the MC/price toggle and the average-entry display.
- **Trades table analog: [Uniswap Transactions](https://mobbin.com/screens/9a89244a-9b7b-49c1-9d6c-28cd7abdfa3f).** Columns are Time (sorted), Type ("Swap X for Y") with a checkbox filter dropdown (Swap/Add/Remove), USD, two token-amount columns, and Wallet (truncated address).
- **Holders table analog: [OpenSea Holders](https://mobbin.com/screens/93596239-8d84-49e1-a17a-92fb82eec150).** Columns are Wallet (avatar plus name or short address), "Owned" with an inline green bar, "% Owned", Est. value and Est. portfolio %. It has a "Quantity owned" Min/Max filter with Apply and a "Most owned" sort.
- **Holder-type segmentation analog: [Perplexity Finance holders](https://mobbin.com/screens/d265c7a4-c61e-46bc-b525-beb10db72df8)**, with Institutional/Insiders/Politicians tabs, a search box and Download (stocks context).
- **Order-lifecycle toasts and entry label (Phantom iOS; perp screens used only for these transferable patterns).** A top toast reads ["Opening 0.00018 BTC long 3x"](https://mobbin.com/screens/e7d53c9d-f418-4a56-9b5a-b8e2a5647e4e), then turns into a success toast, ["Opened…"](https://mobbin.com/screens/c5d3a411-f5d2-4618-bfb4-0eb2abcbf5d4). The chart then shows an "Entry" price label on a dashed line, plus a "Your Position" card (P&L, ROI) with a share icon.
- **Relative-price helper text: [Revolut Business order settings](https://mobbin.com/screens/b06bb6eb-2d35-48df-b76a-56303263f628)**, for example "Your stop price is 9.38% lower than the current indicative market price".

### Inferences
- Axiom keeps the chart and trade panel visible together and pushes speed actions into three places: the right-rail panel, the floating Instant Trade window, and keyboard hotkeys. Density comes from abbreviated numbers, subscript-zero notation (for example "0.0₃1" = 0.0001), icon-only labels with tooltips, and putting MC rather than price on the y-axis.
- The fourth icon in the settings rows ("On" in the trade panel, a robot icon reading "Off" in Instant Trade) is probably MEV protection or an auto-fee toggle. The label is not confirmed.
- "Sell Init." probably means "sell initials" (recover the initial investment).
- A "YOU" tag on your own trades and wallet-name tags on tracked wallets in the trades table are worth copying, as is opening the wallet drill-down from any address.

### Gaps
- The Axiom docs do not show the full token page in one screenshot: how the trades/holders/positions/orders tables are arranged and what columns they have, the token-info/audit sidebar, or dev-wallet details. The only glimpses are the Trader Scan background ("YOU" tag, "Last TX").
- What the "Advanced Trading Strategy" checkbox does (possibly TP/SL ladders) is undocumented.
- Whether presets P1/P2/P3 also switch slippage, fee and MEV values isn't stated. The settings rows sit inside each preset in Instant Trade, which suggests they do (inference).

## Onboarding, wallets, deposit/withdraw, settings, rewards/referrals, portfolio/PnL and PnL card, trackers, yield, mobile navigation

### Takeaway
Axiom onboarding is a short stepper: email OTP, Google or Phantom; then a password and a recovery phrase shown once; then Add Money (deposit SOL or buy via Coinbase). Wallets support multi-wallet management with labels and drag-to-distribute SOL. The Portfolio page combines balance, a PnL chart, PnL-distribution buckets, positions and an activity log, and can look up other wallets. Trackers (Wallet Manager / Live Trades and Twitter Alerts / Customize Feed) are floating, pop-out panels. Rewards are a three-tier referral share plus volume-based cashback tiers and points. For each area the best Mobbin analogs come from Phantom, OKX, Coinbase, Base, Binance, Kraken and Gemini. No Axiom iOS app was found.

### Cited Findings
#### Onboarding / sign-up and wallet creation/import
- **Axiom signup steps (docs text):** "Click Signup" → "Choose either to enter your email, signup with Google, or signup with Phantom" → "Enter One Time Code (Only Via Email)" → "Create your password" → "View your recovery key" ("We show you your seed phrase…") → "Add Money into your account!" ("Deposit SOL directly into the wallet shown or buy SOL through our partner Coinbase with no-KYC").
  - The docs hint "Access your recovery phrase at any time in your settings!" and recommend importing it into Phantom, Rabby or Solflare. — [Axiom docs: Signup](https://docs.axiom.trade/getting-started/signup)
- Coin Bureau says users can either "create a wallet through Axiom or connect an existing Solana wallet such as Phantom". — [Coin Bureau](https://coinbureau.com/review/axiom-trade-review)
- **Axiom multi-wallet (screenshots).** — [Axiom docs: Multi-wallet](https://docs.axiom.trade/multi-wallet)
  - Header: "Axiom Main ≡ 17.53".
  - Left table: "Search by name or address", a "Show Archived" toggle, "Import", "Create Wallet", and columns Wallet, Balance, Holdings and Actions. The active wallet name shows in orange.
  - Right side: a "Source wallets" table with the empty state "Drag wallets to distribute SOL", and a "Destination" section with a disabled action button.
  - Wallet dropdown: "Axiom Main" (checked) with a holdings count, plus "+ Add Wallet".
  - Docs text adds a "Unified Dashboard", "Quick Wallet Switching" and wallet labels such as "Flipping Wallet".
- **[Phantom Onboarding flow (iOS)](https://mobbin.com/flows/ff2e342f-69cb-4a47-ae09-b869822dfdff).** A splash screen leads to "Protect Your Wallet" (Face ID toggle) and then "Create Username" with an inline "Username available" check. The flow ends on an account home showing "$0.00 Add funds to get started. Withdraw anytime." with an "Add Funds" CTA, a "For Your First Trade" carousel (BTC/ETH/SOL cards) and a ranked "Popular" list showing MC per token.
- **[Phantom "Adding an account" flow](https://mobbin.com/flows/82bc7359-9ff8-46cf-9946-adfc40da1355).** A profile sheet (Profile, Settings, Cash Balance, and "Your Accounts" with an edit pencil and "Add Account") leads to "Import Recovery Phrase: Restore an existing wallet with your 12 or 24-word recovery phrase" (text area plus "Import"), and then the new account's home (Send/Swap/Receive/Buy and a Tokens list).
- **[Phantom "Adding a new wallet" flow](https://mobbin.com/flows/22a88db4-5730-47b4-b51d-dd26028d28ec):** a "Your Accounts" list with "Add / Connect Wallet", then "Create Account" with a name field and "Create".

#### Deposit / buy / convert / withdraw
- **Axiom Buy Crypto (docs text):** click the arrow button at the top right → "Deposit" → "Buy" → enter a SOL amount ("up to $500 without KYC") → popup. — [Axiom docs: Buy Crypto](https://docs.axiom.trade/axiom/buy-crypto). The FAQ cites Coinbase for "up to $500 worth of crypto per week, no-KYC". — [Axiom FAQs](https://docs.axiom.trade/faqs)
- **Axiom Convert to USDC (docs text):** wallet button → swap button → swap. — [Axiom docs: Convert](https://docs.axiom.trade/axiom/swap/convert)
- **[OKX "Copying deposit details" (web)](https://mobbin.com/flows/a6c83dd1-51f7-4e6f-95da-faff776eb1ca)** is a vertical stepper: "Select crypto" → "Select network" → "Deposit details" (QR, full address, copy button). Clicking copy turns the button into a green check with a "Copied" toast. Below that are minimum deposit, deposit arrival time, withdrawal available time and token contract, with an FAQ card on the right.
- **[Coinbase "Receive crypto" (web)](https://mobbin.com/flows/3c51b0c3-4437-4496-a4ee-2b135454234e)** shows a "Select network" warning modal ("Receiving crypto over the wrong network could mean losing your funds…", "Don't show this warning again", "I understand"). Then a "Receive ETH on the Base network" modal shows the QR, "Your address", constraint notes and a "Copied to clipboard" toast.
- **[Base "Receiving an asset" (web)](https://mobbin.com/flows/6f420ce2-0a56-4623-9b56-e23e92cbae5b)** starts from an empty home ("You don't have any coins" plus "Buy Coins") and an action menu (Trade/Send/Receive/Deposit). A full-screen QR overlay shows the short address and copy, with a note on which networks the address supports.
- **[Binance "Withdrawing crypto" (web)](https://mobbin.com/flows/342275ff-517f-48f0-86f7-97da54cf8ca4)** is a stepper: Select Coin → Withdraw To (Address / internal user) → Withdraw Amount (MAX, note, available, 24h remaining limit, total, fee, Send). A "Confirm Order" modal lists every field and warnings. Then comes email-verification 2FA, whose error state shows an inline red field error and a top-right error toast ("Too many requests. Please try again later.").
- **[Coinbase "Transfer" (web)](https://mobbin.com/flows/dfdf09d3-5476-42be-8c56-6fdd9fa7866a)** opens a Transfer menu (Send crypto, Receive crypto, Deposit cash, Withdraw cash) from the Advanced trade page. Send goes to a modal (amount, Max, source asset with "Available", "To: Select network and recipient", "Add note", "Preview Send"). The same flow's first screen shows a filled-orders table.
- **[Coinbase "Cash out" (web)](https://mobbin.com/flows/687cd2f7-0444-438c-a498-5c6c91471647):** hovering a balance row reveals deposit/withdraw icon buttons with tooltips. The cash-out modal offers "Cash out all" and an info note about which portfolio funds can be withdrawn from.

#### Settings
- Axiom: the recovery phrase is in settings ([Signup](https://docs.axiom.trade/getting-started/signup)), there is a hotkey toggle ([Instant Trade](https://docs.axiom.trade/axiom/swap/instant-trade)), and trade settings cover slippage, priority, tip/bribe and MEV ([Market](https://docs.axiom.trade/axiom/swap/market); [Coin Bureau](https://coinbureau.com/review/axiom-trade-review)).
- **[Uniswap settings drawer (web, dark)](https://mobbin.com/screens/debc076d-b186-42b2-8c23-b1fae356c2d1)** is a right-side drawer with Theme (Auto/light/dark), "Hide small balances", "Hide unknown tokens & NFTs", "Allow analytics", "Testnet mode", Language, Currency and a version footer.

#### Referrals / rewards
- **Axiom referral (docs text):** "3-Tier Referral System". Level 1 earns 30%, Level 2 3% and Level 3 2% "of Axiom's net fee", across Solana, BSC and Ethereum. Rewards are uncapped. Users "who sign up using a referral link receive a 10% discount on trading fees". — [Axiom docs: Referral Program](https://docs.axiom.trade/getting-started/referral-program)
- **Axiom cashback tiers (docs text):** Wood (1X) has a net fee of 0.95% and 0.05% cashback. Bronze (2X) 0.90%/0.10%, Silver (2.5X) 0.875%/0.125%, Gold (3X) 0.85%/0.15%, Platinum (3.5X) 0.825%/0.175% and Diamond (4X) 0.80%/0.20%. Champion (5X) has a net fee of 0.75% and 0.25% cashback. The multiplier rises with trading volume. — [Axiom docs: Axiom Fees](https://docs.axiom.trade/getting-started/fees/axiom-fees); see also [Reward System](https://docs.axiom.trade/getting-started/reward-system)
- **Axiom points (docs text):** points come from trades and referrals, and "you can track your progress and see how you rank against other traders through our leaderboard". — [Axiom docs: Point System](https://docs.axiom.trade/getting-started/point-system)
- **Mobbin analogs:**
  - [Coinbase Invite Friends](https://mobbin.com/screens/6bf718ac-738b-4dca-bd71-d5a967296bf2): a headline offer, an invite-link field and a "Share" button with a WhatsApp/Messenger/Facebook popover.
  - [Binance Pool referral](https://mobbin.com/screens/96d33710-1c9d-413c-a9c2-cd2cd6e6f105): return rate, referral code, link with copy, "Earned / Invitations / Invitation List" stat cards, "Invite History / Return Details" tabs, Download and an empty state.
  - [OKX referral](https://mobbin.com/screens/bedba306-7c5b-455e-a681-ac1fd38cfddf): link and code rows with copy and a five-step "how it works" timeline.
  - [Replit referral modal](https://mobbin.com/screens/dfbebaa8-fae3-4534-a187-81a7bc74c036): "Credits earned / Completed referrals / Pending referrals" tiles.
- **Leaderboard pattern: [Kraken leaderboard](https://mobbin.com/screens/596e24c3-cff1-466a-9e8c-9cd5a2e5d94b)** (captured on futures, but the pattern is generic). It has "Profit & loss / ROI / Volume" tabs, 7D/1M, nickname search, a "Your rank" box with share and nickname edit, and a toast "Nickname changed".

#### Portfolio / PnL and PnL card
- **Axiom spot portfolio (screenshot).** — [Axiom docs: Portfolio](https://docs.axiom.trade/axiom/portfolio)
  - Top: tabs "Spot | Perpetuals", "Your holdings" with a search icon, a "Search for other wallets..." input, and a period toggle "7d 30d Max".
  - Balance panel: Total Value $3.81K, Unrealized PNL +$0 and Available Balance $3.81K.
  - PNL panel: an area chart.
  - Performance panel: a share icon, Total PNL +$4.13K, Total TXNS 252 (split green/red), and five colored-dot buckets (">500%", "200%–500%", "0%–200%", "0%– −50%", "< −50%") with counts and a green/red ratio bar.
  - Positions table: "Active Positions | History", "Show Hidden", a "USD" toggle, and columns Token, Bought, Sold, Remaining, PnL (sortable) and Action icons. One row shows "+$0.0₃1 (+Infinity%)".
  - Activity table: columns Type (Buy/Sell colored), Token, Amount, Market Cap, Age and Explorer link.
- Docs text: the Performance metrics "break down total PNL and number of transactions, categorized purely by profitability ranges", and activity entries link "directly… to solscan". — [Axiom docs: Portfolio](https://docs.axiom.trade/axiom/portfolio)
- **Mobbin analogs (portfolio):**
  - [Binance Assets Overview](https://mobbin.com/screens/5acd0f5e-9019-4e1f-95e1-1446bbccd036): Estimated Balance, "Today's PnL", a 1W/1M/3M/6M chart, Deposit/Withdraw/Transfer, "Coin View / Wallet View", "Coin Price / Cost Price" and "Today's PnL" columns, and "Hide assets <1 USD".
  - [Kraken Pro home](https://mobbin.com/screens/fe204312-8607-4018-b0dd-a36dc71f4978): account cards with "UP&L" and a "Healthy" margin badge, a Balances/Open orders/Conditional orders/Positions table with "Avg. price", and an Explore chip cloud that includes "P&L Share", "Price Alerts" and "Leaderboard".
  - [Gemini Portfolio](https://mobbin.com/screens/cc6a1261-a495-4977-8ca8-36d9a20b46db): a dark balance-chart card, "Account snapshots", quick actions and an "Alerts" entry card.
- **PnL/share-card analogs:**
  - [Binance spot copy-trading share card (iOS)](https://mobbin.com/screens/fa184fc0-d47a-4ad5-a927-fd920bc4808f): avatar and name, "30D ROI +5.20%", "30D PnL (USDT) +24,825.43", "Cut-off Time", brand footer and QR, and a share sheet (Square, Stickers, Save, More).
  - [Public portfolio-return card](https://mobbin.com/screens/5be7661b-2f1b-4af1-98ca-abe4cf3edb63): a $/% toggle, a swipeable template carousel with dots, and Share/Cancel.
  - [Coinbase Wallet token share card](https://mobbin.com/screens/f4a051ae-4191-4f20-bfb1-25521cbb8c33) and [Coinbase price-chart share](https://mobbin.com/screens/d092bc27-8176-4034-a91d-8354bdc7376f).
  - [TradingView "Congrats, trader!"](https://mobbin.com/screens/f823b607-7d06-42eb-aa45-979d1b70953c): Profit in cash, Win rate and Best trade.
  - [Perplexity share screenshot](https://mobbin.com/screens/bf6f870b-1e78-404c-944b-0769c8ee0606): Copy Image / Download Image, a "Show prev. close" toggle and a "Copied to clipboard" toast.

#### Wallet tracker
- **Axiom Wallet Manager (screenshot).** — [Axiom docs: Adding Wallets](https://docs.axiom.trade/wallet-tracking/adding-wallets)
  - A floating modal with tabs "Wallet Manager | Live Trades" (red unread dot), a "Search by name or addr..." field, pop-out and close.
  - Table columns: Created ("4d"), Name (emoji, name, truncated address, copy and a clock icon), and Actions (a red bell for alerts, trash).
  - Footer buttons: "Import", "Export" and "Add Wallet".
- The "Add Wallet" modal has an emoji picker, "Wallet Name", "Wallet Address" and an "Add Wallet" CTA. Docs text: "The Wallet tracker in in the bottom left corner", and "If you were previously on platforms like Bullx, you can directly import wallets". — [Axiom docs: Adding Wallets](https://docs.axiom.trade/wallet-tracking/adding-wallets)
- **Live Trades tab (screenshot):** a header with a bell, "P1" and a quick-buy amount "⚡ 2.000 ≡". Rows show relative time ("27m"), wallet emoji and name (colored), token avatar plus ticker plus token age ("300BAUD · 2h"), SOL amount ("≡ 86.957") and MC ("$2.5M"). — [Axiom docs: Monitor Wallets](https://docs.axiom.trade/wallet-tracking/monitor-wallets)
- **Mobbin analogs:**
  - [Binance Smart Money signals (iOS)](https://mobbin.com/screens/224a5744-3640-4889-96c6-c7ae16481a77): a card reading "4 Smart Money bought $19,663.67 within 15 mins" with an "Exit Rate 11%" bar, Latest Signal Price, MCap, Highest Gain, a mini chart with a "Max" marker, a "Sold All" state and a yellow "Trade" button.
  - [Base social trade feed (iOS)](https://mobbin.com/screens/d82dd481-ce72-4b31-98bd-4845f75d3849): "urben bought $51.13 of $VVV", with a token card (Market Cap, Price, PnL, Holders) and the buyer's avatar pinned on the price line.
  - [Binance copy-trading portfolio grid (web)](https://mobbin.com/screens/c8750853-6638-4b32-bc24-cda9e624ee8d): trader cards with 7D PnL, ROI, sparkline, AUM, 7D MDD, Sharpe ratio, "Mock" and "Copy" buttons, and sort chips.

#### X (Twitter) tracker
- **Axiom Twitter Alerts (screenshot).** A floating panel titled "Twitter Alerts" (with an unread dot), pop-out and close. Tweet cards show avatar, name, verified badge, handle, relative time plus clock time ("18s · 23:34"), text, embedded quote tweets, images and retweet lines. — [Axiom docs: Tweet Monitor](https://docs.axiom.trade/tweet-monitor)
- **Customize Feed (screenshot).** — [Axiom docs: Tweet Monitor](https://docs.axiom.trade/tweet-monitor)
  - Tabs "Customize Feed | Twitter Alerts", with "Import", "Export" and "Add Handle" buttons.
  - An info banner: "Twitter handles you add will only be actively tracked if they appear in the Top Subscriptions list…".
  - Sub-tabs "My List | Top Subscriptions", a count ("230"), and "Search handle".
  - Table columns: Handle, Tweets, Profile Updates and Follows (per-handle toggle icons), and Actions (trash, or "+ Add").
- Docs text: the feed is free for users with "at least 5 SOL in trading volume". — [Axiom docs: Tweet Monitor](https://docs.axiom.trade/tweet-monitor)

#### Yield and staking (Axiom)
- The FAQ advertises "up to 15% APY on your assets, with instant withdrawals" via Marginfi. — [Axiom FAQs](https://docs.axiom.trade/faqs)
- Native SOL staking to the "Axiom" validator has 0% commission. The axiSOL liquid staking token ("secures over 400k SOL") has a 5% fee on earnings and a 0.1% withdrawal fee. — [Axiom docs: Staking](https://docs.axiom.trade/staking)

#### Perps
- Out of scope per the coordinator. Axiom's docs do include Hyperliquid perps (deposit/trade/withdraw pages, and a separate "Perpetuals" portfolio tab), but they are not inventoried here. — [Axiom docs index](https://docs.axiom.trade/llms.txt)

#### Mobile navigation (analogs; no Axiom iOS app found)
- Bottom tab bars on Mobbin:
  - Phantom (iOS) has five icons: home, wallet/cards, swap, chat, search ([token page](https://mobbin.com/screens/76e93b20-0652-4758-8e2d-4925312a1fba)).
  - Base (iOS) has Home, Search, Trade, Feed and Notifications ([feed](https://mobbin.com/screens/d82dd481-ce72-4b31-98bd-4845f75d3849)).
  - OKX Wallet has Home, Trade, Marketplace, DeFi and Discover ([market](https://mobbin.com/screens/afd911c1-6455-47f4-afee-ef2843bd423f)).
  - Solflare has Portfolio, Market, Swap, Explore and Settings ([market](https://mobbin.com/screens/d5381cd7-2727-46d0-b1ce-8e12787be5a3)).
  - Binance has Home, Markets, Trade, Discover and Assets ([signals](https://mobbin.com/screens/224a5744-3640-4889-96c6-c7ae16481a77)).
- Phantom's token page (iOS) keeps a sticky full-width "Buy" CTA above the tab bar, plus Long/Short/Receive/More tiles and a social "2 chatting… Join Chat" row ([BTC page](https://mobbin.com/screens/76e93b20-0652-4758-8e2d-4925312a1fba)). A position card (Value, Balance, 24h Return) and an Info section (Market Cap, Supply, Created, About, Website/X) follow ([position](https://mobbin.com/screens/fc840afe-719f-4a5d-96a8-07e5946ea5b4); [info](https://mobbin.com/screens/2f8a4b54-f4de-4e28-985b-2dde614ed0c6)).

### Inferences
- Axiom's power features (wallet tracker, Twitter alerts, Instant Trade) are floating, pop-out windows with drag handles rather than separate pages. That lets a trader keep Pulse or the chart in view. A web build needs a small window manager (drag, dock, pop-out to a new browser window, remembered positions).
- The portfolio's "Search for other wallets" makes it double as a wallet explorer, and the same view can power the wallet-tracker drill-down.
- The "+Infinity%" PnL shown in Axiom's own screenshot is an edge case (zero cost basis, for example airdropped tokens) the build should handle explicitly.
- For a self-hosted product the rewards and referral screens may be optional. Fee-tier and cashback UI only matters if the operator charges fees.

### Gaps
- Axiom's settings page and its PnL share-card visuals are undocumented. The Performance panel has a share icon, but the card itself isn't shown.
- No crypto-specific X-tracker analog turned up on Mobbin.
- No Axiom deposit or withdraw modal screenshots were viewed. The withdraw flow (sending SOL out of the embedded wallet) isn't documented beyond Convert.
- No yield/earn screens were searched on Mobbin, to save budget.
- Loading states. The only skeleton-like example seen is a grey placeholder bar under the balance in [Wealthsimple's Crypto flow](https://mobbin.com/flows/20d7d8b0-c365-4549-bca0-106c0d98d51d). Inline error states were seen in Gemini's widget and in a Revolut watchlist "Something went wrong / Try again" ([Revolut flow](https://mobbin.com/flows/dd540059-a15f-465d-a480-5a3a52f2b4e9)).

## Comparable crypto screens on Mobbin worth borrowing (order entry, positions, PnL cards, alerts, watchlists, keyboard-first)

### Takeaway
The most transferable patterns, by area:
- Coinbase Advanced and Kraken Pro: order entry with quick price and size chips, a fee explainer, and an order line drawn on the chart.
- Kraken: modular, tabbed panels that the user can add to.
- Gemini and Kraken: alerts created against a price with ±% chips, or by dragging on the chart.
- Binance and Public: share cards with ROI/PnL, QR and template carousels.
- OpenSea: a keyboard-shortcut cheat-sheet with chorded keys.
- Phantom, OKX and Coinbase: toast and copy feedback.

### Cited Findings
- **Order entry:**
  - [Coinbase Advanced](https://mobbin.com/screens/4ed27744-549c-4cb7-894f-e2bc1f04c623): price chips (MID/BID/1%/5%), size chips (25%/50%/MAX) and an execution/time-in-force row.
  - [Gemini](https://mobbin.com/screens/a3627701-27ac-45e3-a105-e3e93036b9ef): chips including 10% and "Custom".
  - [Kraken Pro](https://mobbin.com/screens/7cef61a7-167f-4abd-ab8a-effc2538da6f): a % slider, "Post only", TP/SL, an "Est. trading fee", and a preview order line on the chart.
  - [OKX](https://mobbin.com/screens/433e97cd-b631-497b-9ccb-5d1d70095954): dual Buy and Sell forms with 0/25/50/75/100% sliders.
- **Positions, history and ledgers:**
  - [Kraken ledger](https://mobbin.com/screens/2da9671f-45f5-4713-9f71-3b27e7f96c32): "Ledger / Orders / Trades / Positions" tabs, Assets/Categories/Date filters, columns Date, Type, Wallet, Asset, Amount (green/red), Fee, Balance and ID, pagination "1–12 of 12", and Exports.
  - [Coinbase Transactions](https://mobbin.com/screens/f37d2ffe-51a8-49ed-a910-5c37403f3919): Type/Status/Asset/Date filter chips.
  - [OKX Orders](https://mobbin.com/screens/85508946-5e75-40f1-bd70-0cd88d6f1e76): All types / All statuses / All time periods.
- **PnL cards:** [Binance](https://mobbin.com/screens/fa184fc0-d47a-4ad5-a927-fd920bc4808f), [Public](https://mobbin.com/screens/5be7661b-2f1b-4af1-98ca-abe4cf3edb63), [TradingView](https://mobbin.com/screens/f823b607-7d06-42eb-aa45-979d1b70953c) and [Perplexity](https://mobbin.com/screens/bf6f870b-1e78-404c-944b-0769c8ee0606), as described above.
- **Alerts:**
  - [Gemini "Create alert" drawer](https://mobbin.com/screens/13711ace-800d-49a0-946c-0c723edb5137): Alert type ("Custom price alert"), Asset, "Receive alert when BTC crosses" with the current price shown, chips −5%/−1%/+1%/+5%, "This alert will trigger once and then pause", and Cancel/Create alert.
  - [Kraken "Set target price"](https://mobbin.com/screens/96248ffd-0133-42ad-b3b5-c8e8c2ce5144): a dark popover with a mini chart and a draggable target line ("Target: 89,198.38 USDC"), timeframe chips and "Select".
  - [Perplexity price alert](https://mobbin.com/screens/05d1e5bc-6996-4d08-a5b2-81a9aca3684a): "Target Price / Movement Amount" toggle and "Notification platform: In-app, Email, and Mobile".
  - [PayPal](https://mobbin.com/screens/48225013-d1a0-42b1-a409-88db6110beda): 5%/8%/10% chips.
  - Empty states: [Revolut Business](https://mobbin.com/screens/11c9ad73-badd-4ab2-a4b3-3667574f50b8) ("Your alerts will appear here" and "Your watchlist will appear here") and [Airwallex](https://mobbin.com/screens/7f3ba377-d5f1-49ae-83f3-896c98c85dce) ("Create your first rate alert").
- **Watchlists:**
  - Star columns appear in [Kraken Pro home](https://mobbin.com/screens/fe204312-8607-4018-b0dd-a36dc71f4978) (Favorites, Top Traded, Gainers, Losers, New tabs with a star per row) and [OKX Rankings](https://mobbin.com/screens/5a85b7c6-778f-4701-bcf0-8307895edc78).
  - The [Coinbase home](https://mobbin.com/flows/3c51b0c3-4437-4496-a4ee-2b135454234e) has a "Prices" list with a "Watchlist" dropdown, inline "Buy" links, stars and drag handles.
  - Axiom stars tokens into a Watchlist ([Explore docs](https://docs.axiom.trade/axiom/finding-tokens/explore-tokens)).
- **Keyboard-first:**
  - [OpenSea "Shortcuts" modal](https://mobbin.com/screens/29cf690c-5ca2-4f25-8346-ebd5c7eb5857) (dark) uses chorded keys ("G then D" for Discover, "G then S" for Stats), "T then M" to toggle Collector/Pro mode, "T then C" to toggle currency, "/ or ⌘K" for search, "?" for help, J/K for next/previous item, and ESC.
  - [Zendesk](https://mobbin.com/screens/f679b815-490f-4349-a70b-36c23bb89a18) groups shortcuts by context and adds "Enable keyboard shortcuts" checkboxes and "Download as a PDF". [YNAB](https://mobbin.com/screens/ea7d8a82-2d9b-4708-a563-d9adcc4f471a) and [Retool](https://mobbin.com/screens/cf5afca5-ea47-417c-9f97-e6ae4d53365c) are also shortcut sheets.
  - Axiom uses Space-plus-key trade hotkeys ([Instant Trade docs](https://docs.axiom.trade/axiom/swap/instant-trade)) and Esc in the search modal ([Market docs](https://docs.axiom.trade/axiom/swap/market)).
- **Search:**
  - [Uniswap search dropdown](https://mobbin.com/screens/864dda50-5223-47c7-ad05-80bc1ddb77fd): "Recent searches" and "Popular tokens", with price and 24h %.
  - [Uniswap "Select a token"](https://mobbin.com/screens/a96a0605-1642-4215-b430-77e5cbec1df3): quick chips, "Your tokens", and a token list with truncated contract addresses.
  - [Base "Select Coin"](https://mobbin.com/screens/acbee0d4-4204-4950-9907-99b945224ed4): a network filter inside the search field.
- **Feedback toasts:**
  - Phantom order lifecycle: [opening](https://mobbin.com/screens/e7d53c9d-f418-4a56-9b5a-b8e2a5647e4e) and [opened](https://mobbin.com/screens/c5d3a411-f5d2-4618-bfb4-0eb2abcbf5d4).
  - OKX "Copied" ([flow](https://mobbin.com/flows/a6c83dd1-51f7-4e6f-95da-faff776eb1ca)), [Uniswap "Address copied" (iOS)](https://mobbin.com/screens/321c152c-ae28-48dd-8565-71171127d6d3) and [Kraken "Nickname changed"](https://mobbin.com/screens/596e24c3-cff1-466a-9e8c-9cd5a2e5d94b).
  - Binance error toast ([withdraw flow](https://mobbin.com/flows/342275ff-517f-48f0-86f7-97da54cf8ca4)).
- **Swap side-drawer: [OpenSea Swap drawer](https://mobbin.com/screens/6a69de36-4f28-4841-8294-f7a195fa87a1)** slides in from the right over the page, with a gear, a rate row ("1.00 ETH = 334.83 UNI") and a fee estimate. It's a pattern for trading from any page without leaving it.

### Inferences
- Taking Kraken's on-chart "Preview" order line together with Axiom's draggable "Limit Order Target" line suggests one primitive: a draggable price line, labeled and colored by order type, that updates the order form two-way.
- Gemini's "trigger once and then pause" wording and Kraken's draw-on-chart target are directly reusable for MC-based alerts ("alert when MC crosses $X").
- OpenSea's chord shortcuts (G+key to navigate, T+key to toggle) can sit alongside Axiom's Space+key trade hotkeys without conflicts.

### Gaps
- No Mobbin examples were found of crypto order-confirmation states that show a Solana tx signature or explorer link, or of a "pending → confirmed → failed" toast with retry. Phantom's opening/opened toast pair is the closest.

## Charting: TradingView Lightweight Charts vs Advanced Charts vs alternatives

### Takeaway
Use **TradingView Lightweight Charts v5 (Apache-2.0)** for an open-source, self-hosted React terminal. It takes your own OHLCV directly, and it has v5 multi-pane support, a markers plugin (`createSeriesMarkers`), price lines (`createPriceLine`, for an average-entry line), custom price formatters (for market-cap axes) and an official plugin/primitives system with example drawing tools. Its gaps are no built-in indicators and only basic example drawing tools, so both need building or porting.

**KLineChart (Apache-2.0)** is the runner-up if built-in drawing tools and indicators matter more: it has 16 built-in overlays, including fibonacci, channels and price lines.

**TradingView Advanced Charts**, which Axiom uses, does not fit a public open-source or self-hosted project. It is proprietary, distributed by request through a private repository, licensed "only… to companies for use in public web projects", and explicitly not available "for personal use, hobbies, studies, or testing".

Highcharts Stock and SciChart.js are commercial.

### Cited Findings
- **Lightweight Charts licensing:** "Apache License, Version 2.0". The attribution requirement is to "Add the 'attribution notice' from the NOTICE file and a link to https://www.tradingview.com/" on a page available to users. The library provides an `attributionLogo` chart option for that link. — [GitHub: tradingview/lightweight-charts](https://github.com/tradingview/lightweight-charts)
- **Version and features:**
  - Latest listed release is 5.2.1 (accessibility plugin, hover performance work). 5.2.0 added `hoveredSeriesOnTop` and series hit-testing. 5.1.0 added "Data Conflation… merges data points when zoomed out". 5.0.9 added a `base` price-format option "to avoid floating-point precision issues" and an `autoScale` option for markers.
  - 5.0.0 brought "Full support for multiple panes within a single chart", reimplemented "Watermark and Series Markers… as plugins", and cut the bundle "by up to 16%" to 35kB. — [LWC release notes](https://tradingview.github.io/lightweight-charts/docs/release-notes)
  - Bundle size conflict: TradingView's comparison page says "45 KB in size", while the release notes say 35kB. — [TradingView product comparison](https://www.tradingview.com/charting-library-docs/latest/product-comparison)
- **Data and indicators:** Lightweight Charts "does not contain any built-in indicators", and users "provide data directly to the library". — [TradingView product comparison](https://www.tradingview.com/charting-library-docs/latest/product-comparison)
- **Markers:** `createSeriesMarkers(series, markers?, options?)` returns a markers plugin API with `setMarkers()` and `markers()`. Markers have time, color, position (for example `'inBar'`) and shape (for example `'arrowDown'`). — [LWC docs: createSeriesMarkers](https://tradingview.github.io/lightweight-charts/docs/api/functions/createSeriesMarkers)
- **Price lines:** `createPriceLine` takes price, color, lineWidth, lineStyle, `axisLabelVisible` and `title` (the docs example uses title 'P/L 500'), and `removePriceLine` removes it. No `draggable` option is documented. `update()` "adds new data item… (or updates the latest item…)", which suits streaming candles. — [LWC docs: ISeriesApi](https://tradingview.github.io/lightweight-charts/docs/api/interfaces/ISeriesApi)
- **Custom price format:** `PriceFormatCustom` has `type: "custom"`, a `formatter` ("Override price formatting behaviour"), a `tickmarksFormatter`, `minMove` and `base`. — [LWC docs: PriceFormatCustom](https://tradingview.github.io/lightweight-charts/docs/api/interfaces/PriceFormatCustom)
- **Official plugin examples:**
  - Custom series: Rounded Candle, Stacked Area/Bars, Heatmap, HLC Area and others.
  - Primitives:
    - Drawing tools: "Rectangle Drawing Tool", "Trend Line" and "Vertical Line".
    - Price lines and alerts: "User Defined Price Lines", "Partial Price Line", "User Price Alerts" via a crosshair menu, and "Expiring Price Alerts".
    - Analysis: "Bands Indicator" and "Volume Profile".
    - Tooltips and labels: "Tooltip", "Delta Tooltip" and "Anchored Text".
    - Other: "Session Highlighting", "Image Watermark" and Accessibility.
  - Distribution is either `@tradingview/lwc-plugin-*` npm packages or copy-paste examples. — [LWC plugin examples](https://tradingview.github.io/lightweight-charts/plugin-examples/)
- **Advanced Charts terms:** it is "Proprietary", priced "Free*", and "Free with TradingView logo". It is obtained by request ("not available for download without approval"). "At this time, we don't provide the Advanced Charts and the Trading Platform libraries for personal use, hobbies, studies, or testing." "These licenses are only available to companies for use in public web projects and/or applications." Lightweight Charts is listed as Apache 2.0, free and open source. — [TradingView: Compare libraries](https://www.tradingview.com/free-charting-libraries/)
- **Advanced Charts features:** "110+ smart drawing tools", "100+ technical indicators" and "13 chart types". — [TradingView Advanced Charts](https://www.tradingview.com/advanced-charts/). Its data model is "you pass data in response to the library's request", and its API includes `createOrderLine` and `createShape`. — [TradingView product comparison](https://www.tradingview.com/charting-library-docs/latest/product-comparison)
- **Advanced Charts distribution:** the official integration examples (React, Next.js, Vue, Nuxt, Angular, React Native, SvelteKit, iOS/Android WebView…) "would obviously require a granted access to the library". The examples repo itself is MIT-licensed. — [GitHub: charting-library-examples](https://github.com/tradingview/charting-library-examples). The library's GitHub Issues sit in a private/restricted repo. — [TradingView getting started (moved page)](https://www.tradingview.com/charting-library-docs/latest/getting_started/)
- **Axiom's chart is TradingView-based.** The docs cite the TradingView partnership ([Axiom docs: TradingView](https://docs.axiom.trade/tradingview)), and the Axiom chart screenshot shows the TradingView left drawing toolbar, the "Indicators" menu, layout "Save" and the TradingView logo, plus custom "USD/SOL" and "MarketCap/Price" toggles ([Axiom docs: Limit Orders](https://docs.axiom.trade/axiom/swap/limit-orders)). OpenSea's token page also credits "Powered by CoinGecko API and TradingView" ([OpenSea screen](https://mobbin.com/screens/3e759970-e844-4ccc-84b9-0cc8afb52173)).
- **KLineChart:** "Apache License V2", 4.2k stars, "Zero dependencies, only 40k under gzip compression", TypeScript definitions and mobile support. It has built-in indicators and "multiple line drawing models", and "KLineChart Pro" is built on top of it. — [GitHub: klinecharts/KLineChart](https://github.com/klinecharts/KLineChart). The built-in overlays are horizontalRayLine, horizontalSegment, horizontalStraightLine, verticalRayLine, verticalSegment, verticalStraightLine, rayLine, segment, straightLine, priceLine, priceChannelLine, parallelStraightLine, fibonacciLine, brush, simpleAnnotation and simpleTag. Custom overlays go through `registerOverlay` and are used via `createOverlay` / `overrideOverlay` / `removeOverlay`. — [KLineChart overlay guide](https://klinecharts.com/en-US/guide/overlay)
- **Highcharts (incl. Stock):** proprietary ("All Software is the property of Highsoft"). "any use of the Software on a Public Website requires the purchase of a SaaS License". Licensees may download and modify the source. Non-commercial use falls under "separate terms". — [Highcharts license](https://shop.highcharts.com/license)
- **SciChart.js:** "commercial software with a FREE Community Edition". Community use covers academic use, non-profits, bloggers/course-writers and commercial trials "for a reasonable time period". Commercial applications need a paid license. — [GitHub: SciChart.JS.Examples](https://github.com/ABTSoftware/SciChart.JS.Examples)

### Requirement fit (from the findings above; "n/v" = not verified in this research)
| Requirement | Lightweight Charts v5 | Advanced Charts | KLineChart | Highcharts Stock | SciChart.js |
|---|---|---|---|---|---|
| Candles from our own trade data | Yes: data supplied directly, `update()` for streaming | Yes: datafeed answers library requests | n/v (generic lib) | n/v | n/v |
| Market-cap mode | Yes: transform OHLC by supply and/or custom `formatter` | Yes in practice (Axiom ships a MarketCap/Price toggle) | n/v | n/v | n/v |
| Trade markers (own/dev/tracked wallets) | Yes: `createSeriesMarkers`, plus custom primitives for avatar bubbles | Yes: `createShape` / annotations | Yes: `simpleAnnotation`/`simpleTag` overlays | n/v | n/v |
| Average-entry price line | Yes: `createPriceLine` with title and axis label | Yes: `createOrderLine` | Yes: `priceLine` overlay | n/v | n/v |
| Drawing tools | Examples only (trend line, rectangle, vertical line); the rest must be built | 110+ | 16 built-in overlays incl. fib and channels | n/v | n/v |
| Indicators | None built in (bands/volume-profile examples) | 100+ | Built-in (list n/v) | n/v | n/v |
| License for a public OSS repo | Apache-2.0 + attribution | Proprietary, company-only, request access | Apache-2.0 | Proprietary (SaaS license for public sites) | Commercial (community edition limited) |

### Inferences
- **Can Advanced Charts be committed to a public GitHub repo?** Almost certainly not. It is proprietary, handed out only after approval through a private repository, and licensed to companies for their own public projects. The pages I fetched don't explicitly say "no public repos", but publishing the library files would redistribute proprietary code to people who don't hold a license.
  - A self-hosted OSS terminal also clashes with the "no personal use" rule: individual self-hosters can't get a license.
  - The only workable pattern is an optional adapter that loads a licensed copy the deploying company supplies, git-ignored and never committed. Treat that as an unverified compliance assumption until TradingView's license text is reviewed.
- **Market-cap mode in Lightweight Charts.** Precompute MC candles (price × circulating supply, or × total supply for pump-style tokens) as a second dataset and swap series data when the user toggles. Use a custom `formatter` for K/M/B axis labels and subscript-zero formatting for tiny prices. USD/SOL works the same way, through a quote-conversion series.
- **Wallet markers.** Use `createSeriesMarkers` for simple arrows and text (B/S, "DEV", the tracked wallet's emoji), and a custom primitive for avatar bubbles like Axiom's. Marker density should come from the Trades table filters (own / dev / tracked / all).
- **Draggable limit and alert lines.** Lightweight Charts documents no draggable price line, so implement it as a primitive with pointer handling. The official "User Defined Price Lines" and "User Price Alerts" examples are a starting point.
- **Indicators.** Compute MA/EMA/VWAP/RSI in a worker (or with a technical-indicators library) and render them as line/histogram series in v5 panes. A full TradingView-grade drawing toolset is the biggest effort gap compared with Axiom.

### Gaps
- I couldn't retrieve TradingView's actual Advanced Charts license agreement text, so the public-repo prohibition is inferred rather than quoted.
- SciChart's licensing pages returned HTTP 403, so its feature set (candles, annotations, indicators) and current pricing are unverified.
- KLineChart's built-in indicator list and latest version number weren't captured.
- The Lightweight Charts 5.2.1 release date wasn't shown.
- TradingView's own pages conflict on Lightweight Charts' bundle size (35 kB vs 45 KB).

## Implications for the build

### Takeaway
Build a dense, dark, desktop-first terminal shaped like Axiom: Pulse board, token page, floating Instant Trade, floating trackers, and portfolio. Borrow interaction details from Coinbase Advanced, Kraken Pro, Phantom and OKX, and chart with Lightweight Charts v5 plus custom primitives. Keep TradingView Advanced Charts out of the repository.

### Cited Findings
- Axiom's core surfaces and their contents are documented in the sections above: [Pulse](https://docs.axiom.trade/axiom/finding-tokens/pulse), [Market/trade panel](https://docs.axiom.trade/axiom/swap/market), [Instant Trade](https://docs.axiom.trade/axiom/swap/instant-trade), [Limit Orders/chart](https://docs.axiom.trade/axiom/swap/limit-orders), [Portfolio](https://docs.axiom.trade/axiom/portfolio), [Wallet tracking](https://docs.axiom.trade/wallet-tracking/adding-wallets), [Tweet Monitor](https://docs.axiom.trade/tweet-monitor), [Trader Scan](https://docs.axiom.trade/trader-scan), [Multi-wallet](https://docs.axiom.trade/multi-wallet) and [Signup](https://docs.axiom.trade/getting-started/signup).
- Licensing basis for the chart choice: Lightweight Charts is Apache-2.0 with attribution ([GitHub](https://github.com/tradingview/lightweight-charts)). Advanced Charts is proprietary and company-only, with no personal use ([TradingView](https://www.tradingview.com/free-charting-libraries/)).

### Inferences
**Screens to build (desktop web first; a mobile PWA layout second):**
1. **Global shell.**
   - Top bar: logo, Discover/Pulse/Trackers/Portfolio/Rewards; a ⌘K or "/" search for name, ticker or CA; a Quick Buy amount plus P1/P2/P3; a wallet selector with SOL balance; Deposit; a network/MEV status chip; settings.
   - Bottom status bar: connection status, wallet-tracker and X-tracker toggles at the bottom left (as in Axiom), and a ticker tape.
2. **Pulse.**
   - Three resizable columns (New Pairs / Final Stretch / Migrated), each with its own filter button, a 14-metric min/max filter modal with a live result count and saved presets, and a display-settings popover (field toggles, card size, quick-buy size).
   - Pause the stream on hover, hover previews for tweets, and a per-card quick-buy pill.
3. **Explore/Trending and Watchlist** (timeframe selector, Dex Paid filter, star).
4. **Token page.**
   - Header strip: avatar, ticker/name/CA copy, age, socials, MC headline, price, liquidity, supply, star.
   - Chart: timeframes from 1s, Indicators, USD/SOL and MC/Price toggles, wallet markers, a draggable limit/alert line, and an average-entry line.
   - Right rail: Buy/Sell; Market/Limit/Advanced; amount, editable presets, and a settings summary (slippage, priority, tip, MEV); a position strip.
   - Bottom tabs: Trades (YOU/dev/tracked tags and Trader Scan popover), Holders (inline % bars, holder-type segments), Positions, Orders. These tables aren't shown in Axiom's docs, so design them from the Uniswap, OpenSea and Kraken patterns.
5. **Instant Trade floating window:** draggable and poppable, with P1–P3, a wallet multi-select, four buy amounts, four sell %s (with a % ⇄ SOL toggle), per-side settings rows, "Sell initials", and Space+key hotkeys.
6. **Trackers:**
   - Wallet Manager: table, emoji/name/address, alerts bell, import/export (including BullX-style lists).
   - Live Trades feed with quick-buy.
   - Twitter Alerts feed plus Customize Feed (handles × Tweets / Profile updates / Follows toggles).
7. **Portfolio:**
   - Balance, PnL chart, performance buckets, Active Positions/History, Activity with explorer links, "search other wallets", and 7d/30d/Max.
   - PnL share card (template carousel, $/% toggle, QR/brand, copy/download image).
8. **Wallets:** create/import (12/24-word or private key), label, archive, and distribute SOL between wallets by drag-and-drop. Deposit (QR, address, copy, network note), Withdraw (stepper and confirm modal), Convert SOL⇄USDC.
9. **Alerts:** price/MC alert drawer (crosses value, ±% chips, once vs repeating, channels) and a notification center.
10. **Settings:** trade presets (slippage, priority fee, tip, MEV mode), hotkeys, display/theme, RPC/endpoint (self-hosted), security/export keys, and a keyboard-shortcut sheet.
11. **Onboarding:** an operator-configurable auth step (self-hosted: local passphrase or wallet connect), create/import wallet, recovery-phrase reveal and confirm, add funds.
12. **Rewards/Referrals:** optional for self-hosted deployments.
13. **Mobile PWA:** bottom tabs (Pulse, Search, Trade, Trackers, Portfolio), single-column Pulse with segmented New/Final/Migrated, and a token page with a sticky Buy/Sell bar.

**Components to create:**
- AppShell/TopBar/StatusBar; FloatingWindow (drag, dock, pop-out, persisted layout).
- Token display: TokenAvatar (launchpad badge plus progress ring), TokenCard (3-line Pulse card), MetricChip (icon, value, threshold color, tooltip), SocialLinks, QuickBuyButton.
- Trade controls: PresetSwitcher (P1–P3), AmountPresetGroup (editable), TradeSettingsSummary plus TradeSettingsModal, BuySellPanel, PositionStrip, InstantTradeWindow.
- Chart: ChartPanel (Lightweight Charts wrapper, plus primitives for wallet-avatar markers, a draggable order line and alert lines).
- Tables: VirtualizedTable, the base for TradesTable, HoldersTable, PositionsTable, OrdersTable and ActivityTable. Also TraderScanPopover.
- Discovery: FilterModal (range inputs, presets, live count), DisplaySettingsPopover, SearchPalette (CA paste, history, Esc).
- Trackers: WalletManager, AddWalletModal (emoji picker), LiveTradesFeed, TweetCard, TweetPreviewPopover, HandlesTable.
- Portfolio: PortfolioSummary, PnLChart, PerformanceBuckets, PnLShareCard (image export).
- Funding and alerts: DepositModal, WithdrawStepper, ConvertModal, AlertDrawer.
- Feedback and keyboard: ToastSystem (pending/confirmed/failed, with an explorer link), HotkeyManager, ShortcutSheet.
- Formatters: K/M/B, subscript-zero prices, relative ages ("25s/4d/11mo"), and safe PnL% (no "+Infinity%").

**Charting recommendation.** Use Lightweight Charts v5 (Apache-2.0).
- It meets the core requirements natively: own-data candles, markers, price lines, panes and custom formatters for MC mode.
- Build drawing tools and indicators as plugins, starting from the official examples. Alternatively, evaluate KLineChart (also Apache-2.0) if out-of-the-box drawing tools outweigh the TradingView-like look and ecosystem.
- Comply with Apache-2.0: keep the NOTICE file, show TradingView attribution with a link (the `attributionLogo` option), and do not remove notices.
- Do not vendor TradingView Advanced Charts. At most, provide an optional, git-ignored adapter for operators who hold their own company license.

### Gaps
- Axiom's live October 2026 UI (filter and display modals, token-page tables, settings, PnL card) is unverified and needs a hands-on review by someone with an account.
- Advanced Charts' exact license wording on public repositories, and SciChart's terms and features, still need confirming if those options are reconsidered.
