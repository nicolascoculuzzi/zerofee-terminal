# zerofee design references (Mobbin)

Curated on 2026-10-03 for [DESIGN.md](DESIGN.md). Every entry was opened and examined as a screenshot through the Mobbin MCP; nothing is described from metadata alone. Links go to `mobbin_url` because image URLs expire, and no Mobbin images are stored in this repo. Each line says what to take. We borrow patterns and proportions, never logos, wordmarks or signature colours. Pixel sizes are estimates scaled from the capture width.

Axiom, Hyperliquid, GMGN and Photon aren't on Mobbin (see [mobbin_ui_flows.md](../research_notes/Solana%20trading%20terminal%20teardown/mobbin_ui_flows.md)). Axiom's structure comes from its docs, cited inline in DESIGN.md.

## The 10 most influential

1. [Coinbase Advanced, spot trade](https://mobbin.com/screens/f8afc154-e5c8-4587-ab43-93c4799a979a): hairline-tiled panels with no gutters, order-book rows of about 18–19 px, an order form with price and size chips, a Subtotal / Fee / Total stack, and an Orders table with a small empty state.
2. [OKX, spot trade](https://mobbin.com/screens/c3ca83ef-f1de-4703-abbf-aa02ff6fa1ff): proof that a black, white and grey interface with colour only in market data reads as premium; quiet panel tabs; dense header stats.
3. [Gemini ActiveTrader](https://mobbin.com/screens/2271e5e3-4a73-4fa3-aad3-24e7bd6e2ad1): trailing zeros dimmed in fixed-precision quantities, MID / BID / 1% / 5% / 10% and 25 / 50 / 75 / 100% / Custom chips, a "● Online" status bar.
4. [Binance Meme Rush, New](https://mobbin.com/screens/972c602f-95aa-44ba-9cd3-1f869d9a58c3): pump.fun-style New / Finalizing / Migrated tabs on mobile, a square avatar with status border and launchpad badge, two-line rows with a header legend.
5. [Uniswap, swap review](https://mobbin.com/screens/a619a575-5745-4ad8-978c-b25aaaa9bfc5): a cost breakdown where each fee row has an info icon. The model for our "Platform fee 0" breakdown.
6. [Phantom, opened toast and entry line](https://mobbin.com/screens/c5d3a411-f5d2-4618-bfb4-0eb2abcbf5d4): a past-tense success toast after an in-progress state, and an "Entry" label on a dashed chart line.
7. [Fey, contextual command menu](https://mobbin.com/screens/ff52ac90-4d18-4765-98da-df1e362a5ee1): actions for the selected ticker with single-key keycaps. The keyboard-first model for our palette.
8. [Juicebox, search filters](https://mobbin.com/screens/b94f8a11-6713-466e-a9d5-d08e558ba525): section nav with active-filter dots, a live match count and a save action. The shape of our 14-metric filter modal.
9. [Linear, issues (dark)](https://mobbin.com/screens/e142df2a-3527-499c-8f81-1b715947ac0c): consistent 14 px icons, grey right-aligned meta, group header bars, no zebra. The calm side of dense.
10. [Kraken Pro, add widget and order line](https://mobbin.com/screens/5bdd6cb2-5040-44c4-8781-c70f3aea60a8): modular panels, a labelled "Preview – Buy – Limit" line on the chart, and a thin status bar with "● Online".

## App shell, top bar, status bar

- [Coinbase Advanced, spot](https://mobbin.com/screens/f8afc154-e5c8-4587-ab43-93c4799a979a): one top row with market context and the Transfer action; icon rail. Take the row density, not the blue.
- [Kraken Pro, add widget](https://mobbin.com/screens/5bdd6cb2-5040-44c4-8781-c70f3aea60a8): a balance chip, Deposit and a ⌘K search pill on one row; a status bar with Online, favourites and feedback.
- [Kraken Pro, widget toggles](https://mobbin.com/screens/25b67ef9-d56e-4f69-865f-16a702da74b7): a popover listing widgets with checkboxes and drag handles, grouped by area. Our Pulse Display popover.
- [Kraken Pro, home (dark)](https://mobbin.com/screens/c26a5185-2683-4078-9f93-8fc6ddabafb6): account summary cards and a Balances / Open orders / Positions tab table on one screen.
- [OpenSea, tokens table](https://mobbin.com/screens/a2072a4d-d59f-4b22-92be-ddcc3100db61): a status bar with Live/Paused, gas, Collector/Pro and Crypto/USD toggles. Our status-bar toggles and paused state.
- [Gemini ActiveTrader](https://mobbin.com/screens/2271e5e3-4a73-4fa3-aad3-24e7bd6e2ad1): "● Online" in the footer. We skip its scrolling ticker tape.
- [Vercel, deployments (dark)](https://mobbin.com/screens/e9576405-bcef-419a-922a-8fb84b044a54): pure-black chrome where status dots are the only colour.

## Pro trading layouts and order entry

- [Coinbase Advanced, fee tooltip](https://mobbin.com/screens/9b76c57a-9ae9-408f-bbd1-f4955a00d544): the fee tier explained right next to "Est. fee"; a side-coloured "Buy BTC" CTA.
- [Coinbase Advanced, chart types](https://mobbin.com/screens/4ed27744-549c-4cb7-894f-e2bc1f04c623): chart-type menu and toolbar layout above the canvas.
- [Kraken Pro, simple order form](https://mobbin.com/screens/e7e29a51-ac57-4038-8ad5-fe228df11309): Buy/Sell segmented, available balance, quantity, total, % slider, full-width CTA, and a "Layout created" toast.
- [Binance, spot](https://mobbin.com/screens/8d1b7823-6418-44c5-b3d5-ab69b3bfd6e3): book on the left, pair list and market trades on the right, about 20 px rows, price coloured by side.
- [Binance, order forms and open orders](https://mobbin.com/screens/14a47c59-4122-498b-ab2e-4ff6d611c85c): Limit / Market / Stop-limit, a slider with stops, a TP/SL checkbox, Buy and Sell CTAs, a B/S ratio bar, an order-cancelled toast.
- [OKX, order forms and bots empty state](https://mobbin.com/screens/f26041bc-ccc7-43f8-b492-2959191e63ae): filled inputs with a unit suffix, a 0–100% slider, pill CTAs, dotted-underline labels in "Spot mode", a one-line empty state.
- [OKX, assets table](https://mobbin.com/screens/da509525-ceef-4935-aa96-01a2f52521a6): two-line cells (value over converted value), PnL with %.
- [Gemini, limit price helper](https://mobbin.com/screens/f58f1725-5477-40de-9271-bfac6f2fadfe): "Current market price" right under the limit input.
- [Gemini, BTC simple page](https://mobbin.com/screens/fe564b29-e2e7-43ff-8c21-9d9861d24ea1): a line coloured above and below a reference; "Average buy price" with a dotted underline.
- [Phantom, swap](https://mobbin.com/screens/65eff589-ab7c-4289-a456-68a161f019c2): "Quote includes a 0.85% Phantom fee". We invert this into "Platform fee 0".
- [Phantom, slippage](https://mobbin.com/screens/8ad7511a-588d-4b54-8134-672a9209f103): Auto plus preset options, and a one-sentence warning about what slippage does.
- [Phantom, quick sell confirm](https://mobbin.com/screens/3fad6a3a-9806-46de-810b-ed318e331d59): a compact confirm with "Don't show again". Our confirm-on-touch sheet.
- [Phantom, auto close](https://mobbin.com/screens/279487cb-c28e-4e7a-9581-8d41e4f89e06): TP/SL inputs with +10% / +25% / +50% / +100% chips and a "% PNL | $ PNL | Price" mode toggle.
- [Phantom, amount with keypad](https://mobbin.com/screens/ecc1b414-1f58-43bb-9eb5-0eb55c4bfd1e): a large amount with 25% / 50% / Max and the fee disclosed in the footer link.
- [Uniswap, swap review](https://mobbin.com/screens/a619a575-5745-4ad8-978c-b25aaaa9bfc5): fee, network cost, rate, max slippage, routing and price impact rows with info icons.
- [Gamma, buy panel](https://mobbin.com/screens/a9f1af57-9e9e-4f7d-9931-6132b939300e): $10 / $125 / $250 presets inside the amount field, collapsible fees with info icons.
- [Whop, buy tokens](https://mobbin.com/screens/b5f3bb6c-2fc1-497f-8386-29d3a6f7e763): the selected state for preset chips.
- [Binance, convert confirm](https://mobbin.com/screens/130eaf2a-8087-470d-961d-f9ac59767838): a "No Fees" chip in the confirmation rows.
- [OKX, convert](https://mobbin.com/screens/b42d6627-0198-4577-8750-71c73f0dc7fb): a "0 Fees" badge next to the title. Keep ours neutral, not lime.
- [OpenSea, swap drawer](https://mobbin.com/screens/6a69de36-4f28-4841-8294-f7a195fa87a1): trading from a right drawer without leaving the page.
- [Kraken, confirm popover](https://mobbin.com/screens/7e080d39-6f61-43d1-8a4d-78ddfa5da1f8): a dotted "Incl. $0.72 fee" label and an explicit acknowledgement checkbox.
- [Base, trade modal](https://mobbin.com/screens/09a5bbe0-2943-4077-9f53-eddf516df513): You pay / You receive with a balance line and "Use max".
- [Public, options ticket](https://mobbin.com/screens/00b5bb2e-ab18-40db-abe1-26a5248bed62): a grid of instant action buttons (Buy Mkt, Sell Mkt…) with quantity chips. The model for the Instant Trade grid.
- [Cash App, buy sheet](https://mobbin.com/screens/3c393e1e-5d4a-4387-874f-281996eead50): a 2 × 3 amount-preset grid in a bottom sheet. Our mobile trade sheet.

## Pulse, discovery and smart money

- [Binance Meme Rush, New](https://mobbin.com/screens/972c602f-95aa-44ba-9cd3-1f869d9a58c3): New / Finalizing / Migrated tabs, a legend row, MC and volume stacked on the right.
- [Binance Meme Rush, Finalizing](https://mobbin.com/screens/2aa0b210-3bdf-44dd-b04a-8fa2556db2f5): top-10 share turning red when high; a status border on the avatar.
- [Binance Meme Rank](https://mobbin.com/screens/55442959-3968-4340-9c27-3efe6dfffeb5): richer three-line cards with metric chips and a Buy button on every card.
- [Binance Rankings](https://mobbin.com/screens/ccf9e08f-080e-4d62-90a9-701f871d4cce): two-part headers ("Last Price / 24h chg%", "Cap / Vol") that explain stacked mobile cells.
- [Binance Alpha](https://mobbin.com/screens/ab7d18c6-e10b-4497-a5c0-f27702157604): chain filter tabs and "Vol / Mcap / Liq" stacked values.
- [Binance Smart Money signals](https://mobbin.com/screens/37ad2b16-f814-48d2-861a-6f396445f479): a visible refresh countdown, buy/sell ratio bars, a dotted "Dominant Flow" label.
- [Binance signal timeline](https://mobbin.com/screens/09771a99-b9ea-406e-b3de-aed9a2fe4fb3): "4 Smart Money bought $8,406" with exit rate, signal price, MCap and max gain. The model for Trackers > Monitor.
- [Coinbase Wallet, trending swaps](https://mobbin.com/screens/5420b26c-19a1-4d3b-bb6e-7b68d373d175): a "60% bought / 40% sold" split bar with legend dots. Our TX ratio bar.
- [Phantom, trending tokens](https://mobbin.com/screens/d8231b54-856d-4f6a-95f8-06035dd7505a): rank badges on avatars, MC under the name, change on the right.
- [Base, social trade feed](https://mobbin.com/screens/0ee5ef3f-8693-4e21-971f-8975e9157712): "Someone bought $MPP" attached to a token card. The idea behind tracked-wallet feed rows.
- [Fey, screener](https://mobbin.com/screens/08c97ee6-5818-4bcc-ae01-2e2a751c1323): a dark dense screener with a selected-row outline and performance chips.
- [OKX, markets](https://mobbin.com/screens/d8d401bd-925d-490d-b367-0fcbf7628c0f): category text tabs and a 24h range bar with a position marker.

## Tables and trade tapes

- [OpenSea, tokens](https://mobbin.com/screens/a2072a4d-d59f-4b22-92be-ddcc3100db61): tabular numbers in every column, sortable headers, NEW tags, a market-cap bucket filter rail.
- [OpenSea, collections](https://mobbin.com/screens/3c43da7c-1aa1-4e4f-8a8d-cdf85c546240): a star column and an "Added to watchlist" toast with a check.
- [OpenSea, item activity](https://mobbin.com/screens/421641ab-0589-4cbb-b91f-e8ae121d2208): event filter chips above a compact table.
- [Uniswap, transactions](https://mobbin.com/screens/9a89244a-9b7b-49c1-9d6c-28cd7abdfa3f): a type filter dropdown (Swap / Add / Remove) in the header, wallet column truncated.
- [Uniswap, tokens](https://mobbin.com/screens/e39f0d0f-bed1-49ff-92e0-c53d36d34de6): counter-example. Rows of about 60 px are too airy for a terminal.
- [Perplexity, holders](https://mobbin.com/screens/d265c7a4-c61e-46bc-b525-beb10db72df8): holder-type segmented filter, signed change colouring, an analyst range bar with markers.
- [AirOps, analytics table](https://mobbin.com/screens/34ea2e01-87d4-4e1d-bfb2-1423b6ab8d40): tabular numbers with small tinted delta chips.
- [Shopify, orders columns](https://mobbin.com/screens/909c6cdb-f0a1-4183-ab1c-b64f3f2c9aa2): a columns popover with drag handles and visibility toggles; a sort popover.
- [Calendly, show columns](https://mobbin.com/screens/c0ec3e52-0c3e-4dbc-a51f-f4098ede87ce): a checkbox column chooser with locked columns.
- [Emergent, tasks table (dark)](https://mobbin.com/screens/430e05a7-1489-4b14-bf6b-1daaf61ff1ce): micro headers, mono IDs, a compact pagination footer.
- [Vercel, usage](https://mobbin.com/screens/e828f30f-3564-432d-8a2f-33b3116dd465): dot + label + sparkline + value rows with right-aligned subtotals.

## Token detail and stats

- [OpenSea, PENGU token](https://mobbin.com/screens/d07a9d5b-cd19-4c4b-a600-0ba26e29c68c): micro-label stats in the header strip, a stats row under the chart, a swap card on the right.
- [Base, ETH token](https://mobbin.com/screens/5d35e943-618c-402a-a9e8-2d8addd1f612): market cap as the headline with a toggle; a Your Position card with average cost and PnL.
- [Coinbase, USDT asset](https://mobbin.com/screens/6f13d33b-0741-4e59-885c-53ee80fcdb12): stats cells as label (with info icon), value and sub-caption.
- [Uniswap, ETH token](https://mobbin.com/screens/e809f183-5245-4aa6-8cbd-0af15cb5c657): a four-column stats row and a "Price" metric switch for the chart.
- [OKX, BTC page](https://mobbin.com/screens/3b440768-50c7-493d-9718-7921689ece5a): dotted-underline stat labels on the right. Counter-example: its glowing lime chart line.
- [Fey, ticker page](https://mobbin.com/screens/7f8ae731-3b5f-42c7-bc83-dd04ecbd04f2): one stats strip with hairline dividers instead of a card grid; a compact top-centre toast.
- [Phantom, BTC token page](https://mobbin.com/screens/76e93b20-0652-4758-8e2d-4925312a1fba): mobile price headline, change chip, timeframe row, a sticky Buy above the tab bar.
- [Phantom, token info](https://mobbin.com/screens/2f8a4b54-f4de-4e28-985b-2dde614ed0c6): key-value info rows (market cap, supply, created).
- [Phantom, position details](https://mobbin.com/screens/14c8763d-ef0c-4cad-b0b4-97eca2a52c43): P&L / ROI / size tiles and an "Auto Close: set take profit and stop loss" entry card.
- [Perplexity, mobile stats](https://mobbin.com/screens/392af3df-0977-47e5-8545-825064ac6052): a "Prev close" label on a dashed line and a compact 3 × 3 stats grid.
- [MoonPay, BTC](https://mobbin.com/screens/96ac35ec-ecee-40f0-9127-e3fb37ed25d3): high and low values labelled directly on a minimal mobile chart.

## Chart chrome

- [Binance, chart settings menu](https://mobbin.com/screens/9ee1d184-7edd-4bb9-9250-bd49a1a53a53): toggles for Open orders, Order history, Average price, Price alert and Price line. Our Markers menu.
- [OKX, drawing tools menu](https://mobbin.com/screens/a2bb80c5-27d1-4a5e-a87e-7c852a2d38f3): menu items with right-aligned shortcut hints.
- [Gemini, floating line toolbar](https://mobbin.com/screens/51336744-d390-48af-8815-0c4fbb57a0d0): drag handle, width, lock and delete in a compact floating bar.
- [Gemini, market selector](https://mobbin.com/screens/252b4451-c9b9-45ea-ab0a-6817d47299cf): a dropdown market list with tabs, search and a watchlist star column.
- [Railway, metrics tooltip](https://mobbin.com/screens/14f51fd0-7ad0-4c59-a44c-9f35b2056107): a compact dark chart tooltip with coloured series dots and tabular values.
- [OKX, taker buy/sell bars](https://mobbin.com/screens/2008706e-f441-44c8-9ddd-d6f5d0fe9ca9): paired buy/sell bars and a dark date-range picker.

## Command palette and search

- [Vapi, command palette](https://mobbin.com/screens/593d7acd-2e16-4365-bcd6-02ce52f48f3b): Actions / Recent / All sections, a footer with key hints and a result count.
- [Fey, command menu](https://mobbin.com/screens/ff52ac90-4d18-4765-98da-df1e362a5ee1): context actions with single-key caps for the selected item.
- [Superhuman, command](https://mobbin.com/screens/85dc5994-9360-428d-9092-7425e070ed7f): a keycap on every command and a strong selected-row state.
- [Dropbox Dash, find](https://mobbin.com/screens/0567ef26-d68b-4674-a6ee-8d255bbe7990): a preview pane beside results and footer action keys.
- [Better Stack, command](https://mobbin.com/screens/5a17a91b-e40a-46bc-b93f-57e720abd6dc): a grouped list with "Close Esc" in the footer.
- [Basedash, search](https://mobbin.com/screens/3ef6da6d-d4c3-4f89-a3aa-95f0c477c84c): "Use arrow keys to navigate" and "Select ↵" footer.
- [Railway, create menu](https://mobbin.com/screens/3b76fe18-ec45-402f-b902-ae363a7a4db4): items with submenu chevrons inside a palette.
- [Linear, search](https://mobbin.com/screens/d0b98680-66e2-47d4-9dc4-28bc9450c27f): scope chips under the query and a plain "No results found for…".
- [OpenSea, search](https://mobbin.com/screens/f603ab17-6650-4db3-ad20-56b6e5579863): category scopes and compact result rows with tabular counts and prices.
- [Uniswap, search dropdown](https://mobbin.com/screens/864dda50-5223-47c7-ad05-80bc1ddb77fd): recent searches and popular tokens with price and 24h change.
- [Kraken, search](https://mobbin.com/screens/54d05797-a4ac-4786-9ee7-ecddc144e1a0): results with change over price on the right and a ⌘K hint in the field.
- [Kraken, market search with filters](https://mobbin.com/screens/6115bfae-ce26-413c-8054-d0213e24a061): filter chips in search and "0 results for … with selected filters".
- [Perplexity, search dropdown](https://mobbin.com/screens/83b1f736-4260-48f3-b6a3-b6da01cfbaf9): Recent and Trending sections with tinted change chips.
- [Binance, select coin](https://mobbin.com/screens/9fbb8a3d-12f1-4de8-a13f-52d2723e4b73): trending chips above the list.

## Filters

- [Juicebox, search filters](https://mobbin.com/screens/b94f8a11-6713-466e-a9d5-d08e558ba525): section nav with active dots, live match count, save changes.
- [OKX, filter drawer](https://mobbin.com/screens/e1788cb5-4baf-4097-966e-527f1193cc64): label plus min–max inputs per row, Reset/Apply footer.
- [Fey, screener filter chips](https://mobbin.com/screens/0caf65f6-dcdc-451d-ae2c-5e8c47e1efff): "Industry | Aerospace ×" segmented chips. Our active-filter row.
- [Contra, filters](https://mobbin.com/screens/c09833dd-c898-4f52-9178-b8bb75aa0861): min/max number inputs under a range, "Clear all filters" and "Save filters".
- [Wellfound, filters](https://mobbin.com/screens/cf9f9476-04ad-4123-8f82-d733fd122ed6): active chips at the top, per-section Clear, a results count in the footer.
- [GetYourGuide, filters](https://mobbin.com/screens/6a1fb39a-89fe-45ae-9c8a-10cc20e4664a): "Reset all" plus "Show 128 results".
- [Linear, filter menu](https://mobbin.com/screens/ed670cda-0527-4716-a1a6-0159f12c4f42): a typed filter menu with submenus.

## Toasts and transaction feedback

- [Phantom, opened toast](https://mobbin.com/screens/c5d3a411-f5d2-4618-bfb4-0eb2abcbf5d4): pending-then-success copy in past tense.
- [Phantom, swapping coins flow](https://mobbin.com/flows/cf0c99a3-89db-459f-a7ea-069e4856dc5f): "Swapped Cash → SOL", a one-line success toast that resets the form.
- [Solflare, swapping a token flow](https://mobbin.com/flows/3a34df63-f2e0-454d-8a1a-d95d5fd95f4c): "You can safely close this screen", then Success with Transaction ID and Explorer rows.
- [Origin, connected toast](https://mobbin.com/screens/8ba60340-dbbf-4a23-985a-4cd6b27f7653): status icon, title, body and close. We skip its countdown bar.
- [Canny, idea created](https://mobbin.com/screens/8794989c-4116-4894-9684-2fd8f4761652): an inline "Undo" in the toast, and a quiet "Paused" chip on a source.
- [Mercury, submitted](https://mobbin.com/screens/0903bf94-3358-4414-8806-7f26e941f9c0): a compact dark one-line toast.
- [Whop, issue submitted](https://mobbin.com/screens/bbd4e248-ff4f-489f-8a57-4e2b5716d737): a compact bottom-right toast.

## Portfolio and PnL

- [Binance, assets overview](https://mobbin.com/screens/5acd0f5e-9019-4e1f-95e1-1446bbccd036): estimated balance, today's PnL, period toggle, "Hide assets <1 USD".
- [Coinbase, portfolio](https://mobbin.com/screens/114d6f6f-395f-40b6-a271-bebd604f0b73): total balance with sparkline and a balance / available / allocation table.
- [OpenSea, profile tokens](https://mobbin.com/screens/4e4e5077-88bf-4446-8b3e-ce60f63498c0): portfolio value with a hide toggle in the header strip, a held-value table.
- [Gemini, portfolio](https://mobbin.com/screens/cc6a1261-a495-4977-8ca8-36d9a20b46db): a balance chart with timeframes and account snapshots.
- [Origin, holdings](https://mobbin.com/screens/c70e093b-4236-4168-b870-9200d0fe71a3): a "Pro view" density toggle and return chips.
- [Binance, copy-trader performance](https://mobbin.com/screens/b92a460e-23dc-40d5-8a9b-cd79d8eb9b7d): ROI/PnL toggle, win rate, positions, MDD as dotted-label rows. Our Performance panel.
- [Binance, trader details](https://mobbin.com/screens/f63adfaf-72f6-4247-9982-8fcabd254ee2): a PnL chart that dips below zero, position history with entry and closing PnL.
- [Kraken, portfolio value](https://mobbin.com/screens/96301422-fcd8-40f6-899d-7aab6d69260f): dotted "Balance change" and "Unrealized return" labels under the balance.

## Share cards

- [Binance, share poster](https://mobbin.com/screens/fa184fc0-d47a-4ad5-a927-fd920bc4808f): ROI big, PnL, cut-off time, brand footer with QR. Drop the 3D art.
- [Binance, 30-day PnL card](https://mobbin.com/screens/e464cd28-6a90-4922-b255-9f4e7e5f4589): a compact PnL card with sparkline and a "Link copied" toast.
- [Public, share](https://mobbin.com/screens/5be7661b-2f1b-4af1-98ca-abe4cf3edb63): a $ / % toggle and a template carousel. Skip its radial glow.
- [Perplexity, share screenshot](https://mobbin.com/screens/bf6f870b-1e78-404c-944b-0769c8ee0606): Copy image / Download image and a "Show prev. close" toggle.
- [OKX, share flow](https://mobbin.com/flows/da0213e4-f24e-49db-8b9f-b0db144267b3): the card preview on the left, message, link and targets on the right, a "Copied" toast.
- [Fey, share copied](https://mobbin.com/screens/588eabbb-a0c2-4774-a19c-ec9511e1f302): two share-card variants with an inline "Copied" state.
- [Cash App, QR amount band](https://mobbin.com/screens/1e6cc94e-40a2-4748-b3f4-da34f8c93147): a bold amount band under the QR.

## Wallet connect, onboarding, backup, deposit

- [OpenSea, connecting a wallet](https://mobbin.com/flows/97dd4da9-ac78-475c-98d0-370dfafa73fb): an ecosystem chooser (Ethereum and 17 more / Solana), then balance and avatar in the header.
- [OpenSea, connecting an app](https://mobbin.com/flows/5ab8ab32-84d8-4c0b-81a8-9604e657b23e): a CONNECTED chip with Disconnect for linked accounts.
- [Uniswap, connecting a wallet](https://mobbin.com/flows/9aaa402b-0d7a-4960-8261-57602073bb6c): a right drawer with wallet rows and a spinner on the one connecting. Its hero is a counter-example for in-app use.
- [Tally, connect wallet](https://mobbin.com/flows/7791b9e6-611e-4cb0-ae5c-b767bd662931): a compact dark wallet list with badges and "All wallets 430+".
- [Phantom, recovery phrase](https://mobbin.com/screens/fa3d1040-f206-4de4-b236-435f1760fd1e): a numbered grid, a "Copied" state, "OK, I saved it".
- [MoonPay, recovery phrase](https://mobbin.com/screens/948ec472-ffa7-464e-b166-0ca51ee60fc6): hidden until "Show recovery phrase", copy disabled until then.
- [Family, exporting a wallet](https://mobbin.com/flows/3b9d8526-346d-4f7e-a778-6d35de6de9de): a recovery phrase / private key toggle and a reveal interaction.
- [Lloyds, memorable information](https://mobbin.com/screens/4a81b310-337b-404b-8e19-efc674b8ca31): "Enter the 2nd, 3rd and 6th characters". Our key-backup verification.
- [Marcus, secret word](https://mobbin.com/screens/2fb82752-386b-4dbd-a84d-49c5b75eab7e): requirements that turn green as they're met.
- [Proton, recovery setup](https://mobbin.com/flows/62f54e4d-a558-4be2-98e2-6dcb560ca29f): a recovery status checklist, phrase modal with copy and download.
- [Perplexity, backup codes](https://mobbin.com/screens/60c61f5d-38a4-44fa-8dba-c9ed260d5ceb): mono codes on tinted chips in two columns.
- [Base, sign in with recovery phrase](https://mobbin.com/screens/21ac15ea-e128-4153-a664-722950025ce9): a segmented step bar for mobile onboarding.
- [OKX, copying deposit details](https://mobbin.com/flows/a6c83dd1-51f7-4e6f-95da-faff776eb1ca): a vertical stepper, QR with address and copy, a "Copied" toast, deposit facts with info icons.
- [OKX, deposit coins](https://mobbin.com/flows/3adb7116-fa6a-4393-9c01-b64354dd8f49): a network picker that shows arrival time and minimum per network.
- [Base, receive QR](https://mobbin.com/screens/c1902c7b-0eff-4237-8f5a-674424ada92b): a full-screen QR with short address, copy and a supported-networks note.

## Settings, shortcuts, alerts

- [Obvious, keyboard shortcuts](https://mobbin.com/screens/d1f418bb-9d1a-40b6-a7b5-7b294ef64703): a searchable, dense, multi-column sheet grouped by area.
- [Perplexity, keyboard shortcuts](https://mobbin.com/screens/b0a63cb0-ff2e-49a9-90ab-b4dff7f8084d): shortcuts that don't apply right now are greyed out; a modifier legend.
- [Zoho CRM, shortcut editor](https://mobbin.com/screens/8291b6de-66e5-495e-91a8-c8a2b6525956): keycaps as rebindable buttons, a master toggle, "Reset shortcuts".
- [Frame.io, shortcuts](https://mobbin.com/screens/7bf0c9af-dd42-4511-a35e-15e097df461b): category nav plus search over shortcut groups.
- [Cofounder, shortcuts](https://mobbin.com/screens/2f5bbe84-7929-4d5e-8a3e-8a899c4c89a3): single-key shortcuts grouped by context.
- [Linear, menu with chords](https://mobbin.com/screens/14daab5b-7872-456a-8c5a-94f3d9d03a48): "G then S" hints on the right of menu items.
- [Toggl, keyboard settings](https://mobbin.com/screens/c6f9271e-5854-4174-bee5-691005237d18): "Allow keyboard shortcuts" with "press ? to see them", and a click-to-reveal token field.
- [Devin, settings](https://mobbin.com/screens/93170d84-7435-4c89-82b5-647330913aba): a searchable nav and grouped rows with the control on the right.
- [Buffer, preferences](https://mobbin.com/screens/8f4e0968-f06d-4fef-a1f1-f714b1f5c5e7): label and description rows with right-aligned selects.
- [Mintlify, danger zone](https://mobbin.com/screens/a704b533-fd36-4209-9f6e-30f49be34cde): two-column destructive settings with written consequences.
- [Perplexity, price alert](https://mobbin.com/screens/05d1e5bc-6996-4d08-a5b2-81a9aca3684a): a Target Price / Movement Amount toggle, current price shown in the label, notification channel.
- [Toggl, create alert](https://mobbin.com/screens/39a87228-c341-480a-b4a9-bf9e84d59f44): a sentence-like rule builder (IF / FOR / REACHES / ALERT).
- [Railway, notification override](https://mobbin.com/screens/ea8d53dc-8270-430d-bbdd-1df73b4ca531): severity chips with tint, border and text on dark.
- [Monzo, unsupported checks](https://mobbin.com/screens/c73a3c93-eb1e-4c54-80c9-27e68531e9d0): "Continue anyway (4s)". Our countdown confirm. Skip its illustration.

## Armed orders and statuses

- [Vercel, deployments](https://mobbin.com/screens/e9576405-bcef-419a-922a-8fb84b044a54): a status dot plus label plus duration, with short IDs and meta.
- [Square, all orders](https://mobbin.com/screens/14618499-6730-4721-9822-bad566504229): status tabs (All / Active / Scheduled / Completed / Canceled) over the table.
- [Xero, purchase orders](https://mobbin.com/screens/faf352c0-6e0c-4bcd-8d48-afd5393107b1): small rectangular status chips.
- [DoorDash, order drawer](https://mobbin.com/screens/147163b2-eef8-40be-b199-dae113a33d9c): a details drawer over the list with sections and totals.

## Empty, loading, error

- [Square, skeleton](https://mobbin.com/screens/09371ef3-f0d0-4fc9-8ab1-607ab3d0e4ab): skeleton bars sized per column under skeleton headers.
- [DoorDash, report skeleton](https://mobbin.com/screens/f470af91-c889-487f-a2a2-87d69a60a781): real headers with skeleton rows and a dark toast.
- [fal, no requests](https://mobbin.com/screens/a8b7726c-26bd-49bc-8cc6-f0a6d03d47c8): one info icon and one sentence.
- [Gemini, widget error](https://mobbin.com/screens/c6637b1c-7ddc-4343-b390-1840fe6dc4a5): an inline "Something went wrong" inside a panel, not a page takeover.
- [Railway, error logs](https://mobbin.com/screens/dd6801ce-350b-479d-b296-7210dbb2c252): error rows marked with a red left edge and mono timestamps.

## Premium dark dashboards

- [Supabase, observability](https://mobbin.com/screens/3826235e-4127-417b-b432-deb5599443f4): mono uppercase micro headers on blocks; quiet dark panels.
- [Plain, reporting](https://mobbin.com/screens/e892500e-f820-4e3e-af83-973bf50ed22e): info icons after metric labels, a dashed average reference line.
- [Midday, overview](https://mobbin.com/screens/973fa6a1-9e7f-4777-8429-66e9283ca007): monochrome charts on black with a minimal legend.
- [Fey, home](https://mobbin.com/screens/5c326535-4eb7-4652-855f-1c6fe9ecdb91): sector rows with value and a thin proportional bar; a watchlist drawer.

## Monograms and identity

- [Xero, contacts](https://mobbin.com/screens/44ed8739-8ccb-4d6f-a532-7a31b1fa5c5f): initials on muted squares. Our monogram fallback instead of emoji or gradients.

## Counter-examples (what not to do)

- [Dropbox Dash, knowledge base](https://mobbin.com/screens/3695f322-3bac-43a3-8e96-e589434c3031): a large gradient banner.
- [Basecamp, card table](https://mobbin.com/screens/52476c45-1afb-415f-826e-6f8ef09182df): coloured column tops that encode nothing.
- [Railway, usage tiles](https://mobbin.com/screens/00864e08-5edc-414f-9cea-ab40465e0cb7): a grid of identical KPI cards.
- [Mintlify, analytics tiles](https://mobbin.com/screens/03b084b9-d5ed-41be-a9ca-43445af854f2): a KPI card row. Fine for a dashboard, but we use one divided strip.
- [Uniswap, tokens](https://mobbin.com/screens/e39f0d0f-bed1-49ff-92e0-c53d36d34de6): rows of about 60 px.
- [OKX, BTC page](https://mobbin.com/screens/3b440768-50c7-493d-9718-7921689ece5a): a glowing neon chart line.
- [Binance, share poster](https://mobbin.com/screens/fa184fc0-d47a-4ad5-a927-fd920bc4808f): 3D coin-and-rocket illustration (keep the hierarchy, drop the art).
