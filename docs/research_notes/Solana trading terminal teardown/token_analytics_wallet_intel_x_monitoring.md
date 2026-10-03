# Solana memecoin terminal teardown: token analytics, wallet intel, wallet tracking, copy trading, X monitoring and alerts (as of Oct 2026)

*Labels used below:*
- ***[official]***: the vendor's own docs.
- ***[unofficial]***: an affiliate or third-party guide.
- ***[vendor claim]***: a marketing number nobody has verified.
- ***[inferred]***: a common heuristic or my own reasoning, not published by the tool.
- ***(search-snippet level)***: the claim came from a search-result summary rather than a full page fetch. Treat the attribution as less certain.

*Dates are given where the source shows one. GMGN's docs are undated and are probably 2024–25. Axiom's Tweet Monitor page still says "coming soon" for features, so it may be stale.*

## 1. Token audit metrics: what each means, how it is computed, what data it needs

### Takeaway
No terminal publishes exact formulas. Axiom's official docs give one-line definitions and GMGN's give qualitative ones. Concrete heuristics come from API vendors: Mobula (snipers = 0–3 blocks, bundlers = 3+ related wallets) and Solana Tracker (published risk weights). These are close enough to standardize on:
- Snipers measured by slot window.
- Bundles = same slot or same transaction.
- Insiders linked by token transfer or by funding.
- Top 10 computed without the bonding curve, pool and burn accounts.
- "Dex paid" read from DexScreener's orders endpoint.
- Authority and Token-2022 risks read from the mint account.

### Cited Findings

