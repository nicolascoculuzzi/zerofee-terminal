# Axiom (axiom.trade) feature inventory, as of October 2026

Compiled 2026-10-03 from public material only. Nothing was logged into and no Axiom API was called.

**How much to trust each source.**
- **Official:** docs.axiom.trade and @AxiomExchange. The docs are thin and mostly date from Feb–Mar 2025. The sitemap shows which pages changed later: referral 2026-09-07, rewards 2026-06-12, staking 2026-01-08, multi-wallet 2025-09-03 ([sitemap](https://docs.axiom.trade/sitemap-pages.xml)).
- **@watchingmarkets ("Market Watcher"):** an Axiom affiliate (referral link axiom.trade/@mwatcher, [tweet](https://x.com/watchingmarkets/status/1905592261251137932)). He keeps one long reply-thread logging every Axiom release with screenshots, from Mar 2025 through Jul 30 2026. Feature names in it are reliable but terse.
- **apebrief.com:** task guides with screenshots verified 2026-09-23→27. This is the best source for current exact UI labels. It only describes what Axiom itself documents.
- **axiompedia.com:** independent guides dated Aug 2026.
- **axiompro.app, tradeonaxiom.com, axiomtradeapp.com:** affiliate/SEO sites. They contradict each other in places, so treat anything only they say as unverified.
- **Tweets:** texts were read through the public FxTwitter embed mirror (api.fxtwitter.com) and are cited by their canonical x.com URL. All dates are UTC.
- **Scope:** per the coordinator's scope change, perps get one line only.

## Discovery: how Pulse works (columns, filters, display, presets, sounds) and what other discovery surfaces exist

### Takeaway
Pulse is a live board with three columns: **New Pairs**, **Final Stretch** and **Migrated** (the docs say "Migrated to Raydium").
- **Column header:** each column has its own search box, quick-buy amount, **P1–P3** presets and **Filters** button.
- **Filters panel:** set per chain and per column. It has **Search Keywords** / **Exclude Keywords** plus five sub-tabs: **Protocols** (27 launchpads), **Quote Tokens**, **Audit**, **$ Metrics** and **Socials**. It supports import, export and share, three numbered filter presets, and **Apply All**.

Display customization grew in big waves through 2025: sound alerts, row and metric colors, decimals, "Ultra Glow", toasts, mega/ultra quick-buy buttons and hover cards. Pulse also got keyboard hotkeys in Jan 2026, plus PnL and mini charts on rows in mid-2026.

Other discovery surfaces:
- Discover/Explore (Trending with a time window, plus New Pairs) and the Watchlist
- Similar Tokens with "OG Mode"
- Pump Live
- Lighthouse market overview
- Surge algorithmic alerts
- Vision (KOL/insider wallet discovery)
- A global search that takes name, ticker, CA or wallet

### Cited Findings

**Columns and cards**
- The docs (Feb 2025) define three views. **New Pairs** shows newly created tokens. **Final Stretch** shows tokens "approaching 100% bonding curve completion". **Migrated to Raydium** lists graduated tokens, newest first. You "can Quick Buy on these tables by simply clicking on the lightning bolt" — [Axiom docs: Pulse](https://docs.axiom.trade/axiom/finding-tokens/pulse)
- In Sep 2026 the columns are labeled "New Pairs, Final Stretch and Migrated". Each column header has a search box, a quick-buy amount field, presets labeled **P1 to P3**, and a **Filters** button — [apebrief: new pairs](https://apebrief.com/axiom/new-pairs/); [apebrief: pulse](https://apebrief.com/axiom/pulse/)
- Card fields in Sep 2026:
  - **Age**, in formats like "0s, 1m, 2mo"
  - **MC** and **V** (market cap, volume)
  - **F**: fees paid, in the chain's native coin
  - **TX**: transaction count
  - **NB**: net buy in dollars, on some rows only
  - A holder-percentage row: top 10, dev holding, snipers, insiders, bundle
  - Social handles
  — [apebrief: pulse](https://apebrief.com/axiom/pulse/)
- The Pulse header (Sep 2026) contains:
  - a **"Create a wallet group"** button
  - a **"Launch"** button
  - a **"Display"** menu
  - a settings button
  - a **"Buy delay on 0 of 8 chains"** counter
  - a chain button reading **"8 Chains"**, with toggles "Hide Solana, Hide Robinhood, Hide Arc, Hide BNB, Hide Ink, Hide HyperEVM, Hide Base, Hide Ethereum"
  — [apebrief: pulse](https://apebrief.com/axiom/pulse/)
- Graduation rules:
  - Axiom publishes no Final Stretch threshold.
  - pump.fun graduates when "there are no more real tokens left in the bonding curve" and migrates to PumpSwap with burnt LP.
  - Raydium LaunchLab graduates at a creator-defined quote threshold, into a CPMM pool.
  — [apebrief: new pairs](https://apebrief.com/axiom/new-pairs/)

**Filters (exact fields)**
- The docs list 14 filters: **Age (mins), Top 10 Holders %, Dev Holding %, Snipers %, Insiders %, Bundle %, Holders, Pro Traders, Liquidity ($), Volume ($), Market Cap ($), Txns, Num Buys, Num Sells** — [Axiom docs: Pulse](https://docs.axiom.trade/axiom/finding-tokens/pulse)
- Filters panel layout from Sep 2026 screenshots:
  - It opens from the column headers.
  - A row of chain icons sits across the top; "filters are set per chain separately".
  - One tab per column (New Pairs / Final Stretch / Migrated), each with a count badge.
  - **Search Keywords** and **Exclude Keywords** fields take comma-separated values (placeholder "keyword1, keyword2...").
  - Sub-tabs: **Protocols**, **Quote Tokens**, **Audit**, **$ Metrics**, **Socials**.
  - Footer: import, export and share icons; preset buttons **1, 2, 3**; a single **Apply All** button.
  — [apebrief: pulse filters](https://apebrief.com/axiom/pulse-filters/)
- **Protocols** (Sep 2026) is a tick list: **Pump, Mayhem, Bags, Bonk, Bonkers, Rise Rich, Stonkfun, Printr, Liquid, Surge, Soar, Moonshot**, with 15 more behind **"Show more"** and a **Select All** option. **Quote Tokens**: **SOL, USDC, USD1, STOCK, OTHER**, with **Unselect All**. **Socials**: **Twitter, Website, Dex Paid** checkboxes — [apebrief: pulse filters](https://apebrief.com/axiom/pulse-filters/)
- Field list from an Oct 2025 guide. Older than the Sep 2026 screenshots, but the most complete enumeration found:
  - **Audits:** Dex Paid, **CA ends in Pump**, Age, Top 10 Holders %, Dev Holding %, Snipers %, Insiders %, Bundle %, Holders, Pro Traders, **Dev Migrations**, **Dev Pairs Created**
  - **Metrics:** Liquidity, Volume, Market Cap, **Bonding Curve %**, **Global Fees Paid**, TXNs / Num Buys / Num Sells
  - **Socials:** **Twitter Reuses**, **Tweet Age**, **At Least One Social**
  - Example presets it suggests: New Pairs with Pump+Bonk only, Snipers ≤10%, Dev ≤10%, Vol ≥$500, MC ≥$5k, at least one social. Migrated with Top10 ≤40%, Global Fees Paid 1.5 SOL, Min Pro Traders 3.
  — [Meme Coin Navigator, 2025-10-19](https://memecoinnavigator.com/best-axiom-trade-filters-for-new-pairs/); "At least one social: ON" also appears in [Meme Coin Navigator, 2026-01-12](https://memecoinnavigator.com/axiom-trade-beginners-guide/)
- The **Quote Token filter** shipped Sep 2025 — [Market Watcher 2025-09-28](https://x.com/watchingmarkets/status/1972234168064168357). The **Bonk Filter** shipped 2025-05-05 ([Market Watcher](https://x.com/watchingmarkets/status/1919380593793487201)) and the **Launch A Coin Filter** 2025-05-09 ([Market Watcher](https://x.com/watchingmarkets/status/1920727011670020565)).
- "Filters persist between sessions" — [axiompedia, 2026-08-25](https://axiompedia.com/guides/trading/axiom-pulse-filter-presets). **Pulse Import/Export** shipped 2025-06-20 — [@AxiomExchange](https://x.com/AxiomExchange/status/1936076070547034148)
- Only **Bundle %** has a published method: "4+ transactions in the same block", then wallets lacking consistent bundling patterns are filtered out. Snipers, Insiders, Dev and Pro Traders methods are not published — [Axiom FAQ](https://docs.axiom.trade/faqs); [apebrief: token metrics](https://apebrief.com/axiom/token-metrics/); [axiompedia glossary](https://axiompedia.com/guides/trading/axiom-pulse-glossary)

**Blacklists, signals and hover cards on Pulse**
- Blacklists:
  - **Master Pulse Blacklist** (2025-05-05) — [@AxiomExchange](https://x.com/AxiomExchange/status/1919421841447247906)
  - **Pulse Quick Dev Blacklist** (2025-06-20) — [@AxiomExchange](https://x.com/AxiomExchange/status/1936076070547034148)
  - **Blacklist Twitter Accounts** (2025-10-05) — [Market Watcher](https://x.com/watchingmarkets/status/1974763956179976368)
  - **Blacklist Funding Wallet** (2026-06-28) — [Market Watcher](https://x.com/watchingmarkets/status/2071141751679504869)
- Hovers and metrics:
  - **Pulse Bubblemaps / Dev Funding / KOL Hovers** (2025-07-08) — [@AxiomExchange](https://x.com/AxiomExchange/status/1942592760915321133)
  - **Pulse KoL Metric** — [Market Watcher](https://x.com/watchingmarkets/status/1942498862100340828)
  - **Large token hover** (2025-05-13) — [Market Watcher](https://x.com/watchingmarkets/status/1922208646093562065)
  - **Twitter Communities Hover**, **Pump Livestream Tokens**, **Migration Bubble** (2025-06-04) — [@AxiomExchange](https://x.com/AxiomExchange/status/1930313033345044506)
- Sep 2025 detection signals:
  - **Reused Image Tokens** — [Market Watcher](https://x.com/watchingmarkets/status/1972233851742433473)
  - **Fresh Wallets**, **Shared Wallets**, **Daos fun** — [Market Watcher](https://x.com/watchingmarkets/status/1972234168064168357)
  - **Tracked Developers**, **Search Developer**, **Pump fun Offchain Indicator** — [Market Watcher](https://x.com/watchingmarkets/status/1972234373752852507)
- 2026 additions:
  - **Pulse Twitter Handle and Stats**: "See Twitter handles and stats directly on Pulse!" (2026-01-09) — [Market Watcher](https://x.com/watchingmarkets/status/2009726736385065418)
  - **PnL on Pulse** and **Quick Hover Price Charts** (2026-06-30) — [Market Watcher](https://x.com/watchingmarkets/status/2071879061207490561)
  - **Pulse Mini Charts** (2026-07-03) — [Market Watcher](https://x.com/watchingmarkets/status/2072992003944489279)
  - **Pulse Tracker** (2025-07-08) is listed without a description — [@AxiomExchange](https://x.com/AxiomExchange/status/1942592760915321133)

**Display and customization**
- **Mega Quick Buy Buttons** and **Customize Tables** (2025-05-09) — [Market Watcher](https://x.com/watchingmarkets/status/1920727011670020565)
- 2025-06-04 release: **Custom Themes**, **Pulse Sound Alerts, Separate Quick Buys, ULTRA button**, and **Change Chart Font Size** — [@AxiomExchange](https://x.com/AxiomExchange/status/1930313033345044506). Market Watcher's itemization: "Separate Pulse Quickbuys" and "Pulse Sound Alerts" — [Market Watcher](https://x.com/watchingmarkets/status/1930181628321526050); "Ultra Quickbuy Button" and "Chart Text Scale" — [Market Watcher](https://x.com/watchingmarkets/status/1930182301784187171)
- "Tons of New Pulse Display Settings" (2025-07-29) — [@AxiomExchange](https://x.com/AxiomExchange/status/1950234718437298673). Itemized as:
  - **Advanced Toast, Toast Position, Pulse Extra Settings, Pulse Row Colors** — [Market Watcher](https://x.com/watchingmarkets/status/1950468423001034861)
  - **Pulse Metric Colors, Ultra Glow, Pulse Metric Decimals, Migration Line** — [Market Watcher](https://x.com/watchingmarkets/status/1950468632892375260)
- **Buy Amount Display Customization** (2025-09-28) — [Market Watcher](https://x.com/watchingmarkets/status/1972233851742433473). **Second Quick Buy on Specific Tables** (2025-11-01) — [Market Watcher](https://x.com/watchingmarkets/status/1984535183153119521)
- **Pulse Hotkeys**: "Snipe new pairs with your keyboard on Pulse and customize your keybinds" (2026-01-02) — [Market Watcher](https://x.com/watchingmarkets/status/2006975141029503203)
- Guides (Jan 2026) describe the display settings in the top-right as determining "the information you will see about a coin on Pulse". A separate **Appearance** button adjusts colors and sizes — [Meme Coin Navigator](https://memecoinnavigator.com/axiom-trade-beginners-guide/)
- The workspace is modular:
  - The X feed can be placed "wherever you want on your trading interface as a building block" — [Market Watcher 2025-04-24](https://x.com/watchingmarkets/status/1915362636381749648)
  - Panels are draggable floating windows — [PANews/Biteye guide, 2025](https://panews.io/articles/4qhagi68)
  - You can pin trending coins on the left and X/Truth alerts on the right — [Market Watcher 2025-10-09](https://x.com/watchingmarkets/status/1976246643692331017)

**Other discovery surfaces**
- **Explore/Discover:**
  - Two areas: **New Pairs** and **Trending**. Trending "ranks tokens based on trading activity over a selected time period".
  - Filters: **Dex Paid, Top 10 Holders %, Liquidity ($), Volume ($), Market Cap ($), Txns, Search**.
  - **Watchlist**: a star icon beside tokens, plus a star button top-right to view the list.
  — [Axiom docs: Explore Tokens](https://docs.axiom.trade/axiom/finding-tokens/explore-tokens)
- **New Algorithmic Trending Page** (2025-06-20) — [@AxiomExchange](https://x.com/AxiomExchange/status/1936076070547034148). **Trending Page Graph and Algorithm** (2025-07-08) — [Market Watcher](https://x.com/watchingmarkets/status/1942498868400382436). A 2026 guide describes Discover as "New Pairs and Trending, with a time window you can set and filters for age, liquidity, holder concentration" — [axiompro.app](https://axiompro.app/terminal/)
- **Similar Tokens → OG Mode**: "designed to surface the oldest tokens with the highest market caps" (Mar 2025) — [Axiom docs: Similar Tokens](https://docs.axiom.trade/axiom/finding-tokens/similar-tokens)
- **Pump Live:** **Sort Pump Live** (2025-06-20) — [Market Watcher](https://x.com/watchingmarkets/status/1935961712269680776); **Revamped Pump Live** (2025-09-28) — [Market Watcher](https://x.com/watchingmarkets/status/1972233851742433473)
- **Lighthouse Market Overview** (2025-06-04) — [@AxiomExchange](https://x.com/AxiomExchange/status/1930313033345044506)
- **Surge**, "Best Algorithmic Alerts in the Market" (2025-07-08) — [@AxiomExchange](https://x.com/AxiomExchange/status/1942592760915321133). Described as algorithmic alerts "aimed at coins that are starting to move" — [axiompro.app](https://axiompro.app/ai-trading/). Not to be confused with the **Surge launchpad** (2026-01-27) — [Market Watcher](https://x.com/watchingmarkets/status/2016116072886235352)
- **Vision**, "discover KOL and insider wallets!" (2025-07-29) — [@AxiomExchange](https://x.com/AxiomExchange/status/1950234718437298673). It sits under **Trackers** and shows wallets as trader cards with pop-up alerts — [axiompro.app terminal](https://axiompro.app/terminal/); [axiompro.app copy-trade](https://axiompro.app/copy-trade/)
- **Search:**
  - The header search accepts "name, ticker, CA, or wallet" — [apebrief](https://apebrief.com/axiom/open-dexscreener-pair/)
  - **Search Quick buy** (2025-06-20) — [@AxiomExchange](https://x.com/AxiomExchange/status/1936076070547034148)
  - **Search Developer** (2025-09) — see above
  - **Upgraded Search Filters** (2026-04-25) — [Market Watcher](https://x.com/watchingmarkets/status/2047947279168946224)
- **Watchlist bar:** it can switch with an active-positions bar (2025-05-14) — [Market Watcher](https://x.com/watchingmarkets/status/1922695956409020684). **Watchlist Quick Buy** (2025-07-29) — [@AxiomExchange](https://x.com/AxiomExchange/status/1950234718437298673)
- **Top navigation:**
  - 2026: **Discover, Pulse, Trackers, Perpetuals, Predictions, Rewards, Portfolio** — [axiompro.app](https://axiompro.app/terminal/)
  - Earlier: Pulse, Discover, Perpetuals, Yield, Portfolio, Rewards — [axiompedia](https://axiompedia.com/guides/getting-started/how-to-trade-on-axiom)
- **No AI decision-making:** "Nothing in Axiom's documentation describes an AI that decides what to buy". The algorithmic tools (Surge, Vision, Trending, bundle detection, recommended fees) are decision support — [axiompro.app](https://axiompro.app/ai-trading/)

### Inferences
- Pulse filter state is clearly a structured, serializable object: per chain × per column × 3 preset slots, with import/export/share. Our build should define a versioned JSON schema and accept imports of Axiom-like exports (field names above).
- "Buy delay on N of 8 chains" looks like a per-chain safety delay or confirmation for Pulse quick-buys, to stop mis-clicks while rows shift. This is unconfirmed speculation. Axiom has no documented "pause on hover", so a pause-on-hover plus a buy-delay option is an easy UX win.
- Axiom's feature pace is weekly. Parity is a moving target, so prioritize the core loop (Pulse → token → one-click buy/sell → exits) over the long tail (Pump Live, Lighthouse, social profiles).

### Gaps
- The exact items, defaults and toggles in the current **Display** menu (compact vs expanded rows, column order, which metrics show) are not enumerated in any public source found. Only the release names above are known.
- No source documents pause-on-hover.
- Not found: the full current field list of the **Audit** and **$ Metrics** tabs (Sep 2026 screenshots didn't enumerate them; the Oct 2025 list is the best proxy), the purpose of the **"Launch"** button, the semantics of "Buy delay", Trending timeframe options, Surge's algorithm or thresholds, the contents of Lighthouse, and the function of "Pulse Tracker".

## Trading: buy/sell mechanics, Instant Trade, quick-buy, presets, MEV, order types, migration orders, multi-wallet, hotkeys

### Takeaway
- **Quick Buy:** trades fire from lightning-bolt buttons on Pulse, search and watchlist, or from the token page's **Instant Trade** panel.
- **Instant Trade:** preset buttons **P1/P2/P3** (with edit pencil), a wallet picker, four buy buttons (default 0.01 / 0.1 / 1 / 10 SOL), four sell-% buttons (10 / 25 / 50 / 100%), an **"Adv."** box and **"Sell Init."** (sell initials). There is no confirmation dialog.
- **Presets:** each holds buy and sell **SLIPPAGE** ("Max %"), **PRIORITY**, **BRIBE** and an **MEV** mode: **Off / Reduced / Secure**. Priority and bribe default to 0.001.
- **Speed modes:** "Turbo Mode" (Apr 2025), a "Fastest Submission Engine" (Jun 2025) and **"Katana Mode"** (Apr 2026, V2 Jun 2026), toggled beside the preset buttons at "0 extra fees".
- **Orders:** limit orders keyed to market cap or price, set by slider or a draggable chart line; TP/SL via an **"Advanced Trading Strategy"** toggle; migration buy/sell via "Sniper Buy/Sell".
- **Not documented:** DCA, trailing stops and auto copy-trading.

### Cited Findings

**Market order flow (docs, Feb 2025)**
- Steps: enter a CA or ticker, enter the SOL amount, click **"Buy [TOKEN NAME]"**.
- The panel tracks "amount of solana bought, amount of solana sold, amount of solana holding, and the amount you are up".
- Settings: **Priority Fee**, **Slippage**, **MEV Protection**. The required minimum bribe shows on a "hand-and-coin icon". MEV protection "applies only to buy transactions".
— [Axiom docs: Market](https://docs.axiom.trade/axiom/swap/market)

**Fee and MEV settings (docs updated 2025-07-21)**
- **Priority Fee** default **0.001**.
- **Slippage Limit** is a max %; "1000% permits 10x price variance".
- **MEV Protection** has three modes:
  - **Off**: no protection
  - **Reduced**: Jito routing, residual rogue-validator risk
  - **Secure**: "Our best form of MEV protection", whitelisted validators, potentially slower; Axiom "recommends using Secure mode whenever possible"
- **Bribe/Tip** default **0.001**.
- With MEV enabled, transactions route through Jito exclusively. With it disabled, they broadcast "to both Jito and standard block leaders".
- Axiom "automatically calculate[s] optimal bribe and priority fee combinations".
— [Axiom docs: Solana Fees](https://docs.axiom.trade/getting-started/fees/solana-fees)
- **MEV Modes** shipped 2025-05-20 — [Market Watcher](https://x.com/watchingmarkets/status/1924738360930717840)

**Settings panel labels (Sep 2026 screenshots)**
- It sits behind "the settings button in the top right". Fields read **SLIPPAGE** (a "Max %" field; the example shows 20%), **PRIORITY** and **BRIBE**. The screenshot caption references "Preset 1".
- apebrief's priority-fee page contradicts itself on the bribe default (0.01 in one place, 0.001 in another). The official docs say 0.001.
— [apebrief: slippage](https://apebrief.com/axiom/slippage/); [apebrief: priority fee](https://apebrief.com/axiom/priority-fee/)
- Axiom presets are "P1-P3 with buy/sell slippage, priority, bribe, and MEV protection box (no market-cap triggers documented)", unlike Photon's S1–S3 auto-buy/sell triggers — [apebrief: switch from Photon](https://apebrief.com/axiom/switch-from-photon/)
- Each of P1, P2, P3 "stores a priority fee, bribe, slippage, and MEV mode" — [tradeonaxiom](https://tradeonaxiom.com/axiom-trade-features/)
- Practitioner settings (opinion, not defaults): Priority 0.004 / Bribe 0.01 for active traders, 0.001/0.001 for small accounts, slippage 80% for buy and sell, MEV off below about 1.5 SOL — [Meme Coin Navigator, 2026-01-12](https://memecoinnavigator.com/axiom-trade-beginners-guide/)

**Instant Trade panel**
- Layout in Sep 2026, top to bottom:
  - preset buttons **P1, P2, P3** with an **edit pencil**
  - a **wallet picker**
  - a Buy row with four buttons (**0.01, 0.1, 1, 10** SOL)
  - a Sell row (**10%, 25%, 50%, 100%**)
  - a settings line under each row, plus an **"Adv."** box and **"Sell Init."**
- No confirmation step for clicks or hotkeys.
— [apebrief: instant trade](https://apebrief.com/axiom/instant-trade/)
- Apr 2025 description: a right-hand bar shows coin and position info, and there are "several presets" for different volatilities. Both "sell directly with SOL or as a percentage can be set for four options", and there is an "option to sell your initials with one click" — [Market Watcher 2025-04-07](https://x.com/watchingmarkets/status/1909263545595736484)
- Later Instant Trade additions:
  - **Split Supply on Instant Trade** (2025-05-05) — [@AxiomExchange](https://x.com/AxiomExchange/status/1919421841447247906)
  - **Instant Trade PNL** (2025-05-20) — [Market Watcher](https://x.com/watchingmarkets/status/1924738360930717840)
  - **Revamped Instant Trade** (2025-07-08) — [@AxiomExchange](https://x.com/AxiomExchange/status/1942592760915321133), which Market Watcher calls "Instant Trade Sidebar and Multi-Wallet Revamp" — [Market Watcher](https://x.com/watchingmarkets/status/1942498862100340828)
  - **Quick Sell Button** (2026-03-15) — [Market Watcher](https://x.com/watchingmarkets/status/2033105937695690990)

**Hotkeys**
- Docs (Mar 2025): "press 'Space' and the respective hotkey" for "Buy x Sol, Sell x%" — [Axiom docs: Instant Trade](https://docs.axiom.trade/axiom/swap/instant-trade)
- Sep 2026: enable via the keyboard-icon hotkey button "at the left of the P1 row", then "Hold Space and press the key" — [apebrief](https://apebrief.com/axiom/instant-trade/)
- **Pulse Hotkeys** with customizable keybinds (2026-01-02) — [Market Watcher](https://x.com/watchingmarkets/status/2006975141029503203). **Custom Twitter Hotkey** (2026-02-04) — [Market Watcher](https://x.com/watchingmarkets/status/2018989925052379292)

**Quick Buy family**
- Lightning bolt on Pulse — [docs](https://docs.axiom.trade/axiom/finding-tokens/pulse)
- **Mega Quick Buy Buttons** (2025-05-09) — [Market Watcher](https://x.com/watchingmarkets/status/1920727011670020565)
- **Separate Quick Buys** and **ULTRA button** (2025-06-04) — [@AxiomExchange](https://x.com/AxiomExchange/status/1930313033345044506)
- **Search Quick buy** (2025-06-20) — [@AxiomExchange](https://x.com/AxiomExchange/status/1936076070547034148)
- **Watchlist Quick Buy** (2025-07-29) — [@AxiomExchange](https://x.com/AxiomExchange/status/1950234718437298673)
- **Second Quick Buy on Specific Tables** (2025-11-01) — [Market Watcher](https://x.com/watchingmarkets/status/1984535183153119521)
- In Sep 2026 the Pulse quick-buy field is a lightning icon with a "0.0" placeholder and its own chain and currency picker — [apebrief: pulse filters](https://apebrief.com/axiom/pulse-filters/); [apebrief: switch chains](https://apebrief.com/axiom/switch-chains/)

**Execution speed modes**
- **Turbo Mode**, "Faster transactions" (2025-04-20) — [Market Watcher](https://x.com/watchingmarkets/status/1914015852267024457)
- **Fastest Submission Engine in the Market** (2025-06-20) — [@AxiomExchange](https://x.com/AxiomExchange/status/1936076070547034148)
- **Katana Mode** (2026-04-25) — [Market Watcher](https://x.com/watchingmarkets/status/2047947279168946224)
  - Promoted as "Speeds up your transactions… Optimized for better performance… 0 extra fees" — [affiliate tweet 2026-04-26](https://x.com/dan123/status/2048519421514133994)
  - "Katana mode can now be enabled using the button beside the preset buttons" — [Market Watcher, search snippet; tweet later unavailable](https://x.com/watchingmarkets/status/2047948553239019875)
  - **Katana Mode V2** (2026-06-30) — [Market Watcher](https://x.com/watchingmarkets/status/2071879061207490561)
- Chain-specific: **"Robinhood Express Lander – Axiom Exclusive"** (2026-07-23) — [Market Watcher](https://x.com/watchingmarkets/status/2080087396314689741)
- Execution claims: settlement within one block or less — [Coin Bureau, 2025-07-17](https://coinbureau.com/analysis/is-axiom-trade-legit)

**Limit orders**
- Docs: set via a "Slider bar in the trading menu" or by "Dragging and dropping the price line directly on the chart" — [Axiom docs: Limit Orders](https://docs.axiom.trade/axiom/swap/limit-orders)
- Sep 2026 UI:
  - a **"Limit"** tab
  - a slider labeled **"-100% to +100%"**
  - a draggable **"Limit Order Target"** line
  - an amount input
  - a button formatted like **"Buy @ 319M MC"**
  - a chart **MarketCap/Price** toggle
- Expiry is not documented.
— [apebrief: limit orders](https://apebrief.com/axiom/limit-orders/)
- **Meteora and Believe Limit Orders** (2025-05-20) — [Market Watcher](https://x.com/watchingmarkets/status/1924738360930717840). **Improved Limit Orders** (2026-03-30) — [Market Watcher](https://x.com/watchingmarkets/status/2038536291126509876)
- There is an undocumented per-account cap on open limit orders ("cancel an old one first") — [axiompedia troubleshooting](https://axiompedia.com/troubleshooting)

**TP/SL, the "Advanced Trading Strategy" (Oct 2025)**
- Flow on the token page:
  1. Toggle **Advanced Trading Strategy** ON (right side of the page).
  2. Click **Add**.
  3. **Stop-Loss (SL)**: % drawdown plus % of holdings to sell.
  4. **Take-Profit (TP)**: % above entry plus amount to sell.
  5. Click **Buy Coin**; the order executes "with your conditions attached".
- Users are advised to "clear leftover conditional[s]" before re-entering.
— [Meme Coin Navigator, 2025-10-26](https://memecoinnavigator.com/how-to-set-a-stop-loss-and-take-profit-on-axiom-pro/)
- Third-party descriptions call this "Auto-Strategies"/"Advanced Ordering" ("buy and place your limit orders in one click") and say spot TP/SL are limit sells above or below entry (unverified naming) — [axiomtradeapp, 2026-09-29](https://axiomtradeapp.com/limit-orders/)

**Migration orders**
- **Axiom Sniper Buy**: "Configure fees", then "click the snipe button".
- **Axiom Sniper Sell**: **Sell → Advanced → Migration**, then enter order details.
- Both use "Axiom's custom nodes".
— [Axiom docs: Migration Actions](https://docs.axiom.trade/axiom/swap/migration-actions)

**Multi-wallet trading**
- "Randomized trading with multiple wallets" (Apr 2025) — [Chinito](https://x.com/HeyChinito/status/1909807448942322124)
- **Higher Multiwallet Limit (25)** (2025-06-04) — [@AxiomExchange](https://x.com/AxiomExchange/status/1930313033345044506)
- **Advanced Multi-Wallet Settings** (2025-10-05) — [Market Watcher](https://x.com/watchingmarkets/status/1974763956179976368)
- **Wallet Groups** (2025-12-08) — [Market Watcher](https://x.com/watchingmarkets/status/1997974869892554887)
- A "Create a wallet group" button sits in the Pulse header (Sep 2026) — [apebrief](https://apebrief.com/axiom/pulse/)

**Quote currencies**
- **USDC Trading** (2026-02-16) — [Market Watcher](https://x.com/watchingmarkets/status/2023349703283241110)
- Pulse quote-token filter values: SOL/USDC/USD1/STOCK/OTHER — [apebrief](https://apebrief.com/axiom/pulse-filters/)

**Automation that does not exist (per docs)**
- No DCA, APIs or algorithmic portfolio management — [axiompro.app](https://axiompro.app/ai-trading/)
- Conflict: one review lists "DCA Orders" — [Pump Parade, 2026-04-09](https://blog.pumpparade.com/crypto-trading/axiom-review-2026-fees-features-verdict/). This is unverified and contradicted by the official docs, which never mention DCA.

### Inferences
- Katana/Turbo likely means parallel multi-path submission (Jito plus other landing services, staked connections). Axiom has published no mechanism, so the "0 extra fees" claim implies Axiom absorbs the extra landing cost. Self-hosted, we would pay these tips ourselves, so the UI should show real landing cost per path.
- Quick-buy sizes appear to come in tiers (regular / "Mega" / "ULTRA"). This is inferred from release names.
- "Sell Init." almost certainly sells the token amount whose current value equals the SOL originally invested ("take out initials"). Inferred from the Apr 2025 description.

### Gaps
- **Auto Fee / Max Fee** fields: no public source found confirming them. Treat as unknown.
- Also unknown: the default hotkey map, the contents of the "Adv." box, limit-order expiry and %-change triggers beyond the slider, the maximum number of TP/SL levels, trailing stop, dev-sell triggers, what "Improved Limit Orders" changed (2026-03-30), and how "Split Supply" distributes across wallets.

## Token page: chart, trades/holders/top traders, token info metrics, dev tokens, socials, similar tokens

### Takeaway
The token page pairs a TradingView chart with the Instant Trade panel on the right, and data tabs below (trades, holders, top traders, orderbook / Trader Scan).

**Chart (MarketCap/Price toggle):**
- Overlays: tracked-wallet icons, your average entry/exit, top holders' average entry/exit, migration market cap line, KOL/watched holding lines.
- "Bubbles" annotate events (DEX paid, migration, snipers, clusters) with hover tooltips.
- Clicking a candle filters the trades list.

**Token-info metrics (exact labels):** **Top 10 H., Dev H., Snipers H., Insiders, Bundlers, LP Burned, Holders, Pro Traders, Dex Paid**.
- Plus fresh/shared wallets, global fees paid (prio/bribe/fees), dev funding, Streamflow locks, communities, recent transfers.
- Bundle detection is the only metric with a published method.

### Cited Findings
- **Layout:** a TradingView chart "with trades, holders, top traders, and orderbook data" and an Instant Trade panel on the right — [axiompro.app terminal](https://axiompro.app/terminal/). TradingView partnership — [Axiom docs: TradingView](https://docs.axiom.trade/tradingview)
- **Chart controls:**
  - **MarketCap/Price** toggle (Sep 2026) — [apebrief: limit orders](https://apebrief.com/axiom/limit-orders/)
  - **Wide chart view** (2025-05-13) — [Market Watcher](https://x.com/watchingmarkets/status/1922208646093562065)
  - **Change Chart Font Size** (2025-06-04) — [@AxiomExchange](https://x.com/AxiomExchange/status/1930313033345044506)
  - **Click Candles to Filter Transactions** (2025-09-28) — [Market Watcher](https://x.com/watchingmarkets/status/1972233851742433473)
- **Chart lines:**
  - **Average Entry and Exit** (2025-06-04) — [Market Watcher](https://x.com/watchingmarkets/status/1930182301784187171)
  - **Top Holders Average Entry Exit Line** (2025-07-08) — [Market Watcher](https://x.com/watchingmarkets/status/1942498865355088328)
  - **Migration Market Cap Line** (2025-07-29) — [@AxiomExchange](https://x.com/AxiomExchange/status/1950234718437298673)
  - **Top KOL and Watched Holding Lines**: "See top tracked and KOL holding supply" (2026-01-08) — [Market Watcher](https://x.com/watchingmarkets/status/2009197498221633639)
- **Chart bubbles:**
  - **Migration Bubble** (2025-06-04) — [@AxiomExchange](https://x.com/AxiomExchange/status/1930313033345044506)
  - **DEX Paid Chart Bubbles** (2025-11-01) — [Market Watcher](https://x.com/watchingmarkets/status/1984535183153119521)
  - **Sniper Bubbles** (2026-03-15) — [Market Watcher](https://x.com/watchingmarkets/status/2033105937695690990)
  - **Chart Bubble Clusters** (2026-06-30) — [Market Watcher](https://x.com/watchingmarkets/status/2071879061207490561)
  - **Bubble Hover Tooltips** (2026-07-30) — [Market Watcher](https://x.com/watchingmarkets/status/2082905054596702538)
- **Tracked wallets on the chart:** tracked-wallet buys "show as alerts on charts" — [apebrief: wallet tracker](https://apebrief.com/axiom/wallet-tracker/). Each tracked wallet's icon "appears on graph" — [Meme Coin Navigator](https://memecoinnavigator.com/how-to-track-import-wallets-on-axiom-trade/)
- **Token info labels:**
  - **Top 10 H.**
  - **Dev H.**
  - **Snipers H.** ("may indicate bot activity")
  - **Insiders** (private sales/team)
  - **Bundlers**
  - **LP Burned**
  - **Holders**
  - **Pro Traders** (shown as "% of experienced traders" or "traders using other platforms")
  - **Dex Paid**
  — [apebrief: token metrics](https://apebrief.com/axiom/token-metrics/)
- **Dex Paid** means a paid DexScreener Enhanced Token Info profile (from $299). It does not verify safety. Related DexScreener purchases are CTO, Advertising and Boost — [apebrief: dex paid](https://apebrief.com/axiom/dex-paid/). Also **Dex Paid Tracker** (2026-01-19) — [Market Watcher](https://x.com/watchingmarkets/status/2013189527393759240)
- **Holders and Top Traders:**
  - **Instant Holders** (2025-04-15) — [Market Watcher](https://x.com/watchingmarkets/status/1912043264431075503)
  - **Holders/Top Traders Avg. Entry and Exit** (2025-06-04) — [@AxiomExchange](https://x.com/AxiomExchange/status/1930313033345044506)
  - **Revamped Holder Section** (2025-07-08) — [@AxiomExchange](https://x.com/AxiomExchange/status/1942592760915321133)
  - **Funding in Top Traders/Holders** (2025-07-29) — [@AxiomExchange](https://x.com/AxiomExchange/status/1950234718437298673)
  - A star icon in holder lists adds a wallet to the tracker — [Meme Coin Navigator](https://memecoinnavigator.com/how-to-track-import-wallets-on-axiom-trade/)
- **Trader Scan:**
  - "integrates into the orderbook interface"
  - per wallet: buy and sell amounts, current balance, realized PnL, holding duration
  - used to spot accumulators, sellers and short-term traders
  — [Axiom docs: Trader Scan](https://docs.axiom.trade/trader-scan)
- **Trades filters:** **Tracked Wallets Trades Filter** (2025-07-08) — [Market Watcher](https://x.com/watchingmarkets/status/1942498865355088328); click-candle filtering (above)
- **Dev intelligence:**
  - **Dev Funding** (2025-07-08) — [Market Watcher](https://x.com/watchingmarkets/status/1942498862100340828)
  - **Tracked Developers / Search Developer** (2025-09-28) — [Market Watcher](https://x.com/watchingmarkets/status/1972234373752852507)
  - **Dev token improvements** (2026-05-09) — [Market Watcher](https://x.com/watchingmarkets/status/2053020775410450730)
  - Filters **Dev Migrations / Dev Pairs Created** — [Meme Coin Navigator](https://memecoinnavigator.com/best-axiom-trade-filters-for-new-pairs/)
- **Other panels and indicators:**
  - **Global Fees Paid per Coin (Prio/Bribe/Fees)** (2025-06-04) — [@AxiomExchange](https://x.com/AxiomExchange/status/1930313033345044506)
  - **Twitter Affiliate Badge** and **DEXScreener Banner Hover** (2025-07-30) — [Market Watcher](https://x.com/watchingmarkets/status/1950468915655528941)
  - **Fresh Wallets / Shared Wallets** (2025-09-28) — [Market Watcher](https://x.com/watchingmarkets/status/1972234168064168357)
  - **Token PnL Tracker** (2025-10-05) — [Market Watcher](https://x.com/watchingmarkets/status/1974763956179976368)
  - **Streamflow Locks** (2026-01-23) — [Market Watcher](https://x.com/watchingmarkets/status/2014618117498905061)
  - **Reposcan Upgrade** (2026-02-08) — [Market Watcher](https://x.com/watchingmarkets/status/2020488283705242036)
  - **Recent transfers** and **Husher** (2026-05-09) — [Market Watcher](https://x.com/watchingmarkets/status/2053020775410450730)
  - **InsightX Atlas** (2026-05-22) — [Market Watcher](https://x.com/watchingmarkets/status/2057736928624046329)
  - **Token Communities** (2026-05-28) — [Market Watcher](https://x.com/watchingmarkets/status/2059913467516056042)
- **Bags-specific (Jan 2026):** "real time claims, a claims tracker (alpha tracker), and enhanced royalty information", plus double cashback on Bags tokens — [Market Watcher](https://x.com/watchingmarkets/status/2012843803023937660)
- **Social previews:**
  - **Twitter Preview Popup** "only works for tweets and not actual twitter handles" (Mar 2025) — [Axiom docs](https://docs.axiom.trade/twitter-preview-popup)
  - **Twitter Account Preview** (2025-05-20) — [Market Watcher](https://x.com/watchingmarkets/status/1924738360930717840)
  - **Insta, Truth, Youtube, TikTok Previews** (2025-05-05) — [@AxiomExchange](https://x.com/AxiomExchange/status/1919421841447247906)
  - **Facebook, Twitch, LinkedIn, Pinterest Tooltips** (2025-06-20) — [@AxiomExchange](https://x.com/AxiomExchange/status/1936076070547034148)
- **Bundle Checker** flags "4+ transactions in the same block" and filters out wallets lacking consistent bundling patterns — [Axiom FAQ](https://docs.axiom.trade/faqs)
- **PnL sharing:** create PnL cards via **"Share PnL" above the chart**. The page shows coins bought/sold, PnL and open positions (2025-04-02) — [Market Watcher](https://x.com/watchingmarkets/status/1907407815053840837)
- **Similar Tokens / OG Mode** (see Discovery) — [Axiom docs](https://docs.axiom.trade/axiom/finding-tokens/similar-tokens)

### Inferences
- The chart "bubble" system plus holder/KOL lines is Axiom's signature token-page UX. Replicating it needs an event-classification pipeline: dev buys/sells, sniper/bundle tags, DEX-paid timestamps, migrations, clusters. It also needs per-wallet cost-basis for the entry/exit lines.
- "Funding" (for holders, top traders and dev) implies Axiom traces each wallet's first SOL funder. The Jun 2026 "Blacklist Funding Wallet" feature builds on the same data.

### Gaps
- Exact bottom-tab names and order are not confirmed by any public source (e.g., "Trades / Positions / Orders / Holders / Top Traders / Dev Tokens").
- Also unconfirmed: whether there is a USD/SOL toggle; what the trade-size filters and "dev/you" trade filters look like; whether a CTO flag exists; what "Husher" and "Reposcan" do; how LP Burned, Pro Traders, Snipers and Insiders are computed.

## Trackers, alerts and notification channels, copy trading, portfolio and PnL

### Takeaway
**Wallet tracker:**
- Lives under **Trackers** and in the bottom bar, with three tabs: **Wallet Manager**, **Live Trades**, **Monitor**.
- Adds wallets by emoji/name/address, imports from BullX/GMGN, exports, and has a per-wallet bell.
- Limit raised from 500 to **10,000** wallets in Jul 2025. Live Trades has MC and protocol filters, plus wallet transfers (Jul 2026).

**X tracker** (**"Social"** button in the bottom bar):
- Tabs: My List / Top Tracked / Tracking, with a "+@" add button.
- Covers Truth Social. Tracks follows and profile/home-page changes; blacklists accounts; has a custom hotkey.
- Free above 5 SOL trading volume. Keyword/trend filters still "Coming Soon" as of Sep 2026.

**Alerts:**
- In-app toasts (with position setting), Pulse sound alerts, Surge.
- **Price alerts** that push to **Discord and Telegram** (Aug 2025).

**Copy trading:** no automatic copy trading as of Sep 2026. Copying is manual via alerts plus one-click buys.

**Portfolio/PnL:** rich. Cards (custom, multi-wallet, time-based, video), PnL calendar, PnL modal graph, fees-in-PnL, reset PnL on entry, a live PnL widget.

### Cited Findings

**Wallet tracker**
- Docs (Feb 2025): the tracker is "in the bottom left corner". Enter "an emoji, name, and wallet address, then select 'Add Wallet'"; get live notifications. An import feature transfers lists from platforms "like Bullx". You can track buys "in real time while looking at Pulse" — [Axiom docs: Adding Wallets](https://docs.axiom.trade/wallet-tracking/adding-wallets); [Axiom docs: Monitor Wallets](https://docs.axiom.trade/wallet-tracking/monitor-wallets)
- Trackers page (Oct 2025) has three sections:
  - **Wallet Manager**
  - **Live Trades** (real-time buys and sells)
  - **Monitor** ("how many tracked wallets are in a specific coin")
  Add Wallet takes an icon (shown on the chart), address and name. Paste lists from GMGN into **Import Wallets** — [Meme Coin Navigator, 2025-10-19](https://memecoinnavigator.com/how-to-track-import-wallets-on-axiom-trade/)
- Sep 2026: Wallet Manager shows **Import, Export and Add Wallet** buttons and an **Actions** column with a **bell icon** and delete per row. "Alerts when Axiom is closed" are not documented — [apebrief: wallet tracker](https://apebrief.com/axiom/wallet-tracker/)
- Limits: **500 Tracked Wallets** (2025-07-08) — [Market Watcher](https://x.com/watchingmarkets/status/1942498868400382436). **Wallet Tracker Revamp (10,000 wallet limit)** (2025-07-29) — [@AxiomExchange](https://x.com/AxiomExchange/status/1950234718437298673)
- Live Trades features:
  - **Smaller wallet tracker** (2025-05-13) — [Market Watcher](https://x.com/watchingmarkets/status/1922208646093562065)
  - **Protocols in Live Trades** (2025-06-04) — [Market Watcher](https://x.com/watchingmarkets/status/1930182711089500429)
  - **Live Trades MC Filter** (2025-06-20) — [Market Watcher](https://x.com/watchingmarkets/status/1935961712269680776)
  - **Wallet Tracker Transfers** (2026-07-03) — [Market Watcher](https://x.com/watchingmarkets/status/2072992003944489279)
- Live notifications fire when a tracked wallet buys, with one click to the coin; the tracker opens from the bottom bar (2025-04-24) — [Market Watcher](https://x.com/watchingmarkets/status/1915363591127027931)

**X/Twitter and social tracker**
- Docs (Mar 2025): **Tweet Monitor** is free with "at least 5 SOL in trading volume". **Custom Twitter Tracker**: add handles and customize notifications. Planned: filters "by specific accounts, keywords, and trends" — [Axiom docs: Tweet Monitor](https://docs.axiom.trade/tweet-monitor)
- Sep 2026 UI:
  - **"Social"** button (X logo) in the bottom bar
  - **"My List" → "Top Tracked"** (a ranked table of handles by supports count)
  - **"Add"**, or the blue **"+@"** button for unranked handles
  - added accounts appear under **"Tracking"**
  - keyword/trend monitoring marked **"Coming Soon"**
  — [apebrief: twitter tracker](https://apebrief.com/axiom/twitter-tracker/)
- **Truth Social Tracker** (2025-05-05) — [@AxiomExchange](https://x.com/AxiomExchange/status/1919421841447247906). X alerts "from any account, even Trump's Truth Social posts"; "track who follows whom or adjust any alert settings" (2025-10-09) — [Market Watcher](https://x.com/watchingmarkets/status/1976246643692331017)
- Tracking options (2025): tweet, "homepage" (profile) and follower monitoring, limited to the top 1,500 — [PANews/Biteye](https://panews.io/articles/4qhagi68)
- The feed is customizable and placeable as a "building block", with notifications, and you "can even boost them for more reach" (2025-04-24) — [Market Watcher](https://x.com/watchingmarkets/status/1915362636381749648)
- Also: **Blacklist Twitter Accounts** (2025-10-05) — [Market Watcher](https://x.com/watchingmarkets/status/1974763956179976368); **Custom Twitter Hotkey** (2026-02-04) — [Market Watcher](https://x.com/watchingmarkets/status/2018989925052379292)

**Alerts and notification channels**
- **Price Alerts**: "Set price alerts for tokens and integrate with Discord and Telegram to get notified when your alerts are triggered" (2025-08-23) — [Market Watcher](https://x.com/watchingmarkets/status/1959147280025473448)
- **Advanced Toasts + Position** (2025-07-29) — [@AxiomExchange](https://x.com/AxiomExchange/status/1950234718437298673), itemized as "Advanced Toast", "Toast Position" — [Market Watcher](https://x.com/watchingmarkets/status/1950468423001034861)
- **Pulse Sound Alerts** (2025-06-04) — [@AxiomExchange](https://x.com/AxiomExchange/status/1930313033345044506)
- **Surge** algorithmic alerts (2025-07-08) — [@AxiomExchange](https://x.com/AxiomExchange/status/1942592760915321133)

**Copy trading**
- None native:
  - "Nothing it describes copies a wallet's buys into yours" — [apebrief: wallet tracker](https://apebrief.com/axiom/wallet-tracker/)
  - Copying is manual via alerts plus Instant Trade — [axiompro.app copy-trade](https://axiompro.app/copy-trade/)
  - "Copy Trading: Absent" (2026-08-27) — [AXL comparison](https://www.axltoken.com/trading-bots/gmgn-vs-axiom/)
- Conflicting, unverified claims of copy-trade config ("buy size, spend cap, slippage, sell-copy toggle") appear on SEO sites — [tradeonaxiom](https://tradeonaxiom.com/axiom-trade-features/); [axiompro.app ai-trading](https://axiompro.app/ai-trading/)

**Portfolio**
- Docs (Feb 2025), Spot portfolio:
  - **Balance**: "total portfolio value, available balance, and unrealized PNL"
  - **PNL Chart**
  - **Performance Metrics**: PNL and txn counts by profitability ranges
  - **Active Positions**: entry, sold, remaining, PNL %
  - **Activity Feed**: token, amount, MC, age, Solscan link
  — [Axiom docs: Portfolio](https://docs.axiom.trade/axiom/portfolio)
- Wallet management lives in a **Portfolio → Wallets** tab (Sep 2026) — [apebrief: wallets](https://apebrief.com/axiom/wallets/)

**PnL features by date**
- **"Share PnL"** cards (2025-04-02) — [Market Watcher](https://x.com/watchingmarkets/status/1907407815053840837)
- Live PNL tracker widget with configurable colors and background (2025-04-09) — [Chinito](https://x.com/HeyChinito/status/1910007462528467223)
- Total daily PnL display (2025-04-09) — [Market Watcher](https://x.com/watchingmarkets/status/1909875615596994560)
- **New PnL Cards** (2025-04-15) — [Market Watcher](https://x.com/watchingmarkets/status/1912043264431075503)
- **Custom PNL Cards, Multiwallet PNL Cards** (2025-05-05) — [@AxiomExchange](https://x.com/AxiomExchange/status/1919421841447247906)
- **Time-based PNL Cards** (2025-05-05) — [Market Watcher](https://x.com/watchingmarkets/status/1919380586478567921)
- **Fees in PNL** (2025-06-04) — [@AxiomExchange](https://x.com/AxiomExchange/status/1930313033345044506)
- **PNL Calendar** (2025-06-20) — [@AxiomExchange](https://x.com/AxiomExchange/status/1936076070547034148)
- **PNL Modal Graph, Reset PNL on Entry (Share individual positions), PNL Calendar Revamp** (2025-07-08) — [@AxiomExchange](https://x.com/AxiomExchange/status/1942592760915321133)
- **Token PnL Tracker** (2025-10-05) — [Market Watcher](https://x.com/watchingmarkets/status/1974763956179976368)
- **Video PNLs** (2026-03-15) — [Market Watcher](https://x.com/watchingmarkets/status/2033105937695690990)
- **PnL on Pulse** (2026-06-30) — [Market Watcher](https://x.com/watchingmarkets/status/2071879061207490561)

**Social layer**
- "Trade with friends on Axiom / Create a social profile / User counts" (2025-12-22) — [Market Watcher](https://x.com/watchingmarkets/status/2003045582378836131). **Users Online**: "See how many other people are trading" (2026-02-04) — [Market Watcher](https://x.com/watchingmarkets/status/2018989925052379292)

### Inferences
- Axiom's tracker alerts are browser-session based. The only documented off-app channel is price alerts to Discord/Telegram. A server-side tracker with Telegram/Discord/webhook push for wallet buys, X posts and TP/SL fills would be a clear upgrade for a self-hosted build.
- Axiom never shipped auto copy-trading despite 10k-wallet tracking. Its absence may be deliberate (liability/UX), but it is a gap competitors such as GMGN exploit.

### Gaps
- No public source confirms deleted-tweet alerts, bio/display-name change alerts, reply/quote filtering, or the X data source Axiom uses.
- Also not found: the exact sound options, wallet-tracker import formats (JSON/CSV field names), per-wallet alert settings behind the bell, and whether Live Trades filters by buy/sell or size beyond MC.

## Perpetuals and yield/earn (briefly)

### Takeaway
Perps are out of scope (one line below). Yield started as a Marginfi lending integration ("Yield"/"Savings") in 2025. Axiom added its own liquid-staking token **axiSOL** on the Yield page in Dec 2025. Prediction markets launched in Jun 2026; the provider is unclear (Polymarket per SEO sites, Kalshi/DFlow per Kalshi).

### Cited Findings
- Perps (out of scope): a "Perpetuals" tab on Hyperliquid, USDC margin, up to 50x leverage, plus a 0.01% Axiom fee per transaction — [Axiom docs: Perps Deposit](https://docs.axiom.trade/perpetuals/deposit)
- **Marginfi yield:**
  - "up to 15% APY on your assets, with instant withdrawals" via Marginfi — [Axiom FAQ](https://docs.axiom.trade/faqs)
  - Observed 3.04% APY on USDC/SOL (2025) — [PANews/Biteye](https://panews.io/articles/4qhagi68)
  - A Marginfi account costs about 0.016 SOL to create (May 2025) — [CoinGecko Learn](https://www.coingecko.com/learn/what-is-axiom-exchange)
- **axiSOL (Axiom Staked SOL):**
  - Built on the Solana Stake Pool Program and uses Harmonic for higher rewards.
  - Validator "Axiom" `DqbRPQXbN8GDKWZkKiHnRjiSKPqE3rQaNgTPxdLGPDMK`. Direct stake is 0% commission ("100% of inflation and MEV rewards").
  - The LST charges "5% fee on earnings and 0.1% withdrawal fee". It "now secures over 400k SOL".
  — [Axiom docs: Staking](https://docs.axiom.trade/staking) (updated 2026-01-08)
  - Live on the **Yield page** 2025-12-02 — [Market Watcher](https://x.com/watchingmarkets/status/1995797934110114123)
- **Predictions:**
  - "Prediction Markets. Get paid to trade what happens next." (2026-06-12) — [@AxiomExchange](https://x.com/AxiomExchange/status/2065465775767331086)
  - **Major Predictions Update** (2026-06-28) — [Market Watcher](https://x.com/watchingmarkets/status/2071141751679504869)
  - SEO sites say it is a Polymarket-powered **Predictions** tab with a separate rewards dashboard and leaderboard — [axiompro.app](https://axiompro.app/exchange/); [axiompro.app predictions](https://axiompro.app/prediction-markets/)
  - Kalshi stated "@AxiomExchange is next" for tokenized Kalshi markets on Solana (2025-12-01) — [Kalshi](https://x.com/Kalshi/status/1995585557930672473). The provider is unresolved.

### Inferences
- Yield and predictions are peripheral to a memecoin terminal's core loop. axiSOL is mainly an Axiom revenue and loyalty product, and needs nothing replicated beyond an optional "stake idle SOL" link.

### Gaps
- Not found: the current (2026) lending provider and APYs, whether Marginfi is still used, and the prediction-market provider and fee.

## Wallet management: embedded wallet, keys, multiple wallets and groups, deposits/withdrawals, internal transfers, SOL↔USDC

### Takeaway
- **Embedded wallet:** non-custodial, on **Turnkey**. Login is by email (OTP + password), Google or Phantom, with "Additional Auth Methods" added Jul 2025.
- **Keys:** a seed phrase is shown at signup and retrievable in Settings (reportedly **Account and Security → Manage Wallets**, with a key icon that reveals a private key after password).
- **Multiple wallets:** up to 25 per account (Jun 2025), with labels, a switcher, a Wallets tab (add/import, **Source wallets → Destination → Start Transfer**, **Claim Rent**), and **Wallet Groups** (Dec 2025).
- **Privacy features:** Vanish private execution (Nov 2025), "Private funding and dust optimization" (Feb 2026), "Private Consolidation" (Jun 2026).
- **Funding:** an Exchange panel with tabs **Convert / Deposit / Buy**, per-chain deposit addresses, a Robinhood auto-bridge, and a card on-ramp.
- **Withdrawals:** sources conflict on whether a native external-send UI exists.

### Cited Findings
- **Turnkey:** "Axiom partners with Turnkey for wallet infrastructure"; the platform is "non-custodial" — [Axiom FAQ](https://docs.axiom.trade/faqs)
- **Signup:**
  - Methods: **Email** (one-time code), **Google**, **Phantom**.
  - Flow: password creation, then view seed phrase, then fund.
  - The recovery phrase is "available anytime in account settings" and importable to Phantom, Rabby or Solflare.
  — [Axiom docs: Signup](https://docs.axiom.trade/getting-started/signup)
  - **Additional Auth Methods** (2025-07-30) — [Market Watcher](https://x.com/watchingmarkets/status/1950468169316913187)
- **Key export path:** "Settings, then Account and Security, then Manage Wallets"; "the key icon beside one reveals its private key after your password" — [axiompro.app wallet](https://axiompro.app/wallet/) (unverified third-party). The "Account and Security" settings location is corroborated by [Solana Trading Bots, 2026-03-04](https://solanatradingbots.com/axiom-trade-how-to-use/)
- **Docs (multi-wallet):**
  - unified view of "balances, open orders, and recent transactions"
  - switch wallets "without requiring users to log out"
  - "label or name each wallet"
  — [Axiom docs: Multi-wallet](https://docs.axiom.trade/multi-wallet)
  - Limit 25 — [@AxiomExchange 2025-06-04](https://x.com/AxiomExchange/status/1930313033345044506)
- **Wallets tab (Sep 2026):**
  - add-wallet and import buttons
  - transfers: "Drag source wallet(s) into Source wallets field, select Destination, click Start Transfer", only between your own Axiom wallets
  - a **Claim Rent** button (undescribed)
  — [apebrief: wallets](https://apebrief.com/axiom/wallets/)
- **Wallet Groups** (2025-12-08) — [Market Watcher](https://x.com/watchingmarkets/status/1997974869892554887); "Create a wallet group" (Sep 2026) — [apebrief: pulse](https://apebrief.com/axiom/pulse/). **Advanced Multi-Wallet Settings** (2025-10-05) — [Market Watcher](https://x.com/watchingmarkets/status/1974763956179976368). **Split tokens** (2025-05-05) — [Market Watcher](https://x.com/watchingmarkets/status/1919380586478567921)
- **Privacy:**
  - "Public infra, private execution. Meet @vanishTrade, now integrated with … @AxiomExchange" (2025-11-14) — [Solana](https://x.com/solana/status/1989398845802123450)
  - "Privacy on Axiom / Trade privately on Solana" — [Market Watcher](https://x.com/watchingmarkets/status/1989272120527102397)
  - **Private funding and dust optimization** (2026-02-22) — [Market Watcher](https://x.com/watchingmarkets/status/2025561298591707367)
  - **Private Consolidation** (2026-06-17) — [Market Watcher](https://x.com/watchingmarkets/status/2067161049384505778)
- **Exchange panel (Sep 2026):**
  - tabs **Convert, Deposit, Buy**
  - dropdowns **"Receive on"** and **"Deposit from"**
  - a per-chain deposit address (SOL; BSC; BASE; ETH; HYPEREVM; INK; ARC)
  - Robinhood: "Deposit ETH on ETH. Funds are auto-bridged…", minimum $3, about 26 s and about $0.01, accepts ETH/USD1/USDC/USDG/USDT
  - Arc cross-chain deposits "coming soon"
  - **Buy**: an Onramper card route, Solana only
  — [apebrief: fund chains](https://apebrief.com/axiom/fund-chains/)
- **Cross Chain Deposits** (2026-03-15) — [Market Watcher](https://x.com/watchingmarkets/status/2033105937695690990)
- **Coinbase on-ramp** (2025 docs): "buy up to $500 worth of Solana" per week without KYC — [Axiom docs: Buy Crypto](https://docs.axiom.trade/axiom/buy-crypto). This differs from the Sep 2026 "Onramper" label, so the provider may have changed.
- **Convert:** wallet button → swap button, convert "your crypto to USDC" — [Axiom docs: Convert](https://docs.axiom.trade/axiom/swap/convert). The Sep 2026 Convert tab swaps across chains, e.g. SOL→BNB — [apebrief](https://apebrief.com/axiom/fund-chains/)
- **Withdrawals (conflicting):**
  - "Withdrawals: SOL & USDC supported" — [Coin Bureau, 2025-07-17](https://coinbureau.com/analysis/is-axiom-trade-legit)
  - Versus "no direct withdrawal interface" documented, so the exit route is the recovery phrase in an external wallet — [apebrief: withdraw](https://apebrief.com/axiom/withdraw/)
- **Chain balances:**
  - Chain switching moves no money; each chain has separate balances and its own address.
  - The selection persists and appears in the URL (e.g., `chains=robinhood`).
  — [apebrief: switch chains](https://apebrief.com/axiom/switch-chains/); [apebrief: robinhood chain](https://apebrief.com/axiom/robinhood-chain/)

### Inferences
- For a single-user, server-signing build, Axiom's multi-wallet model maps directly onto server-held keypairs: N wallets, groups, split buys, randomized amounts, consolidation, rent reclaim, and private funding via intermediate hops.
- Our build needs explicit external withdraw/send with an address allowlist, since Axiom's own UX here is ambiguous.

### Gaps
- Not found: wallet-group semantics (buy-split rules, randomization ranges), what "Claim Rent" closes, how "private funding" and Vanish work technically, which "Additional Auth Methods" were added, and whether a native withdraw/send screen exists in 2026.

## Fees and economics (headline numbers)

### Takeaway
- **Fee:** 1% per swap ("net fee… begins at 1%"), with cashback tiers lowering the net fee from **0.95% (Wood)** to **0.75% (Champion)**.
- **Referrals:** a 3-level program paying **30% / 3% / 2%** of Axiom's net fee. Referees get **10% off**.
- **Points:** classes, leaderboards and quests, with no token as of Aug 2026.
- **Promos:** Winners Arc ($200k USD1/week), double cashback on Bags, a $100k HOOD launch pool.
- No subscription tier found.

### Cited Findings
- Tier table — [Axiom docs: Axiom Fees](https://docs.axiom.trade/getting-started/fees/axiom-fees):

  | Tier | Multiplier | Net fee | Cashback |
  |---|---|---|---|
  | **Wood** | 1X | 0.95% | 0.05% |
  | **Bronze** | 2X | 0.90% | 0.10% |
  | **Silver** | 2.5X | 0.875% | 0.125% |
  | **Gold** | 3X | 0.85% | 0.15% |
  | **Platinum** | 3.5X | 0.825% | 0.175% |
  | **Diamond** | 4X | 0.80% | 0.20% |
  | **Champion** | 5X | 0.75% | 0.25% |

  "Your multiplier increases with your total trading volume"; volume thresholds are unpublished.
- **Referrals:**
  - "net fee on every trade… begins at 1%"
  - Level 1 30%, Level 2 3%, Level 3 2%, "no cap"
  - covers "Solana, BSC, and Ethereum"
  - referees get "a 10% discount on trading fees"
  — [Axiom docs: Referral Program](https://docs.axiom.trade/getting-started/referral-program) (updated 2026-09-07)
  - Referral links look like `axiom.trade/@handle` — [Chinito](https://x.com/HeyChinito/status/1910007462528467223)
- **Points:** earned per trade, from referrals and from referrals' referrals, with a leaderboard; "possible future airdrops" — [Axiom docs: Point System](https://docs.axiom.trade/getting-started/point-system). Points are "counted in different classes" and earn claimable SOL — [Market Watcher 2025-03-27](https://x.com/watchingmarkets/status/1905218582377615386). "Earn SOL through trading, referrals and quests" — [Market Watcher 2025-03-28](https://x.com/watchingmarkets/status/1905591060975235504). No official token or airdrop as of 2026-08-13 — [Boxmining](https://boxmining.com/axiom-token-airdrop-guide/)
- **Programs:**
  - **New Rewards and Leaderboards** (2025-06-20) — [@AxiomExchange](https://x.com/AxiomExchange/status/1936076070547034148)
  - **Raydium Rewards** (2025-06-04) — [Market Watcher](https://x.com/watchingmarkets/status/1930182711089500429)
  - **Winners Arc**: "$200,000 paid out in USD1 every week to the 50 highest PnL traders on USD1 pairs" (2026-01-20) — [Market Watcher](https://x.com/watchingmarkets/status/2013540983137349811)
  - **DOUBLE Cashback on Bags Tokens** (2026-01-18) — [Market Watcher](https://x.com/watchingmarkets/status/2012843803023937660)
  - "🌿HOOD, now on Axiom. $100k, first come first serve!" (2026-07-10) — [@AxiomExchange](https://x.com/AxiomExchange/status/2075704026109190440)
  - Tasks for $20 ETH to your Robinhood wallet (2026-07-11) — [Market Watcher](https://x.com/watchingmarkets/status/2075739209692754332)
- **Scale:**
  - $100M revenue about 4 months after the late-Jan 2025 early-access launch. Axiom returned "as much as 43% of its fees as rewards" — [The Block](https://www.theblock.co/post/355676/axiom-exchange-hits-100-million-in-revenue-just-four-months-after-launch)
  - 30-day fees $27.2M vs GMGN $25.4M; all-time $736.7M (DefiLlama, as cited 2026-08-14) — [axiompedia](https://axiompedia.com/compare/axiom-vs-gmgn)
  - "$453+ million" cumulative revenue; about $237M annualized (2026-08-08) — [Cryptobriefing](https://cryptobriefing.com/gmgn-overtakes-axiom-24-hour-revenue/). These are different metrics (fees vs revenue), so the figures conflict.

### Inferences
- After cashback, a buy+sell round trip costs 1.5% (Champion) to 1.9% (Wood) of notional in Axiom platform fees, before priority/bribe/tips. On a 1 SOL position, a zero-platform-fee build saves about 0.015–0.019 SOL per round trip, or about 0.017 SOL at Gold. That is the headline pitch. (Arithmetic from the published tier table.)

### Gaps
- Not found: tier volume thresholds, quest mechanics, how point classes convert to SOL, and whether a separate subscription exists (none found).

## Chains, DEXes and launchpads supported in 2026; mobile app status

### Takeaway
Axiom launched on Solana (Jan–Feb 2025) and added chains in this order:
- **BNB** (2025-10-24)
- **Ethereum** (2026-05-21)
- **Robinhood Chain** (2026-07-10)
- By late Sep 2026 the header selector shows **8 chains: SOL, HOOD, Arc, BNB, Ink, HYPE (HyperEVM), BASE, ETH**. Several 2026 reviews still say Solana-only or 2–3 chains, so treat the long tail as new and lightly used.

Solana launchpads: 27 protocols in the Pulse filter (Pump, Mayhem, Bags, Bonk, Bonkers, Rise Rich, Stonkfun, Printr, Liquid, Surge, Soar, Moonshot plus 15 more). Historically also Boop, LaunchLab, Meteora DBC, Believe, Launch a Coin, Moonit, Daos.fun, Orca, and Flap (BNB).

Mobile: no native app as of Aug 2026. Axiom pushes a home-screen web app (PWA, Sep 2025).

### Cited Findings
- **Chain launch dates:**
  - "Axiom now supports BNB🔶." (2025-10-24) — [@AxiomExchange](https://x.com/AxiomExchange/status/1981511201596330007); a KOL had beta access "for a few weeks" — [orangie](https://x.com/orangie/status/1981509294177595585)
  - "ETH." (2026-05-21, with video) — [@AxiomExchange](https://x.com/AxiomExchange/status/2057564366124253325); "ETH on Axiom and InsightX Atlas" — [Market Watcher](https://x.com/watchingmarkets/status/2057736928624046329)
  - HOOD (2026-07-10) — [@AxiomExchange](https://x.com/AxiomExchange/status/2075704026109190440); "Bags RH coins are LIVE NOW on @AxiomExchange" (2026-07-14) — [BagsApp](https://x.com/BagsApp/status/2076819794582495340)
- **8-chain selector (Sep 2026):** "SOL, HOOD, Arc, BNB, Ink, HYPE, BASE, ETH" with "All (8)". "Pulse mixes tokens from all enabled chains into unified columns" — [apebrief: switch chains](https://apebrief.com/axiom/switch-chains/); [apebrief: chains](https://apebrief.com/axiom/chains/)
- **On Robinhood Chain**, ETH is gas and ordering is first-come-first-served, so "premium fees provide no priority advantage" — [apebrief: robinhood chain](https://apebrief.com/axiom/robinhood-chain/)
- **Conflicting chain counts:**
  - "Solana only" — [Coin Bureau, 2026-06-09](https://coinbureau.com/review/axiom-trade-review)
  - "Solana, BSC" — [axiompedia compare, 2026-08-14](https://axiompedia.com/compare)
  - Three chains (Solana, Ethereum, BNB) — [AXL, 2026-08-27](https://www.axltoken.com/trading-bots/gmgn-vs-axiom/)
  - Referral docs name "Solana, BSC, and Ethereum" — [Axiom docs](https://docs.axiom.trade/getting-started/referral-program)
- **Launchpad and DEX additions by date:**
  - **Boop, Bonk, LaunchLabs, Dynamic BC Day 1 Support** (2025-05-05) — [@AxiomExchange](https://x.com/AxiomExchange/status/1919421841447247906)
  - **Launch A Coin Filter** (2025-05-09) — [Market Watcher](https://x.com/watchingmarkets/status/1920727011670020565)
  - **Meteora and Believe Limit Orders** (2025-05-20) — [Market Watcher](https://x.com/watchingmarkets/status/1924738360930717840)
  - **Full Moonit Support** (2025-06-04) — [Market Watcher](https://x.com/watchingmarkets/status/1930182711089500429)
  - **Orca Integration** (2025-07-30) — [Market Watcher](https://x.com/watchingmarkets/status/1950468169316913187)
  - **Daos fun** (2025-09-28) — [Market Watcher](https://x.com/watchingmarkets/status/1972234168064168357)
  - **Bonkers** (2026-01-14) — [Market Watcher](https://x.com/watchingmarkets/status/2011503747197731068)
  - **Soar Launchpad** (2026-01-19) — [Market Watcher](https://x.com/watchingmarkets/status/2013189527393759240)
  - **Flap on Axiom** (2026-01-26) — [Market Watcher](https://x.com/watchingmarkets/status/2015729969490440347)
  - **Surge Launchpad** (2026-01-27) — [Market Watcher](https://x.com/watchingmarkets/status/2016116072886235352)
  - **Printr Launchpad** (2026-04-23) — [Market Watcher](https://x.com/watchingmarkets/status/2047255500878754217)
- Pump.fun graduates into **PumpSwap** and LaunchLab into a Raydium **CPMM** pool — [apebrief: new pairs](https://apebrief.com/axiom/new-pairs/)
- **Mobile:**
  - **Mobile UI Updates** (2025-04-12) — [Market Watcher](https://x.com/watchingmarkets/status/1911009040789893169)
  - "Trading on your phone? Axiom as an App on your Home Screen." (2025-09-15) — [Market Watcher](https://x.com/watchingmarkets/status/1967520647233606106)
  - "No official Axiom native app exists as of August 2026" — [axiompedia troubleshooting](https://axiompedia.com/troubleshooting)
  - "No native mobile app" — [tradeonaxiom](https://tradeonaxiom.com/axiom-trade-features/)
  - Mobile browser works but there is no dedicated app or Telegram bot — [Pump Parade, 2026-04-09](https://blog.pumpparade.com/crypto-trading/axiom-review-2026-fees-features-verdict/)

### Inferences
- "Flap" is a BNB-chain launchpad, which suggests BNB Pulse covers BNB launchpads (four.meme is likely too, but unconfirmed).
- The "STOCK" quote token and Robinhood Chain support show Axiom moving toward tokenized-stock memecoins in 2026.
- For our Solana-only v1 the relevant set is: Pump.fun/PumpSwap, Raydium LaunchLab (Bonk, Bonkers…), Meteora DBC (Bags, Believe, many white-label pads), Moonshot/Moonit, Boop, plus Raydium/Meteora/Orca AMMs for migrated tokens.

### Gaps
- No source found for the dates Base, Ink, Arc and HyperEVM were added. The 15 protocols behind "Show more" were not enumerated.
- Not found: the BNB/Base/ETH launchpad lists (four.meme, Clanker/Zora etc. unconfirmed), and which Solana DEX aggregator, if any, Axiom routes through for migrated tokens.

## Security: 2FA, withdrawal whitelist, session management, anti-phishing

### Takeaway
Axiom's security story is "non-custodial via Turnkey plus an exportable seed phrase."
- No public source documents 2FA, a withdrawal allowlist or session management as of Aug–Sep 2026. One 2025 review mentions unspecified "MFA", and Jul 2025 added unspecified "Additional Auth Methods".
- Anti-phishing guidance amounts to "support is Discord tickets only", plus warnings about lookalike domains and fake apps.
- The biggest trust event was **Feb 2026**: an employee abused internal support dashboards to look up users' linked wallets.

### Cited Findings
- "non-custodial infrastructure, secure key management, and encryption"; Turnkey partner — [Axiom FAQ](https://docs.axiom.trade/faqs)
- "No documented two-factor authentication system (as of August 2026)"; seed phrase exportable via Settings — [axiompedia: is Axiom safe](https://axiompedia.com/security/is-axiom-trade-safe). A 2025 review cites "Multi-factor authentication (MFA)" but says "specifics… aren't clearly laid out" — [Coin Bureau, 2025-07-17](https://coinbureau.com/analysis/is-axiom-trade-legit). **Additional Auth Methods** (2025-07-30) — [Market Watcher](https://x.com/watchingmarkets/status/1950468169316913187)
- No whitelist or 2FA withdrawal requirements are documented — [apebrief: withdraw](https://apebrief.com/axiom/withdraw/). A password gates private-key reveal — [axiompro.app wallet](https://axiompro.app/wallet/) (unverified)
- **Support and phishing:** support is via Discord tickets only, and users should disable DMs because "scammers often impersonate support staff" — [Axiom docs: Support](https://docs.axiom.trade/support). The phishing domain **auth-axiom.trade** is on the MetaMask, ScamSniffer and SEAL blocklists. There is no official Telegram bot or native app — [axiompedia](https://axiompedia.com/security/is-axiom-trade-safe)
- **Feb 2026 incident:**
  - Axiom: "someone on our team abused internal customer support tools to look up user wallets. We have removed access to these tools…" (2026-02-26) — [@AxiomExchange](https://x.com/AxiomExchange/status/2027018976929423583)
  - A senior BD employee allegedly used internal dashboards to look up wallet addresses tied to users and shared them — [Unchained, 2026-02-27](https://unchainedcrypto.com/zachxbt-accuses-axiom-employee-of-misusing-private-wallet-data/)
  - The dashboard allowed lookup "by wallet address, referral code, or account ID" with "no logging of who accessed what", over about 10 months — [axiompedia](https://axiompedia.com/security/is-axiom-trade-safe)
  - Headline allegation: "$400k Insider Trading" — [Yahoo Finance](https://finance.yahoo.com/news/axiom-crypto-exposed-zachxbt-alleges-122625589.html)

### Inferences
- A self-hosted, single-user build removes the Feb-2026 risk class entirely: no operator can see your tracked wallets, linked wallets or trade history.
- Server-side signing means the server is the vault, so we must ship what Axiom lacks:
  - TOTP/passkey login
  - per-session revocation
  - IP allowlist
  - withdrawal address allowlist with delay
  - encrypted keystore with a hardware-backed KEK where available
  - audit log of every signature

### Gaps
- Not found: session/device management UI, login alerts, and which auth methods were added in Jul 2025.

## Notable outages, incidents, complaints and most-requested missing features

### Takeaway
**Incidents:**
- **Aug 28–29, 2025**: a Pump.fun API change left Axiom users unable to sell for hours.
- **May 2025**: a user-reported 251 SOL wallet drain (cause not established publicly).
- **Oct 2025**: research attributing about 70% of sandwich-extracted SOL to Axiom users.
- **Feb 2026**: the internal-tools data-abuse scandal.

**Recurring complaints:**
- failed transactions and slippage
- the 1% fee on small trades
- an undocumented limit-order cap
- Discord-only support
- phishing and fake apps
- (in 2025) reports of surprise KYC and slow support

**Gaps vs competitors:** no auto copy-trading, no Telegram bot, no public API, no native mobile app, X keyword/trend alerts still "Coming Soon", and no published metric definitions. GMGN briefly flipped Axiom's daily revenue in Aug 2026 on multichain and Telegram strength.

### Cited Findings
- **Aug 28–29, 2025:** "a change to Pump.fun's API broke the integrations… Axiom users could not sell through the app for several hours" — [axiompedia](https://axiompedia.com/security/is-axiom-trade-safe); [axiompedia troubleshooting](https://axiompedia.com/troubleshooting)
- **2025-05-17:** "my Axiom trading wallet was drained for over 251 SOL ($42,000)". The thread's root-cause claims weren't retrievable — [sladq_](https://x.com/sladq_/status/1923845717488980456)
- **Oct 2025 sandwich research:** "Around 70% of the extracted SOL came from users on Solana's Axiom platform" (about 529k SOL extracted over a year). This measures SOL extracted, not victims — [axiompedia: MEV modes](https://axiompedia.com/guides/trading/axiom-mev-protection-modes-explained)
- **Troubleshooting top issues:**
  - failed transactions (slippage), "most common complaint"
  - limit order cap
  - "1% each way before cashback" on small trades
  - fake apps and phishing
  - Discord-only tickets, "no live chat"
  — [axiompedia troubleshooting](https://axiompedia.com/troubleshooting)
- **2025 complaints:** "unexpected KYC requests during the withdrawal process", "slow or unresponsive support", "delayed settlement… inconsistent fill rates". These are reported by Coin Bureau from Reddit/Trustpilot and unverified — [Coin Bureau, 2025-07-17](https://coinbureau.com/analysis/is-axiom-trade-legit)
- **Review cons:** "Steep learning curve", "No Telegram bot", "Limited widget customization", "MEV protection 'isn't guaranteed'" — [Pump Parade, 2026-04-09](https://blog.pumpparade.com/crypto-trading/axiom-review-2026-fees-features-verdict/)
- **Gaps vs GMGN:** "Automated copy trading", multichain breadth, "Scam detection (GoPlus engine)", "AI/Agent API", "Telegram interface" — [AXL, 2026-08-27](https://www.axltoken.com/trading-bots/gmgn-vs-axiom/). "No official public API" — [tradeonaxiom](https://tradeonaxiom.com/axiom-trade-features/)
- **Revenue race:** GMGN about $336k vs Axiom about $559k in 24h. GMGN's edge is attributed to multichain (incl. BSC), a Telegram bot and "AI-driven trading signals" (2026-08-08) — [Cryptobriefing](https://cryptobriefing.com/gmgn-overtakes-axiom-24-hour-revenue/)
- **Market share (Aug 2026):** Axiom about 39%, GMGN about 36%, Photon under 1%. BullX "announced a pause of trading in June 2026" — [axiompedia compare](https://axiompedia.com/compare)
- **Long-promised, still unshipped:** X keyword/trend filters, promised in Mar 2025 docs and still "Coming Soon" in Sep 2026 — [Axiom docs: Tweet Monitor](https://docs.axiom.trade/tweet-monitor); [apebrief](https://apebrief.com/axiom/twitter-tracker/)
- **Opaque metrics:** methods for snipers, insiders, dev and pro traders are unpublished — [axiompedia glossary](https://axiompedia.com/guides/trading/axiom-pulse-glossary)
- **Wallet alerts are app-bound:** wallet-tracker alerts when the app is closed are not documented — [apebrief](https://apebrief.com/axiom/wallet-tracker/)

### Inferences
- Third-party API dependence (Aug 2025) is a real failure mode. Building every launchpad and AMM instruction directly from on-chain program IDLs, with no launchpad web APIs in the trade path, is a robustness edge.
- The Oct 2025 sandwich stat suggests many Axiom users trade with MEV "Off" and high slippage (guides recommend 80%). Our defaults should be protected sends for buys plus auto-slippage bounded by a quote, with a visible "sandwich risk" warning.

### Gaps
- Reddit r/solana and r/SolanaMemeCoins threads could not be fetched (the shared web-search budget ran out). The "most-requested features" list therefore comes from reviews and comparison sites, not first-hand Reddit tallies.
- No source found for an outage-timeline or status page for Axiom specifically.

## Timeline of major features, 2024 → 2026

### Takeaway
- **2024:** pre-launch only. The X account was created Apr 2024.
- **Jan–Mar 2025:** launch with the core loop (Pulse, Instant Trade, limit and migration orders, tracker, yield).
- **Apr–Jul 2025:** an explosive weekly cadence: PnL cards, multi-wallet, sound alerts, themes, trending, Surge, Vision, 10k tracker, display settings.
- **Aug–Dec 2025:** alerts, PWA, dev/fresh-wallet intel, BNB, privacy (Vanish), axiSOL, wallet groups.
- **2026:** launchpads (Bonkers, Soar, Flap, Surge, Printr), Pulse hotkeys, USDC trading, Winners Arc, privacy funding, Katana Mode, ETH, predictions, Robinhood Chain, chart bubbles. By Sep 2026, 8 chains.

### Cited Findings
**2024**
- @AxiomExchange account joined **2024-04-16**; profile "The ONLY Trading Platform You'll Ever Need. Memes, Perps, Yield, All-In-One." — [@AxiomExchange](https://x.com/AxiomExchange)
- No shipped user-facing features were found for 2024.

**2025**
- **Late Jan 2025** early access, **mid-Feb 2025** public launch. YC W25. Founders Henry Zhang ("Mist") and Preston Ellis ("Cal"), as reported by The Block. At launch: Solana swaps, MarginFi yield, points; Jito-based SOL staking was "coming soon" — [The Block](https://www.theblock.co/post/355676/axiom-exchange-hits-100-million-in-revenue-just-four-months-after-launch)
- **Feb 3–4, 2025** docs: Pulse (3 columns, 14 filters), Market, Limit Orders, Convert, Migration Actions (Sniper Buy/Sell), Portfolio, Wallet tracking — [docs sitemap](https://docs.axiom.trade/sitemap-pages.xml)
- **Mar 2025:** multi-wallets, Custom Twitter Tracker, Tweet Preview Popup, OG coins mode (2025-03-14) — [bessa](https://x.com/_gabriel_bessa/status/1900612870804586726). Docs added Tweet Monitor and Preview (03-20), Instant Trade hotkeys and Similar Tokens (03-23), Trader Scan (03-28) — [sitemap](https://docs.axiom.trade/sitemap-pages.xml). Rewards (SOL via trading/referrals/quests) — [Market Watcher](https://x.com/watchingmarkets/status/1905591060975235504)
- **Apr 2025:**
  - 04-02 PnL Cards ("Share PnL") — [link](https://x.com/watchingmarkets/status/1907407815053840837)
  - 04-09 instant X tooltips, randomized multi-wallet trading — [link](https://x.com/HeyChinito/status/1909807448942322124); live PnL tracker widget — [link](https://x.com/HeyChinito/status/1910007462528467223)
  - 04-12 Mobile UI Updates — [link](https://x.com/watchingmarkets/status/1911009040789893169)
  - 04-15 New PnL Cards and Instant Holders — [link](https://x.com/watchingmarkets/status/1912043264431075503)
  - 04-20 Turbo Mode — [link](https://x.com/watchingmarkets/status/1914015852267024457)
- **May 2025:**
  - 05-05 Custom/Multiwallet PNL Cards, Split Supply, Master Pulse Blacklist, Truth Social Tracker, IG/Truth/YT/TikTok previews, Boop/Bonk/LaunchLabs/Dynamic BC — [link](https://x.com/AxiomExchange/status/1919421841447247906)
  - 05-09 Mega Quick Buy Buttons, Customize Tables, Launch A Coin Filter — [link](https://x.com/watchingmarkets/status/1920727011670020565)
  - 05-13 Wide chart view, smaller wallet tracker, large token hover — [link](https://x.com/watchingmarkets/status/1922208646093562065)
  - 05-20 Twitter Account Preview, Instant Trade PNL, **MEV Modes**, Meteora/Believe limit orders — [link](https://x.com/watchingmarkets/status/1924738360930717840)
- **Jun 2025:**
  - 06-04 Custom Themes, Fees in PNL, Lighthouse, X Communities hover, Global Fees Paid, Pump Livestream tokens, Pulse Sound Alerts, Separate Quick Buys, ULTRA, Avg Entry/Exit, 25 wallets, chart font size, Migration Bubble — [link](https://x.com/AxiomExchange/status/1930313033345044506); plus Raydium Rewards, Protocols in Live Trades, Full Moonit — [link](https://x.com/watchingmarkets/status/1930182711089500429)
  - 06-20 Fastest Submission Engine, PNL Calendar, Rewards/Leaderboards, Algorithmic Trending, more tooltips, Pulse Import/Export, Search Quick buy, Quick Dev Blacklist — [link](https://x.com/AxiomExchange/status/1936076070547034148); plus Live Trades MC filter, Sort Pump Live — [link](https://x.com/watchingmarkets/status/1935961712269680776)
- **Jul 2025:**
  - 07-08 Surge, Pulse Tracker, Holder revamp, Bubblemaps/Dev Funding/KOL hovers, Instant Trade revamp, PNL modal graph, top-holder avg entry/exit, Reset PNL, PNL Calendar revamp — [link](https://x.com/AxiomExchange/status/1942592760915321133); plus 500 tracked wallets, Trending graph — [link](https://x.com/watchingmarkets/status/1942498868400382436)
  - 07-29/30 **Vision**, **10,000-wallet tracker**, Pulse Display Settings (row/metric colors, decimals, Ultra Glow, extra settings), Migration MC Line, Funding in Holders/Top Traders, Advanced Toasts + Position, Watchlist Quick Buy, Additional Auth Methods, Orca, X affiliate badge, DexScreener banner hover — [link](https://x.com/AxiomExchange/status/1950234718437298673); [link](https://x.com/watchingmarkets/status/1950468169316913187)
- **Aug 2025:**
  - 08-07 Axiom "FLIPS HYPERLIQUID IN 24H REVENUE" — [DegenerateNews via Market Watcher](https://x.com/watchingmarkets/status/1953381365187063899)
  - 08-23 **Price Alerts → Discord/Telegram** — [link](https://x.com/watchingmarkets/status/1959147280025473448)
  - 08-28/29 Pump.fun API sell outage — [axiompedia](https://axiompedia.com/security/is-axiom-trade-safe)
- **Sep 2025:**
  - 09-03 multi-wallet docs updated — [sitemap](https://docs.axiom.trade/sitemap-pages.xml)
  - 09-15 PWA "App on your Home Screen" — [link](https://x.com/watchingmarkets/status/1967520647233606106)
  - 09-28 Reused Image Tokens, Click Candles to Filter, Buy Amount Display Customization, Revamped Pump Live, Fresh/Shared Wallets, Daos fun, Quote Token filter, Tracked Developers, Search Developer, Pump fun Offchain Indicator — [link](https://x.com/watchingmarkets/status/1972233851742433473)
- **Oct 2025:**
  - 10-05 Advanced Multi-Wallet Settings, Blacklist Twitter Accounts, Token PnL Tracker — [link](https://x.com/watchingmarkets/status/1974763956179976368)
  - 10-24 **BNB** — [link](https://x.com/AxiomExchange/status/1981511201596330007)
- **Nov 2025:**
  - 11-01 DEX Paid Chart Bubbles, Second Quick Buy — [link](https://x.com/watchingmarkets/status/1984535183153119521)
  - 11-14 **Vanish private execution** — [link](https://x.com/solana/status/1989398845802123450)
- **Dec 2025:**
  - 12-02 **axiSOL** on Yield page — [link](https://x.com/watchingmarkets/status/1995797934110114123)
  - 12-08 **Wallet Groups** — [link](https://x.com/watchingmarkets/status/1997974869892554887)
  - 12-22 social profiles / trade with friends — [link](https://x.com/watchingmarkets/status/2003045582378836131)

**2026**
- **Jan 2026:**
  - 01-02 **Pulse Hotkeys** — [link](https://x.com/watchingmarkets/status/2006975141029503203)
  - 01-08 KOL/Watched holding lines — [link](https://x.com/watchingmarkets/status/2009197498221633639)
  - 01-09 Pulse X handle and stats — [link](https://x.com/watchingmarkets/status/2009726736385065418)
  - 01-14 Bonkers — [link](https://x.com/watchingmarkets/status/2011503747197731068)
  - 01-18 Bags double cashback and claims tracker — [link](https://x.com/watchingmarkets/status/2012843803023937660)
  - 01-19 Soar and Dex Paid Tracker — [link](https://x.com/watchingmarkets/status/2013189527393759240)
  - 01-20 **Winners Arc** — [link](https://x.com/watchingmarkets/status/2013540983137349811)
  - 01-23 Streamflow Locks — [link](https://x.com/watchingmarkets/status/2014618117498905061)
  - 01-26 Flap — [link](https://x.com/watchingmarkets/status/2015729969490440347)
  - 01-27 Surge Launchpad — [link](https://x.com/watchingmarkets/status/2016116072886235352)
- **Feb 2026:**
  - 02-04 Custom Twitter Hotkey, Users Online — [link](https://x.com/watchingmarkets/status/2018989925052379292)
  - 02-08 Reposcan Upgrade — [link](https://x.com/watchingmarkets/status/2020488283705242036)
  - 02-16 **USDC Trading** — [link](https://x.com/watchingmarkets/status/2023349703283241110)
  - 02-22 Private funding and dust optimization — [link](https://x.com/watchingmarkets/status/2025561298591707367)
  - 02-26 internal-tools abuse statement — [link](https://x.com/AxiomExchange/status/2027018976929423583)
- **Mar 2026:**
  - 03-15 Quick Sell Button, Video PNLs, Sniper Bubbles, Cross Chain Deposits — [link](https://x.com/watchingmarkets/status/2033105937695690990)
  - 03-30 Improved Limit Orders — [link](https://x.com/watchingmarkets/status/2038536291126509876)
- **Apr 2026:**
  - 04-23 Printr — [link](https://x.com/watchingmarkets/status/2047255500878754217)
  - 04-25 **Katana Mode** and Upgraded Search Filters — [link](https://x.com/watchingmarkets/status/2047947279168946224)
- **May 2026:**
  - 05-09 Husher, Dev token improvements, Recent transfers — [link](https://x.com/watchingmarkets/status/2053020775410450730)
  - 05-21 **ETH** — [link](https://x.com/AxiomExchange/status/2057564366124253325)
  - 05-22 InsightX Atlas — [link](https://x.com/watchingmarkets/status/2057736928624046329)
  - 05-28 Token Communities — [link](https://x.com/watchingmarkets/status/2059913467516056042)
- **Jun 2026:**
  - 06-12 **Prediction Markets** — [link](https://x.com/AxiomExchange/status/2065465775767331086)
  - 06-17 Private Consolidation — [link](https://x.com/watchingmarkets/status/2067161049384505778)
  - 06-28 Blacklist Funding Wallet and Predictions update — [link](https://x.com/watchingmarkets/status/2071141751679504869)
  - 06-30 **Katana Mode V2**, PnL on Pulse, Quick Hover Price Charts, Chart Bubble Clusters — [link](https://x.com/watchingmarkets/status/2071879061207490561)
- **Jul 2026:**
  - 07-03 Wallet Tracker Transfers and Pulse Mini Charts — [link](https://x.com/watchingmarkets/status/2072992003944489279)
  - 07-10 **Robinhood Chain** ($100k pool) — [link](https://x.com/AxiomExchange/status/2075704026109190440)
  - 07-23 Robinhood Express Lander — [link](https://x.com/watchingmarkets/status/2080087396314689741)
  - 07-30 Bubble Hover Tooltips — [link](https://x.com/watchingmarkets/status/2082905054596702538)
- **Aug–Sep 2026:**
  - 08-08 GMGN briefly out-earns Axiom daily — [Cryptobriefing](https://cryptobriefing.com/gmgn-overtakes-axiom-24-hour-revenue/)
  - 09-07 referral docs updated (Solana/BSC/Ethereum) — [sitemap](https://docs.axiom.trade/sitemap-pages.xml)
  - Sep 2026 screenshots show **8 chains** (SOL, HOOD, Arc, BNB, Ink, HYPE, BASE, ETH) and 27 Solana protocols in the Pulse filters — [apebrief](https://apebrief.com/axiom/switch-chains/)

### Inferences
- Axiom ships roughly 2–4 named features every 1–2 weeks. Most are small, compounding UX/data improvements (hovers, bubbles, colors, filters), not big new products. Copying the long tail is less important than nailing the data pipeline those features sit on (holder/funding/dev classification, cost basis, event bubbles).

### Gaps
- Not found: official release notes for Aug–Sep 2026 (the Market Watcher thread ends 2026-07-30), and add dates for Base, Ink, Arc and HyperEVM.
- The Market Watcher thread is an affiliate's log. Items are real releases shown in screenshots, but naming is his paraphrase unless it matches an @AxiomExchange post.

## Implications for the build: what to replicate first and where we can beat Axiom

### Takeaway
To reach parity with how Axiom is actually used, we need: a 3-column Pulse with rich per-column filters and blacklists; one-click/hotkey trading with P1–P3 presets and fast multi-path landing; limit, TP/SL and migration orders executed server-side; a token page with holder/dev/funding intelligence and chart overlays; and a 10k-wallet tracker with live trades.

Our structural advantages: 0% platform fee (vs 0.75–1%), self-hosted privacy (no Feb-2026-style operator access), server-side always-on automation and alerts, auto copy-trading, a public API/webhooks, transparent metric definitions, and direct on-chain integrations that survive launchpad API changes.

### Cited Findings
- Fee gap: 1% base, 0.75% best tier — [Axiom docs: fees](https://docs.axiom.trade/getting-started/fees/axiom-fees); [referral docs](https://docs.axiom.trade/getting-started/referral-program)
- Missing in Axiom (as of Aug–Sep 2026):
  - auto copy-trading — [apebrief](https://apebrief.com/axiom/wallet-tracker/); [AXL](https://www.axltoken.com/trading-bots/gmgn-vs-axiom/)
  - public API — [tradeonaxiom](https://tradeonaxiom.com/axiom-trade-features/)
  - DCA (not documented) — [axiompro.app](https://axiompro.app/ai-trading/)
  - X keyword/trend alerts — [apebrief](https://apebrief.com/axiom/twitter-tracker/)
  - documented 2FA — [axiompedia](https://axiompedia.com/security/is-axiom-trade-safe)
  - alerts while closed (except price alerts) — [apebrief](https://apebrief.com/axiom/wallet-tracker/); [Market Watcher](https://x.com/watchingmarkets/status/1959147280025473448)
- Reliability and trust events: Aug 2025 API outage; Feb 2026 data abuse — [axiompedia](https://axiompedia.com/security/is-axiom-trade-safe); [@AxiomExchange](https://x.com/AxiomExchange/status/2027018976929423583)

### Inferences
**Prioritized checklist**

**P0: parity core (v1)**
1. **Pulse:**
   - New Pairs / Final Stretch / Migrated, streaming via Geyser/websocket.
   - Per-column, per-chain filters: Search/Exclude Keywords; Protocols; Quote Tokens; Audit (Dex Paid, CA ends in pump, Age, Top10%, Dev%, Snipers%, Insiders%, Bundle%, Holders, Pro Traders, Dev Migrations, Dev Pairs Created); $ Metrics (Liquidity, Volume, MC, Bonding Curve %, Global Fees Paid, Txns, Buys, Sells); Socials (Twitter, Website, Telegram, At least one social, Twitter Reuses, Tweet Age, Dex Paid).
   - 3 filter presets, Apply All, JSON import/export/share.
   - Blacklists: token, dev, funding wallet, X account.
   - Card fields: Age, MC, V, F, TX, NB, holder-% row, socials.
   - Per-column quick-buy amount.
   - Sound alerts.
   - Pause-on-hover (our addition).
2. **Trading:**
   - Instant Trade: 4 buy amounts, 4 sell %, "Sell Init.", sell by amount or %.
   - P1–P3 presets with separate buy/sell slippage, priority, tip and MEV mode (Off / Jito-only "Reduced" / protected-validator "Secure" analogue).
   - Auto-fee from recent prioritization fees, with a max cap.
   - Space+key hotkeys on the token page and customizable Pulse hotkeys.
   - No-confirm one-click, with an optional confirm and "buy delay" safety.
3. **Landing engine ("Katana" parity):** parallel submission to Jito plus other relays/staked RPCs, with per-path latency and landing-rate telemetry. MEV-protected default for buys.
4. **Orders, server-side, always on:**
   - limit buy/sell by MC or price, with a chart-drag "Limit Order Target" and a ±% slider
   - TP/SL ladder attached at entry ("Advanced Trading Strategy")
   - migration buy/sell
   - no artificial order cap
5. **Token page:**
   - TradingView chart with MC/Price toggle and markers for your trades, dev and tracked wallets.
   - Lines for your avg entry/exit, top-holder avg entry/exit, migration MC.
   - Event bubbles: DEX paid, migration, snipers.
   - Click-candle → filter trades.
   - Tabs: trades (filters: dev / you / tracked / size), holders and top traders (avg entry/exit, PnL, funding source, star-to-track), Trader Scan, dev's other tokens.
   - Token info: Top 10 H., Dev H., Snipers H., Insiders, Bundlers, LP Burned, Holders, Pro Traders, Dex Paid, fresh/shared wallets, fees paid.
6. **Wallet tracker:**
   - 10k+ addresses, Wallet Manager (emoji/name/address, GMGN/BullX import, export), Live Trades (MC/protocol/side/size filters, transfers), Monitor (tracked-holder counts per token).
   - Chart icons, toasts and sounds.
7. **Wallets:**
   - ≥25 server-held wallets with labels and groups, multi-wallet/split/randomized buys.
   - Consolidate/transfer, rent reclaim.
   - External withdraw with address allowlist.
   - Seed/private-key export.
8. **Portfolio/PnL:** positions, activity, fee-inclusive PnL, PnL calendar, shareable PnL cards (custom background, per-position reset).

**P1: high-value next**
9. X/Truth tracker:
   - Tweets, replies, quotes, deletions, follows, bio changes.
   - Keyword/trend alerts (Axiom still lacks these).
   - Tweet/account previews on Pulse and the token page.
   - Needs a paid X data source; budget for it.
10. Off-app notifications: Telegram/Discord/webhook for price alerts, tracked-wallet buys, X posts, order fills (Axiom only does price alerts).
11. Discover/Trending with timeframes, Watchlist (with quick buy), global search (name/ticker/CA/wallet/dev), Similar Tokens/OG mode, Pump Live.
12. Dev intelligence: dev funding trace, tracked developers, dev migrations/pairs-created stats, reused image/tweet detection.
13. Display system: row/metric colors, decimals, compact/expanded rows, column order, themes, toast position, movable panels.

**P2: differentiation / later**
14. Auto copy-trading with per-wallet caps, sell-mirroring and blacklist (Axiom has none).
15. Public local API plus webhooks and scripting, plus DCA and trailing stops (absent on Axiom).
16. KOL/insider discovery (Vision-like, needs a labeled-wallet dataset), Surge-like momentum alerts, Lighthouse-like market overview.
17. Privacy funding (multi-hop or mixer-free fresh-wallet funding) and private consolidation.
18. Extra chains (BNB, Base, ETH) only after Solana parity. Axiom's revenue is "almost all Solana" — [axiompedia](https://axiompedia.com/compare/axiom-vs-gmgn).

**Weaknesses to beat (marketing and roadmap)**
- **Cost:** 0% platform fee vs 0.75–1%.
- **Privacy and trust:** single-user, self-hosted, with no operator dashboard over your wallets or tracked lists.
- **Always-on:** server-side orders, alerts and copy-trades run without a browser tab.
- **Security:** TOTP/passkeys, session revocation, withdrawal allowlist and signature audit log, none of which Axiom documents.
- **Transparency:** published, open-source definitions for snipers, insiders, bundlers and pro traders.
- **Resilience:** direct on-chain instruction builders per launchpad, so no launchpad web-API single point of failure (the Aug 2025 lesson).
- **Safer defaults:** MEV-protected buys and quote-bounded slippage, given that about 70% of sandwich-extracted SOL came from Axiom users (Oct 2025).

### Gaps
- Parity details still unknown and to be validated hands-on by the team (hands-on, not via any Axiom API):
  - exact Display-menu options
  - Auto Fee / Max Fee existence
  - TP/SL level limits
  - default hotkey map
  - wallet-group split semantics
  - token-page tab names
