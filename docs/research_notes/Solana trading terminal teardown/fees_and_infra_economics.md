# Economics of Solana memecoin trading terminals: platform fees vs. self-hosting (as of 3 October 2026)

Conventions used throughout these notes:
- **Retrieval date.** Every price, doc page and API value below was retrieved on **2026-10-03** unless a different date is given. Where a page shows its own date (for example "last updated May 20, 2026"), that date is quoted too.
- **SOL price.** **SOL = US$119.50**, from the CoinGecko simple-price API at 2026-10-03 15:36 UTC ([CoinGecko API](https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd)). DefiLlama's price feed showed $119.49 at the same time ([DefiLlama coins API](https://coins.llama.fi/prices/current/coingecko:solana)).
- **EUR to USD.** €1 = US$1.1225, the ECB reference rate for 2026-10-02 ([Frankfurter/ECB API](https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD)).
- **Labels.** "Estimate" marks every number I derived or modelled myself. Unlabeled numbers come from the cited source.
- **Scope.** Perpetuals and Hyperliquid builder fees are **out of scope**, per the user's scope change. Only spot trading is covered.
- **Search budget.** The session's web-search budget ran out partway through. Later checks were done by fetching primary pages directly (official docs, DefiLlama API, Solana RPC).

---

## 1. Per-trade platform fees, referral discounts, cashback and hidden markups (spot)

### Takeaway
Almost every major Solana terminal or bot lists **1% per buy and per sell**, charged inside the swap transaction. The effective rate is pulled down by referral discounts and volume-based SOL cashback:
- Axiom: 0.95% net down to 0.75%.
- Trojan: 1% minus 10–45% cashback, i.e. 0.90% down to 0.55%.
- Maestro: 1% minus 15–30% cashback.
- BONKbot Telemetry: 1% minus 5–25% cashback.
- Bloom: 0.9% if referred.

The cheapest programmatic options are PumpPortal's Local API at 0.5% and Jupiter Ultra at 0–10 bps. Jupiter Ultra charges **50 bps on tokens less than 24 hours old**, which covers most memecoin trades. "Hidden" costs are mostly not spreads. They are inflated default priority fees and bribes (BullX defaults to 0.01 SOL plus 0.01 SOL), surcharges such as BullX's +0.002 SOL in MEV mode, and venue-level extras such as pump.fun's mobile surcharge of up to 0.1%.

### Cited Findings