**Axiom (official definitions only, no formulas)**
- Pulse filters [official]:
  - Top 10 Holders %: "percentage of supply held by the top 10 wallets. Lower values indicate more decentralization."
  - Dev Holding %.
  - Snipers %: "percentage of early buyers (snipers). High sniper percentage may indicate bot activity."
  - Insiders %: "percentage held by insiders (private sales, team members)."
  - Bundle %: "percentage of supply held in bundle wallets."
  - Holders: "total number of unique wallet holders."
  - Pro Traders: "percentage of experienced traders holding or trading the token."
  - Also Age (mins), Liquidity, Volume, Market Cap, Txns, Num Buys and Num Sells.
  - The page gives no thresholds or algorithms — [Axiom Docs: Pulse](https://docs.axiom.trade/axiom/finding-tokens/pulse)
- Axiom's docs index has no page defining token-info metrics, dex paid, sounds or copy trading. The intel pages it does list are Tweet Monitor, Twitter Preview Popup, Trader Scan, Adding Wallets / Monitor Wallets, Migration Actions, Instant Trade and Similar Tokens — [Axiom llms.txt](https://docs.axiom.trade/llms.txt)
- [unofficial] An affiliate site that states it is "not the official Axiom Trade" says:
  - Axiom flags "four or more buy transactions in one block" as a possible bundle. The detector "drops wallets whose next transaction is not part of a bundle" and "applies at any point in a coin's life."
  - Pro Traders = "the share of holders trading from professional terminals."
  - Atlas = a holder map that "clusters linked wallets... with filters for exchanges and contracts."
  - Wallet funding shows "where the top wallets and the developer got their funds."
  - Source: [axiompro.app Token Scanner](https://axiompro.app/token-scanner/)
- [unofficial, search-snippet level] Third-party Axiom guides give these rules of thumb. The search summary merged several pages, so attribution to a single URL is uncertain.
  - "If the top 10 holders own over 30%, it's likely a bundled coin or dev sniped their own coin."
  - "If the dev owns more than 5%, it's risky."
  - The sniper (crosshair) icon counts traders who "have bought on the first block."
  - The insider (ghost) icon is "usually the supply that has been transferred from the dev's wallet (locked or unlocked)."
  - Sources: [Meme Coin Navigator](https://memecoinnavigator.com/best-axiom-trade-filters-for-new-pairs/); [shutdafudup Axiom guide](https://shutdafudup.com/axiom-pro-trading-guide-for-memecoin-hunters/); [Coin Bureau review](https://coinbureau.com/review/axiom-trade-review)

**GMGN (official definitions, undated)**
- Holder tags and statuses — [GMGN Docs: Insider Traders, Snipers, First 70 Buyers](https://docs.gmgn.ai/index/insider-traders-snipers-first-70-buyers):
  - Insider Traders ("Rat Traders"): "Wallets that did not buy tokens after trading opened, but hold tokens, may indicate that the token creator's holdings were transferred to multiple wallets to secretly sell off."
  - Snipers: "Buyers who purchased within the first few blocks after trading opened."
  - First 70 Buyers: "Wallets that were the first 70 to buy tokens after the opening of trading."
  - Scammer wallets: "frequently buy rug pull tokens, suspected to be secondary accounts of the token creators."
  - Per-wallet status values: Hold / Buy More / Sell Part / Sell All / Transferred ("No tokens were sold, but a portion was transferred").
- Icon definitions — [GMGN Docs: Featured Icon Definition](https://docs.gmgn.ai/index/featured-icon-definition):
  - Wallet behaviour:
    - Sniper: "buys in earlier blocks after pool created."
    - Suspected Insider: "Multiple position holders share the same creation time, funding source."
    - Insider: "has insider information and owns token earlier."
    - Bundled Tx: "Single account combines multiple wallets' txs into one tx bundle."
    - DEV Team: "Creator and bundled buyers."
  - Wallet types:
    - Fresh Wallet: "Newly created wallet."
    - BOT Trader: "Transactions made using different platforms' trading bots."
    - Bot Wallet: "Mostly sandwich attacker."
    - Smart Money: "Wallet who often earns money."
    - KOL: "Key Opinion Leader who connected X account on GMGN.AI with verified mark."
  - Token flags:
    - CTO ("community takeover").
    - DEXScreener Ad, and DEXScreener Info ("Update DEXScreener Social Infos").
    - High Liquidity ("Initial Pool Liquidity > $300K") and Low Liquidity ("< $4K").
    - Huge Value ("Transaction value greater than $10k").
    - Dev and insider holding icons (e.g. "DEV (Token creator) holds 10%").
- GMGN's OpenAPI ("skills" for AI agents):
  - Holder analysis: dev, snipers, insiders, bundlers, rat traders, fresh wallets.
  - Safety checks: honeypot detection, a 0–1 rug score, wash-trade flags, bonding-curve status, renounce checks, "500+ professional data dimensions."
  - Access: an Ed25519 key pair registered at gmgn.ai/ai. No pricing or rate limits are published.
  - Source: [GitHub GMGNAI/gmgn-skills](https://github.com/GMGNAI/gmgn-skills)
- GMGN exposes `rat_trader_amount_rate`, described as the volume share from insider/"sneak" wallets — [GMGN skills](https://github.com/GMGNAI/gmgn-skills) (search-snippet level)
- A third-party agent skill built on GMGN data had to split the top-100 holders into "normal / burn / dex." This kept the burn address and the AMM pool out of Top10/Top20, which implies GMGN's raw holder list includes them — [agent-os PR #3095](https://github.com/use-agent-os/agent-os/pull/3095)

**API vendors that publish concrete heuristics**
- Mobula — [Mobula: Detecting Snipers & Bundlers](https://docs.mobula.io/almanac/detecting-snipers-bundlers):
  - Sniper: buys "within the first few blocks (typically 0-3 blocks)." Supporting signals: same block as deployment or the next one, a fresh wallet, funded just before launch, high priority fees or MEV bundles.
  - Bundler: "3+ related wallets triggers tagging." Also: several wallets in one atomic tx, a common funder, the exact same block, or buy sizes in a tight range (e.g. all "0.5 SOL").
  - Insider: transacted directly with the deployer, was funded by the dev or known insiders, or was active before the public announcement.
  - API fields: `top10HoldingsPercentage`, `snipersHoldingsPercentage`, `bundlersHoldingsPercentage`, `insidersHoldingsPercentage`, `devHoldingsPercentage`. Per-holder labels: `sniper` / `bundler` / `insider` / `proTrader`.
  - Bands: Green = top 10 < 25%, zero bundlers, dev < 3%. Yellow = top 10 at 25–40%. Red = top 10 > 50%, snipers > 20% combined, or 10+ bundler wallets.
- Mobula's "Axiom data" cookbook (Axiom-style metrics, not Axiom's own feed):
  - Counts: `holdersCount`, `insidersCount`, `bundlersCount`, `snipersCount`, `freshTradersCount`, `proTradersCount`, `smartTradersCount`.
  - Buy counts: `freshTradersBuys`, `proTradersBuys`, `smartTradersBuys`.
  - Streamed over `wss://pulse-v2-api.mobula.io` with a free API key.
  - Source: [Mobula: Axiom data API](https://docs.mobula.io/cookbooks/axiom-data-api)
- Solana Tracker risk score — [Solana Tracker: Risk Score](https://docs.solanatracker.io/data-api/risk):
  - Additive weights normalized to a 1–10 scale; higher means riskier.
  - Authorities and liquidity: freeze authority 7,500 (danger); mint authority 2,500 (danger); LP not burned/locked 4,000; "Rugged" (no liquidity left) 20,000; very low liquidity 7,500, low liquidity 5,000.
  - Other flags: no social links 2,000; incomplete bonding curve 4,000; price −50% in 24h 1,000.
  - Concentration: single holder above 10% up to above 90% scores 2,000–7,000; top 10 above 15% scores 5,000.
  - Holder classes: snipers 10–50% scores 3,000–10,000; insiders 10–50% scores 3,000–10,000; bundlers from 1 to 1,000+ wallets score 2,000–15,000; dev 1–50% scores 1,000–10,000.
  - Fees: Meteora dynamic fee above 5% up to above 75% scores 1,000–7,500.
  - Its "Rugged" text says "Rugcheck considers the token unsafe," which suggests the model derives from RugCheck.

**Bundles vs clusters**
- Bubblemaps defines a bundle as "a set of wallets that transacted together during the token launch: typically all buying in the same block or within the same snipe window. The link is temporal and transactional." A cluster is "linked by on-chain behavior over time: shared funding sources, coordinated transfers, or recycled addresses. The link is structural and behavioral" — [Bubblemaps blog: Bundle vs Cluster](https://blog.bubblemaps.io/whats-the-difference-between-bundle-cluster-2/)
- trench.bot's bundle checker is "a simple transaction slot viewer." For each slot it shows how many unique wallets bought, the SOL they spent and how much they still hold. It warns that "two UNRELATED wallets could sometimes purchase in the same slot" (multi-wallet buys on BullX, fast copy-trading bots) — [trench.bot Bundle Scanner Guide](https://docs.trench.bot/bundle-tools/bundle-scanner-guide)

**Top-10 exclusions and thresholds**
- Concentration should "always exclude liquidity pools and known program vaults," because a raw holder list "usually shows the pool as the #1 'holder'." If the top 10 (excluding the bonding-curve contract) hold over ~30%, the token is "structurally fragile"; many rugs launch above 60% — [MemeAssist](https://memeassist.com/learn/top-holder-concentration-rug-signal)

**LP burned %**
- Graduated pump.fun tokens have migrated to PumpSwap since Mar 20, 2025 (Raydium before that). A permissionless migrate instruction creates the PumpSwap pool and burns the LP tokens. Graduation happens at ~$69K market cap (~85 SOL in the curve) — [Chainstack: listening to pump.fun migrations](https://docs.chainstack.com/docs/solana-listening-to-pumpfun-migrations-to-raydium); [StakePoint](https://stakepoint.app/blog/how-to-lock-pumpswap-lp-tokens); [SolTokenCreator](https://www.soltokencreator.io/blog/pump-fun-graduation-explained)
- Base rate: 776,306 launches vs 10,972 graduations between 2026-06-17 and 2026-07-15, a 1.41% graduation rate — [SolTokenCreator](https://www.soltokencreator.io/blog/pump-fun-graduation-explained) (search-snippet level; attribution uncertain)
- GMGN's copy-trade filters include a minimum "Pool Burnt Ratio" — [GMGN Docs: Copy Trade](https://docs.gmgn.ai/index/copy-trade-copy-smart-money-automatically-earn-sol)
- RugCheck's report summary returns `lpLockedPct` (14.62 for BONK) — [RugCheck API summary for BONK](https://api.rugcheck.xyz/v1/tokens/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263/report/summary)

**RugCheck (structure of the score)**
- RugCheck has a public Swagger at api.rugcheck.xyz with Tokens / Wallets / Stats groups, including `GET /tokens/{id}/report`, `/tokens/{id}/insiders/graph` and `/wallet/{address}/risk` — [Apidog RugCheck guide](https://apidog.com/blog/rugcheck-api/); [Qodex guide](https://qodex.ai/blog/how-to-get-a-rugcheck-api-key-and-start-using-the-api) (search-snippet level)
- The `/v1/tokens/{mint}/report/summary` endpoint responded without authentication.
  - For BONK it returned `tokenProgram`, `tokenType`, `risks[] {name, value, description, score, level}`, `score: 101`, `score_normalised: 7` and `lpLockedPct`.
  - The only risk listed was "Mutable metadata" (level `warn`, score 100, "Token metadata can be changed by the owner").
  - So scores are additive, and higher means riskier.
  - Source: [RugCheck API (BONK)](https://api.rugcheck.xyz/v1/tokens/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263/report/summary)
- **Conflict:** a third-party summary claims a 0–100 normalized score where "scores above 80 generally indicate lower structural risk." That contradicts the BONK output (normalized score 7 for a widely held token) — [Solana Compass RugCheck page](https://solanacompass.com/projects/rugcheck) (search-snippet level; attribution uncertain)
- Risk names seen on a real report: "Low amount of LP Providers", "Top 10 holders high ownership", "Large Amount of LP Unlocked", "Single holder ownership" (84.8%) and "Mutable metadata" — [RugCheck SPRK report](https://rugcheck.xyz/tokens/3mpc3aWQNDmULcGXYt3yJdkScKNrxCnwamQWcEREG7jH)

**Mint/freeze authority and Token-2022 risks**
- A permanent delegate "can transfer any amount of tokens from any account to another or even burn them" — [Solana docs: Permanent Delegate](https://solana.com/docs/tokens/extensions/permanent-delegate)
- Extensions flagged as traps:
  - `permanentDelegate`: "the single worst one."
  - `transferHook`: can "make selling fail under conditions the creator chooses."
  - `pausable`: freezes all transfers.
  - `nonTransferable`: the token can't be moved once acquired.
  - `defaultAccountState = frozen`: new accounts start frozen.
  - The guide recommends screening by reading the mint account directly (`getAccountInfo`) rather than trusting indexers.
  - Sources: [dev.to: Token-2022 traps](https://dev.to/mrwizardlyloaf/token-2022-traps-that-drain-ai-trading-agents-and-how-to-screen-them-33bo); [Neodyme: Token-2022 pitfalls](https://neodyme.io/en/blog/token-2022/)
- Open-source checkers flag Token-2022 permanent delegates and transfer fees; any transfer hook is treated as a potential honeypot — [GitHub hpark236/token-risk](https://github.com/hpark236/token-risk)

**DEX paid / boosts / CTO**
- DexScreener endpoints — [DexScreener API reference](https://docs.dexscreener.com/api/reference):
  - Paid and community features: `GET /token-profiles/latest/v1`, `/token-profiles/recent-updates/v1`, `/community-takeovers/latest/v1` (with `claimDate`), `/ads/latest/v1`, `/token-boosts/latest/v1`, `/token-boosts/top/v1`, `/orders/v1/{chainId}/{tokenAddress}`.
  - Market data: `/tokens/v1/{chainId}/{tokenAddresses}`, `/token-pairs/v1/{chainId}/{tokenAddress}`, `/latest/dex/pairs/{chainId}/{pairId}`, `/latest/dex/search`.
  - Profiles, takeovers, ads and metas are documented at 60 requests/min.
- `orders/v1` returns `[{type: "tokenProfile"|"communityTakeover"|"tokenAd"|"trendingBarAd", status: "processing"|"cancelled"|"on-hold"|"approved"|"rejected", paymentTimestamp}]` — [openSVM dexscreener-mcp-server API reference](https://github.com/openSVM/dexscreener-mcp-server/blob/main/docs/api-reference.md)
- The orders endpoint is reported at 60 requests/min. DexScreener's REST API is free and has no paid tier with higher limits — [CoinPaprika: DexScreener rate limits](https://coinpaprika.com/education/dexscreener-api-rate-limits-explained/) (search-snippet level)

**Dev history and socials**
- Creator intelligence covers deployer address, wallet age, funding, current balance, tx count and deployment history, contrasting "a locked pool held by a deployer with twenty dead launches" — [rug.tools](https://www.rug.tools/university/rug-pull-checker) (search-snippet level)
- Data for creator history:
  - Bitquery's Pump.fun API covers the launch-to-graduation lifecycle over gRPC, Kafka, WebSocket and GraphQL, with "more than two years of history" — [Bitquery Pump.fun API](https://docs.bitquery.io/docs/examples/Solana/Pump-Fun-API/)
  - Pump.fun's unofficial frontend API (`frontend-api-v3.pump.fun/coins/{mint}`) returns coin data including the creator — [community pump.fun API docs](https://mintlify.wiki/BankkRoll/pumpfun-apis/api-reference/coins/get-coin)
- Uxento advertises "Twitter History Analysis to expose rebranded scam accounts with complete name change history." Its launch post lists "Spot rebrands, fakes & real GitHub projects" and "Domain, bundle & alpha group checks" — [Uxento showcase](https://www.ruggingcommunity.com/tools/uxento/showcase/); [launch tweet](https://x.com/yassirwtf/status/1943133177599476125)
- TweetScout (now Sorsa) gives X accounts a 0–1000 score based on how many influential crypto accounts (KOLs, projects, VCs) follow them. Its API returns the score, a top-follower count and the top 20 followers — [TweetScout/Sorsa](https://tweetscout.io/); [TweetScout developer API](https://app.tweetscout.io/developer)
- Axiom's Twitter Preview Popup "only works for tweets and not actual twitter handles" — [Axiom Docs: Twitter Preview Popup](https://docs.axiom.trade/twitter-preview-popup)

**Fresh wallets**
- Nansen defines a fresh wallet as "a recently created wallet with high-volume activities." Wallet-age filters use windows such as 7 days — [Nansen](https://www.nansen.ai/post/navigating-the-crypto-tides-with-fresh-wallet-activity)
- 71% of wallets used in crypto fraud were created within 30 days before the event — [Crypto Trace Labs](https://cryptotracelabs.com/blog/on-chain-wallet-age-analysis-using-first-transaction-timing-for-attribution/)

### Inferences
- **Snipers.** The definitions conflict: Axiom guides say first block, GMGN says first few blocks, Mobula says 0–3. Use a configurable slot window, default 0–3 slots after the creation slot (or after the pool-open slot for direct pool launches). Exclude the creator and the creation-slot co-buyers; those are the bundle / "DEV Team".
- **Bundles: three signals combined.**
  - (a) Any non-dev buy in the creation slot.
  - (b) ≥4 buy txs from distinct wallets in one slot (Axiom-style), or ≥3 wallets sharing a funder (Mobula-style).
  - (c) One tx signed by several buyer wallets (GMGN "Bundled Tx").
  - Cut trench.bot-style false positives by also requiring one of: a shared funder, a tight size band, or adjacent transaction indexes within the slot.
  - [inferred] Jito bundles aren't labelled in transaction metadata. Infer them from a tip transfer to a Jito tip account plus consecutive tx indexes in the same slot.
- **Insiders.** Take the union of the published views, all computable from a per-mint trade/transfer ledger plus a funder lookup:
  - Holders who received tokens by transfer and never bought (GMGN).
  - Supply transferred out of the dev wallet (Axiom guides).
  - Wallets funded by the deployer (Mobula).
- **Holder math [inferred; standard Solana RPC behaviour].**
  - Top 10: `getTokenLargestAccounts` returns the 20 largest token accounts. Map them to owners, then drop the bonding-curve PDA/ATA, AMM vaults, burn/incinerator and lockers.
  - Exact holder count options:
    - Full scan with `getProgramAccounts` (Token program, `memcmp` mint at offset 0, `dataSize` 165). For Token-2022, drop `dataSize` because extension accounts are bigger.
    - A DAS token-accounts query.
    - A live ledger fed by gRPC account updates using the same `memcmp`.
  - Use the mint's current `supply` as the denominator.
- **Authority and Token-2022 checks cost one RPC read.** Parse the mint with `@solana/spl-token` (`unpackMint` + `getExtensionTypes`). Read the Metaplex metadata account for `isMutable` and the update authority. Cache the result per mint.
- **"Dex paid" polling.** Poll the global feeds (`/token-profiles/latest/v1`, `/community-takeovers/latest/v1`, `/token-boosts/latest/v1`, `/ads/latest/v1`) every few seconds. That catches new payments for all tokens within the 60 rpm budget. Use per-mint `orders/v1` calls only for tokens on screen.
- **Pro traders [inferred].** Most likely computed by finding fee transfers to known terminal/bot fee wallets (or their router programs) inside each swap tx. That needs a curated fee-wallet list.
- **Dev history and migration rate.** Index every launchpad `create` and `migrate` event by creator from gRPC, and backfill older history from Bitquery or pump.fun's frontend API. Migration rate = migrated ÷ created; also count launches in the last 24h. With a 1.41% base graduation rate, a dev with several migrations is a strong positive outlier.

### Gaps
- No terminal publishes its exact sniper window, bundle threshold, insider funding-hop depth, fresh-wallet age cutoff or "pro trader" algorithm. The numbers above come from vendors (Mobula, Solana Tracker) or third parties.
- I found no documentation of how Axiom shows dev history or migration rate. I didn't retrieve token-audit definitions for Photon, BullX or Padre/Terminal.
- RugCheck doesn't publish its full risk list or weights.
- DexScreener's docs page doesn't show rate limits for `/tokens/v1`, `/latest/dex/*` or `orders/v1`. The 60 rpm figure for orders is from a third party.
- I found no source describing how domain age (RDAP/WHOIS) or X handle reuse is checked. Uxento's method is undisclosed.

## 2. Wallet intel: funding tracing, clustering, labels, PnL/win rate, and which services have APIs

### Takeaway
Funding-source tracing is now available off the shelf: Helius `funded-by` returns a wallet's first incoming SOL transfer with an identity label. Clustering mostly means shared funder, shared timing and transfers within the cluster (Bubblemaps). Vendors compute PnL with weighted-average cost over swaps only. GMGN OpenAPI, Cielo, Solana Tracker (KOL leaderboard), Helius, Nansen, Arkham (x402) and Mobula can all be called from a self-hosted backend; Kolscan and Bubblemaps have no documented public API.

### Cited Findings
- Helius Wallet API (Beta) — [Helius Wallet API overview](https://www.helius.dev/docs/wallet-api/overview):
  - Endpoints: `GET /v1/wallet/{wallet}/identity`, `POST /v1/wallet/batch-identity` (≤100 addresses), `/balances`, `/balance-at`, `/history`, `/transfers`, `/funded-by`.
  - The identity data covers "32,500+ labeled accounts and programs plus 21.5M+ categorical tags" (exchanges, protocols, institutions).
  - Identity and funded-by need a paid plan; Free returns 403.
- `funded-by` — [Helius: funded-by](https://www.helius.dev/docs/wallet-api/funded-by):
  - Finds the wallet's "first incoming SOL transfer."
  - Returns `funder`, `funderName`, `funderType` (e.g. exchange), `amount`, `amountRaw`, `date`, `signature`, `timestamp`, `slot` and `explorerUrl`.
  - Listed use cases: exchange detection, and "Sybil Detection: Group multiple wallets funded by the same source."
- `funderType` uses the identity categories, which include App/Bot, Trading Firm, Transaction Sending, Treasury, Validator, Vault and X402. Each Wallet API request costs 100 credits — [Helius API reference: funded-by](https://www.helius.dev/docs/api-reference/wallet-api/funded-by) (search-snippet level)
- Bubblemaps groups wallets by funding relationships, coordinated buy/sell timing across tokens, recurrence across tokens, and internal transfers before exchange deposits — [Bubblemaps blog](https://blog.bubblemaps.io/whats-the-difference-between-bundle-cluster-2/); [CoinMarketCap on Bubblemaps](https://coinmarketcap.com/cmc-ai/bubblemaps/what-is/)
- RugCheck exposes an insider network graph (`/tokens/{id}/insiders/graph`) and a wallet risk endpoint (`/wallet/{address}/risk`) — [Apidog RugCheck guide](https://apidog.com/blog/rugcheck-api/) (search-snippet level)
- How vendors compute PnL:
  - Allium uses average cost basis. New average cost = (previous balance × previous average cost + new amount × purchase price) ÷ (previous balance + new amount). The average cost doesn't change on sales. Latest (unrealized) PnL = balance × (price − average cost). Historical PnL = realized + change in unrealized — [Allium Holdings/PnL](https://docs.allium.so/api/developer/holdings/overview)
  - Moralis uses weighted average cost and computes realized PnL only: (average sell price − average cost) × tokens sold. "Gas fees and transaction fees are not included." Unrealized PnL is left to the client (current price − average cost) × balance. Moralis covers EVM chains only — [Moralis PnL](https://docs.moralis.com/data-api/data-features/data-enrichment/profitability-pnl)
  - Birdeye computes PnL from balance changes, counting only spot swaps (not transfers or derivatives) — [Birdeye feedback board](https://birdeye.nolt.io/407)
- GMGN's portfolio skill defines win rate as the share of profitable trades over a period (0–1). "pnl" = realized_profit ÷ total_cost. Windows are 1D, 7D and 30D — [GMGN gmgn-portfolio SKILL.md](https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-portfolio/SKILL.md) (search-snippet level)
- A bug report on a GMGN-based wallet analysis found that "coins in profit" was overcounted because unsettled (open) positions were included — [agent-os issue #2797](https://github.com/use-agent-os/agent-os/issues/2797)
- Cielo API — [Cielo developer docs](https://developer.cielo.finance/); [Related Wallets endpoint](https://developer.cielo.finance/reference/getrelatedwallets):
  - Endpoint costs: Feed 5 credits (3 when filtered by wallet; double with market cap), Token PnL 5, Aggregated Token PnL 20, Trading Stats 30.
  - It also has Related Wallets and Tracked Wallets endpoints.
  - Plans: Free, Builder ($89/mo, 100k credits), Architect ($188/mo, 250k credits) and Enterprise. Pricing is search-snippet level.
- Solana Tracker's Data API exposes a KOL leaderboard at `https://data.solanatracker.io/v2/pnl/leaderboard/kols`, plus per-wallet positions and win rate — [Solana Tracker: KOL tracking](https://docs.solanatracker.io/guides/kol-tracking)
- Kolscan is a free KOL feed and PnL leaderboard, reportedly bought by Pump.fun in mid-2025 — [Kalkine Media](https://kalkinemedia.com/education/guides/kolscan-how-solanas-smart-money-gets-ranked). I found no official API; community scrapers exist — [kol-quest scrape-kolscan.ts](https://github.com/nirholas/kol-quest/blob/main/scrape-kolscan.ts)
- Arkham has 91 endpoints sold per request in USDC via x402: entity and address attribution, transfers, exchange flows, swaps and token holders. Most lookups cost a flat $0.20 — [solana-foundation/pay-skills PR #206](https://github.com/solana-foundation/pay-skills/pull/206)
- Nansen API: Pro is $49/mo with 2,000 credits, and x402 pay-per-call starts at $0.01 — [Eco support article](https://eco.com/support/en/articles/14800361-what-is-nansen-onchain-analytics-and-smart-money-explained) (secondary). It has a Smart Money endpoint — [Nansen API docs](https://docs.nansen.ai/api/smart-money)
- Birdeye reportedly offers free basic access and a $99/mo Pro plan — [Solana wallet PnL tools overview](https://crypto.techguide.org/solana-wallet-pnl-tracker) (search-snippet level; attribution uncertain)
- Solana mechanics usable for linking wallets:
  - `closeAccount` sends the reclaimed rent to a chosen destination account — [Solana docs: Close Token Account](https://solana.com/docs/tokens/basics/close-account)
  - Any signer can be the fee payer, so one wallet can sponsor fees for others — [Privy: Solana gas sponsorship](https://docs.privy.io/wallets/gas-and-asset-management/gas/solana)

### Inferences
- **Clustering heuristics [inferred], strongest first:**
  1. Same first funder (Helius `funded-by`), especially when the funder isn't a CEX.
  2. Direct SOL or token transfers between the wallets.
  3. Same fee payer.
  4. Same rent-refund destination when token accounts are closed.
  5. Buys in the same slot or at adjacent tx indexes, with near-identical sizes.
  6. The same wallet set recurring across several launches by one dev.
- **CEX funders need special handling [inferred].** Thousands of unrelated users withdraw from the same exchange hot wallet. Only link two wallets through a CEX funder if the withdrawals are close in time and similar in amount.
- **Label sources [inferred].**
  - KOLs: Solana Tracker's KOL API plus GMGN's KOL tag (X-verified) plus manual curation.
  - CEX and infrastructure: Helius identity categories.
  - Known snipers, bundlers and scammers: build our own list from the detectors in §1 and keep it persistent. GMGN's "Scammer" and "Bot Wallet" tags show that big terminals keep proprietary lists like this. I found no public dataset of known snipers.
- **PnL engine for our backend [inferred]:**
  - Track a weighted average cost in SOL per (wallet, mint), plus a USD view.
  - Include the base fee, priority fee, Jito tip and platform fee in cost. Moralis leaves gas out, but at memecoin sizes fees matter.
  - Track transferred-in tokens separately at zero cost and flag them, rather than inventing a cost basis.
  - Compute win rate per *closed* position (≥95% sold), never counting open positions. That avoids the GMGN-skill overcount bug.
- **Vendors one self-hosted user can actually call:**
  - Usable: Helius (credits), Cielo (credits), Solana Tracker (API key), GMGN OpenAPI (Ed25519 key, no published limits), Mobula (free key), RugCheck (public summary endpoint), Arkham and Nansen (x402 micro-payments).
  - Skip: Kolscan (scrape only, with ToS risk) and Bubblemaps (no API documented).

### Gaps
- I couldn't find how many KOL wallets Helius identity covers, or which Solana CEX hot wallets it labels. I didn't research the Solscan label API.
- I found no documentation or pricing for a Bubblemaps API.
- Arkham's and Nansen's Solana label depth isn't quantified anywhere I found.
- Cielo's and Birdeye's prices came from search snippets and need checking on their pricing pages.

## 3. Wallet tracker: real-time detection across all DEXes, limits, UI patterns, import/export

### Takeaway
Use one Yellowstone-compatible gRPC transaction subscription with `accountInclude` set to the tracked wallets and `vote=false`/`failed=false`, then parse swaps venue-agnostically from before/after balances. Helius LaserStream allows up to 10M account includes per stream, and compressed cuckoo filters (Triton and Helius) make very large lists cheap. Budget gRPC caps explicit lists much lower: Chainstack allows 200 accounts per filter × 5 filters. Axiom's UI pattern is: add a wallet (emoji + name + address), import lists from other tools, and show alerts and markers on charts.

### Cited Findings
- LaserStream — [Helius LaserStream FAQ](https://www.helius.dev/docs/faqs/laserstream):
  - "Up to 10 million account includes per stream, unlimited program filters."
  - Concurrent gRPC connections: Business 10, Professional 100.
  - Mainnet needs Business or Professional; devnet is included in Developer as well.
  - 48-hour replay, nine regional endpoints, drop-in replacement for Yellowstone clients.
  - Data overage: 2 credits per 0.1 MB.
- Filter fields — [Helius LaserStream subscribe reference](https://www.helius.dev/docs/api-reference/laserstream/grpc/subscribe):
  - Transaction filters: `accountInclude`, `accountExclude`, `accountRequired`, `vote`, `failed`, `signature`.
  - Token-account expansion: `token_accounts` (ALL or BALANCE_CHANGED) and `match_mints`.
  - Account filters: `memcmp`, `datasize`, `token_account_state`, `lamports`, `nonempty_txn_signature`.
  - Commitment levels: PROCESSED, CONFIRMED or FINALIZED; replay from `from_slot`.
- Beyond ~10,000 accounts, Helius suggests a compressed cuckoo filter (~3–4 bytes per account) instead of an explicit pubkey list — [Helius LaserStream docs](https://www.helius.dev/docs/laserstream) (search-snippet level)
- Triton's compressed filters for Yellowstone — [Triton blog](https://blog.triton.one/compressed-filters-for-yellowstone-grpc-track-millions-of-accounts-with-10x-less-overhead/):
  - Shipped June 2026; TypeScript support from client v5.0.9.
  - False-positive rate under 1%, re-checked client-side.
  - 1M accounts ≈ 4 MiB, against ~44 MB for an explicit list.
  - Addresses can be added or removed in O(1) without rebuilding.
- Chainstack's Yellowstone add-on caps explicit lists at 200 accounts per filter and up to 5 account filters per connection, on the $49, $149 and $449/month tiers — [Chainstack dev-portal PR #695](https://github.com/chainstack/dev-portal/pull/695); [Chainstack Yellowstone docs](https://docs.chainstack.com/docs/yellowstone-grpc-geyser-plugin)
- Helius alternatives to gRPC:
  - Enhanced WebSocket `transactionSubscribe` takes up to 50,000 addresses in `accountInclude`, with opt-in ATA expansion — [Helius transactionSubscribe](https://helius.dev/docs/api-reference/enhanced-websockets/transactionsubscribe)
  - Webhooks take up to 100k addresses per webhook on all plans — [Helius Webhooks FAQ](https://www.helius.dev/docs/faqs/webhooks)
- Detection latency by method (vendor blog dated Jul 15, 2026, updated Sep 7, 2026) — [RPC Fast: copy-trading bot playbook](https://rpcfast.com/blog/how-to-build-a-solana-copy-trading-bot):
  - Polling: hundreds of ms to seconds.
  - WebSocket: ~300 ms, "fragile under load."
  - Yellowstone gRPC: "10–40 ms."
  - gRPC + ShredStream: "5–20 ms."
- Axiom wallet tracker [official] — [Axiom Docs: Adding Wallets](https://docs.axiom.trade/wallet-tracking/adding-wallets):
  - It opens from the bottom-left corner; "Add Wallet" asks for an emoji, a name and an address.
  - Users "can directly import wallets in our custom wallet tracker using the import feature" (e.g. from BullX).
  - Charts show "live alerts while influencers and smart money wallets are buying to track confluence and hype."
- [unofficial] Axiom's tracker reportedly handles "up to 10,000 wallets" with no subscription. Buys and sells show "on charts, in columns next to Pulse, and in pop-ups" — [axiompro.app Wallet Tracker](https://axiompro.app/wallet-tracking/)
- Axiom Trader Scan [official] shows each wallet's buys, sells, current balance, realized PnL and holding time for a token. It classifies behavior as "accumulators, offloading, or flipping for gains" — [Axiom Docs: Trader Scan](https://docs.axiom.trade/trader-scan)

### Inferences
- **Venue-agnostic swap parsing [inferred; standard technique].** For each tx that touches a tracked wallet:
  - SOL delta: `preBalances`/`postBalances` at the wallet's account index, plus any WSOL token-balance change.
  - Token deltas: `preTokenBalances`/`postTokenBalances` entries whose `owner` is the wallet.
  - SOL out and token in = buy; the reverse = sell.
  - Price = |SOL change after fees| ÷ |token change|.
  - This covers the pump.fun curve, PumpSwap, Raydium, Meteora, Orca and Jupiter routes with no per-DEX decoder. Add per-DEX decoders only for venue labels and for copy trading, which needs pool accounts.
  - Classify token movements with no SOL or stablecoin leg as "transfer" events.
- **Subscription setup.**
  - Use processed commitment for alerts, then reconcile at confirmed to drop forked-out events.
  - Turn on `token_accounts: BALANCE_CHANGED` so trades routed through the wallet's ATAs still match.
  - Keep the tracked list in memory and re-check matches when using compressed filters.
- **Standard RPC websockets are a poor fallback [inferred].** `logsSubscribe` accepts only one address in `mentions`, so N wallets need N subscriptions. Prefer Helius Enhanced WS (≤50k addresses) or webhooks (≤100k).
- **Import/export format [inferred].**
  - Support JSON `{address, name, emoji, group, alerts:{buy, sell, minSol}, sound}` plus CSV.
  - Map the common export formats from Axiom, BullX and GMGN; Axiom documents importing but not its file format.
- **UI patterns:**
  - A live feed column (wallet emoji and name, token, side, SOL size, market cap at fill, age).
  - Buy/sell bubbles on charts, labelled by wallet.
  - Pop-up toasts with optional per-wallet sounds.
  - Filters: minimum SOL, buys only, first buy only, wallet group.

### Gaps
- I didn't retrieve Helius Business/Professional monthly prices.
- Axiom's official wallet cap and export format are undocumented; the 10,000 figure is unofficial.
- I didn't retrieve GMGN's or Photon's tracker limits.
- I found no independent benchmark comparing Enhanced WebSocket and gRPC latency beyond the RPC Fast vendor tiers.

## 4. Copy trading: architecture, latency, parameters, risks, and platform implementations

### Takeaway
Every implementation runs the same loop: detect the leader's swap (gRPC/ShredStream), filter, size, build and send it (priority fee plus Jito tip or MEV protection), then either mirror sells proportionally or rely on TP/SL. Competitive bots aim for detect-to-submit under ~60 ms. Retail copy trading on Trojan and GMGN exposes the same parameters: % or fixed size, a max per buy, market-cap and liquidity windows, first-buy only, platform exclusions, blacklists and copy-sell. The key risk is leaders, or devs targeting them, dumping into followers.

### Cited Findings
- Trojan Terminal copy trading [official] — [Trojan Docs: Copy Trading](https://docs.trojan.com/terminal-overview/tools-and-widgets/copy-trading-bot):
  - Sizing: a percentage of the target's buy (e.g. 10% of a 10 SOL buy = 1 SOL) or a fixed SOL amount.
  - Execution: priority fee, a "Bribe" (required with MEV protection), and slippage ("often requiring higher values" for copy trades). Sell-side settings are separate.
  - Sells: **Copy Sell** mirrors the target's sell %; **Auto Sell** places stop-loss/take-profit limit orders when the buy completes.
  - Filters: market-cap range, minimum liquidity, max spend per buy (with % sizing), exclude launchpad (bonding-curve) tokens, prevent duplicate buys.
  - Not compatible with snipers ("block latency disadvantage"), custom-program wallets or unsupported pools.
- Trojan Telegram bot [official, search-snippet level] — [Trojan Docs: Copy Trade (TG)](https://docs.trojanonsolana.com/telegram-bot-user-guide/copy-trading-crypto):
  - Requires Advanced Mode. Each copy has a Tag and a Target Wallet.
  - Max Buy works only with % sizing and applies "per transaction, NOT per token."
  - With Duplicate Buys off, only the first buy per token is copied; this resets after a full exit.
  - "Only Renounced" and "Exclude PumpFun Tokens" (bonding curve) filters; a copy-sells toggle mirrors the sell %.
- GMGN copy trade [official, undated] — [GMGN Docs: Copy Trade](https://docs.gmgn.ai/index/copy-trade-copy-smart-money-automatically-earn-sol):
  - Buy modes: Fixed Buy, and Maximum Follow-Buy (copy the leader's size up to a cap).
  - Sells: automatic follow-sell ("sold in proportion to the proportion of its position"), no follow-sell, or TP/SL on average cost. Batch TP/SL recalculates when the position grows.
  - Filters: market-cap and liquidity limits; token creation time (e.g. ≥10 s); Pool Burnt Ratio; min/max leader buy size; maximum number of position increases per token; platform filter (Pump/Raydium); blacklist of up to 20 tokens.
  - Execution: priority fee (0.002–0.006 SOL recommended), Anti-MEV, auto slippage, and a "Lightning Mode" that trades speed for "chain rollback risks."
  - Limits: at most 10 concurrent copy tasks; 1% fee per transaction; Solana only.
- Third-party guides list GMGN's buy modes as Max Buy, Fixed Buy and Fixed Ratio — [CoinCodeCap GMGN guide](https://coincodecap.com/best-settings-for-gmgn-bot); [shutdafudup GMGN guide](https://shutdafudup.com/gmgn-copy-trade-settings-and-strategy/) (search-snippet level)
- Axiom: the official docs index has no copy-trading page — [Axiom llms.txt](https://docs.axiom.trade/llms.txt). An unofficial site says Axiom "copy trading" means adding wallets to the Wallet Tracker and mirroring their buys at your own size — [tradeonaxiom.com](https://tradeonaxiom.com/axiom-trade-copy-trading/)
- BullX NEO offered copy trading; Photon reportedly does not — [SolanaTradingBots: BullX NEO vs Photon](https://solanatradingbots.com/compare/bullx-neo-vs-photon/). A search snippet says that as of Sep 16, 2026 BullX NEO is "wallet-only," with trading disabled on Solana, Ethereum, Base, BNB Chain and TRON — [SolanaTradingBots: BullX Neo](https://solanatradingbots.com/bullx-how-to-use/) (unverified)
- Pump.fun acquired Padre on Oct 24, 2025; it now runs as "Terminal" at terminal.pump.fun (Solana, Ethereum, BNB Chain, Base) — [Crypto Briefing](https://cryptobriefing.com/pump-fun-acquires-padre-trading-terminal-multi-chain-expansion/); [SolBotRank](https://solbotrank.com/guides/padre-terminal-explained)
- Reference architecture (RPC Fast, 2026) — [RPC Fast playbook](https://rpcfast.com/blog/how-to-build-a-solana-copy-trading-bot):
  - Detection: gRPC 10–40 ms; with ShredStream 5–20 ms.
  - Parsing: per-DEX instruction parsers (Raydium, Orca, Jupiter, Pump.fun).
  - Sizing: fixed, proportional (needs live leader balance), or fixed ratio with hard caps.
  - Risk controls: per-token and per-trade caps, blacklists/allowlists, honeypot checks, skip if price drifted past a threshold, duplicate and rate guards.
  - Submission: pre-signed templates, multiple relays and regions, SWQoS-staked paths.
  - Budget: under 60 ms detect-to-submit. At 800 ms latency, copies fill "18% or worse," often mirroring the leader's exit instead of their entry.
- Exploitation risk:
  - A TROLL token was marketed to KOLs; when one KOL bought, the dev dumped on the copy traders auto-following that KOL — [Yahoo Finance](https://finance.yahoo.com/news/unlucky-trader-fumbles-36-million-180210516.html) (search-snippet level)
  - Academic work describes manipulative bots that "front-run trades, conceal positions, and fabricate sentiment" to extract value from copy traders — [arXiv 2601.08641](https://arxiv.org/abs/2601.08641)
- Open-source references (unaudited; treat as untrusted code): [roswelly/solana-grpc-copy-trading-bot](https://github.com/roswelly/solana-grpc-copy-trading-bot), [outsmartchad/solana-trading-cli](https://github.com/outsmartchad/solana-trading-cli), [keidev-sol/Solana-Copy-Trading-Bot-Rust](https://github.com/keidev-sol/Solana-Copy-Trading-Bot-Rust)

### Inferences
- **Decision pipeline for our backend [inferred]:**
  1. Receive the leader's swap event (processed).
  2. Check the leader's state. Is this their first buy, if first-buy-only is on? Have they already sold in this slot or a later one?
  3. Safety gate from the cached audit: mint/freeze authority, Token-2022 extensions, top 10, bundle %, dev history.
  4. Market gate: market cap and liquidity window, token age, platform, blacklist.
  5. Drift guard: skip if the current price is more than X% above the leader's fill.
  6. Size the trade (fixed, ratio or capped follow), then apply per-trade, per-token and daily exposure caps.
  7. Build a direct program swap (pump.fun, PumpSwap, Raydium or Meteora) using accounts parsed from the leader's own tx; fall back to Jupiter.
  8. Send through a Jito bundle (with tip) and a staked RPC/SWQoS path in parallel.
  9. Confirm via the gRPC stream.
  10. When the leader sells, sell the same *fraction of our position* as the fraction of theirs they sold. TP/SL runs independently.
- **Optional delay [inferred].** Waiting for the leader's tx to reach confirmed avoids copying forked or failed trades, but costs ~1 slot.
- **Latency expectations.** A single-user bot on a shared gRPC endpoint will usually land at least one slot after the leader. Target under 100 ms detect-to-submit, with under 60 ms as a stretch goal. Trojan's sniper caveat and RPC Fast's 800 ms ≈ 18% slippage figure mean the drift guard matters more than raw speed.
- **Anti-exploitation defaults:**
  - A minimum market cap and liquidity.
  - Skip tokens that are only seconds old (GMGN's ≥10 s creation-time filter).
  - Cap copies per leader per hour.
  - Auto-pause a leader after N losing copies.
  - Never copy into tokens where the leader sits in the dev's funding cluster.

### Gaps
- I found no official copy-trading docs for Axiom or Photon. BullX's current status isn't verified by a primary source.
- Commercial copy bots don't publish their real end-to-end latency.
- The GMGN doc is undated, so parameters may have changed in 2026.
- I found no copy-trading documentation for Padre/Terminal.

## 5. X/Twitter monitoring: detection, providers, price and latency, CA extraction, auto-buy, ToS

### Takeaway
The official X API is pay-per-use in 2026: $0.005 per post read and $0.010 per user read, capped at 3M post reads a month. Its filtered stream for pay-per-use apps allows 1 connection and 1,000 rules at ~4–5 s P99 latency, far slower than the 100–200 ms memecoin trackers claim (J7, GenX, TweetStream). Third-party providers are much cheaper and offer per-account monitors, including follows and profile changes (SocialData, twitterapi.io). But X's terms ban scraping without written consent and set liquidated damages. CA extraction is base58 regex plus validation, with OCR for images, and auto-buy on tweets needs strict gating because accounts get hijacked.

### Cited Findings
- X API pricing [official] — [X API pricing](https://docs.x.com/x-api/getting-started/pricing):
  - Reads: posts $0.005 per resource; users $0.010; following/followers $0.010; likes, mutes and blocks $0.001.
  - Writes: creating a post costs $0.015, or $0.200 if it contains a URL.
  - Requests for the same resource within one 24-hour UTC day are charged once. Your own data costs $0.001 per resource.
  - Cap: "3 million Post reads per monthly billing cycle"; Enterprise above that.
- Pay-per-use timeline (secondary): launched Feb 6, 2026. Legacy Basic ($200/mo) was force-migrated after Jun 1, 2026. Legacy Pro ($5,000/mo) was deprecated, with auto-migration after Sep 1, 2026 — [Outstand](https://www.outstand.so/blog/x-api-pricing)
- Filtered stream [official] — [X Filtered Stream](https://docs.x.com/x-api/posts/filtered-stream/introduction):
  - Pay-per-use: 1 connection, 1,000 rules per project, 1,024-character rules, core operators (e.g. `from:`, `has:images`, `-is:retweet`).
  - Enterprise: 25,000+ rules and 2,048-character rules.
  - Latency: "approximately 4-5 seconds of P99 latency"; "For lower latency requirements, see Powerstream."
- twitterapi.io:
  - Pay-as-you-go: $0.15 per 1k tweets and $0.18 per 1k profiles; 1 USD = 100,000 credits; no minimum spend — [twitterapi.io pricing](https://twitterapi.io/pricing)
  - WebSocket at `wss://ws.twitterapi.io/twitter/tweet/websocket` with claimed ~1.2 s average and P99 under 2 s [vendor claim] — [twitterapi.io](https://twitterapi.io/)
  - Account-monitor plans: Starter $29/mo (6 accounts), Growth $79 (20), Professional $149 (50), Enterprise $299 (150), Enterprise Plus $499 (500). Webhook delivery costs $0.00015 per matched tweet — [twitterapi.io blog: monitor accounts](https://twitterapi.io/blog/how-to-monitor-twitter-accounts-for-new-tweets-in-real-time); [twitterapi.io blog: webhooks](https://twitterapi.io/blog/using-webhooks-for-real-time-twitter-data) (search-snippet level)
- SocialData:
  - Data API: $0.0002 per tweet or profile returned — [SocialData pricing](https://docs.socialdata.tools/getting-started/pricing/)
  - Monitor types: User Tweets, User Following (new follows), User Profile (profile changes) and Search Query — [SocialData Monitoring pricing](https://docs.socialdata.tools/monitoring/pricing/)
  - User monitors are a flat hourly fee: ~$4.99/mo each for 1–10 monitors, ~$4.49 for 11–100, down to ~$2.49 for 1,000+ — same source.
  - Search monitors cost $0.0002 per tweet plus $0.0002 per run — same source.
  - Webhooks fire "within seconds" after a tweet, follow or profile change — [SocialData](https://socialdata.tools/) (search-snippet level)
- Apify: Tweet Scraper V2 costs $0.40 per 1k tweets (paid queries must return at least 50); other actors charge $0.15–0.25 per 1k — [Apify Tweet Scraper V2](https://apify.com/apidojo/tweet-scraper); [use-apify overview](https://use-apify.com/docs/best-apify-actors/best-twitter-scrapers)
- Memecoin trackers [vendor claims]:
  - J7Tracker: "social-media tracking under 200ms" — [j7tracker.io](https://j7tracker.io/)
  - GenX (browser extension): "1,000+" accounts at "100ms–200ms"; detects newly created coins linked to influencer tweets — [Chrome Web Store: GenX](https://chromewebstore.google.com/detail/genx/gciehnfcppaoafpeegdehachdghlaoob)
  - TweetStream: 169 ms seven-day p50 from post timestamp to first server receipt; delete, pin, profile-change, follow and unfollow alerts "when available" — [TweetStream](https://tweetstream.io/crypto-twitter-alerts)
  - Uxento Vision: one feed for Twitter, Truth Social, Telegram, DEX screeners and news, plus name-change history — [Uxento showcase](https://www.ruggingcommunity.com/tools/uxento/showcase/)
  - CoreXTracker (open source): tweets, replies and profile updates — [GitHub CoreXTracker/core](https://github.com/CoreXTracker/core)
- Axiom Tweet Monitor [official] — [Axiom Docs: Tweet Monitor](https://docs.axiom.trade/tweet-monitor):
  - Free once your account has "at least 5 SOL in trading volume."
  - Scans "key crypto-related Twitter accounts in real time."
  - Lets you "Add your own twitter handles" and "Customize the notifications that you receive."
  - Lists more customization as "Coming Soon," so the page may be stale.
- CA extraction:
  - Solana addresses match `[1-9A-HJ-NP-Za-km-z]{32,44}` (base58, 32–44 characters) — [0xProcessing: match wallet addresses](https://docs.0xprocessing.com/quick-start/match-crypto-wallet-addresses) (search-snippet level)
  - Sniper parsers scan tweets for base58 CAs, detect "in under 500 ms" from receipt, and auto-buy — [Odin.tools](https://odin.tools/blog/twitter-x-solana-sniper-bot-2026)
  - Posting the CA as an image "can't stop snipers with OCR" — [MEXC News](https://www.mexc.com/en-PH/news/201990) (search-snippet level)
- Hijack risk: a news report titled "Microsoft's X Account Hijacked to Promote Clippy Meme Coin" — [Bitcoin.com News](https://news.bitcoin.com/crypto-news/microsoft-x-account-hijacked-promote-clippy-meme-coin)
- ToS:
  - Since Sep 29, 2023, X's terms forbid crawling or scraping without "prior written consent" — [TechCrunch](https://techcrunch.com/2023/09/08/x-updates-its-terms-to-ban-crawling-and-scraping)
  - The current terms set liquidated damages of $15,000 (€15,000 in EU/EFTA/UK) per 1,000,000 posts accessed in any 24 hours — [X Terms of Service (2025-05-08 PDF)](https://cdn.cms-twdigitalassets.com/content/dam/legal-twitter/site-assets/terms-of-service-2025-05-08/en/x-terms-of-service-2025-05-08.pdf) (search-snippet level)

### Inferences
- **How sub-second trackers likely work [inferred; undisclosed].** Probably pools of logged-in sessions polling X's internal timeline and notification endpoints, or enterprise feeds (Powerstream). Either way they beat the official filtered stream's 4–5 s P99. Many third-party data providers likely rely on non-official access, so they carry ToS risk for the provider and possibly for the user.
- **Detecting each event [inferred]:**
  - New tweets: from the stream or monitor.
  - Deleted tweets: keep each tracked account's last N tweet IDs, re-fetch recent timelines (or use provider delete events), and flag IDs that disappear.
  - Profile/bio changes: diff profile snapshots (name, handle, bio, avatar, banner, URL, pinned tweet), or use SocialData's profile monitor.
  - Follows: diff following lists, or use SocialData's following monitor.
- **Monthly cost for 50 tracked accounts [inferred from the prices above]:**
  - SocialData, tweets only: ≈ 50 × $4.49 ≈ $225/mo. Adding following and profile monitors roughly triples that.
  - twitterapi.io Professional: $149/mo.
  - X filtered stream with `from:` rules: ~2,000 posts/day ≈ 60k reads × $0.005 ≈ $300/mo, if stream deliveries are billed as post reads, at 4–5 s P99.
- **CA pipeline:**
  1. Collect regex candidates from tweet text, URLs (pump.fun, DexScreener, Birdeye and Jupiter links; the `pump` mint suffix) and alt text.
  2. Base58-decode each candidate and require exactly 32 bytes.
  3. Confirm with `getAccountInfo` that it is an SPL or Token-2022 mint, and prefer mints created in the last N minutes.
  4. Optionally run image OCR (e.g. tesseract.js) in parallel with a timeout.
  5. Extract tickers with `$[A-Za-z][A-Za-z0-9]{1,9}`.
- **Auto-buy gating:**
  - An author allowlist.
  - The CA must validate as a fresh mint and pass the audit.
  - A size cap and at most one buy per CA.
  - A global kill switch.
  - Optional manual confirmation for authors not on the allowlist.
  - The hijack example shows why this is needed.

### Gaps
- None of Axiom, Uxento, J7 or TweetScout documents where its X data comes from or how it detects deletions and follows.
- X doesn't say whether pay-per-use filtered-stream deliveries are billed per post, and I found no public Powerstream pricing.
- I didn't retrieve TweetScout API pricing.
- The latency numbers for twitterapi.io, J7, GenX and TweetStream are vendor claims, not independent benchmarks.

## 6. Alert delivery: in-app toasts and sounds, Telegram, Discord, browser push/PWA

### Takeaway
For one user, the binding limits are Telegram's ~1 message/s per chat and Discord's ~30 requests/min per webhook, so alerts have to be coalesced. Web Push works on desktop and Android, but on iOS only for PWAs installed to the home screen (iOS 16.4+). Axiom documents chart alerts and customizable tweet notifications but not its sound settings.

### Cited Findings
- Telegram bots [official] — [Telegram Bots FAQ](https://core.telegram.org/bots/faq):
  - Avoid sending more than one message per second to a single chat. Groups allow at most 20 messages per minute. Bulk broadcasts are capped at ~30 messages/s.
  - Paid broadcasts go up to 1,000/s, but need at least 100,000 Stars and 100,000 monthly active users.
  - Bursts eventually return 429 errors.
- Discord webhooks:
  - About 30 requests per 60 s per webhook, and 5 requests per 5 s per channel, shared across that channel's webhooks.
  - 429 responses carry `retry_after`, and `global: true` signals the 50/s global limit.
  - Sources: [discord-webhook.com](https://discord-webhook.com/en/blog/discord-webhook-rate-limits/) (secondary); [Discord developer support](https://support-dev.discord.com/hc/en-us/articles/6223003921559-My-Bot-is-Being-Rate-Limited)
- Web Push on iOS:
  - Works from iOS 16.4, but only for web apps added to the Home Screen, not Safari tabs.
  - The permission prompt must follow a direct user action; badges are supported.
  - Sources: [MobiLoud](https://www.mobiloud.com/blog/pwa-push-notifications/); [GoodBarber](https://www.goodbarber.com/blog/ios-16-4-and-web-push-notifications-a1240/)
- Axiom:
  - Tracked wallets show "live alerts" on charts — [Axiom Docs: Adding Wallets](https://docs.axiom.trade/wallet-tracking/adding-wallets)
  - Tweet Monitor lets users "Customize the notifications that you receive" — [Axiom Docs: Tweet Monitor](https://docs.axiom.trade/tweet-monitor)
  - [unofficial] Pop-ups appear next to Pulse — [axiompro.app](https://axiompro.app/wallet-tracking/)

### Inferences
- **One internal event bus feeding several outputs [inferred]:**
  - UI over WebSocket: toast; a sound per category (Web Audio API with preloaded short clips); the Notification API when the tab is hidden.
  - Telegram: a 1 msg/s per-chat token bucket; merge bursts into one digest message; inline buttons that deep-link into the terminal.
  - Discord: a queue capped at ~25/min per webhook that honors `retry_after`, with embeds batched.
  - Web Push: VAPID via the `web-push` npm package; service-worker `notificationclick` handlers deep-link back. iOS users must install the PWA first.
- **Priority classes.**
  - P0: our own copy-trade fills and failures, and auto-buy triggers.
  - P1: tracked-wallet buys over a minimum size, and new CAs from allowlisted authors.
  - P2: everything else.
  - Only P0 and P1 go to Telegram and Push.

### Gaps
- I didn't find Discord's exact per-webhook numbers in an official doc; the limits are dynamic and reported in response headers.
- Axiom's sound and notification options are undocumented.

## Implications for the build

### Takeaway
Adopt explicit, configurable metric definitions modelled on the Mobula, GMGN and Axiom-guide heuristics, computed by our own indexer from gRPC. Cross-check them against RugCheck and DexScreener. Run wallet tracking and copy trading on one shared Yellowstone-compatible gRPC transaction stream. Do X monitoring through a per-account monitor provider, kept behind an adapter because of ToS and vendor risk.

### Cited Findings
Threshold anchors used in the table below:
- Top 10: over 30% is risky ([MemeAssist](https://memeassist.com/learn/top-holder-concentration-rug-signal); [Meme Coin Navigator](https://memecoinnavigator.com/best-axiom-trade-filters-for-new-pairs/)); over 50% is red ([Mobula](https://docs.mobula.io/almanac/detecting-snipers-bundlers)).
- Dev holding: under 3% is green (Mobula); over 5% is risky (Axiom guides).
- Snipers: bought within 0–3 blocks, red above 20% (Mobula). Snipers and insiders start adding to the risk score above 10% ([Solana Tracker](https://docs.solanatracker.io/data-api/risk)).
- Bundles: ≥4 buys in one block ([axiompro.app](https://axiompro.app/token-scanner/)) or 3+ related wallets (Mobula).
- Freeze and mint authority are dangers (Solana Tracker).
- Token-2022 traps: permanentDelegate, transferHook, pausable, nonTransferable, frozen-by-default accounts ([dev.to](https://dev.to/mrwizardlyloaf/token-2022-traps-that-drain-ai-trading-agents-and-how-to-screen-them-33bo)).
- DexScreener `orders/v1` type and status values ([openSVM reference](https://github.com/openSVM/dexscreener-mcp-server/blob/main/docs/api-reference.md)).

### Inferences
**Metric definitions to adopt (v1; every number configurable):**

| Signal | Definition in our build | Bands |
|---|---|---|
| Supply basis | The mint's current `supply` | — |
| Excluded accounts | Bonding-curve PDA/ATA; AMM vaults (PumpSwap, Raydium, Meteora, Orca); burn/incinerator; lockers (shown separately as "locked"); known CEX hot wallets (shown separately) | — |
| Top 10 % | Sum of the 10 largest non-excluded owners ÷ supply | ok <20, caution 20–30, warn >30, danger >50 |
| Dev % | Creator's current balance ÷ supply, plus a status (hold / sold part / sold all / transferred) | ok <3, warn >5, danger >10 |
| Snipers | Non-dev, non-bundle wallets whose first buy was ≤3 slots after the creation (or pool-open) slot; show count and % held now | warn >10%, danger >20% |
| Bundlers | Non-dev buyers in the creation slot; OR ≥4 distinct buyers in one slot that also share a funder or a tight size band; OR several wallets in one tx. Show wallet count, % at launch and % held now | warn >10% held, danger >25% (our choice) |
| Insiders | Holders who received tokens by transfer and never bought (GMGN), plus wallets funded by the creator or the creator's funder (≤2 hops), plus anyone who received a transfer from the creator | warn >10%, danger >20% |
| Fresh wallets | Wallet first received SOL less than 7 days before its first buy, OR has ≤20 lifetime signatures. Report share of top-100 holders and % held | warn >20% held (our choice) |
| Pro traders | Traders whose swap tx pays a known terminal or bot fee wallet (curated list) | info |
| KOL / smart money | KOL = holders on the KOL list (Solana Tracker KOL API + manual curation). Smart money = our own engine: 30D realized ≥ X SOL, ≥20 closed positions, win rate ≥50% | info / positive |
| Holders | Distinct non-excluded owners with balance above dust | info |
| DEX paid / CTO / Ad / Boost | `orders/v1` contains `tokenProfile` with status `approved`; CTO = `communityTakeover` with `approved` or listed in the CTO feed; Ad = `tokenAd`; Boost = in the token-boosts feed | info |
| LP burned % | (Burned LP + LP held by the incinerator) ÷ LP minted. Canonical PumpSwap migration = burned by the protocol. Still on bonding curve = N/A | danger <90% unless locked |
| Authorities | Mint authority present → danger; freeze authority present → danger; mutable metadata → warn | — |
| Token-2022 | permanentDelegate, transferHook, pausable, nonTransferable or defaultAccountState=frozen → danger. Transfer fee >0 → warn, ≥5% → danger. mintCloseAuthority → warn | — |
| Dev history | Launches (all-time and last 24h), migrated count, migration rate, prior quick dumps or rugs | ≥3 launches/24h → warn; prior rug → danger |
| Socials | X handle reused by another mint in our DB; X account under 30 days old; handle renamed recently; website domain under 7 days old (RDAP); no socials at all | warn each |
| Risk score | Additive weights in the style of Solana Tracker, normalized to 0–100, with the RugCheck summary shown as a second opinion | — |

**Required data sources:**
- Required:
  - A Yellowstone-compatible gRPC stream: Helius LaserStream (Business plan or higher) or Triton. Chainstack only fits small lists: 200 × 5 = 1,000 wallets per connection.
  - Standard RPC: `getAccountInfo`, `getTokenLargestAccounts`, `getSignaturesForAddress`, `getProgramAccounts`/DAS.
  - DexScreener API (free).
  - A local Postgres/SQLite indexer of launchpad create/trade/migrate events and per-mint ledgers.
- Strongly recommended:
  - Helius Wallet API: `funded-by`, plus identity for CEX labels. Paid plan; ~100 credits per call.
  - RugCheck's public summary endpoint.
  - A KOL list (Solana Tracker API).
  - An X data provider behind an adapter: SocialData monitors (tweets, follows, profile changes) or twitterapi.io, with the official X filtered stream as the ToS-compliant fallback.
- Optional cross-checks: GMGN OpenAPI, Cielo, Mobula, Bitquery (dev-history backfill), and Arkham/Nansen via x402 for one-off attribution.

**Recommended pipelines:**
1. **Wallet tracking.**
   - One gRPC tx subscription: `accountInclude` = tracked wallets, `vote=false`, `failed=false`, processed commitment reconciled at confirmed, ATA expansion on.
   - Flow: balance-delta swap parser → enrichment (price, market cap, labels, audit snapshot) → event bus → outputs (UI feed, chart markers, toasts and sounds, Telegram, Discord, Push).
   - Above ~10k wallets, switch to compressed filters. Fallbacks: Helius Enhanced WS (≤50k) or webhooks (≤100k).
2. **Copy trading.**
   - Same stream → leader-state check (first buy only? already exited?) → audit gate → market gate → drift guard → sizing with caps.
   - Build a direct program swap from the leader's own tx accounts (Jupiter fallback), send via Jito and staked RPC in parallel, confirm via gRPC.
   - Mirror sells proportionally, with TP/SL alongside.
   - Target detect-to-submit under 100 ms (stretch under 60 ms). Hard caps per trade, per token and per day; auto-pause a leader after N losing copies.
3. **X monitoring.**
   - Handle list → provider adapter (new tweets, deletions via tweet-ID diff, profile diffs, follows) → dedupe → CA/ticker extraction (regex → 32-byte base58 check → on-chain mint check; OCR optional) → token audit → alert.
   - Auto-buy only for allowlisted authors, with a fresh mint that passes the audit, size caps and a kill switch.
4. **Alerts.** WebSocket to the UI. Telegram at 1 msg/s per chat with digests. A Discord queue at ≤25/min per webhook that honors `retry_after`. Web Push via VAPID; iOS needs a home-screen PWA.

### Gaps
- The thresholds marked "our choice" (bundle %, fresh-wallet %, dev-history counts, social account ages) have no external source and should be tuned on our own labelled data.
- Helius plan prices and the legal standing of third-party X providers need checking before we commit.
