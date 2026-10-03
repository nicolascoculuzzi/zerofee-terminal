# Non-spot "extras" in Axiom-style Solana terminals: yield, deposits/bridging/on-ramps, portfolio & PnL, rewards, wallet security, mobile (as of October 2026)

> Scope and method notes. Researched 2026-10-03. The user cut perpetuals from scope partway through, so perps appear below as one line only. The shared web-search budget ran out partway through, so later findings come from fetching primary docs directly. Several "Axiom guide" sites (axiompedia.com, axiompro.app) are third-party referral/affiliate sites. They are used only where nothing better existed and are flagged each time. "[unverified]" marks claims I could not confirm from a primary source.

## Perpetuals

Perps: out of scope by user decision; Axiom offers it via Hyperliquid — [Axiom docs: Trading on Hyperliquid](https://docs.axiom.trade/perpetuals/trading-on-hyperliquid)

## Yield / earn: what Axiom uses, the APIs/SDKs to deposit and withdraw SOL/USDC, and the risks

### Takeaway
Axiom's earn offering has two parts. (a) Native SOL staking to Axiom's own validator, plus an "axiSOL" liquid-staking token from a stake pool that charges 5% of earnings and 0.1% on withdrawal. (b) A lending "Yield" tab built on MarginFi for SOL, USDC and mSOL. MarginFi has since become Project 0, and its old SDK was deprecated in 2026. For a zero-fee self-hosted build, the cleanest integrations are Kamino's keyless REST API and Jupiter Lend's REST API (free API key). Both return unsigned transactions that we sign locally. For SOL yield, buy an LST through Jupiter, where the platform fee is 0 bps.

### Cited Findings
**Axiom**
- Axiom docs, "Staking" page:
  - Native SOL staking through Axiom's validator, using Solana's audited Stake Pool Program. Axiom says it "adopted Harmonic" to generate higher rewards.
  - Direct validator staking has 0% commission, and stakers get "100% of MEV and staking rewards".
  - axiSOL (the liquid staking token) charges a 5% fee on earnings and a 0.1% fee on withdrawals, and "secures over 400k SOL".
  - Available via the Axiom site, Ledger or Phantom. No APY figures are given.
  - Source: [Axiom docs: Staking](https://docs.axiom.trade/staking.md)
- A Coin Bureau review dated June 9, 2026 confirms the same staking setup and fees, and warns that "these fees can change". — [Coin Bureau review](https://coinbureau.com/review/axiom-trade-review)
- Lending yield: users deposit SOL, USDC or mSOL into MarginFi lending vaults from the portfolio page. Advertised as "up to 15% APY with instant withdrawals" (Sacra profile, undated). — [Sacra: Axiom](https://sacra.com/c/axiom/)
  - A live yield page exists at axiom.trade/yield?chain=sol but returned HTTP 403 to fetches, so the provider Axiom uses today is unverified. — [Axiom yield page](https://axiom.trade/yield?chain=sol)
  - Some secondary reviews also say Kamino. — [Techiexpert review](https://techiexpert.com/axiom-trade-review/) [unverified/secondary]
- Axiom's current docs index lists "Staking" but has no lending/yield page. — [Axiom docs index (llms.txt)](https://docs.axiom.trade/llms.txt)

**MarginFi → Project 0**
- app.marginfi.com now says "marginfi has moved to Project 0". — [app.marginfi.com](https://app.marginfi.com/)
- SDK migration timeline (2026):
  - March 15: `marginfi-client-v2` deprecated, with no further updates.
  - August 25: the mainnet upgrade to program 0.1.10 breaks older SDKs on flash loans and health simulation.
  - September 4: banks move to new oracle setups, and SDKs below 2.8.0 cannot decode them.
  - Source: [Project 0 migration guide](https://docs.marginfi.com/typescript-sdk/migration)
- The new SDK (same guide):
  - Package: `@0dotxyz/p0-ts-sdk@^2.8.0`.
  - `Project0Client.initialize(connection, config)` needs no wallet.
  - `makeDepositTx(bank, "100")` and `makeWithdrawTx(bank, amount, withdrawAll)` return transactions for you to sign and send. Withdrawals may return several chained transactions.
  - Accounts are PDAs with an account index.
  - Source: [Project 0 migration guide](https://docs.marginfi.com/typescript-sdk/migration)
- Project 0 calls itself a "DeFi-native prime broker", with cross-venue margin across Kamino, Drift, Jupiter Lend and its own pool (search-snippet level only). — [Yieldwire](https://yieldwire.xyz/blog/marginfi-solana-yields-after-relaunch) [secondary]

**Kamino (REST and SDK)**
- Public API base is `https://api.kamino.finance`, with no API key required for public endpoints. — [Kamino docs index](https://kamino.com/docs/llms.txt)
  - Earn vaults: `POST /ktx/kvault/deposit`, `POST /ktx/kvault/withdraw`, `GET /kvaults/vaults`.
  - Lending: `POST /ktx/klend/deposit|withdraw|borrow|repay`.
- Earn deposit flow: — [Kamino: Earn via API](https://kamino.com/docs/build/recipes/earn/earn-via-api.md)
  - Request: `POST` with body `{"wallet":"<pubkey>","kvault":"<vault>","amount":"1.0"}`.
  - Response: `{"transaction":"<base64>"}`, a pre-built unsigned transaction that uses address lookup tables (ALTs).
  - The client decodes it, resolves the ALTs, sets the fee payer and blockhash, signs locally and sends.
- The TypeScript SDK is `@kamino-finance/klend-sdk`, for example `KaminoAction.buildDepositTxns` with the USDC mint. — [klend-sdk on GitHub](https://github.com/Kamino-Finance/klend-sdk)

**Jupiter Lend (REST and SDK)**
- Endpoints: — [Jupiter Lend OpenAPI spec](https://developers.jup.ag/docs/openapi-spec/lend/lend.yaml)
  - Base URL: `https://api.jup.ag/lend/v1`.
  - Writes: `POST /earn/deposit`, `/earn/withdraw`, `/earn/mint`, `/earn/redeem`. Each also has an `-instructions` variant that returns raw instructions.
  - Body: `{asset, signer, amount}`, or `{asset, signer, shares}` for mint/redeem. Returns a base64 unsigned transaction.
  - Reads: `GET /earn/tokens`, `GET /earn/positions?users=`, `GET /earn/earnings?user=&positions=`.
  - Every endpoint requires an `x-api-key` header.
- SDKs: `@jup-ag/lend` (build) and `@jup-ag/lend-read` (read). — [Jupiter developer docs index](https://developers.jup.ag/docs/llms.txt)
- API keys come from Jupiter's portal and go in the `x-api-key` header to api.jup.ag. Rate limits by plan: — [Jupiter developer docs index](https://developers.jup.ag/docs/llms.txt)

  | Plan | Price | Rate limit |
  |---|---|---|
  | Keyless | free | 0.5 RPS |
  | Free | free | 1 RPS |
  | Developer | $25/mo | 10 RPS |
  | Launch | $100/mo | 50 RPS |
  | Pro | $500/mo | 150 RPS |

- Jupiter warns that public RPC endpoints are rate-limited and recommends Helius, Triton or Alchemy. — [Jupiter Lend overview](https://developers.jup.ag/docs/lend)

**SOL yield via an LST swap**
- Jupiter's Meta-Aggregator charges a 0 bps platform fee on "Jupiter token purchases (SOL/Stable → JUP/JLP/jupSOL)" and on pegged pairs (LST-LST, stable-stable). — [Jupiter: Order & Execute](https://developers.jup.ag/docs/swap/order-and-execute.md)

**Risks**
- Drift Protocol lost about $270M in an exploit on April 1, 2026, and told users not to deposit "until further notice". — [Yahoo Finance](https://finance.yahoo.com/markets/crypto/articles/solana-based-drift-protocol-investigates-185731011.html)
  - Later reports say Drift is relaunching with Tether backing as a USDT-margined venue. — [CoinGabbar](https://www.coingabbar.com/en/crypto-currency-news/drift-protocol-recovery-plan-tether-relaunch-update-june-2026) [secondary]
  - Reports also say integrators must re-initialize on new program IDs. — [rfp.wiki](https://www.rfp.wiki/crypto/stablecoins-on-off-ramps/defi-financial-services/drift-protocol) [secondary]
  - This matters for yield because Drift is one of the venues Project 0 aggregates, so cross-venue products carry other venues' contract risk.

### Inferences
- **USDC parking:** use Kamino Earn via REST (no key; returns an unsigned transaction we sign with our own keystore) or Jupiter Lend Earn (free key).
  - Neither documented API has an integrator-fee field, so we add nothing.
  - Remaining costs are protocol-side (reserve borrow/supply spread, any vault performance or management fee) plus Solana network fees.
- **SOL:**
  - Hold an LST rather than axiSOL, which takes 5% of rewards plus 0.1% on exit. jupSOL costs 0 bps via Jupiter `/order`. JitoSOL works via `/build` (no Jupiter fee), or at 0 bps on `/order` if you already hold another LST, since LST-LST counts as pegged.
  - Native stake accounts are the lowest-counterparty option, but unstaking takes about an epoch (general knowledge, not sourced here).
- **"Instant withdrawals" depend on utilization.** A fully borrowed reserve can't be withdrawn until borrowers repay. This is standard lending risk and worth warning about in the UI (general knowledge).
- **Skip the Project 0 SDK.** It had three breaking changes in 2026, which means a real maintenance burden for a one-person build.
- **Never hard-code APYs.** Read them from `GET /kvaults/vaults` and `GET /earn/tokens`.

### Gaps
- Whether Axiom's Yield tab still routes to MarginFi/Project 0 in October 2026, or has switched to Kamino or Jupiter Lend. The page returns 403 to fetches, and Axiom's docs have no lending page.
- Kamino vault fee schedules and Jupiter Lend's fee/spread model were not retrieved.
- No current APY numbers were captured. They are dynamic anyway.

## Deposits, withdrawals, bridging, fiat on/off-ramps, CEX deposit flows and SOL↔USDC swaps

### Takeaway
Axiom funds wallets through a Coinbase on-ramp (up to $500 a week without KYC) and an in-app "Convert" swap, and it doesn't say which provider powers Convert. Every bridge and swap aggregator offers an optional integrator/app fee, and we can just leave it unset. Protocol fees still apply:
- **Relay:** $0.02 plus 0–0.15% depending on route type.
- **deBridge:** about 8 bps plus a flat native-token fee.
- **Mayan Swift:** no protocol fee.
- **Jupiter `/build`:** no Jupiter fee.

Fiat on-ramp production access needs partner onboarding (MoonPay and Transak production keys require KYB). For a single user the practical options are linking out to an exchange, or Coinbase Onramp through a self-serve CDP project.

### Cited Findings
**Axiom**
- "Buy Crypto" uses Coinbase as the partner, and users can transact "up to $500 without KYC". — [Axiom docs: Buy Crypto](https://docs.axiom.trade/axiom/buy-crypto.md)
- Sacra dates the Coinbase on-ramp to July 2025 (older info) and gives the limit as "$500 of crypto per week with no KYC". — [Sacra](https://sacra.com/c/axiom/)
- "Convert" swaps crypto to USDC inside Axiom. The provider isn't disclosed. — [Axiom docs: Convert](https://docs.axiom.trade/axiom/swap/convert.md)
- Axiom trades on Solana, BSC and Ethereum (rewards apply on all three). — [Axiom docs: Reward System](https://docs.axiom.trade/getting-started/reward-system.md)

**Coinbase Onramp**
- Overview: — [Coinbase Onramp overview](https://docs.cdp.coinbase.com/onramp/introduction/welcome)
  - Requires a CDP account and API keys.
  - Two integration styles: Coinbase-hosted, or headless with embedded Apple Pay/Google Pay.
  - Payment methods: debit cards, credit cards (outside the US), Apple Pay, Google Pay, ACH (US only) and Coinbase balances.
  - Solana is among the supported networks.
- Session token: — [CDP API: Create session token](https://docs.cdp.coinbase.com/api-reference/rest-api/onramp-offramp/create-session-token)
  - `POST https://api.developer.coinbase.com/onramp/v1/token`, with `Authorization: Bearer <JWT>` signed using the CDP API key.
  - Body: `addresses` (required: address plus blockchains), plus optional `assets` and `clientIp`.
  - Returns a single-use `token` that expires after 5 minutes.
- Offramp: — [Coinbase Offramp guide](https://docs.cdp.coinbase.com/onramp/offramp/offramp-integration-guide.md)
  - URL format: `https://pay.coinbase.com/v3/sell/input?partnerUserRef=…&redirectUrl=…&sessionToken=…`.
  - In production, `redirectUrl` must be on the domain allowlist.
  - Tokens are created on the backend, once per user session.

**MoonPay**
- URL signing: — [MoonPay URL signing](https://dev.moonpay.com/widget/on-ramp/customization/url-signing.md)
  - `signature` is mandatory whenever `walletAddress` or `walletAddresses` is passed.
  - It is an HMAC-SHA256 of the whole query string, including the leading `?`, keyed with `sk_test_…` or `sk_live_…`.
  - Base64-encode the result, URL-encode it, append it as `&signature=`, and do this server-side.
- Go-live criteria: — [MoonPay going live](https://dev.moonpay.com/platform/overview/going-live.md)
  - Show MoonPay's terms and privacy policy, separate fee lines (network, ecosystem, MoonPay), "Powered by MoonPay", and the regional disclosures.
  - Onboarding and commercial terms go through MoonPay directly.

**Transak**
- A staging API key is available on signup. — [Transak docs](https://docs.transak.com/)
- A production key requires KYB plus compliance approval, "three mandatory security changes", and a Mandatory Partner Checklist.
- Off-ramp is supported.

**Relay (EVM/BTC ↔ Solana)**
- Quote API: — [Relay: Get Quote](https://docs.relay.link/references/api/get-quote)
  - `POST https://api.relay.link/quote`, now deprecated in favour of `/quote/v2`.
  - Required fields: `user, originChainId, destinationChainId, originCurrency, destinationCurrency, amount, tradeType`. The recipient defaults to `user`.
  - `x-api-key` is optional and only raises rate limits.
  - `appFees` (recipient plus bps) is optional.
  - The response includes `steps` and a `fees` object (gas, relayer, relayerGas, relayerService, app, subsidized).
- Solana specifics: — [Relay: Solana guide](https://docs.relay.link/references/api/api_guides/solana.md)
  - Chain ID `792703809`. SOL currency address `11111111111111111111111111111111`; USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`.
  - Supports "all tokens tradeable on Jupiter".
  - Solana's 1232-byte transaction limit produces `SOLANA_TX_TOO_LARGE` errors. Limit routing with `includedOriginSwapSources` or `maxRouteLength`.
- Fees: — [Relay: Cost & fee structure](https://docs.relay.link/references/api/api_core_concepts/fees.md)
  - A $0.02 flat execution fee is always included, plus destination gas.
  - Platform fee by route: token bridge and wrap/unwrap 0.00%; stablecoin swap 0.01%; major swap 0.06%; minor swap 0.15%.
  - App fees are optional and default to none.
- Deposit addresses: — [Relay: Deposit addresses](https://docs.relay.link/features/deposit-addresses.md)
  - Call `/quote/v2` with `useDepositAddress: true` to get a `depositAddress` that needs no wallet signature. Relay describes this as "ideal for CEX withdrawals, fiat onramps".
  - When the sender is an exchange, set `refundTo` to an address you control.
  - Deposits of $0.05 or less are not swept. Only "solver currencies" are supported; anything else is unrecoverable.
  - Treat "strict" addresses as single-use.
  - Origin chains include Ethereum, Base, Arbitrum, Optimism, BNB, Polygon, Solana and Bitcoin.

**deBridge DLN**
- Fees: — [deBridge: Fee structure](https://docs.debridge.com/dln-details/overview/fee-structure.md)
  - A fixed fee in the source chain's native token (the docs' example is 0.001 ETH).
  - A 4 bps protocol fee.
  - About 4 bps solver ("taker") margin.
  - Estimated operating expenses (the docs' example is about 0.03 USDC).
  - The affiliate fee is optional and zero if you don't configure it.
- Affiliate parameters are `affiliateFeePercent` and `affiliateFeeRecipient`. On Solana same-chain swaps, the recipient must be a Jupiter referral key. — [deBridge: Affiliate fees](https://docs.debridge.com/dln-details/affiliates/affiliate-fees.md)
- Order endpoint: `GET /v1.0/dln/order/create-tx`. — [deBridge docs index](https://docs.debridge.com/llms.txt)

**Mayan**
- Three routes: — [Mayan docs](https://docs.mayan.finance/)
  - Swift: about 2 s, filled from solver capital already on the destination chain.
  - MCTP / Fast MCTP: about 5 s, via Circle CCTP.
  - Wormhole Swap: under a minute.
  - Chains include Solana, Ethereum, Base, Arbitrum, BNB, Monad, Sui and HyperEVM.
- Fees: — [Mayan: Fees & earning](https://docs.mayan.finance/build/fees-earning.md)
  - "Swift has no protocol fee".
  - MCTP and Wormhole quotes return a variable `protocolBps`.
  - The integrator `referrerBps` is optional, with caps of 200 bps on Swift and 100 bps on MCTP from Solana.
- The SDK can build transactions on EVM, Solana and Sui, including a manual instruction-building mode. — [Mayan docs index](https://docs.mayan.finance/llms.txt)

**LI.FI**
- The integrator fee is set with `fee` (a decimal fraction of `fromAmount`) and needs an `integrator` string. — [LI.FI monetization](https://docs.li.fi/introduction/integrating-lifi/monetizing-integration)
- "LI.FI may receive a share of the collected fees depending on the use case and volume."
- On Solana swap-and-bridge routes, the fee applies to the intermediate token.
- Fee wallets are configured at portal.li.fi.

**Across**
- Across advertises fills in under 2 seconds across 26+ chains. The landing page I fetched did not confirm Solana support. — [Across docs](https://docs.across.to/)

**Circle CCTP V2 (native USDC burn/mint)**
- Solana is CCTP domain 5. — [Circle CCTP how-to (Solana source)](https://developers.circle.com/cctp/howtos/transfer-usdc-from-solana-to-hypercore)
- `minFinalityThreshold` 1000 means a fast transfer; 2000 means standard.
- The fast-transfer protocol fee example is 1 bp of the amount. Live fees come from the Iris API at `/v2/burn/USDC/fees/{src}/{dst}`.
- That guide targets one specific destination; only its generic CCTP parameters are used here.

**SOL↔USDC swaps (Jupiter)**
- Swap API V2 base: `https://api.jup.ag/swap/v2`. — [Jupiter: Order & Execute](https://developers.jup.ag/docs/swap/order-and-execute.md)
- Meta-Aggregator (`/order` + `/execute`) platform fees are built into quotes and can't be removed:

  | Pair type | Jupiter platform fee |
  |---|---|
  | Pegged pairs and Jupiter tokens | 0 bps |
  | SOL-stable | 2 bps |
  | LST-stable | 5 bps |
  | Other pairs | 10 bps |
  | Tokens less than 24 h old | 50 bps |

- The referral fee is optional (50–255 bps), and Jupiter keeps 20% of it.
- The Router (`/build`, Metis-only routing) has "No Jupiter swap fees". — [Jupiter developer docs index](https://developers.jup.ag/docs/llms.txt)

**Detecting deposits (including from a CEX)**
- Solana RPC `accountSubscribe(pubkey, {commitment, encoding})` pushes `accountNotification` messages. Cancel with `accountUnsubscribe`. — [Solana docs: accountSubscribe](https://solana.com/docs/rpc/websocket/accountsubscribe)
- Helius `GET /v0/addresses/{address}/transactions`: — [Helius Enhanced Transactions](https://www.helius.dev/docs/api-reference/enhanced-transactions/gettransactionsbyaddress)
  - Filters: `type`, `source`, slot and time ranges, and `limit` from 1 to 100.
  - You need `token-accounts=balanceChanged` (or `all`) to catch incoming SPL transfers that only touch associated token accounts.

### Inferences
**Settings that keep our fee at zero**

| Provider | What to do |
|---|---|
| Relay | Omit `appFees` |
| deBridge | Omit `affiliateFee*` |
| Mayan | Omit `referrerBps` |
| LI.FI | Omit `fee`. LI.FI's own cut is opaque, so prefer calling Relay or Mayan directly. |
| Jupiter | Use `/build` (no Jupiter fee) for SOL↔USDC, or accept 2 bps on `/order` for RFQ routing. Never set `referralFee`. |

**Fees we cannot remove:**
- Solana network fees and tips.
- Relay's $0.02 and its platform bps.
- deBridge's 4 bps, solver margin and flat fee.
- The CCTP fast-transfer fee.
- On-ramp card fees and spreads.

**On/off-ramp for one person:**
- MoonPay and Transak production access needs KYB, so they are impractical.
- Coinbase CDP is self-serve, but production redirect URLs must be allowlisted. A localhost or `*.ts.net` origin may not qualify [unverified].
- Simplest path: a "Buy" button that deep-links to the user's own exchange, while the terminal shows the deposit address and QR code.
- Off-ramp by sending USDC/SOL to the user's own exchange deposit address, kept on the withdrawal allowlist.

**CEX → Solana:**
- Withdrawing to a self-custody address needs no memo. Memos only matter for exchange omnibus addresses (general knowledge).
- Detect arrivals by subscribing to the wallet's SOL account and token ATAs, with Helius backfill to reconcile.
- For funds stuck on EVM chains, use a Relay deposit address with `refundTo` set to the user's own address.

### Gaps
- Coinbase's guest-checkout limits and fees from Coinbase's own docs. Only Axiom and Sacra state the "$500 (per week) without KYC" figure.
- Whether Coinbase's allowlist accepts localhost or tailnet origins.
- Across's Solana support and its integrator-fee options.
- Mayan's current MCTP protocol bps.
- MoonPay and Transak fee levels.
- Which provider powers Axiom's Convert.

## Portfolio & PnL: calculation conventions, historical charts, shareable PnL cards, trade-history CSV export

### Takeaway
Axiom shows separate spot and perps portfolios. Each has:
- Balance and unrealized PnL.
- A PnL chart.
- PnL distribution buckets.
- Per-position bought / sold / remaining / PnL %.
- An activity feed.

Axiom does not document how it calculates any of this. Recommendations for our build:
- **Cost basis:** weighted-average cost per mint, in both SOL and USD. Count all acquisition costs in basis (network fee, priority fee, Jito tip, launchpad/DEX fee), and deduct sale costs from proceeds.
- **Share cards:** render server-side with Satori → resvg-js; both run on Bun.
- **Tax export:** export a raw ledger CSV (CoinLedger-style template) and let tax software apply the local lot method.

### Cited Findings
- Axiom spot portfolio shows: — [Axiom docs: Portfolio](https://docs.axiom.trade/axiom/portfolio.md)
  - Total value, available balance and unrealized PnL.
  - A PnL chart.
  - Total PnL and trade counts by profitability range.
  - Active positions with "amount bought, sold, remaining balance, and the PNL percentage".
  - An activity feed with Solscan links.
  - Perps have their own portfolio.
  - The page does not document the calculation method, fee treatment, sharing or export.
- GMGN lets you share PnL from a token page or from wallet dashboard tabs (Recent PnL, Holdings, Activity). Backgrounds are customizable, cards go to X or Telegram, and the feature is framed as part of the referral program. — [GMGN: Share transaction profits](https://docs.gmgn.ai/index/cooperation-referral-share-transaction-profits.md)
- GMGN is described as offering "deep wallet analytics, PnL history" (as of Aug 28, 2026). — [TraderView](https://traderview.com/)
- GMGN documents the fee components that belong in PnL: — [GMGN fees & settings](https://docs.gmgn.ai/index/gmgn-fees-settings.md)
  - A 1% platform fee.
  - Launchpad fees, such as Pump.fun's 1%.
  - Total on-chain fee = priority fee + tip + gas.
- US tax rules (IRS FAQ): — [IRS virtual currency FAQ](https://www.irs.gov/individuals/international-taxpayers/frequently-asked-questions-on-virtual-currency-transactions)
  - FAQ 8: basis includes "fees, commissions and other acquisition costs".
  - FAQ 7: gain/loss = amount received − adjusted basis.
  - FAQ 39–40: specific identification is allowed with records of acquisition and sale date/time, basis and fair market value.
  - FAQ 41: the default is FIFO.
  - FAQ 46: keep records.
- Satori: — [Satori](https://github.com/vercel/satori)
  - Converts JSX/HTML + CSS to SVG.
  - Flexbox only (Yoga); no CSS grid.
  - Fonts must be passed in as TTF/OTF/WOFF data; no WOFF2.
  - Images via `<img>` with a URL or base64. Emoji via `graphemeImages` or `loadAdditionalAsset`.
  - Runs on Node 16+, browsers, workers and edge runtimes. PNG output needs resvg. Licence: MPL-2.0.
- resvg-js: — [resvg-js](https://github.com/yisibl/resvg-js)
  - Two packages: `@resvg/resvg-js` (napi-rs) and `@resvg/resvg-wasm`.
  - Usage: `new Resvg(svg, opts).render().asPng()`. Fonts load via `fontFiles` or `fontBuffers`.
  - Runs unmodified on Bun since 0.8.1.
- Rebuilding trade history: Helius returns: — [Helius Enhanced Transactions](https://www.helius.dev/docs/api-reference/enhanced-transactions/gettransactionsbyaddress)
  - `events.swap` (tokenInputs/tokenOutputs), `tokenTransfers`, `nativeTransfers`, `fee`, `feePayer`.
  - `source` (JUPITER, PUMP_FUN, RAYDIUM…), and you can filter with `type=SWAP`.
- Pricing positions with Jupiter: — [Jupiter developer docs index](https://developers.jup.ag/docs/llms.txt)
  - Price API `GET /price/v3?ids=` covers up to 50 mints with heuristic USD prices.
  - Portfolio API `GET /portfolio/v1/positions?wallet=` returns DeFi positions, including yield positions.
- CoinLedger universal import template: — [CoinLedger template guide](https://help.coinledger.io/en/articles/6028758-universal-manual-import-template-guide)
  - Columns: `Date (UTC), Platform, Asset Sent, Amount Sent, Asset Received, Amount Received, Fee Currency, Fee Amount, Type, Description, TxHash`.
  - Dates as `mm/dd/yyyy hh:mm:ss`, in UTC.
  - Deposit types: Income, Interest, Staking, Airdrop, Deposit and others. Withdrawal types: Gift Sent, Theft Loss, Withdrawal and others.
  - Trades fill both the sent and received sides.
  - Leave unused fields blank (no "0" or "N/A"). Skip the fee fields if the fee is already netted out.

### Inferences
**PnL engine (recommended conventions)**
- Use our executor's own fill log as the source of truth. Backfill and reconcile from Helius for anything executed outside the terminal.
- Track each (wallet, mint) position as: quantity, total cost in SOL, total cost in USD (SOL/USD at fill time), and average cost = total cost / quantity.
- **Buy:** cost = SOL spent + base fee + priority fee + Jito tip + any launchpad/DEX fee. Our own fee is 0.
  - ATA rent is refunded when the account closes, so track it separately, not as PnL.
- **Sell:** realized PnL = (SOL received − sell fees and tips) − average cost × quantity sold. Reduce total cost pro rata so the average cost stays the same.
- **Unrealized:** quantity × mark price − remaining cost. Take the mark from Jupiter Price or the last fill.
- Show PnL in both SOL and USD.
- Transfers in or out are not PnL events:
  - Tokens arriving with unknown basis get a "basis unknown" flag.
  - Airdrops default to 0 basis, which the user can edit.
- Use average cost for on-screen PnL. The tax export emits raw fills so the tax tool can apply FIFO or specific-ID (US) or average-cost/pooling rules elsewhere.

**History charts**
- Store periodic equity snapshots (SOL + tokens × price + yield positions) in SQLite.
- Derive cumulative realized PnL and a daily PnL calendar from the ledger.

**PnL card**
- Pipeline: React component → Satori (fonts bundled) → resvg-js → PNG.
- Size: 1200×675 for X cards, or 1080×1350.
- Fields: symbol, PnL % and amount in SOL/USD, entry and exit market cap, hold time.
- Render locally with no third-party upload. Offer toggles to hide absolute amounts and the wallet address.
- Cache by trade ID. Headless Chromium screenshots are a heavier fallback.

**CSV export**
- Native schema: ISO-8601 UTC timestamp, signature, wallet, side, mint, symbol, quantity, price in SOL, price in USD, SOL amount, a fee breakdown (base / priority / tip / venue), and the program/venue.
- Plus preset mappings for CoinLedger and Koinly.

### Gaps
- Axiom's and competitors' exact PnL method (average cost or FIFO; whether tips and priority fees count) is undocumented.
- Koinly's universal CSV spec page returned 403, and the Awaken Tax format was not retrieved.
- Non-US cost-basis rules were not retrieved (Canada ACB average cost, UK s.104 pooling, France's portfolio formula). The CRA page fetched was only a landing page.

## Rewards, referrals and points (for completeness; likely dropped)

### Takeaway
- **Axiom:** 1% base fee, with volume-tiered SOL cashback from 0.05% to 0.25% of trade value. Three-level referrals pay 30%, 3% and 2% of referees' fees. There is also a points/leaderboard program with no published redemption terms.
- **GMGN:** 1% fee, 10–30% referral commissions, and PnL-card sharing tied to referrals.

These are all rebates on roughly a 1% fee, so a zero-fee self-hosted build makes them pointless.

### Cited Findings
- Axiom fee tiers. The multiplier rises with lifetime volume, and cashback is paid in SOL. — [Axiom docs: Axiom Fees](https://docs.axiom.trade/getting-started/fees/axiom-fees.md)

  | Tier | Multiplier | Net fee | Cashback |
  |---|---|---|---|
  | Wood | 1x | 0.95% | 0.05% |
  | Bronze | 2x | 0.90% | 0.10% |
  | Silver | 2.5x | 0.875% | 0.125% |
  | Gold | 3x | 0.85% | 0.15% |
  | Platinum | 3.5x | 0.825% | 0.175% |
  | Diamond | 4x | 0.80% | 0.20% |
  | Champion | 5x | 0.75% | 0.25% |

- Axiom referrals pay Tier 1 30%, Tier 2 3% and Tier 3 2%. Cashback applies to Solana, BSC and Ethereum trades. — [Axiom docs: Reward System](https://docs.axiom.trade/getting-started/reward-system.md)
- Axiom points are earned per trade and from referrals, including second-level referrals, with a leaderboard. No redemption or token terms are published. — [Axiom docs: Point System](https://docs.axiom.trade/getting-started/point-system.md)
- Referral codes give about a 10% fee discount (third-party affiliate claims). — [Axiompedia referral (affiliate)](https://axiompedia.com/referral); [TraderView](https://traderview.com/)
- GMGN direct referral commissions are 10–30% depending on referred volume, can go higher by application, and are paid in SOL. — [GMGN referral](https://docs.gmgn.ai/index/cooperation-referral-refer-friends-to-earn-rebate-30-rebates-easily-earn-over-usd8000-monthly.md)
- GMGN charges a 1% fee. — [GMGN fees](https://docs.gmgn.ai/index/gmgn-fees-settings.md)
- Base fees as of August 2026: Axiom 1%, GMGN 1%, Photon 1%, BullX 1%, Trojan 0.9%, Bloom 1%. — [TraderView](https://traderview.com/)
- Scale:
  - Turnkey says Axiom made $100M+ in revenue within 100 days of moving to Turnkey. — [Turnkey case study](https://www.turnkey.com/customers/axiom-global-defi-trading-platform)
  - Another source reports $200M+ revenue in 202 days and about 70% terminal market share in H1 2026. — [The Learning Pill, H1'26](https://thelearningpill.substack.com/p/the-state-of-the-trenches-h126)

### Inferences
- Even Champion-tier Axiom users pay 0.75% net per trade, so zero platform fee saves that on every fill.
- A "fees saved vs. Axiom Wood/Champion" counter is a cheap optional stat to show.
- Drop referrals, cashback and points entirely.

### Gaps
- Current referral splits for Photon, BullX and Terminal (Padre) were not verified.

## Wallet security: what commercial terminals use, and the best equivalent for a self-hosted single-user app

### Takeaway
Axiom's wallets run on Turnkey. Keys are generated and used inside attested secure enclaves under a JSON policy engine, and users can export their seed. Axiom documents no 2FA and no withdrawal allowlists. Its February 2026 incident was insider misuse of internal dashboards, not key theft.

A self-hosted single-user build should replace the enclave with:
- An Argon2id-encrypted hot keystore, unlocked per session.
- Optional OS-keychain storage, on desktop only.
- A small hot balance, with automatic sweeps to a hardware or multisig cold address.
- Withdrawal allowlists and spend caps enforced by the backend.
- A kill switch.

### Cited Findings
**Commercial practice**
- Axiom uses Turnkey's policy engine and "Programmable Key Management", with policies written as JSON, to automate on-chain actions. Turnkey says Axiom never controls user funds or keys, and cites 1M+ wallets and 100K+ onboardings a month. — [Turnkey case study](https://www.turnkey.com/customers/axiom-global-defi-trading-platform)
- Turnkey runs critical operations in secure enclaves (TEEs), with remote attestation via QuorumOS. — [Turnkey: Our approach](https://docs.turnkey.com/security/our-approach)
  - "No single developer at Turnkey can alter or deploy enclaves, or reconstruct core secrets."
  - Every change to an organization's data must be approved and cryptographically stamped inside an enclave before the policy engine considers it.
- Privy splits keys with Shamir secret sharing into 2-of-2 shares: an enclave share and an auth share. — [Privy architecture](https://docs.privy.io/security/wallet-infrastructure/architecture)
  - It uses AWS Nitro Enclaves, which have "no persistent storage, no interactive access, and no network connectivity".
  - The key is rebuilt in memory only to sign, then destroyed.
- Axiom shows a 12-word seed at signup, exportable to Phantom, Rabby or Solflare. As of August 2026 no 2FA is documented and withdrawal whitelists aren't mentioned. MEV protection has three modes: Off, Reduced and Secure. — [Axiompedia (third-party)](https://axiompedia.com/security/is-axiom-trade-safe)
- February 2026: ZachXBT alleged that a senior business-development employee and associates used internal "God mode" dashboards to access private user data, track wallets and front-run trades for about ten months, and that Axiom lacked role-based access control. — [The Learning Pill](https://thelearningpill.substack.com/p/the-state-of-the-trenches-h126)
  - Axiom acknowledged the tool abuse and removed access. No funds or keys were compromised. — [Axiompedia](https://axiompedia.com/security/is-axiom-trade-safe)

**Self-hosted building blocks**
- Bun.secrets: — [Bun docs: Secrets](https://bun.com/docs/runtime/secrets)
  - API: `get`, `set` and `delete({service, name[, value]})`.
  - Backends: macOS Keychain, Linux libsecret (needs a running secret-service daemon) and Windows Credential Manager. The OS encrypts credentials at rest.
  - The docs call it new and experimental (labelled v1.4.2 on the page) and "mostly useful for local development tools". They recommend against it for production servers or headless systems.
- Key-derivation parameters from OWASP, in order of preference: — [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
  - Argon2id: at least m=19 MiB, t=2, p=1.
  - scrypt: N=2^17, r=8, p=1.
  - PBKDF2-HMAC-SHA256: 600,000 iterations.
- Squads spending limits: — [Squads: Spending limits](https://docs.squads.so/main/navigating-your-squad/settings/spending-limits.md)
  - A member can move up to a set amount without full multisig approval.
  - Each limit covers one token, can be restricted to set destination addresses, and resets each period.
- Ledger supports Solana through its Solana app, used with Phantom, Solflare or Ledger Live. Some operations need blind signing. — [Ledger support](https://support.ledger.com/article/360016265659-zd) [thin source; summary-level]

### Inferences
Recommended self-hosted design:
1. **Keystore**
   - Generate hot keypairs locally and store them only as ciphertext: Argon2id(passphrase, salt) → key-encryption key → XChaCha20-Poly1305 or AES-256-GCM over the 64-byte secret.
   - Unlock at session start, hold the key in memory, auto-lock when idle, and wipe it on lock.
   - On a macOS desktop, Bun.secrets can optionally hold a wrapped data key for convenience unlock. Don't rely on it on a headless VPS.
   - Never keep plaintext Solana-CLI-style JSON keypairs.
2. **Hot/cold split**
   - The hot wallet holds only the trading float, capped at a set amount.
   - The cold wallet is a Ledger address, or a Squads vault with Ledger signers. Its private key never touches the server.
3. **Profit sweeps:** a scheduler moves any SOL/USDC above the cap to the cold address. The destination is pinned, and every sweep is logged and triggers a notification.
4. **Allowlist and caps**
   - The backend refuses transfers to addresses not on the allowlist.
   - Adding an address needs the passphrase plus a time delay.
   - Enforce caps on single trade size, daily notional volume, and priority fee/tip.
5. **Kill switch:** one action (UI, hotkey or bot) cancels pending orders, stops automations, sweeps to cold and locks the keystore.
6. **Exposure**
   - Bind the server to 127.0.0.1 and allow remote access only via Tailscale.
   - Put the UI behind a passkey (WebAuthn) or TOTP, with CSRF protection.
   - Keep an append-only log of signing events.
7. **Transaction guardrails:** simulate before signing, and reject transactions that call unknown programs or send to unexpected destinations.
- Turnkey and Privy solve multi-tenant custody problems. For one user they add an external dependency and cost without real benefit. Local encryption plus hardware cold storage is the closest equivalent.

### Gaps
- The wallet infrastructure behind GMGN, Photon, BullX and Terminal is unverified.
- Turnkey session and authenticator details (passkeys, session expiry) were not retrieved.
- Which Squads program version supports spending limits was not confirmed.

## Mobile access: which terminals have apps, and how to reach a self-hosted terminal from a phone

### Takeaway
- **Axiom:** no official native app; it is mobile web/PWA only. An App Store app called "Axiom" is an unrelated paper-trading app.
- **GMGN:** web, mobile and Telegram.
- **Fomo:** mobile-first on iOS and Android.
- **Telegram bots:** described as "table stakes".

For a self-hosted terminal, the safest phone access is the React app as a PWA served only inside a Tailscale tailnet. `tailscale serve` provides a real HTTPS certificate, which enables service workers and iOS 16.4+ web push. An optional Telegram bot can handle alerts, with any actions gated behind confirmation.

### Cited Findings
- Axiom has no official app on Google Play or the App Store. Users add axiom.trade to their home screen, and store apps claiming to be Axiom are not legitimate. — [Axiompro (third-party affiliate guide)](https://axiompro.app/download/)
- The App Store listing "Axiom - Social Trading" (id6764267933) is by Carret Labs LLC. It is a paper-trading social app with its privacy policy on axiom.fyi, not Axiom Trade. — [App Store listing](https://apps.apple.com/us/app/axiom-social-trading/id6764267933)
- Mobile availability (verified Aug 28, 2026): — [TraderView](https://traderview.com/)
  - Fomo: "genuinely mobile-first design with iOS and Android apps".
  - GMGN: web, mobile and Telegram.
  - Axiom, Photon, BullX, Trojan and Bloom: mobile "not publicly confirmed".
  - Telegram bots are confirmed for Axiom, GMGN, BullX, Trojan and Bloom.
- All major platforms run Telegram bots alongside the web app, which is now "table stakes rather than a differentiator". — [The Learning Pill](https://thelearningpill.substack.com/p/the-state-of-the-trenches-h126)
- Fomo's mobile app has one-click trading, portfolio views, TP/SL and advanced charts (June 11, 2026 announcement; the perps part is out of scope). — [Fomo blog](https://fomo.family/blog/perpetuals-now-on-fomo)
- Tailscale Serve: — [Tailscale Serve](https://tailscale.com/kb/1312/serve)
  - `tailscale serve 3000` proxies a local port to tailnet devices only.
  - It provisions TLS certificates for `device.tailnet.ts.net`; HTTPS must be enabled in the admin console.
  - It adds `Tailscale-User-Login`, `-Name` and `-Profile-Pic` headers, except for tagged devices.
  - ACLs and grants apply. Funnel is the variant that exposes a service to the public internet.
- iOS web push: — [WebKit blog](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
  - Requires iOS/iPadOS 16.4+, and only for web apps added to the Home Screen with manifest `display: standalone` or `fullscreen`.
  - Permission must follow a user gesture.
  - Built on the Push API, Notifications API, Service Workers and the Badging API.
  - Delivered via Apple Push Notification service; no Apple Developer membership needed.
- Telegram encryption: cloud chats, including ordinary private chats, use server-client encryption, not end-to-end. Only Secret Chats are end-to-end encrypted. — [Telegram FAQ](https://telegram.org/faq)
- Telegram Bot API: — [Telegram Bot API](https://core.telegram.org/bots/api)
  - `setWebhook` accepts a `secret_token` (1–256 characters, `A-Za-z0-9_-`) that comes back in the `X-Telegram-Bot-Api-Secret-Token` header.
  - Webhook ports: 443, 80, 88 or 8443.
  - `getUpdates` long polling needs no public endpoint, and can't be used at the same time as a webhook.

### Inferences
- **Option A (recommended): PWA over Tailscale Serve.**
  - No open ports.
  - The HTTPS certificate makes the PWA installable and enables push on iOS and Android.
  - The identity headers give a second check on who is connecting.
  - Still require an in-app passkey or PIN for anything that signs, in case the phone is lost or unlocked.
  - Keep push payloads content-light, because they pass through Apple's and Google's push services.
- **Option B: raw WireGuard to a home server.** Same model, but more manual. You need your own certificates for PWA features (not sourced here).
- **Option C: Telegram companion bot.**
  - Use long polling so nothing is exposed inbound, and allowlist your numeric chat ID.
  - Send alerts by default. Put any trading command behind confirmation plus a PIN, and never send key material.
  - Remaining risks: a Telegram account takeover, and the fact that bot chats are not end-to-end encrypted.
- **Avoid public exposure for a key-holding app.** That rules out Tailscale Funnel, and tunnels without strong authentication.

### Gaps
- Native-app feature sets for GMGN, Photon, BullX and Terminal were not verified.
- Axiom's stance on mobile comes from a third-party site, not from Axiom.
- The trade-offs of Cloudflare Tunnel/Access were not researched (the search budget ran out).

## Implications for the build

Perps are out of scope. Recommended order, with a provider for each:

1. **Wallet security core.** Build this first; everything else depends on it.
   - Local Argon2id-encrypted keystore with session unlock and auto-lock.
   - Hot/cold split, with a Ledger (or Squads + Ledger) cold address.
   - Withdrawal allowlist, spend and tip caps, a profit-sweep scheduler and a kill switch.
   - Bun.secrets only as an optional convenience on desktop.
2. **Funding and withdrawals.**
   - Receive screen with address, QR and live detection (`accountSubscribe` plus Helius backfill).
   - Withdrawals to allowlisted addresses only.
   - SOL↔USDC via Jupiter `/build` (no Jupiter fee), optionally `/order` (2 bps SOL-stable) for better fills.
   - Zero platform fee everywhere.
3. **Portfolio and PnL.**
   - Our own fill ledger plus Helius reconciliation.
   - Weighted-average cost in SOL and USD, with all fees and tips in basis.
   - Equity snapshots for charts.
   - CSV export in our native format plus CoinLedger and Koinly presets.
4. **PnL cards.** Satori + resvg-js on Bun, rendered locally, with privacy toggles.
5. **Mobile.** PWA via Tailscale Serve with web push. Optionally, a Telegram alert bot using long polling, a chat-ID allowlist and confirmation-gated actions.
6. **Yield (optional).**
   - USDC → Kamino Earn REST (no key, unsigned transactions) or Jupiter Lend Earn (free key).
   - SOL → jupSOL (0 bps on `/order`) or JitoSOL (via `/build`).
   - Skip the Project 0 SDK (breaking changes in 2026) and Drift (April 2026 exploit).
7. **Bridging and on-ramp (optional).**
   - Relay API: Solana chain `792703809`, no app fee by default, 0% platform fee on same-asset bridge routes plus $0.02, and deposit addresses for EVM/CEX inflows.
   - Mayan Swift as a fallback (no protocol fee).
   - On-ramp: link out to the user's exchange, or Coinbase Onramp via a personal CDP project. Skip MoonPay and Transak because both require KYB.
8. **Rewards, referrals and points.** Drop them.