**Axiom**
- Fee: 1% base on spot trades, with SOL cashback by volume tier. Net fee and cashback per tier:

  | Tier | Net fee | Cashback |
  |---|---|---|
  | Wood (1X) | 0.95% | 0.05% |
  | Bronze (2X) | 0.90% | 0.10% |
  | Silver (2.5X) | 0.875% | 0.125% |
  | Gold (3X) | 0.85% | 0.15% |
  | Platinum (3.5X) | 0.825% | 0.175% |
  | Diamond (4X) | 0.80% | 0.20% |
  | Champion (5X) | 0.75% | 0.25% |

  Source: [Axiom docs – Axiom Fees](https://docs.axiom.trade/getting-started/fees/axiom-fees).
- Referral program: three tiers paying **30% / 3% / 2%** of Axiom's net fee. A referred user gets a **10% discount** on trading fees. Commissions are "based on Axiom's net fee – starting at 1% then adjusted for user discounts and promotions" — [Axiom docs – Referral Program](https://docs.axiom.trade/getting-started/referral-program).
- Default network settings: priority fee **0.001 SOL** and bribe **0.001 SOL**. MEV modes are Off, Reduced (via Jito) and Secure (waits for a whitelisted validator) — [Axiom docs – Solana Fees](https://docs.axiom.trade/getting-started/fees/solana-fees).
- Axiom's embedded wallets run on Turnkey (non-custodial). Turnkey's case study, dated Sept 19, 2025, cites "1M+ user wallets", "100K+ users onboarded monthly" and "$100M+ in platform revenue within 100 days" — [Turnkey case study](https://www.turnkey.com/customers/axiom-global-defi-trading-platform).

**Photon**
- Fee: a flat **1%** on every buy and sell, calculated on the SOL input for buys and on gross proceeds for sells — [SolanaBox (secondary)](https://solanabox.tools/tools/photon-sol).
- Referral discount: sources **conflict**.
  - Some secondary sources say 0.9% with a referral ([SolanaBox](https://solanabox.tools/tools/photon-sol)).
  - Others say Photon "does not currently offer a referral discount" ([PhotonGuides fee index (affiliate site)](https://photonguides.com/guides/fees/solana-terminal-fee-index)).
  - I could not reach Photon's own docs (the domain did not resolve).

**BullX NEO**
- Official docs:
  - Fee: "1% of the initial token amount, collected in SOL for every buy and sell".
  - Default priority fee **0.01 SOL** and default bribe **0.01 SOL**.
  - MEV mode adds "0.002 SOL on top of any bribe you set".
  - The docs still describe pump.fun as charging "1% protocol fee" (stale; see section 3).

  Source: [BullX NEO docs – Fees and Gas](https://bullx.gitbook.io/bullx-neo-docs/fees-and-gas).
- 0.9% if referred (secondary) — [Boxmining BullX tutorial](https://boxmining.com/bullx-tutorial/).

**GMGN**
- Fee: "GMGN only charges a 1% handling fee for a single transaction, and there are no additional charges" — [GMGN docs – Fees & Settings](https://docs.gmgn.ai/index/gmgn-fees-settings).
- Same page:
  - Anti-MEV requires a priority fee of at least 0.002 SOL.
  - Minimum priority fee and minimum tip are each 0.0001 SOL; the maximum is 2 SOL.
  - "total on-chain fee of 0.002–0.005 SOL is generally sufficient" for normal trades.
  - The page also says pump.fun charges 1% (stale).
- Referrers get rebates ("30% rebates", higher on application) — [GMGN docs – Referral](https://docs.gmgn.ai/index/referral-link).
- DefiLlama measures GMGN's Solana referral payouts at "~16% of fees" — [DefiLlama GMGN methodology](https://defillama.com/protocol/gmgn).
- A **user-side** referral discount ("up to 30%, to 0.70%") appears only on affiliate/SEO sites ([uwuu.ai](https://uwuu.ai/blog/gmgn-review)), not in GMGN's docs. **Unverified.**

**Padre → "Terminal" (owned by pump.fun)**
- Pump.fun acquired Padre on **Oct 24, 2025** and rebranded it Terminal. Before the deal Padre had more than $1B of volume, more than 35,000 users and more than $10M in fees — [Brave New Coin](https://bravenewcoin.com/insights/pump-fun-acquires-padre-trading-terminal-as-memecoin-market-cools).
- Fee: an SEO site claims a "flat 1% on every fill, with no tier table". On bonding-curve tokens you also pay pump.fun's fee — [Terminalpedia (secondary/SEO)](https://terminalpedia.com/guides/fees/terminal-fees-explained). I found no official fee page; docs.padre.gg serves the app shell.
- DefiLlama tracks cashback/referral payouts for Terminal — [DefiLlama Terminal](https://defillama.com/protocol/terminal).

**Trojan**
- Fee: "Trojan charges 1% per successful trade", with SOL cashback that rises by rank — [Trojan docs – FAQs](https://docs.trojan.com/faqs).
- Cashback: from **10%** (Degen rank) up to **45%** ("Claim 45% cashback rewards") — [Trojan docs – Ranks & Rewards](https://docs.trojan.com/trojan-arena/ranks-and-rewards).
- Referrals: five layers deep. Total revenue share is **27.5% / 32.5% / 42.5% / 47.5%** for Honors I–IV — [Trojan docs – Referral System](https://docs.trojan.com/trojan-arena/referral-system).
- "10% of Trojan's daily fees will be won by one lucky trencher" (the Jackpot). This comes out of fees, not an extra charge — [Trojan FAQs](https://docs.trojan.com/faqs).
- Older secondary sources still cite "0.9% with a referral, 1% without" — [Medium/Coinmonks](https://medium.com/coinmonks/trojan-bot-vs-bonk-bot-vs-sol-trading-bot-025b524a9c4c). The current official docs do not state a 0.9% rate.

**BONKbot / Telemetry**
- Fee: "1% fees on each successful swap transaction" — [BONKbot docs – Fee Structure](https://docs.bonkbot.io/fee-structure).
- Telemetry (the web terminal) cashback ranges from **5% (Iron) to 25% (Platinum III)** of fees, by trailing volume — [BONKbot docs – Cashback](https://docs.bonkbot.io/rewards/cashback).
  - The doc's worked example ("Trade 25k SOL … 6,250 SOL returned") is internally inconsistent. The percentages read as a share of fees.
- Referrals:
  - Telemetry: flat 30% revenue share, three levels.
  - BONKbot Telegram: 30% in month 1, 20% in month 2, 10% lifetime.

  Source: [BONKbot docs – Referrals](https://docs.bonkbot.io/rewards/referrals).
- Historically, 10% of fees went to BONK DAO for burns (secondary) — [CoinGecko Learn](https://www.coingecko.com/learn/solana-telegram-trading-bots).

**Nova**
- Fee: 1% per transaction; referrers earn 20% of fees (secondary) — [SolanaBox – Nova](https://solanabox.tools/tools/nova).
- Official docs returned HTTP 401.

**Banana Gun**
- Solana trades carry a "1 percent fee"; Ethereum is 0.5%. Banana Gun's own blog, dated July 31, 2026 — [Banana Gun blog](https://blog.bananagun.io/blog/best-solana-trading-bots-right-now).
- 40% of bot revenue (after referrals) goes to BANANA holders — [Banana Gun docs – Rewards](https://docs.bananagun.io/banana-token/rewards).

**Maestro**
- Fee: "a 1% tax on every buy and sell". On Solana, "Fees will be directly extracted in the same transaction". Solana fee wallet: `MaestroUL88UBnZr3wfoN7hqmNWFi3ZYCGqZoJJHE36` — [Maestro docs – Monetization](https://docs.maestrobots.com/sniper/monetization).
- Cashback: Bronze 15% / Silver 20% / Gold 25% / Diamond 30% of the 1% fee — [Maestro docs – Cashback](https://docs.maestrobots.com/sniper/cashback).
- Referral: 25% lifetime commission — [Maestro docs – Referral Program](https://docs.maestrobots.com/sniper/referral-program).
- Maestro Premium is **$200/month** with no swap-fee reduction (secondary) — [CoinGecko Learn](https://www.coingecko.com/learn/top-telegram-trading-bots); [Coinspot](https://coinspot.io/en/telegram-trading-bots/maestro-trading-bot/).

**Bloom**
- Fee: 1% per buy and sell, or "a reduced fee of 0.9% (10% discount)" via referral — [Bloom docs – Fees Structure](https://docs.bloombot.app/grow-with-bloom/fees-structure).
- Referred users get the 10% back as cashback. Claims open every 6 hours above a 0.1 SOL minimum — [Bloom docs – Cashback](https://docs.bloombot.app/grow-with-bloom/cashback).
- Referral: **25% / 3% / 2%**, "calculated from the standard 1% fee, regardless of any discounts" — [Bloom docs – Referrals](https://docs.bloombot.app/grow-with-bloom/referrals).

**PumpPortal (programmatic API)**
- Lightning Transaction API: **1%** per trade. Local Transaction API (you sign locally): **0.5%** per trade.
- Both fees are "calculated before any slippage". They exclude Solana network fees and pump.fun bonding-curve fees.

Source: [PumpPortal – Fees](https://pumpportal.fun/fees/).

**Jupiter Ultra**

| Pair type | Fee |
|---|---|
| Buying JUP/JLP/jupSOL | 0 bps |
| Pegged assets (LST-LST, stable-stable) | 0 bps |
| SOL–stable | 2 bps |
| LST–stable | 5 bps |
| All other pairs | **10 bps** |
| **New tokens (within 24 hours)** | **50 bps** |

- Jupiter takes **20% of integrator fees**.
- The Ultra Swap API "is no longer actively maintained and has been superseded by Swap V2".

Source: [Jupiter Ultra – Fees](https://developers.jup.ag/docs/ultra/fees).

- Swap V2: the Meta-Aggregator path carries a "Jupiter platform fee" (bps not published on the page). The Router path has "No" Jupiter platform fee; integrators may add `platformFeeBps` — [Jupiter Swap V2 docs](https://developers.jup.ag/docs/swap).

**Other venue-level markups**
- Pump.fun: "Mobile users may experience fee increases of up to .1% on certain transactions" — [pump.fun fee docs](https://pump.fun/docs/fees). DefiLlama tracks "pump.fun Mobile App" fees separately ($16.0M in 2026 YTD) — [DefiLlama API](https://api.llama.fi/summary/fees/pump.fun-mobile-app?dataType=dailyFees).
- Raydium referral links/Blinks pay the link sharer **1% of every swap** made through the link — [Raydium docs – Referrals & Blinks](https://docs.raydium.io/user-flows/referrals-and-blinks).
- LaunchLab token-page referrals pay **0.1%** — [Raydium docs – LaunchLab referral](https://docs.raydium.io/user-flows/earn-referral-fees-launchlab).

### Inferences
- **Effective net fees for an active trader (Oct 2026).**

  | Platform | Effective net fee |
  |---|---|
  | Axiom | 0.75–0.95% (0.855% if referred at Wood: 0.95% × 0.9, assuming the discount applies to the net fee) |
  | Trojan | 0.55–0.90% |
  | Maestro | 0.70–0.85% |
  | BONKbot Telemetry | 0.75–0.95% |
  | Bloom | 0.90% if referred |
  | GMGN, Photon | 1% |
  | PumpPortal Local | 0.5% |
  | Jupiter Ultra | 0.1–0.5% |

  These are derived from the cited tier tables.
- **Hidden markups.** I found no evidence of hidden price spreads in official docs. The material "hidden" costs are:
  - High default gas and bribes. BullX defaults to 0.02 SOL per trade before MEV mode, which is about $2.39 per side at $119.50.
  - Jupiter Ultra's 50 bps on fresh tokens.
  - Pre-slippage fee calculation (PumpPortal).
  - Venue surcharges (pump.fun mobile, Raydium referral links).
- **Stale docs.** BullX and GMGN docs still quote pump.fun at 1%. Users reading them underestimate protocol costs; the current bonding-curve fee is 1.25% (section 3).

### Gaps
- No official fee page was reachable for Photon, Nova or Terminal (Padre). Their fee rates rest on secondary or SEO sources plus DefiLlama methodology.
- GMGN's user-side referral discount is unverified.
- I did not verify per-terminal fee transfers on-chain (for example, checking that fee-wallet transfers equal 1.000% of input).

---

## 2. Revenue and volume of these platforms, 2025–2026: what the community pays in aggregate

### Takeaway
On Solana alone, trading apps and Telegram bots collected **$59.0M in fees in the 30 days to Oct 2–3, 2026** and **$476.1M over the trailing year**, per DefiLlama. Platforms kept $38.0M and $294.8M after cashback and referrals. Axiom dominates: **$760M lifetime fees, $460M revenue**, peaking at $92.7M of fees in May 2025.

The 2024–25 incumbents have collapsed:
- Photon: $254M in 2024 to $8.4M in 2026 YTD.
- BullX: about $0.
- Banana Gun: about $0.
- BONKbot: $3.3M in 2026 YTD.

Meanwhile fomo and pump.fun's own Terminal grew. **Protocol fees paid on memecoin venues (pump.fun plus PumpSwap: $157M in 30 days) are about 2.7× all terminal fees.** That is the cost a zero-fee terminal cannot remove.

### Cited Findings

All figures below come from DefiLlama's fees/revenue API (daily series aggregated by me), retrieved 2026-10-03, with data through 2026-10-02. Endpoints:
- Per protocol: `https://api.llama.fi/summary/fees/<slug>?dataType=dailyFees|dailyRevenue`
- Solana-only overview: [DefiLlama Solana overview API](https://api.llama.fi/overview/fees/solana?dataType=dailyFees)

**Solana-only aggregate, categories "Trading App" plus "Telegram Bot"**
- Fees: 24h $2.49M; **30d $59.0M**; **1y $476.1M**.
- Revenue: 30d $38.0M; 1y $294.8M.
- 30-day Solana fees by platform:

  | Platform | 30d Solana fees |
  |---|---|
  | Axiom | $31.22M |
  | fomo | $13.64M |
  | GMGN | $6.33M |
  | Terminal | $5.32M |
  | Trojan | $1.05M |
  | Maestro | $0.38M |
  | Photon | $0.34M |
  | BONKbot | $0.11M |

  Source: [DefiLlama Solana fees](https://defillama.com/fees/chain/solana). Bloom is classed as "Gaming" by DefiLlama and is excluded from this sum.

**Per-platform fees (all chains), 2024 / 2025 / 2026 YTD**

| Platform | 2024 | 2025 | 2026 YTD | All-time fees | All-time revenue | Peak month |
|---|---|---|---|---|---|---|
| [Axiom](https://defillama.com/protocol/axiom) | — | $546.7M (rev $352.2M) | $213.6M (rev $108.1M) | $760.3M | $460.3M | May 2025: $92.7M fees / $61.3M rev |
| [GMGN](https://defillama.com/protocol/gmgn) | $25.4M | $137.0M (rev $118.4M) | $172.5M (rev $139.6M) | — | — | — |
| [Photon](https://defillama.com/protocol/photon) | $254.1M | $179.4M | $8.4M | $441.9M | — | Jan 2025: $84.6M |
| [Trojan](https://defillama.com/protocol/trojan) | $126.8M | $87.3M | $13.6M | $227.7M | $169.6M | — |
| [BullX](https://defillama.com/protocol/bullx) | $96.0M | $106.4M | $0.6M | $203.0M | — | Jan 2025: $54.6M |
| [BONKbot](https://defillama.com/protocol/bonkbot) | $66.9M | $20.7M | $3.3M | $95.0M | $62.2M | — |
| [Banana Gun](https://defillama.com/protocol/banana-gun) | $58.3M | $22.5M | $0.6M | $87.1M | — | — |
| [Maestro](https://defillama.com/protocol/maestro) | $57.0M | $45.1M | $10.6M | $144.6M | — | — |
| [Bloom](https://defillama.com/protocol/bloom-trading-bot) | $9.3M | $50.3M | $3.2M | — | — | Jan 2025: $20.1M |
| [Terminal](https://defillama.com/protocol/terminal) (ex-Padre) | — | $6.9M (from Oct 2025) | $37.9M (rev $21.2M) | — | — | Jan 2026: $6.3M |
| [Padre](https://defillama.com/protocol/padre) (pre-acquisition) | — | $10.3M | — | — | — | — |
| [fomo](https://defillama.com/protocol/fomo-wallet) | — | $4.3M | $76.8M (rev $70.9M) | — | — | — |
| [Nova](https://defillama.com/protocol/nova) | — | $0.3M | ~$0 | — | — | — |

Notes on the table:
- **Axiom September 2026:** $37.5M of fees, split Solana $29.99M, Robinhood Chain $6.97M, BSC $0.50M.
- **GMGN September 2026:** $48.7M, but mostly non-Solana: Robinhood Chain $27.69M, BSC $12.72M, Solana only $6.06M. GMGN's Solana fees in 2026 YTD were $34.05M.
- **Trojan** revenue by year: $92.9M (2024), $66.6M (2025), $10.1M (2026).
- **BullX** revenue has been about $0/month since April 2026.
- **Banana Gun** 2025 fees on Solana were $10.14M.
- **Maestro** 2026 revenue was $7.8M. Solana fees were $19.38M in 2025 and $3.55M in 2026 YTD.
- **Padre**'s data series ends 2025-10-24, the acquisition date.
- **fomo September 2026:** $35.0M of fees, split Robinhood Chain $16.51M, Solana $12.9M.

**Share of gross fees kept as revenue, 2026 YTD** (my calculation from the figures above)

| Platform | Revenue ÷ fees |
|---|---|
| Axiom | 50.6% (≈49% paid back as cashback plus referrals) |
| GMGN | 80.9% |
| Trojan | 74% |
| Terminal | 56% |
| Maestro | 74% |
| BONKbot | 73% |
| Bloom | 87.5% |
| fomo | 92% |

DefiLlama's methodology defines Axiom revenue as "fees retained by Axiom after deducting referral and cashback payouts" — [DefiLlama Axiom](https://defillama.com/protocol/axiom).

**Protocol- and venue-level fees for comparison (Solana, 30 days)**
- pump.fun: **$47.97M**. 2025 fees were $619.5M (revenue $584.1M); 2026 YTD fees $315.0M (revenue $240.5M) — [DefiLlama pump.fun](https://defillama.com/protocol/pump.fun).
- PumpSwap: **$109.21M**. 2025 $361.5M; 2026 YTD $550.3M, including LP and creator fees — [DefiLlama PumpSwap](https://defillama.com/protocol/pumpswap).
- Raydium AMM: $35.11M.
- Meteora DLMM: $26.14M.
- Jupiter Aggregator: $3.77M.
- Phantom Wallet: $7.00M.

  Source for the last four: [DefiLlama Solana overview API](https://api.llama.fi/overview/fees/solana?dataType=dailyFees).

**Jito MEV tips (total tips paid)**
- 2024: $668.5M. 2025: $716.6M. 2026 YTD: **$43.5M**.
- Monthly: January 2025 $292.1M vs September 2026 **$5.1M**.

Source: [DefiLlama Jito MEV Tips](https://defillama.com/protocol/jito-mev-tips).

### Inferences
- **Implied September 2026 Solana spot volume** (estimate: fees ÷ gross fee rate of ~0.95–1%):

  | Platform | Implied volume |
  |---|---|
  | Axiom | ≈ $3.0–3.2B |
  | GMGN (Solana) | ≈ $0.6B |
  | Terminal | ≈ $0.5B |
  | Trojan | ≈ $0.1B |

  fomo's fee rate is not established here, so its volume is not inferred.
- **Who pays what.** In aggregate the Solana memecoin community paid ~$59M/month to terminals. A further ~$157M/month went to pump.fun and PumpSwap protocol fees, which also go to LPs and creators. A zero-fee terminal removes the first bucket for its users, not the second.
- **The tip market has shrunk.** Jito tips fell about 98% from January 2025 to September 2026. Some of this is memecoin activity cooling; some is tip flow spreading to other landing services (see section 3's on-chain sample).

### Gaps
- DefiLlama adapters can break. BullX and Banana Gun near-zero 2026 values could be adapter gaps rather than true zero activity. I did not cross-check against Dune.
- No Dune, Blockworks or Artemis figures were collected; the search budget was exhausted.
- User counts per terminal were not obtained, so average fees per user are unknown.

---

## 3. Fees that remain with zero platform fee (protocol, network, tips, rent)

### Takeaway
A zero-platform-fee user still pays:
1. **Venue fees.** The pump.fun bonding curve charges 1.25% per side (0.95% protocol plus 0.30% creator). PumpSwap charges **1.25% down to 0.30%** depending on market cap. Most Raydium pools charge 0.25%.
2. The **5,000-lamport base fee** per signature.
3. **Priority fees and tips.** These are tiny for a tuned client but large at terminal defaults.
4. **Token-account rent**, now **0.00148844 SOL** per account. Rent is refundable.

On-chain on Oct 3, 2026 the median successful pump.fun curve trade paid about **0.000015 SOL** in network fees. Jito's tip floor median was **0.00001 SOL**. Terminal defaults of 0.002–0.022 SOL per side are therefore 100–1,000× what the network requires in calm periods. For small trades they matter more than the platform fee.

### Cited Findings

**pump.fun bonding curve** (page "Last updated: May 20, 2026")
- Creator fee 0.300% + protocol fee 0.95% + LP 0% = **1.25%** total.
- Graduation fee 0.015 SOL. Coin creation is free.
- "does not charge frontend fees beyond those listed", except the mobile surcharge of up to 0.1%.

Source: [pump.fun – Fees](https://pump.fun/docs/fees).

**PumpSwap canonical pools, SOL-denominated, by market cap in SOL** (same page)

| Market cap (SOL) | Creator | Protocol | LP | Total |
|---|---|---|---|---|
| 0–420 | 0.300% | 0.930% | 0.020% | 1.250% |
| 420–1,470 | 0.950% | 0.050% | 0.200% | 1.200% |
| 1,470–2,460 | 0.900% | 0.050% | 0.200% | 1.150% |
| 2,460–3,440 | 0.850% | 0.050% | 0.200% | 1.100% |
| 3,440–4,420 | 0.800% | 0.050% | 0.200% | 1.050% |
| 4,420–9,820 | 0.750% | 0.050% | 0.200% | 1.000% |
| 9,820–14,740 | 0.700% | 0.050% | 0.200% | 0.950% |
| 14,740–19,650 | 0.650% | 0.050% | 0.200% | 0.900% |
| 19,650–24,560 | 0.600% | 0.050% | 0.200% | 0.850% |
| 24,560–29,470 | 0.550% | 0.050% | 0.200% | 0.800% |
| 29,470–34,380 | 0.500% | 0.050% | 0.200% | 0.750% |
| 34,380–39,300 | 0.450% | 0.050% | 0.200% | 0.700% |
| 39,300–44,210 | 0.400% | 0.050% | 0.200% | 0.650% |
| 44,210–49,120 | 0.350% | 0.050% | 0.200% | 0.600% |
| 49,120–54,030 | 0.300% | 0.050% | 0.200% | 0.550% |
| 54,030–58,940 | 0.275% | 0.050% | 0.200% | 0.525% |
| 58,940–63,860 | 0.250% | 0.050% | 0.200% | 0.500% |
| 63,860–68,770 | 0.225% | 0.050% | 0.200% | 0.475% |
| 68,770–73,681 | 0.200% | 0.050% | 0.200% | 0.450% |
| 73,681–78,590 | 0.175% | 0.050% | 0.200% | 0.425% |
| 78,590–83,500 | 0.150% | 0.050% | 0.200% | 0.400% |
| 83,500–88,400 | 0.125% | 0.050% | 0.200% | 0.375% |
| 88,400–93,330 | 0.100% | 0.050% | 0.200% | 0.350% |
| 93,330–98,240 | 0.075% | 0.050% | 0.200% | 0.325% |
| 98,240+ | 0.050% | 0.050% | 0.200% | 0.300% |

- USDC-denominated pools follow the same structure: 1.25% at 0–59,000 USDC market cap, falling to 0.30% at 20M+ USDC. Non-canonical PumpSwap pools charge 0.30% (0.05% protocol + 0.25% LP) — [pump.fun – Fees](https://pump.fun/docs/fees).
- At SOL = $119.50, the tier boundaries 420 SOL ≈ $50K, 9,820 SOL ≈ $1.17M and 98,240 SOL ≈ $11.7M market cap (my conversion).
- DefiLlama's pump.fun methodology mentions a "creator/cashback slice" and "Mayhem-mode fees" — [DefiLlama pump.fun](https://defillama.com/protocol/pump.fun). The fee page itself describes no trader cashback.

**Other venues and aggregators**
- Raydium: "0.25% on most pools (some tiers offer 0.01%, 0.05%, or 1%)". Its FAQ puts the network fee at ~0.0005–0.002 SOL — [Raydium FAQ](https://docs.raydium.io/getting-started/faq).
- Meteora DAMM v2 and Dynamic Bonding Curve (DBC) fees are configurable per pool: fixed, time-scheduler or market-cap-scheduler base fees, plus optional dynamic (volatility) fees — [Meteora DAMM v2 fees](https://docs.meteora.ag/core-products/damm-v2/fees/overview); [Meteora DBC](https://docs.meteora.ag/core-products/dbc/what-is-dbc).
- Aggregators: Jupiter Ultra charges 10 bps (50 bps on tokens under 24h old). The Swap V2 Router path has no Jupiter platform fee — [Jupiter Ultra fees](https://developers.jup.ag/docs/ultra/fees); [Jupiter Swap V2](https://developers.jup.ag/docs/swap).

**Network base fee, rent and chain throughput**
- Rent: the Rent sysvar on mainnet reads `"lamportsPerByte": "5080"`, which gives:
  - Token account (165 bytes + 128 overhead): 1,488,440 lamports = **0.00148844 SOL** (≈ $0.178).
  - Zero-byte account: 650,240 lamports.

  These are my reads via `getAccountInfo(SysvarRent…)` and `getMinimumBalanceForRentExemption(165)` on the public RPC ([Solana RPC docs](https://solana.com/docs/rpc/http/getminimumbalanceforrentexemption)).
- 5,080 is **step 2** of SIMD-0437's five-step rent reduction (6,960 → 6,333 → **5,080** → 2,575 → 1,322 → 696 lamports/byte) — [SIMD-0437](https://github.com/solana-foundation/solana-improvement-documents/blob/main/proposals/0437-incremental-rent-reduction.md).
  - The old token-account rent was 0.00203928 SOL. Trojan's FAQ still says "about 0.002 SOL … refundable after you sell" — [Trojan FAQs](https://docs.trojan.com/faqs).
- Throughput (`getRecentPerformanceSamples`, 30 × 60 s samples ending ~15:50 UTC Oct 3, 2026) — [Solana RPC docs](https://solana.com/docs/rpc/http/getrecentperformancesamples):
  - Slot time **0.267 s**, about 323,000 slots/day.
  - 4,273 tx/s total, 1,767 non-vote tx/s (152.6M non-vote tx/day).
  - The node reported `solana-core 4.3.0`.
- Transaction **version 1** now exists on mainnet. `getBlock` fails unless `maxSupportedTransactionVersion: 1` is set (my observation, via the public RPC).

**Jito tip floor snapshot** (2026-10-03 15:37:53 UTC)

| Statistic | Landed tip |
|---|---|
| 25th percentile | 0.000002343 SOL |
| **50th percentile** | **0.00001 SOL** |
| 75th percentile | 0.000025775 SOL |
| 95th percentile | 0.0001 SOL |
| 99th percentile | 0.0001 SOL |
| EMA of 50th percentile | 0.0000116 SOL |

Source: [Jito tip_floor API](https://bundles.jito.wtf/api/v1/bundles/tip_floor).

**Helius Sender minimum tips**
- **Sender Max: 0.001 SOL.** Enters a "priority tip buffer for top of block" and routes via Helius, Jito, Harmonic, Rakurai and others.
- **SWQOS-only: 0.000005 SOL**, enabled with `?swqos_only=true`.
- Tips between the two minimums are "accepted but do not enter the priority tip buffer".
- A priority fee is also mandatory.

Source: [Helius Sender docs](https://www.helius.dev/docs/sending-transactions/sender); [Sender SWQOS-only](https://www.helius.dev/docs/sending-transactions/sender-swqos-only).

An older search snippet cited a 0.0002 SOL "dual routing" minimum ([Helius Sender docs via search](https://www.helius.dev/docs/sending-transactions/sender)). The current page lists only the two tiers above.

**Terminal and bot gas defaults**

| Platform | Default / guidance |
|---|---|
| Axiom | 0.001 SOL priority + 0.001 SOL bribe ([Axiom docs](https://docs.axiom.trade/getting-started/fees/solana-fees)) |
| BullX | 0.01 SOL priority + 0.01 SOL bribe, + 0.002 SOL in MEV mode ([BullX docs](https://bullx.gitbook.io/bullx-neo-docs/fees-and-gas)) |
| GMGN | 0.002–0.005 SOL total for normal trades; ≥0.006 SOL for automated orders ([GMGN docs](https://docs.gmgn.ai/index/gmgn-fees-settings)) |
| Banana Gun | Docs example: 0.001 Buy Gas on top of a 0.0001 SOL base = 0.0011 SOL ([Banana Gun Solana docs – Gas Settings](https://banana-gun.gitbook.io/banana-gun-solana/trading/settings/gas-settings)) |

**On-chain sample: what pump.fun and PumpSwap trades actually paid**

Method (my own measurement): 30 blocks via `getBlock` (jsonParsed, `maxSupportedTransactionVersion: 1`), every 60th slot from slot 452,976,264 to 452,978,004. That is **2026-10-03 15:38:42–15:46:26 UTC**, a Saturday. The sample covered 37,078 transactions, of which **6,695 touched the pump.fun or PumpSwap programs**. Tips were matched against:
- Jito's 8 tip accounts, from `getTipAccounts` ([Jito block engine](https://mainnet.block-engine.jito.wtf/api/v1/bundles)).
- Helius Sender's 10 tip accounts ([Helius Sender docs](https://www.helius.dev/docs/sending-transactions/sender)).

Results:

| | pump.fun bonding curve | PumpSwap |
|---|---|---|
| Transactions | 2,324 | 4,371 |
| Success rate | **31.8%** (68% failed; bot competition) | 75.8% |
| Network fee (base + priority), successful txs | p25 0.000009 · **p50 0.000015** · p75 0.000105 · p90 0.00031 · p99 0.0015 · mean 0.000157 SOL | **p50 0.000005** (base only) · p90 0.000015 · p99 0.000956 SOL |
| Jito tip (txs paying one) | 13.4% of successful txs; p50 0.00001 · p90 0.001 SOL | 9.2%; p50 0.000004 SOL |
| Helius Sender tip (txs paying one) | 12.7%; p50 0.00001 · p90 0.001 SOL | 1.2% |
| Compute units | p50 99,837 · p90 170,278 | — |
| Fee on a failed tx | p50 0.000006 SOL | — |

Other frequent signer-to-third-party SOL transfers in the sample were apparent tips to other landing services. The service names are inferred from vanity prefixes and are not verified against provider docs:
- 10 "Fa1con…" accounts, about 70 transfers each, all of exactly **0.002 SOL**.
- "TEMPaMe…" (median **0.05 SOL**) and "nozn…" (median 0.0238 SOL). These look like Temporal/Nozomi.
- "astra…" and "AsTRA…" (medians 0.0153 and 0.0013 SOL). These look like Astralane.
- Several "ste11…" and "Sp…" accounts (median 0.002 SOL).

### Inferences
- **The network floor is negligible in calm conditions.** The median successful pump.fun curve trade paid ~0.000015 SOL (≈ $0.0018) of network fees. A self-hosted client using Sender SWQOS-only (0.000005 SOL tip) plus a modest priority fee (~0.0001 SOL) costs ≈ 0.0001 SOL/side, about $0.013 (estimate). Contested launches justify much higher tips, as the 0.002–0.05 SOL tips to Falcon, Temporal and Nozomi accounts show.
- **Worked round trips (buy and sell, pump.fun curve, SOL = $119.50; estimates):**

  | Trade size (per side) | Setup | Platform | Protocol | Network | Total | Share of size |
  |---|---|---|---|---|---|---|
  | 1 SOL | Platform 0.95% + Axiom defaults | 0.019 | 0.025 | 0.00401 | **0.04801 SOL** ($5.74) | 4.80% |
  | 1 SOL | Self-hosted, 0% platform, SWQOS-only tuned | 0 | 0.025 | 0.00022 | **0.02522 SOL** ($3.01) | 2.52% |
  | 0.1 SOL | Axiom defaults | 0.0019 | 0.0025 | 0.00401 | — | **8.41%** ($1.00) |
  | 0.1 SOL | BullX defaults | 0.0019 | 0.0025 | 0.04401 | — | **48.4%** |
  | 0.1 SOL | Self-hosted tuned | 0 | 0.0025 | 0.00022 | — | **2.72%** ($0.33) |

  Platform, protocol and network columns are in SOL.
- **Rent is not a cost** if the terminal closes empty token accounts after selling. Each close returns 0.00148844 SOL. The terminal should do this automatically or offer a "reclaim rent" action.
- **Failed transactions cost money.** About 68% of pump.fun curve transactions failed in the sample. Failed transactions still pay base and priority fees; tips inside a failed transaction revert with it. A client that avoids spamming duplicates saves money.

### Gaps
- My on-chain sample covers about 8 minutes on a Saturday. A weekday or launch-mania distribution will be higher.
- Tip classification beyond Jito and Helius is heuristic.
- No historical tip-floor time series was collected; the Jito API returns only the current snapshot.
- I did not compute a priority-fee distribution for retail-terminal transactions specifically, as opposed to bots.
- Orca Whirlpool fee tiers and Raydium LaunchLab's bonding-curve fee rate were not fetched.

---

## 4. Infrastructure pricing in 2026: RPC, gRPC, shreds, data APIs, X data, servers, and free tiers

### Takeaway
Real-time Solana data is now cheap at the low end:
- Chainstack Yellowstone gRPC from **$49/month** (on top of a $49 Growth plan).
- Solana Vibe Station gRPC at **$150/month**.
- Shyft from **$199/month** with unmetered streaming.
- ERPC gRPC at **€198/month**.
- Alchemy at **$75 per TB** streamed with no minimum.

Helius gates mainnet LaserStream gRPC behind **Business ($499)**. QuickNode includes gRPC from **Scale ($499)**. Jito ShredStream **shut down Sept 5, 2026**; the successor, DoubleZero Edge, costs **$450–1,500 per IP per month** after a free trial. X data is now pay-per-use at **$0.005 per post read**. Hetzner cloud prices **rose 2.1–2.75×** on June 15, 2026.

### Cited Findings

**Helius** (full detail in section 5)

| Plan | Price | Credits | RPS |
|---|---|---|---|
| Free | $0 | 1M | 10 |
| Developer | $49 | 10M | 50 |
| Business | $499 | 100M | 200 |
| Professional | $999 | 200M | 500 |

- Overage $5 per million credits.
- Dedicated nodes "Starting from $2,900/mon".
- Raw shreds $1,000/month per IP ($800 on Professional).

Source: [Helius pricing](https://www.helius.dev/pricing); [Helius billing docs](https://www.helius.dev/docs/billing/plans).

**Triton One**
- $125 minimum deposit, "prepaid, non-refundable, and valid for 12 months".
- Standard RPC and unary gRPC: $0.08/GB + $10 per million calls. Streaming: $0.08/GB.
- Shred streaming: "From $450 / month or $0.18 per 15 min PAYG, per IP per data centre".
- Preconfs (Jito BAM): $50 per million messages.
- Dedicated node pricing is not published.

Source: [Triton pricing](https://triton.one/pricing).

**QuickNode**

| Plan | Price | Credits | RPS | Overage |
|---|---|---|---|---|
| Free trial | $0 | 10M | 15 | — |
| Build | $49 | 80M | 50 | $0.62/M |
| Accelerate | $249 | 450M | 125 | $0.56/M |
| Scale | $499 | 950M | 250 | $0.53/M |
| Business | $999 | 2B | 500 | $0.50/M |

- Annual billing is 15% cheaper.

Source: [QuickNode pricing](https://www.quicknode.com/pricing).
- Solana gRPC has been included on Scale and Business since **June 1, 2026**, and is a $499/month add-on below that.
  - Metering: **10 API credits per 0.1 MB** delivered.
  - Stream limits: Scale 10 streams × 10 accounts per stream; Business 25 × 50.

  Source: [QuickNode blog, June 1, 2026](https://www.quicknode.com/blog/solana-grpc-is-now-included-with-scale-and-business-plans).

**Chainstack**

| Plan | Price | Request units | RPS |
|---|---|---|---|
| Developer | $0 | 3M | 25 |
| Growth | $49 | 20M | 250 |
| Pro | $199 | 80M | 400 |
| Business | $499 | 200M | 600 |
| Enterprise | $990+ | — | — |

- Warp transactions: $0.15 each.
- Unlimited-node add-on: $149 (25 RPS) up to $3,199 (500 RPS).

Source: [Chainstack pricing](https://chainstack.com/pricing/).
- Yellowstone gRPC add-on, Growth plan and above:
  - **$49/month = 2 streams** and **$149/month = 7 streams**, previously 1 and 5 (article updated Jul 6, 2026) — [Chainstack blog](https://chainstack.com/yellowstone-grpc-more-streams-same-price/).
  - $449/month = 25 streams — [Chainstack pricing](https://chainstack.com/pricing/).
  - The pricing page still shows 1/5 streams, so the two sources **conflict**.

**Shyft** (credit-free model)

| Plan | Price | RPC req/s | gRPC |
|---|---|---|---|
| Free | $0 | 10 | No |
| Build | $199 | 100 | Yes |
| Grow | $349 | 150 | Yes |
| Accelerate | $649 | 400 | Yes |

- Streaming is unlimited and unmetered.
- Dedicated gRPC nodes "Starting from $1800/mo".
- Extra connections: $100 per 10.

Source: [Shyft pricing](https://shyft.to/solana-rpc-grpc-pricing).

**Alchemy**
- Solana gRPC: "$75 per terabyte" streamed. "No plan prerequisite, no minimum monthly commit".
- Regions: US East, US West, EU Central, Asia-Pacific.

Source: [Alchemy Solana gRPC](https://www.alchemy.com/solana-grpc).

**ERPC (ELSOUL LABO / Validators DAO)**
- RPC plans: Developer €42/month (42M tokens, 50 req/s), Business €298, Pro €598.
- Geyser gRPC Standard: €198/month (1 IP whitelist, max 10 streams). Bundles €298–€980.
- Dedicated gRPC: €1,580–€2,980.
- ShredStream Standard: €198/month.
- VPS: €42/month (1 vCPU, 4 GB).
- Bare metal: SLV Metal APP+ €298 (Ryzen 7950X, 128 GB); SLV Metal MV €798 (24-core EPYC, 384 GB).

Source: [ERPC pricing](https://erpc.global/en/price/).

**Solana Vibe Station**
- RPC (monthly): Lite $40, Basic $75, Ultra $150, Elite $300, Epic $500.
- Staked RPC: Basic $300, Ultra $500, Elite $1,000.
- Geyser gRPC: Basic $150/month ($15/day, $40/week), Ultra $200, Elite $250.

Source: [SVS docs – Purchasing](https://docs.solanavibestation.com/introduction/purchasing).

A search summary listed staked RPC at $150/$250/$500 ([SVS docs via search](https://docs.solanavibestation.com/solana-core-services/staked-rpc-services)). This **conflicts** with the purchasing page.

**Jito ShredStream → DoubleZero Edge**
- ShredStream "will be completely shut down in 60 days (September 5, 2026)". Access was by approved public key, needed UDP port 20000 on a public IP, and served 8 regions — [Jito docs](https://docs.jito.wtf/lowlatencytxnfeed/).
- DoubleZero Edge:
  - Free trial (90 days for validators; by form for others).
  - Then "$450–$1,500/month, per IP, depending on region", across 30+ metros including Frankfurt, Amsterdam and New York.
  - Claims to be "11.6ms faster (p50) vs. Jito ShredStream" (data from July 6, 2026).

  Source: [DoubleZero – Jito ShredStream migration](https://doublezero.xyz/jito-shredstream).

**PumpPortal Data API**
- Since **May 1, 2026** an API key is required.
- `subscribeNewToken` and `subscribeMigration` are free.
- `subscribeTokenTrade` and `subscribeAccountTrade` are metered at **0.01 SOL per 10,000 trades** streamed.

Source: [PumpPortal fees](https://pumpportal.fun/fees/).

**X (Twitter) data**
- Official API is pay-per-use:
  - **$0.005 per post read**, $0.010 per user read.
  - $0.015 per post created ($0.20 with a URL). "Owned reads" $0.001.
  - Capped at **3 million post reads per month** before Enterprise.

  Source: [X API pricing docs](https://docs.x.com/x-api/getting-started/pricing).
- Legacy Basic ($200) and Pro ($5,000) tiers are closed to new signups (secondary) — [Outstand](https://www.outstand.so/blog/x-api-pricing).
- Third party twitterapi.io: **$0.15 per 1K tweets**, $0.18 per 1K profiles, minimum $0.00015 per call — [twitterapi.io pricing](https://twitterapi.io/pricing).

**Servers**
- Hetzner raised prices about 30–37% on April 1, 2026 ([igor'sLAB](https://www.igorslab.de/en/hetzner-to-significantly-increase-prices-for-cloud-and-dedicated-servers-from-april-2026/); [DevOps Daily](https://devops-daily.com/posts/hetzner-price-increases-2026)). It raised them again on **June 15, 2026**, for new orders and rescales, in Germany and Finland ([Northflank](https://northflank.com/blog/hetzner-cloud-server-price-increases)):

  | Instance | Old (€/month) | New (€/month) |
  |---|---|---|
  | CPX22 | 7.99 | 19.49 |
  | CPX32 | 13.99 | 35.49 |
  | CPX42 | 25.49 | 69.49 |
  | CPX52 | 36.49 | 100.49 |
  | CCX13 | 15.99 | 42.99 |
  | CCX23 | 31.49 | 85.99 |
  | CCX33 | 62.49 | 138.49 |
  | CCX63 | 374.49 | 853.49 |

- OVHcloud (US price list, setup fee equals one month):
  - Advance-1 2026: $204/month (EPYC 4245P, 6 cores).
  - Advance-4 2026: $383 (EPYC 4585PX, 16 cores).
  - Advance-5 2026: **$731** (Xeon 6527P, 24 cores, 128 GB–1 TB RAM).
  - Public bandwidth 1–5 Gbps.

  Source: [OVHcloud bare-metal prices](https://us.ovhcloud.com/bare-metal/prices/).
- Latitude.sh bare metal: Gen 4 from **$296/month** (m4.metal.small) to $3,971 (rs4.metal.xlarge: 64 cores, 1.5 TB). m4.metal.xlarge (48 cores, 768 GB) is $3,475/month. Gen 3 runs $190–$938 — [Latitude pricing](https://www.latitude.sh/pricing). Locations include FRA, AMS, LON, NYC, ASH, CHI, TYO and SGP — [Latitude locations](https://www.latitude.sh/locations).
- Cherry Servers:
  - Medium Solana RPC Node **$1,349.01/month** (EPYC 9354P, 32 cores, 768 GB, 10 Gbps, 100 TB egress).
  - Large RPC Node $1,461.33/month (Threadripper PRO 7975WX, 768 GB).
  - Agave validator $831.87/month.
  - Locations include the Netherlands, Germany and Chicago.

  Source: [Cherry Servers Solana](https://www.cherryservers.com/solana-servers).
- TeraSwitch: "$177/month (Milan 7313P) to $1,137/month (Turin 9275F)", via a search-tool summary of [teraswitch.com/pricing](https://teraswitch.com/pricing). The page returned a Cloudflare 403 to direct fetch, so this is **not directly verified**.

**Free and public tiers**
- Solana public mainnet RPC limits: 100 requests per 10 s per IP; 40 per 10 s for a single method; 40 concurrent connections; 100 MB per 30 s. The endpoints are "not intended for production applications" — [Solana clusters docs](https://solana.com/docs/references/clusters).
- Helius Free: 1M credits, 10 RPS, `sendTransaction` 1/s, no LaserStream mainnet. Sender works on all plans "including the free tier" — [Helius billing](https://www.helius.dev/docs/billing/plans); [Helius Sender](https://www.helius.dev/docs/sending-transactions/sender).
- Chainstack Developer: 3M RU, 25 RPS. Shyft Free: 10 RPC req/s, no gRPC. QuickNode free trial: 10M credits, 15 RPS. Sources as above.

### Inferences
- **Cost per GB streamed (estimate, from cited unit prices):**

  | Provider | Cost per GB |
  |---|---|
  | Helius overage | ≈ $0.10 (20,000 credits/GB × $5/M) |
  | QuickNode (Scale overage) | ≈ $0.053 (100,000 credits/GB × $0.53/M) |
  | Alchemy | $0.075 |
  | Triton | $0.08 |
  | Shyft | Flat (unmetered) |

  For a firehose-style terminal feed of more than 1 TB/month, flat-rate gRPC (Shyft, SVS, ERPC, Chainstack streams) is cheapest. Helius is competitive when its included credits cover the volume and you value Sender, staked sending and DAS in one bill.
- **Free tiers can run** a single-user terminal with wallet reads, quotes and Sender submission, provided blockhash polling is ≥10 s. They **cannot** run a full real-time "trenches" feed of all pump.fun and PumpSwap trades: no mainnet gRPC on Helius Free, Shyft Free or Chainstack Developer, and the public RPC caps at 100 MB per 30 s.
- **Shreds** now cost $450–1,500/IP/month everywhere (DoubleZero, Triton, Helius). They belong only in a pro tier.

### Gaps
- Triton and Helius dedicated-node specifications and real quotes; Enterprise prices are not public.
- Hetzner dedicated (AX) and auction prices after June 2026.
- OVH price for a 512 GB RAM configuration (the base price is for minimum RAM).
- TeraSwitch prices not verified.
- Provider terms on reselling or sharing endpoints were not reviewed.

---

## 5. If we used our own Helius RPC, how expensive would it be?

### Takeaway
- **Single-user terminal without a market firehose:** fits **Developer at $49/month**. Estimated use is 0.9–2.2M credits/month; Sender is free; tips are paid on-chain.
- **Free ($0):** works for prototyping only if polling is light.
- **Live "trenches" feed of all pump.fun and PumpSwap trades:** needs **Business at $499/month**, the cheapest plan with mainnet LaserStream gRPC. Its 100M credits cover an estimated 16–79M credits/month for successful-only pump.fun+PumpSwap transactions.
- **Community-scale serving:** Professional ($999, 200M credits, 500 RPS, data add-ons) or a dedicated node ($2,900+/month, used alongside a shared plan).

### Cited Findings

**Plans** (billing docs "last_updated: 2026-04-09"; pricing page retrieved 2026-10-03)

| | Free | Developer | Business | Professional |
|---|---|---|---|---|
| Price | $0 | $49 | $499 | $999 |
| Monthly credits | 1M | 10M | 100M | 200M |
| RPC rate limit | 10 req/s | 50 req/s | 200 req/s | 500 req/s |
| DAS and Enhanced APIs | 2 req/s | 10 req/s | 50 req/s | 100 req/s |
| Enhanced WebSockets | No | Yes | Yes | Yes |
| LaserStream gRPC | No | Devnet | Devnet + Mainnet | Devnet + Mainnet |
| Preconfirmations | No | No | No | Yes, 10 credits/msg |

- Enterprise is custom (1B+ credits).
- Extra credits cost $5 per million.
- Payment by card or USDC on Solana.
- Professional can add **+100 RPS for $100/month**.
- Autoscaling is "capped" on Developer and Business and unlimited on Professional.

Source: [Helius billing – Plans](https://www.helius.dev/docs/billing/plans); [Helius pricing](https://www.helius.dev/pricing).

**What unlocks what**
- **Mainnet LaserStream gRPC:** "LaserStream Mainnet access requires a Business or Professional plan" — [Helius LaserStream docs](https://www.helius.dev/docs/laserstream); same on [Helius credits docs](https://www.helius.dev/docs/billing/credits) and [pricing](https://www.helius.dev/pricing).
  - **Conflict:** the LaserStream rate-limit table in the billing docs lists Business as "Devnet" only — [Helius billing](https://www.helius.dev/docs/billing/plans).
- **Enhanced WebSockets** (Helius extensions `transactionSubscribe` and enhanced `accountSubscribe`): "require a Developer, Business, or Professional plan" — [Helius credits docs](https://www.helius.dev/docs/billing/credits).
  - **Conflict:** another billing-docs table shows Developer as "Standard" WebSockets only — [Helius billing](https://www.helius.dev/docs/billing/plans).
- **Staked connections:** "Staked Transactions Are Now Default for All Paid Plans: All transactions via mainnet.helius-rpc.com automatically use staked connections." Each costs 1 credit — [Helius credits docs](https://www.helius.dev/docs/billing/credits).
- **Data add-ons** (Professional only, covering LaserStream gRPC and WebSockets): 5 TB $400, 10 TB $750, 25 TB $1,750, 50 TB $3,250, 100 TB $6,000 per month. Overage is 2 credits per 0.1 MB — [Helius billing](https://www.helius.dev/docs/billing/plans).
- **Raw shreds (UDP):** $1,000/month per IP ($800 on Professional).
- **Preprocessed transactions:** 0.1 credits per message, all paid plans.

  Source for both: [Helius LaserStream docs](https://www.helius.dev/docs/laserstream).

**Credit costs per method**

| Method or product | Credits |
|---|---|
| Standard RPC call (`getAccountInfo`, `getLatestBlockhash`, `getSignatureStatuses`, `getTransaction`, `getBlock`, etc.) | **1** |
| `getProgramAccounts` | **10** |
| `getProgramAccountsV2` (paginated) | 1 |
| DAS API, every method | **10** |
| Enhanced Transactions | 100 |
| Priority Fee API | 1 |
| `simulateBundle` | 1 |
| `getTransactionsForAddress` | 10+ ("10 credits per 100 returned" for full transactions) |
| Wallet API | 100 |
| Webhook events | 1 |
| Webhook management | 100 |
| **Sender** | **0** |
| Staked `sendTransaction` | 1 |

Source: [Helius billing](https://www.helius.dev/docs/billing/plans); [Helius credits](https://www.helius.dev/docs/billing/credits).

**Streaming metering**
- **LaserStream gRPC and all WebSocket usage, standard methods included: 2 credits per 0.1 MB** of uncompressed data. "All WebSocket usage is metered at 2 credits per 0.1 MB."
- Parsed Streams (`parsedTransactionSubscribe`): 1 credit per delivered event, on all plans. Metering started **Sept 24, 2026**; earlier users are charged from Oct 1, 2026.
- Helius's typical sizes: block ~4 MB, account ~0.0004 MB, transaction ~0.0006 MB.

Source: [Helius credits](https://www.helius.dev/docs/billing/credits).

**Embedded wallets (Helius WaaS)**
- "Each signature costs 200 credits ($0.001 at the standard credit rate)". Paid plans only. Keys are secured by Turnkey.

Source: [Helius credits](https://www.helius.dev/docs/billing/credits); [Helius docs index](https://www.helius.dev/docs/llms.txt).

**Rate limits for sending and heavy calls**

| Endpoint | Free | Developer | Business | Professional |
|---|---|---|---|---|
| `sendTransaction` | 1/s | 5/s | 50/s | 100/s |
| `getProgramAccounts` | 5/s | 25/s | 50/s | 75/s |
| WebSocket connections | 5 | 150 | 250 | 250 |
| LaserStream connections | — | 100 | 100 | 100 |

- LaserStream allows up to 10M pubkeys.
- **Sender rate limit conflict:** the billing table says 15/s on all plans, but the Sender doc says "Default: 50 transactions per second", with more for Professional on request.

Source: [Helius billing](https://www.helius.dev/docs/billing/plans); [Helius Sender](https://www.helius.dev/docs/sending-transactions/sender).

**Sender cost and tips**
- "Sender does not consume API credits — you pay per transaction with a SOL tip. It is available on every plan, including the free tier."
- Minimum tips: **Sender Max 0.001 SOL** (all pathways plus the priority tip buffer) and **SWQOS-only 0.000005 SOL**. Every transaction must also include a compute-unit price instruction.
- Regional HTTP endpoints: Salt Lake City, Newark, London, Frankfurt, Amsterdam, Singapore, Tokyo.

Source: [Helius Sender](https://www.helius.dev/docs/sending-transactions/sender).

**Dedicated nodes**
- "Starting at $2,900+/month". No credits, no rate limits, Yellowstone gRPC included.
- "APIs, webhooks, and staked connections require a shared plan".
- The comparison page warns of "Poor landing rates", single points of failure and `getProgramAccounts` performance risk.

Source: [Helius LaserStream vs Dedicated](https://www.helius.dev/docs/laserstream/laserstream-vs-dedicated-nodes); [Helius Dedicated Nodes](https://www.helius.dev/docs/dedicated-nodes).

### Inferences

**Single-user terminal workload (estimate; my assumptions, priced with the credit table above)**

| Activity | Assumption | Credits/month |
|---|---|---|
| Blockhash polling | `getLatestBlockhash` every 2 s | 1,296,000 |
| | or every 10 s | 259,200 |
| Wallet balances | `getTokenAccountsByOwner` every 10 s | 259,200 (≈0 if pushed via WebSocket `accountSubscribe`; data is ~0.0004 MB per update) |
| Token page views | 300/day × ~34 credits (mint + curve account, `getTokenLargestAccounts`, 1 DAS `getAsset` = 10, `getSignaturesForAddress`, 20 × `getTransaction`) | 306,000 |
| Holder scans | 100/day × `getProgramAccounts` (10 credits) | 30,000 |
| Trades and confirmations | 100/day × ~12 credits (Priority Fee API + simulate + 10 status polls); submission via Sender = 0 | 36,000 |
| Priority-fee refresh | every 10 s | 259,200 |
| **Total** | | **≈ 0.9M (lean) to 2.2M (chatty)** |

Credit bounds: Free allows 1M and Developer 10M.

**Market-data streaming volume (estimate)**
- Scaling my 30-block sample (223 pump-related transactions per block, 135 successful) by 323K blocks/day gives:
  - pump.fun+PumpSwap: ≈ **72M tx/day**, of which **43.6M** succeeded.
  - pump.fun curve only: ≈ 25M/day, 8.0M succeeded.
- Monthly data, at Helius's 2 credits/0.1 MB:

  | Stream | 0.6 KB/tx (Helius "typical") | 2 KB/tx | 3 KB/tx |
  |---|---|---|---|
  | All pump+PumpSwap, successful only | 786 GB = **15.7M credits** | 2.6 TB = 52.4M | 3.9 TB = **78.6M** |
  | Including failed transactions | — | — | 6.5 TB = **129.7M** (exceeds Business) |
  | pump.fun curve, successful only | — | 478 GB = 9.6M | — |

  I suspect full pump.fun transactions with logs are 2–3 KB uncompressed, not 0.6 KB; this is unverified. Either way, **filter out failed transactions server-side** (Yellowstone supports this).

**Plan per build phase (estimate)**

| Phase | Plan | Monthly cost | Notes |
|---|---|---|---|
| 0. Prototype | **Free** | $0 | Poll blockhash every ≥10 s; no firehose; `sendTransaction` 1/s; use Sender with tip |
| 1. Single-user MVP | **Developer** | **$49** | 10M credits covers 0.9–2.2M RPC credits plus WebSocket data for your own wallet and watched tokens; Enhanced WebSockets; Parsed Streams for low-frequency events (e.g. 20,000 events/day ≈ 0.6M credits/month, illustrative); new-token and migration events free via PumpPortal |
| 2. Full trenches | **Business** | **$499** | LaserStream mainnet; ~16–79M credits for a successful-only firehose plus RPC use |
| 2, alternative | Shyft Build + Helius Developer | **$248** ($199 + $49) | Shyft: unmetered gRPC, 100 RPC req/s; Helius: Sender, staked sending, DAS. Cheaper than Business with comparable features |
| 3. Shared or community | **Professional** | **$999** (+$100 per extra 100 RPS; + data add-ons from $400/5 TB) | Or a dedicated node at $2,900+/month alongside a shared plan, which is still needed for Sender, staked sending and APIs |

**Tips and per-trade cost**
- Each trade's landing cost is the on-chain tip plus priority fee, not credits.
- Sender SWQOS-only at 0.000005 SOL ($0.0006) is the cheapest option; Sender Max at 0.001 SOL ($0.12) is the most reliable.
- At 100 trades/day, Sender Max tips alone are 3 SOL/month ($358). SWQOS-only tips are 0.015 SOL/month ($1.79). Estimates.

### Gaps
- The Helius docs contradict themselves on Business LaserStream mainnet (3 sources yes, 1 table no), Developer Enhanced WebSockets, and the Sender rate limit (15 vs 50 TPS). Confirm in the dashboard before committing.
- The actual uncompressed size of a pump.fun transaction in LaserStream was not measured.
- Daily pump.fun token-creation counts were not measured.

---

## 6. Break-even: at what monthly volume does self-hosting beat 0.75–1% platform fees?

### Takeaway
Break-even volume equals monthly infrastructure cost divided by the platform's net fee rate. Assuming SOL = $119.50 (Oct 3, 2026):

| Setup | Monthly cost | Beats 1% above | Beats 0.75% above |
|---|---|---|---|
| Budget | $49 | **$4,900/month** (~41 SOL) | **$6,533** (~55 SOL) |
| Standard | $250 | **$25,000** (~209 SOL) | **$33,333** (~279 SOL) |
| Pro | $2,000 | **$200,000** (~1,674 SOL) | **$266,667** (~2,232 SOL) |

A $0 free-tier setup beats any platform fee at any volume, within its feature limits. Against Jupiter Ultra (0.1%), break-even is 10× higher: $49,000 for budget, $250,000 for standard. Protocol and network fees are paid in both cases and cancel out. Tuning priority fees and tips adds extra savings, especially for small trades.

### Cited Findings
- Platform net rates used in the calculation:
  - 1% list price at Photon, GMGN, Trojan, BONKbot, Maestro, Bloom, BullX and Banana Gun (Solana) — section 1 sources ([GMGN docs](https://docs.gmgn.ai/index/gmgn-fees-settings); [Trojan FAQs](https://docs.trojan.com/faqs); [BONKbot docs](https://docs.bonkbot.io/fee-structure); [Maestro docs](https://docs.maestrobots.com/sniper/monetization); [Bloom docs](https://docs.bloombot.app/grow-with-bloom/fees-structure); [BullX docs](https://bullx.gitbook.io/bullx-neo-docs/fees-and-gas); [Banana Gun blog](https://blog.bananagun.io/blog/best-solana-trading-bots-right-now)).
  - Axiom 0.95% (Wood) to 0.75% (Champion) — [Axiom docs](https://docs.axiom.trade/getting-started/fees/axiom-fees).
  - Trojan as low as 0.55% (1% minus 45% cashback) — [Trojan docs](https://docs.trojan.com/trojan-arena/ranks-and-rewards).
  - PumpPortal Local 0.5% — [PumpPortal](https://pumpportal.fun/fees/).
  - Jupiter Ultra 0.1% — [Jupiter](https://developers.jup.ag/docs/ultra/fees).
- Infrastructure unit prices are as cited in sections 4–5:
  - Helius Developer $49 ([Helius](https://www.helius.dev/pricing)).
  - Shyft Build $199 ([Shyft](https://shyft.to/solana-rpc-grpc-pricing)).
  - Hetzner CPX32 €35.49 ([Northflank](https://northflank.com/blog/hetzner-cloud-server-price-increases)).
  - Helius Professional $999.
  - DoubleZero Edge $450–1,500/IP ([DoubleZero](https://doublezero.xyz/jito-shredstream)).
  - X API $0.005/post read ([X docs](https://docs.x.com/x-api/getting-started/pricing)).
- SOL price: $119.50 — [CoinGecko API](https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd).

### Inferences

**Reference tiers (estimates assembled from the cited unit prices)**
- **Budget ≈ $49/month.** Helius Developer; runs on the user's own machine. Optional VPS: Hetzner CPX22 €19.49 ≈ $21.88. The free variant at $0 uses Helius Free plus PumpPortal's free new-token and migration streams.
- **Standard ≈ $250/month (the reference figure).** Shyft Build $199 + Helius Developer $49 = $248, with the app running on the user's machine.
  - An always-on VPS (CPX32 ≈ $39.84) and third-party X data (~$10–50) bring the realistic range to **~$250–340**.
  - Cheaper variant: Chainstack Growth $49 + Yellowstone $49 + VPS ≈ $140.
  - Single-vendor variant: Helius Business $499.
- **Pro ≈ $1,500–3,000/month (using $2,000 below).** Helius Professional $999; a second gRPC provider for redundancy ($199–222); a colocated server ($204–383 at OVH, $296+ at Latitude); shreds via DoubleZero Edge, Triton or Helius ($450–1,500/IP); official X API ~$100–300.

**Break-even V\* = C ÷ f**

| Net platform fee f | Budget $49 | Standard $250 | Pro $2,000 |
|---|---|---|---|
| 1.00% | $4,900 (41 SOL) | $25,000 (209 SOL) | $200,000 (1,674 SOL) |
| 0.95% (Axiom Wood) | $5,158 (43 SOL) | $26,316 (220 SOL) | $210,526 (1,762 SOL) |
| 0.90% (referred) | $5,444 (46 SOL) | $27,778 (232 SOL) | $222,222 (1,860 SOL) |
| 0.75% (Axiom Champion) | $6,533 (55 SOL) | $33,333 (279 SOL) | $266,667 (2,232 SOL) |
| 0.55% (Trojan top cashback) | $8,909 (75 SOL) | $45,455 (380 SOL) | $363,636 (3,043 SOL) |
| 0.50% (PumpPortal Local) | $9,800 (82 SOL) | $50,000 (418 SOL) | $400,000 (3,347 SOL) |
| 0.10% (Jupiter Ultra) | $49,000 | $250,000 | $2,000,000 |

**Net monthly saving vs a 0.95% / 1% terminal (positive means self-hosting wins)**

| Monthly volume | Budget $49 | Standard $250 | Pro $2,000 |
|---|---|---|---|
| $5,000 | −$2 / +$1 | −$202 / −$200 | −$1,952 |
| $10,000 | +$46 / +$51 | −$155 | −$1,905 |
| $50,000 | +$426 / +$451 | +$225 / +$250 | −$1,525 |
| $100,000 | +$901 | +$700 | −$1,050 |
| $250,000 | +$2,326 | +$2,125 | +$375 / +$500 |
| $500,000 | +$4,701 | +$4,500 | +$2,750 |

**Fixed per-trade fees often matter more than the percentage**
- At terminal-default gas of 0.002 SOL per side, a 0.1 SOL trade loses 2% per side to gas.
- A tuned self-hosted client (SWQOS-only tip plus ~0.0001 SOL priority) cuts a 0.1 SOL round trip from **8.41% to 2.72%** of size: 5.69 points saved, of which 1.9 are the platform fee. See section 3.

**Volume is round-trip notional.** A trader who buys and sells 1 SOL 50 times a month generates 100 SOL (~$11,950) of fee-bearing volume, which already beats the budget tier.

### Gaps
- No distribution of real users' monthly volumes, so I can't say what share of traders clears each break-even.
- Self-hosting labor and time are not priced.
- Platforms' non-fee value (cashback paid in SOL, referral income, UX) is only partly netted. Referral income a user earns on a platform is ignored.

---

## 7. Shared-infrastructure models among friends: cost splitting and trust/security trade-offs

### Takeaway
One person running a gRPC subscription and a small relay that friends connect to splits a $150–500 fixed cost into **~$15–50 per person** for 10 people (estimate). This works because market data is non-rival: one ingest serves everyone. The trade-offs:
- **Privacy:** the host sees what you watch.
- **Integrity:** the host could alter or delay data.
- **Availability:** single point of failure.
- **Terms of service:** providers' rules on sharing were not checked.

Never route signing keys or unsigned trade intents through the host. Each user should sign locally and send directly to Sender/Jito.

### Cited Findings
- Some providers limit how many IPs can connect:
  - ERPC's €198 gRPC plan allows "1 IP Whitelist, max 10 stream connections" ([ERPC pricing](https://erpc.global/en/price/)), so friends must go through the host's relay.
  - Shyft's newer plans list "Unlimited" IP addresses, plus $100 per 10 extra connections ([Shyft pricing](https://shyft.to/solana-rpc-grpc-pricing)).
  - Chainstack sells streams per account: 2 for $49, 7 for $149 ([Chainstack blog](https://chainstack.com/yellowstone-grpc-more-streams-same-price/)).
  - Helius LaserStream allows 100 active connections per plan ([Helius billing](https://www.helius.dev/docs/billing/plans)).
- The open-source Yellowstone gRPC plugin config supports:
  - `x_token` authentication and "trusted-metadata" auth with a `billing_endpoint_url` that reports usage (for example every 5 s).
  - Per-client `filter_limits`, for example max 1 accounts filter, `account_max` 10, and rejecting the SPL Token program as a firehose filter.

  Source: [rpcpool/yellowstone-grpc config.json](https://github.com/rpcpool/yellowstone-grpc/blob/master/yellowstone-grpc-geyser/config.json).
- Sender charges no credits; each transaction carries its own tip from the signer's wallet — [Helius Sender](https://www.helius.dev/docs/sending-transactions/sender).

### Inferences

**Cost splitting (estimates)**

| Setup | Total/month | Per person |
|---|---|---|
| Shyft Build ($199) + relay VPS (€19.49 ≈ $22), 10 friends | ≈ $221 | **≈ $22** |
| Helius Business ($499), 10 friends | — | ≈ $50 |
| Chainstack Growth + Yellowstone ($98) + VPS, 5 friends | — | ≈ $24 |

Each person still pays their own trade tips and priority fees.

**Trust and security**
- **Privacy.** The relay host can log every subscription, revealing which tokens and wallets each friend tracks.
- **Integrity.** A malicious or compromised host can feed delayed or fake prices. Mitigations:
  - Re-check critical state (pool reserves, quote) against a second RPC before signing.
  - Simulate locally.
  - Use TLS on the relay.
- **Front-running.** Never send transactions through the host's sender. Submit directly from each client to Sender or Jito, so the host cannot see transactions before they land.
- **Abuse.** One friend running heavy queries can exhaust a shared credit pool. Use per-user tokens and quotas (section 8).
- **Key compromise.** A leaked shared provider key exposes everyone's quota. Rotate keys and proxy server-side, never in the browser.

### Gaps
- I did not review provider terms of service on sharing or reselling access (Helius, Shyft, ERPC, Chainstack). This could make informal sharing a ToS violation.
- No reference implementations of community gRPC relays were evaluated.

---

## 8. Community-hosted infrastructure costs

### Takeaway
If the project hosts shared infrastructure, **market data is a fixed cost**: one ingest is fanned out to everyone. **Per-user wallet reads and hosted signing scale with users.** Transaction tips are paid by each user on-chain.

With a push-based design, an estimated per-user cost is:

| Users | Setup | Monthly cost (estimate) | Per user |
|---|---|---|---|
| 10 | Helius Business ($499) + 1 gateway | ~$540 | ~$54 |
| 10 | Shyft + gateway | ~$240 | ~$24 |
| 100 | Helius Business | ~$540–620 | ~$5.4–6.2 |
| 1,000 | Helius Professional | ~$1,600–2,000 | ~$1.6–2.0 |
| 1,000 | Own 2-node cluster | ~$3,200–9,500 | ~$3.2–9.5 |
| 10,000 | Own 6-node, 3-region cluster | ~$9,700–26,500 + ops staff | ~$1–2.7 |
| 10,000 | Helius Professional + autoscale | ~$17,700+ | — |

**A polling-heavy design costs ~$11/user/month at every scale.**

**Hosted embedded wallets can dwarf infrastructure.** At 1,500 signatures per user per month:

| Provider | Price per signature | Per user per month |
|---|---|---|
| Turnkey pay-as-you-go | $0.10 | $150 |
| Turnkey Pro | $0.05 | $75 |
| Turnkey Enterprise | from $0.0015 | $2.25 |
| Helius WaaS | $0.001 | $1.50 |
| Local self-custody signing | — | **$0** |

### Cited Findings

**(1) Inputs for tiers: hosted plans, dedicated nodes, own nodes**
- Helius plan prices, credits, RPS and the +100 RPS add-on are as in section 5. Enterprise is "Custom pricing" — [Helius billing](https://www.helius.dev/docs/billing/plans).
- Dedicated nodes: Helius "Starting at $2,900+/month" ([Helius](https://www.helius.dev/docs/laserstream/laserstream-vs-dedicated-nodes)); Shyft dedicated gRPC from $1,800/month ([Shyft](https://shyft.to/solana-rpc-grpc-pricing)); ERPC dedicated gRPC €1,580–2,980 ([ERPC](https://erpc.global/en/price/)). Triton's dedicated pricing is not public ([Triton](https://triton.one/pricing)).
- Official hardware requirements from Anza (Agave) — [Anza docs](https://docs.anza.xyz/operations/requirements):
  - CPU at ≥2.8 GHz base, AMD Gen 3+ or Intel Ice Lake+, with SHA and AVX2.
  - RPC nodes: **16 cores / 32 threads or more** and **512 GB+ RAM** for all account indexes.
  - NVMe: accounts 1 TB+, ledger 1 TB+, snapshots 500 GB+, kept on separate disks.
  - Network: "For an unstaked node: 1 GBit/s symmetric connection is sufficient"; staked nodes need ≥2 Gbit/s, with 10 Gbit/s recommended.
  - Ubuntu 24.04. Docker is not recommended.
- Bare-metal options that roughly meet RPC needs:
  - Cherry Medium Solana RPC Node $1,349.01/month (32 cores, 768 GB, 10 Gbps, **100 TB free egress**) — [Cherry](https://www.cherryservers.com/solana-servers).
  - Latitude m4.metal.xlarge $3,475/month (48 cores, 768 GB). The rs4.metal.xlarge listing shows "20TB free out" — [Latitude](https://www.latitude.sh/pricing).
  - OVH Advance-5 2026 from $731/month (24 cores, up to 1 TB RAM; the 512 GB price is higher) — [OVHcloud](https://us.ovhcloud.com/bare-metal/prices/).
  - ERPC SLV Metal MV €798/month (24-core EPYC, 384 GB, below Anza's 512 GB guidance for full indexes) — [ERPC](https://erpc.global/en/price/).
  - TeraSwitch $177–1,137 (not verified) — [TeraSwitch](https://teraswitch.com/pricing).
- The Yellowstone gRPC plugin is open source (free) — [rpcpool/yellowstone-grpc](https://github.com/rpcpool/yellowstone-grpc/blob/master/yellowstone-grpc-geyser/config.json).
- Jito ShredStream is shut down (Sept 5, 2026). DoubleZero Edge costs $450–1,500/IP/month by region — [Jito](https://docs.jito.wtf/lowlatencytxnfeed/); [DoubleZero](https://doublezero.xyz/jito-shredstream). Triton shreds start at $450/month ([Triton](https://triton.one/pricing)); Helius shreds cost $800–1,000/IP ([Helius](https://www.helius.dev/docs/laserstream)).
- Helius advises dedicated nodes be "combined with a shared plan". Dedicated nodes carry "single points of failure" and `getProgramAccounts` "can impact node performance or cause node failure" — [Helius Dedicated Nodes](https://www.helius.dev/docs/dedicated-nodes).

**(2) What scales with users**
- Fixed costs:
  - LaserStream and WebSocket data is billed per MB streamed (2 credits/0.1 MB) **per connection**. One server-side subscription relayed by your own gateway costs once.
  - Sender charges 0 credits, and the tip is inside each user's signed transaction.

  Source: [Helius credits](https://www.helius.dev/docs/billing/credits); [Helius Sender](https://www.helius.dev/docs/sending-transactions/sender).
- Per-user costs:
  - RPC reads (1 credit each; DAS 10; `getProgramAccounts` 10).
  - Request rate ceilings (200/500 RPS).
  - `sendTransaction` limits (50/100 per second).
  - WebSocket connection caps (250).

  Source: [Helius billing](https://www.helius.dev/docs/billing/plans).
- A shared Sender key may face a 15–50 TPS default limit, with more on request for Professional — [Helius billing](https://www.helius.dev/docs/billing/plans); [Helius Sender](https://www.helius.dev/docs/sending-transactions/sender).

**(3) Hosted embedded wallets**
- Turnkey — [Turnkey pricing](https://www.turnkey.com/pricing):
  - Pay as you go: 25 free signatures/month, then **$0.10/signature**, up to 1,000 free wallets.
  - Pro: **$99/month + $0.05/signature**, up to 2,000 wallets.
  - Enterprise: "As low as **$0.0015 / signature**", unlimited wallets, gas sponsorship, SLAs.
- Privy (page dated Oct 1, 2026) — [Privy pricing](https://www.privy.io/pricing):
  - Core is free for 0–499 MAU. Scale is **$299/month** for 500–2,499 MAU. Growth is **$499/month** for 2,500–9,999 MAU.
  - "50K signatures and $1M transaction volume" included monthly.
  - Beyond 10,000 MAU: "$2,000 PAYG base fee, plus $0.05 per MAU above 10,000 and $0.01 per signature above 50,000".
  - Enterprise "as low as $0.001/signature".
- Helius WaaS: 200 credits ($0.001) per signature, no per-MAU fee, keys secured by Turnkey — [Helius credits](https://www.helius.dev/docs/billing/credits).
- **Axiom uses Turnkey** for non-custodial wallet creation, signing and policy-based key management. Figures: 1M+ wallets, 100K+ users onboarded monthly — [Turnkey case study](https://www.turnkey.com/customers/axiom-global-defi-trading-platform).

**(4) Funding inputs**
- What users would otherwise pay: Solana terminal fees totalled $59.0M in 30 days and $476.1M in a year ([DefiLlama](https://api.llama.fi/overview/fees/solana?dataType=dailyFees)). This is the value pool a zero-fee, membership-funded model competes for.

**(5) Abuse controls available off the shelf**
- Yellowstone gRPC supports `x_token`, trusted-metadata auth with a per-client billing reporter, per-client filter limits, and reject lists (e.g. blocking SPL Token program firehose filters) — [Yellowstone config](https://github.com/rpcpool/yellowstone-grpc/blob/master/yellowstone-grpc-geyser/config.json).
- Helius returns HTTP 429 above rate limits, autoscaling is capped on Developer and Business, and a usage API exposes credit consumption — [Helius billing](https://www.helius.dev/docs/billing/plans); [Helius docs index](https://www.helius.dev/docs/llms.txt).
- The Solana public RPC's own limits (100 requests per 10 s per IP, 40 per method, 40 connections, 100 MB per 30 s) are a model for per-IP throttling — [Solana clusters](https://solana.com/docs/references/clusters).

### Inferences

**Cost model assumptions (all estimates)**
- Push-based design: 0.3M credits/user/month and 0.1 req/s average per user.
- Polling design: 2M credits/user/month and 0.5 req/s per user.
- Peak load is 3× average.
- Shared market-data ingest: 16–87M credits/month.
- One gateway VPS (Hetzner CPX32 ≈ $39.84) per 500 concurrent users, with 20% of users concurrent.
- About 10 KB/s per connected user, giving ≈5.2 TB/month egress at 1,000 users and ≈52 TB at 10,000.
- Helius overage at $5/M.

**(1) Monthly cost by community size (estimates)**

| Users | Option | Monthly cost | Per user |
|---|---|---|---|
| ~10 | Helius Business + 1 gateway | ≈ $539 | ≈ $54 |
| | Shyft Build + gateway | ≈ $240 | ≈ $24 |
| | Chainstack Growth + Yellowstone + gateway | ≈ $140 | ≈ $14 (20M RU cap) |
| ~100 | Helius Business, push design | ≈ $539–624 | ≈ $5.4–6.2 |
| | Helius Business/Professional, polling design (200M+ credits) | ≈ $1,119–1,474 | ≈ $11–15 |
| | Shyft Grow ($349) or Accelerate ($649) + gateway | ≈ $390–690 | ≈ $3.9–6.9 |
| ~1,000 | Helius Professional, push design (310–390M credits, ~300 peak RPS) | ≈ $1,619–1,974 | ≈ $1.6–2.0 |
| | Helius Professional, polling design (~2B credits + 1,000 extra RPS) | ≈ $11,100+ | — |
| | Own nodes: 2 RPC nodes ($1,349–3,475 each) + 1 shred IP ($450–1,500) + Helius plan for Sender/fallback ($49–999) + gateway | ≈ $3,237–9,489 | ≈ $3.2–9.5 |
| ~10,000 | Helius Professional + autoscale, push design (~3B credits, +2,500 RPS) | ≈ $17,700–18,100 | — |
| | Polling design | ≈ $115,000 | — |
| | Own nodes: 6 nodes over 3 regions (2 per region) + 3 shred IPs + Helius Professional + 4 gateways | ≈ $9,650–26,500 | ≈ $0.97–2.65 |

- At 1,000 users, own nodes are only worth it for latency control or polling-heavy loads. They add an ops burden: Agave/Firedancer upgrades, snapshots, disk wear, an on-call rota.
- At 10,000 users, own nodes need roughly **0.5–1 FTE of operations**, which is not priced here. Helius Enterprise is unpriced and likely cheaper than list overage.

**(2) Fixed vs scaling costs**
- **Fixed:**
  - One market-data ingest (gRPC firehose, indexer, token metadata cache).
  - Shreds per region.
  - Base node and plan fees.
- **Scaling with users:**
  - Wallet reads (balances, positions, history).
  - Gateway compute and bandwidth.
  - WebSocket connections.
  - Hosted signing.
  - Support.
- **Paid by users, not us:** priority fees, tips (Sender, Jito), protocol fees, rent.
- The key design choice is **ingest once, push to all**. Derive balance changes from the shared stream wherever possible instead of per-user polling. This is the 5–7× difference between the push and polling rows above.

**(3) Embedded wallets** (assumes 50 trades/day = 1,500 signatures/user/month)

| Users | Turnkey PAYG | Turnkey Pro | Turnkey Enterprise | Helius WaaS | Privy (@ $0.01 over 50K) | Privy Enterprise |
|---|---|---|---|---|---|---|
| 100 | $15,000 | $7,599 | $225 | $150 | ≈ $1,000 | $150 |
| 1,000 | $150,000 | — | $2,250 | $1,500 | ≈ $14,500 | — |
| 10,000 | — | — | $22,500 | $15,000 | ≈ $149,500 | $15,000 |

- Privy's "$1M transaction volume" allowance would also be exceeded quickly by traders.
- **Self-custodial local signing (browser or desktop keypair, or wallet-adapter) costs $0 per signature** and is the only option compatible with a zero-fee promise at scale.

**(4) Funding without per-trade fees (estimates)**
- **Membership.** Price = cost per user ÷ paying share.
  - Example: 1,000 users at ≈$2/user (Helius push) with 25% paying → **≈$8/month**.
  - With own nodes at ≈$4/user and 25% paying → **≈$16/month**.
  - Context: a member trading $10,000/month saves ~$95–100/month vs a 0.95–1% terminal.
- **Donations and sponsors.** Unpredictable. Best used for fixed costs such as the market-data ingest, not per-user costs.
- **Optional voluntary tip jar.** Opt-in, default 0. It preserves the "zero platform fee" claim only if truly optional.

**(5) Abuse controls for a shared endpoint**
- **Per-user keys.** Issue them after Sign-In-With-Solana.
- **Token-bucket rate limits** per key and per IP, modelled on the public RPC limits.
- **Method allowlists:**
  - Block `getProgramAccounts` on the Token program.
  - Cap `getTransaction` batch sizes.
  - Route heavy analytics through cached endpoints.
- **Subscription caps:** per-user WebSocket and gRPC subscription limits, plus Yellowstone `filter_limits` and reject lists.
- **Hide provider keys.** Never expose Helius or Shyft keys to browsers; proxy server-side.
- **Monitoring and response:** per-user usage via Yellowstone billing hooks or the Helius usage API, alerts on credit burn, and automatic suspension.
- **No shared submission path.** Clients send directly to Sender/Jito so the community server never handles trades before they land.

### Gaps
- No Helius Enterprise or Triton dedicated quote.
- Gateway capacity (users per server) and per-user bandwidth are assumptions, not benchmarks.
- No measured RPS for a real terminal user.
- Privy's signature allowance semantics are ambiguous (per plan vs overage only).
- Provider ToS on serving many end users from one plan were not reviewed.
- The 0.5–1 FTE ops estimate is a judgment, not sourced.

---

## 9. Implications for the build

### Takeaway
Ship three documented infrastructure tiers. Tell users in the README that "zero platform fee" removes 0.75–1% per trade, not protocol or network costs. Show a per-trade cost breakdown so users can see that pump.fun's 1.25% and their own gas settings are often the largest costs.

### Cited Findings
- Protocol fees that remain:
  - pump.fun curve 1.25% (0.95% protocol + 0.30% creator).
  - PumpSwap 1.25% → 0.30% by market cap.

  Source: [pump.fun fees](https://pump.fun/docs/fees).
- Sender tips: 0.001 SOL (Max) or 0.000005 SOL (SWQOS-only) — [Helius Sender](https://www.helius.dev/docs/sending-transactions/sender).
- Rent: 0.00148844 SOL per token account, refundable on close — on-chain Rent sysvar; [SIMD-0437](https://github.com/solana-foundation/solana-improvement-documents/blob/main/proposals/0437-incremental-rent-reduction.md).
- Platform fees avoided: 0.75–1% ([Axiom](https://docs.axiom.trade/getting-started/fees/axiom-fees); [GMGN](https://docs.gmgn.ai/index/gmgn-fees-settings)).
- Jito tip-floor median: 0.00001 SOL on Oct 3, 2026 ([Jito API](https://bundles.jito.wtf/api/v1/bundles/tip_floor)).

### Inferences

**Recommended infrastructure tiers (monthly, Oct 2026 prices; totals are estimates)**

**Budget: $0–49/month**
- Helius Free ($0) or Developer ($49).
- Helius Sender with SWQOS-only as the default tip mode (0.000005 SOL), plus a "fast" toggle for Sender Max (0.001 SOL).
- PumpPortal free `subscribeNewToken` and `subscribeMigration` streams for new pairs (API key required).
- Standard WebSocket `accountSubscribe` for the user's own wallet.
- Runs locally. No X API, or bring-your-own key.
- Optional Hetzner CPX22 VPS (€19.49 ≈ $22).
- Limits: no all-trades trenches feed; 10–50 RPS.

**Standard: ~$150–340/month (reference $250 = gRPC + Helius Developer; VPS and X data optional)**
- Flat-rate gRPC for the full pump.fun+PumpSwap feed: Shyft Build $199, SVS gRPC $150, ERPC €198, or Chainstack Growth + Yellowstone $98.
- Helius Developer ($49) for RPC, DAS, Sender and staked sending.
- Hetzner CPX32 VPS (€35.49 ≈ $40).
- Third-party X data (twitterapi.io at $0.15 per 1K tweets): about $10–50/month (estimate).
- Single-vendor alternative: Helius Business $499.

**Pro: ~$1,500–3,000/month (reference $2,000)**
- Helius Professional ($999) or Business ($499) plus a second gRPC provider for redundancy.
- Colocated bare metal in Frankfurt, Amsterdam or New York: OVH $204–383, Latitude from $296, Cherry.
- Optional shreds: DoubleZero Edge $450–1,500/IP, Triton from $450, Helius $800–1,000.
- Official X API pay-per-use ($0.005/post; ~$100–300/month estimate; capped at 3M reads).

**Community-hosted option** (if the project runs shared infrastructure)
- Start at Helius Business ($499) with a push-based gateway. That is ≈$5–6/user/month at 100 users.
- Move to Professional at ~1,000 users (≈$1.6–2/user).
- Evaluate own nodes plus Helius-for-Sender only at multi-thousand users or for latency control.
- Keep signing **client-side** to avoid $1.50–150/user/month in hosted-wallet fees.

**Suggested README break-even message (numbers as of Oct 3, 2026, SOL = $119.50):**

> **This terminal takes 0% of your trades. Trading still isn't free.** On every trade you pay:
> - the venue's protocol fee (pump.fun bonding curve 1.25%; PumpSwap 0.30–1.25% depending on market cap; Raydium ~0.25%);
> - Solana's network fee (0.000005 SOL base, plus the priority fee you choose);
> - any tip you choose (from 0.000005 SOL via Helius Sender SWQOS-only, 0.001 SOL for Sender Max);
> - a refundable 0.0015 SOL rent deposit for each new token account. We reclaim it for you when you close the position.
>
> You also pay for your own infrastructure. Compared with a 1% terminal (0.75–0.95% on Axiom after cashback), self-hosting pays for itself above about:
> - **$0 setup (free tiers):** from the first trade, with limited features;
> - **$49/month:** ~$4,900–6,500 of monthly trading volume (~41–55 SOL);
> - **$250/month:** ~$25,000–33,000 (~209–279 SOL);
> - **$2,000/month (pro, shreds and colocation):** ~$200,000–267,000.
>
> If you trade less than that, use the free setup or keep using a hosted terminal. On small trades your gas settings matter more than any platform fee: 0.002 SOL of priority fee plus tip is 2% of a 0.1 SOL trade, each way.

**Per-trade costs the app should display** (pre-trade estimate and post-trade actuals parsed from the transaction):
1. **Protocol/venue fee**, as a percentage and in SOL. Split into protocol, creator and LP, and show the current PumpSwap market-cap tier.
2. **Aggregator fee**, if routed via Jupiter (10 bps; 50 bps for tokens under 24h on Ultra; 0 on the Swap V2 Router path).
3. **Base fee** (5,000 lamports per signature).
4. **Priority fee**: CU price × CU limit, in SOL and USD, against the recent median (e.g. ~0.000015 SOL for pump.fun trades on Oct 3, 2026).
5. **Tip**: amount and destination service (Sender Max / SWQOS-only / Jito), against the Jito tip-floor percentiles.
6. **Rent deposit** (0.00148844 SOL), marked "refundable", with an auto-close or reclaim action.
7. **Price impact and maximum slippage loss** at the chosen tolerance.
8. **Total cost**: one-way and estimated round trip, as a percentage of trade size. Warn when fixed costs exceed 1% of size.
9. **Failed-transaction cost**: base plus priority fee is still paid if the trade fails.
10. **"Platform fee: 0"**, with a running "saved vs a 1% terminal" counter.

### Gaps
- Real end-to-end landing success rates for SWQOS-only vs Sender Max vs Jito at different tips were not measured. The default tip mode should be validated empirically before launch.
- Per-user volume distributions are needed to state what share of users clears each break-even.
