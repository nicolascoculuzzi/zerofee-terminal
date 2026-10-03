# Solana Transaction Landing and MEV Protection: Implementation Brief for a Self-Hosted TypeScript (Bun) Trading Backend (as of 2026-10-03)

Scope and method note: every URL below was accessed on 2026-10-03. Exact values (endpoints, tip accounts, minimums, limits) were extracted from official documentation pages using an automated page-to-text fetch. Before hardcoding any base58 address, verify it programmatically (for example with Jito `getTipAccounts`) or diff it against the docs in CI, because extraction can mis-transcribe characters. The session's web-search quota ran out partway through. A few items therefore rest on a single fetched source or a search-result snippet; those are marked "(snippet only)" or "UNVERIFIED". "FLAG" marks values that changed recently or are likely to change. Data feeds (gRPC/ShredStream) belong to another researcher and appear here only where they affect landing or confirmation.

---

## 1. Helius Sender: endpoints, tiers, tips, fees, limits, request format, routing

### Takeaway
Helius Sender is paid per send with a SOL tip and uses no API credits. Servers get seven regional plain-HTTP endpoints; browsers get one global HTTPS endpoint.

There are two tiers. FLAG: this tier structure is new in 2026.
- **Sender Max:** tip of at least 0.001 SOL. The transaction enters a "priority tip buffer" and is fanned out across Helius SWQoS, Jito, Harmonic, Rakurai and other pathways, with Helius adding the pathway tips itself.
- **SWQoS-only** (`?swqos_only=true`): tip of at least 0.000005 SOL (5,000 lamports). Uses a single path.

Every transaction must carry a tip transfer and a `setComputeUnitPrice` instruction. The default rate limit is 50 TPS. `?mev-protect=true` and `rebate-address=` (backrun rebates) are opt-in.

### Cited Findings
**Endpoints**
- Frontend/browser (HTTPS): `https://sender.helius-rpc.com/fast`, with ping at `https://sender.helius-rpc.com/ping`. — [Helius Sender docs](https://www.helius.dev/docs/sending-transactions/sender)
- Backend/server regional HTTP endpoints, exactly as written in the Markdown source:
  - `http://slc-sender.helius-rpc.com/fast` (Salt Lake City)
  - `http://ewr-sender.helius-rpc.com/fast` (Newark)
  - `http://lon-sender.helius-rpc.com/fast` (London)
  - `http://fra-sender.helius-rpc.com/fast` (Frankfurt)
  - `http://ams-sender.helius-rpc.com/fast` (Amsterdam)
  - `http://sg-sender.helius-rpc.com/fast` (Singapore)
  - `http://tyo-sender.helius-rpc.com/fast` (Tokyo)
  - Every region has a ping endpoint on the same host with `/ping` in place of `/fast`. — [sender.md](https://www.helius.dev/docs/sending-transactions/sender.md)
  - Note: the rendered-HTML extraction showed Singapore as `/ping`, but the Markdown source shows `/fast`. Treat `/ping` as a rendering artifact. — [Helius Sender docs](https://www.helius.dev/docs/sending-transactions/sender); [sender.md](https://www.helius.dev/docs/sending-transactions/sender.md)
- HTTPS vs HTTP: "The HTTPS endpoint resolves CORS preflight failures that occur with browser-based applications when using the regional HTTP endpoints." Backends should "choose the regional HTTP endpoint closest to your infrastructure for optimal performance." — [sender.md](https://www.helius.dev/docs/sending-transactions/sender.md)
- Connection warming: "Use connection warming when your application has gaps longer than 5 seconds between transactions". The example pings `/ping` with `setInterval(..., 5000)`. — [sender.md](https://www.helius.dev/docs/sending-transactions/sender.md)
  - An older Helius blog instead says to ping during idle periods "exceeding one minute". The 5-second figure in the current docs is the stricter guidance. — [Helius zero-slot blog](https://www.helius.dev/blog/zero-slot)
- The product page advertises "7 global endpoints" in Tokyo, Singapore, London, Amsterdam, Frankfurt, Salt Lake City and Newark. — [helius.dev/sender](https://www.helius.dev/sender)

**Tip accounts (mainnet-beta; pick one at random per transaction)**
- `4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE`, `D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ`, `9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta`, `5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn`, `2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD`, `2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ`, `wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF`, `3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT`, `4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey`, `4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or`. — [Helius Sender docs](https://www.helius.dev/docs/sending-transactions/sender)
- The docs' example chooses one with `TIP_ACCOUNTS[Math.floor(Math.random() * TIP_ACCOUNTS.length)]`. — [sender.md](https://www.helius.dev/docs/sending-transactions/sender.md)

**Tiers and minimums (FLAG: new tier structure)**
- Tier table from the docs:
  - Sender Max: minimum tip 0.001 SOL (1,000,000 lamports); routing "All high-speed pathways"; uses the buffer.
  - SWQoS-only: minimum tip 0.000005 SOL; routing "Single SWQOS path"; no buffer.
  - "Tips between 0.000005 SOL and 0.001 SOL are accepted but do not enter the priority tip buffer."
  - — [Helius Sender docs](https://www.helius.dev/docs/sending-transactions/sender)
- The product page states the SWQoS-only minimum as "0.000005 SOL (5,000 lamports)". One automated extraction showed "5 lamports", which is wrong: 0.000005 SOL is 5,000 lamports. — [helius.dev/sender](https://www.helius.dev/sender)
- Sender Max mechanics:
  - A tip of 0.001 SOL or more enters "a priority tip buffer that prioritizes the highest-tipping submissions".
  - It "routes your submission across every available high-speed pathway" (Helius, Jito, Harmonic, Rakurai) and "automatically adds pathway-specific tips on your behalf—you only provide the Sender tip".
  - "the 0.001 SOL minimum is unlikely to be competitive" for contested transactions. Helius suggests matching "the value of the transaction you're trying to land".
  - Bundles of up to 4 transactions are supported, and only one of them needs to carry the tip.
  - — [sender-max.md](https://www.helius.dev/docs/sending-transactions/sender-max.md)
- SWQoS-only:
  - Enable it by adding `swqos_only=true` to any Sender URL, for example `http://slc-sender.helius-rpc.com/fast?swqos_only=true`.
  - Recommended for "Cost-sensitive trading, high transaction volume". Avoid it for "highly contested accounts, competitive launches".
  - Tips of 0.000005–0.001 SOL "stay on this single path". It consumes no API credits.
  - — [sender-swqos-only.md](https://www.helius.dev/docs/sending-transactions/sender-swqos-only.md)
- An older Helius blog lists minimums of "0.0002 SOL for Jito or 0.000005 SOL (5,000 lamports) for SWQoS-only" and recommends "take the 75th percentile and add a small buffer" for dynamic tips. The 0.0002 SOL figure is superseded by the current 0.001 SOL Sender Max minimum. The blog also describes Sender as submitting "via SWQoS and Jito simultaneously". — [Helius zero-slot blog](https://www.helius.dev/blog/zero-slot)

**Transaction requirements**
- Both a SOL tip transfer and a compute-unit-price instruction are mandatory. `skipPreflight` is optional ("lowers latency when set to true"). `maxRetries` is "typically set to 0". — [Helius Sender docs](https://www.helius.dev/docs/sending-transactions/sender)
- The docs' example uses `ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 })` plus `setComputeUnitLimit`. The quickstart shows no polling or retry loop. — [sender.md](https://www.helius.dev/docs/sending-transactions/sender.md)
- Helius publishes no minimum priority fee, only minimum tips. — [sender.md](https://www.helius.dev/docs/sending-transactions/sender.md)

**Request format (JSON-RPC POST to `/fast`)**
- `{"id":"unique-request-id","jsonrpc":"2.0","method":"sendTransaction","params":["BASE64_ENCODED_TRANSACTION",{"encoding":"base64","skipPreflight":true,"maxRetries":0}]}` — [Helius Sender docs](https://www.helius.dev/docs/sending-transactions/sender)
- `{"id":"unique-request-id","jsonrpc":"2.0","method":"sendBundle","params":[["BASE64_SIGNED_TX_1","BASE64_SIGNED_TX_2"],{"encoding":"base64"}]}`. A bundle holds "up to 4 fully-signed transactions", and "at least one transaction must carry the tip". — [Helius Sender docs](https://www.helius.dev/docs/sending-transactions/sender)

**Limits and cost**
- Default "50 transactions per second". "Sender transactions don't consume API credits". Professional-plan users can request higher limits. Approved users append `?api-key=YOUR_SENDER_API_KEY`. — [sender.md](https://www.helius.dev/docs/sending-transactions/sender.md); [Helius Sender docs](https://www.helius.dev/docs/sending-transactions/sender)

**MEV Protect (FLAG: new)**
- `mev-protect=true` routes transactions "away from validators statistically linked to sandwich attacks".
- It works on:
  - `https://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY&mev-protect=true`
  - `https://sender.helius-rpc.com/fast?mev-protect=true`
  - `https://sender.helius-rpc.com/fast?swqos_only=true&mev-protect=true`
- "Only a limited amount of stake (roughly 3–4 million SOL) is excluded at any time". Helius calls the landing and latency impact "negligible" for most flows, but says latency-sensitive strategies should measure it.
- — [mev-protect.md](https://www.helius.dev/docs/sending-transactions/mev-protect.md)

**Backrun rebates (FLAG: new)**
- Add `rebate-address=<YOUR_SOL_ADDRESS>` to mainnet `sendTransaction` calls. "You earn 50% of the MEV your trade creates".
- Only single-transaction mainnet requests qualify. "No additional latency is incurred". Only backruns are allowed (no frontrunning), and the payout arrives in the same block.
- — [backrun-rebates.md](https://www.helius.dev/docs/sending-transactions/backrun-rebates.md)

**Basic RPC sending vs Sender (Helius "staked connections")**
- Basic `sendTransaction` costs 1 credit. It is described as routing "directly to current and upcoming block leaders through a priority lane" and is the choice "when reliability matters more than raw speed". Sender Max is the option for "Competitive trading (fastest landing)". — [overview.md](https://www.helius.dev/docs/sending-transactions/overview.md)
- The send-manually guide pairs `recommended: true` fee estimates with "the highest chance of inclusion via Helius's staked connections" but does not say which plans include staked connections. — [send-manually.md](https://www.helius.dev/docs/sending-transactions/send-manually.md)

### Inferences
- **Cost.** At the 2026-10-03 15:35 UTC Jito tip-floor snapshot (section 2), the 99th-percentile landed Jito tip was about 264k lamports and the median about 6.1k. Sender Max's 1,000,000-lamport floor is therefore about 3.8x the Jito p99 and about 160x the median, which makes Sender Max a premium lane for contested trades. The SWQoS-only floor (5,000 lamports) is close to the Jito median.
- **Low tips on the default URL.** Combining the two doc pages, a tip between 0.000005 and 0.001 SOL sent to the default Sender URL most likely behaves like SWQoS-only: one path, no buffer.
- **Don't double-send to Jito.** Sender Max already adds Jito tips and pathways. Sending the same signed transaction directly to Jito as well adds an independent failure domain but no new pathway, and Jito only credits tips paid to Jito's own tip accounts.
- **Server setup.** Use the regional HTTP endpoints, which avoid TLS cost. Keep a warm keep-alive socket by pinging `/ping` at least every 5 seconds while idle.

### Gaps
- Helius publishes no latency or landing-rate numbers for Sender.
- The ordering rules of the priority tip buffer are not documented.
- It is unclear whether BAM is a distinct Sender pathway; the docs say "etc.".
- It is unclear whether `rebate-address` applies to Sender endpoints or only to Helius RPC.
- Pricing for limits above 50 TPS is not published.
- No plan-level statement says which Helius plans' standard `sendTransaction` calls use staked connections.

---

## 2. Jito: block engine, sendTransaction vs sendBundle, tips, tip floor, BAM, jitodontfront

### Takeaway
Jito's block engine exposes two send methods:
- **`sendTransaction`:** a proxy that forwards directly to the validator. Adding `?bundleOnly=true` turns it into a revert-protected single-transaction bundle.
- **`sendBundle`:** up to 5 transactions, executed sequentially and atomically.

The minimum tip is 1,000 lamports, paid to one of 8 tip accounts. The default rate limit is 1 request per second per IP per region.

`jitodontfront` is a read-only marker account that forbids anything being ordered ahead of your transaction inside a Jito bundle. It protects only when the transaction actually goes through Jito.

BAM (TEE-based block building) covered about 34% of stake when it added preconfirmations on 2026-09-09. Jito's public send docs still say nothing about how BAM changes submission or ordering.

### Cited Findings
**Endpoints and paths**
- Regional mainnet block engines:
  - `https://amsterdam.mainnet.block-engine.jito.wtf`
  - `https://dublin.mainnet.block-engine.jito.wtf`
  - `https://frankfurt.mainnet.block-engine.jito.wtf`
  - `https://london.mainnet.block-engine.jito.wtf`
  - `https://ny.mainnet.block-engine.jito.wtf`
  - `https://slc.mainnet.block-engine.jito.wtf`
  - `https://singapore.mainnet.block-engine.jito.wtf`
  - `https://tokyo.mainnet.block-engine.jito.wtf`
  - — [Jito docs](https://docs.jito.wtf/lowlatencytxnsend/)
- Global host, as used in the docs' example: `https://mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true`. — [Jito docs](https://docs.jito.wtf/lowlatencytxnsend/)
- Paths:
  - `/api/v1/transactions` for `sendTransaction`.
  - `/api/v1/bundles` for `sendBundle`, `getBundleStatuses`, `getInflightBundleStatuses` (bundles from the last 5 minutes) and `getTipAccounts`.
  - — [Jito docs](https://docs.jito.wtf/lowlatencytxnsend/)

**sendTransaction vs sendBundle**
- `sendTransaction` "acts as a direct proxy to the Solana sendTransaction RPC method, but forwards your transaction directly to the validator". Jito recommends "a 70/30 split between priority fee and jito tip". For `sendBundle`, "Only the Jito tip matters". — [Jito docs](https://docs.jito.wtf/lowlatencytxnsend/)
- `bundleOnly=true` gives revert protection by sending the transaction only as a single-transaction bundle. The bundle id comes back in the `x-bundle-id` response header. — [Jito docs](https://docs.jito.wtf/lowlatencytxnsend/)
- A bundle holds at most 5 transactions. "Transactions in a bundle are guaranteed to execute in the order they are listed", and "if any transaction in a bundle fails, none of the transactions in the bundle will be committed to the chain." — [Jito docs](https://docs.jito.wtf/lowlatencytxnsend/)
- Encoding: `base64` is recommended; `base58` is deprecated. — [Jito docs](https://docs.jito.wtf/lowlatencytxnsend/)

**Tips**
- Minimum tip is 1,000 lamports (stated for bundles). The docs warn that during high-demand periods this floor "may prove insufficient". — [Jito docs](https://docs.jito.wtf/lowlatencytxnsend/)
- Tip accounts (8): `96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5`, `HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe`, `Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY`, `ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49`, `DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh`, `ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt`, `DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL`, `3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT`. — [Jito docs](https://docs.jito.wtf/lowlatencytxnsend/)
- Runtime lookup: `{"jsonrpc":"2.0","id":1,"method":"getTipAccounts","params":[]}`. — [Jito docs](https://docs.jito.wtf/lowlatencytxnsend/)
- Tip placement: "Integrate tip instructions within your main transaction alongside core logic". "Sending tips as standalone transactions in bundles may increase exposure to uncle bandit situations." — [Jito docs](https://docs.jito.wtf/lowlatencytxnsend/)
- Tip floor (REST): `https://bundles.jito.wtf/api/v1/bundles/tip_floor`. Tip stream (WebSocket): `wss://bundles.jito.wtf/api/v1/bundles/tip_stream`. — [Jito docs](https://docs.jito.wtf/lowlatencytxnsend/)
- Live tip_floor response at fetch time: `[{"time":"2026-10-03T15:34:59+00:00","landed_tips_25th_percentile":1.0000000000000002e-6,"landed_tips_50th_percentile":6.145500000000001e-6,"landed_tips_75th_percentile":0.000067913,"landed_tips_95th_percentile":0.0001287499999999998,"landed_tips_99th_percentile":0.0002643690299999999,"ema_landed_tips_50th_percentile":5.021080713564013e-6}]` — [Jito tip_floor API](https://bundles.jito.wtf/api/v1/bundles/tip_floor)

**Limits and auth**
- "1 request per second per IP per region". Exceeding it returns HTTP 429. Higher limits are requested through a Discord ticket. Authenticate with the `x-jito-auth: <uuid>` header or `?uuid=<uuid>`. — [Jito docs](https://docs.jito.wtf/lowlatencytxnsend/)

**Bundle status**
- `getBundleStatuses` takes `params: [[bundle_id,...]]`. It returns `bundle_id`, `transactions`, `slot`, `confirmationStatus` (processed/confirmed/finalized) and `err`, or `null` if the bundle is not found. — [Jito docs](https://docs.jito.wtf/lowlatencytxnsend/)

**jitodontfront (anti-sandwich marker)**
- Add "any valid Solana public key starting with `jitodontfront`" (example: `jitodontfront111111111111111111111111111111`) to an instruction's account list. "Mark the account as read-only to optimize landing speed." It applies to "Both `sendBundle` and `sendTransaction` endpoints". — [Jito docs](https://docs.jito.wtf/lowlatencytxnsend/)
- Allowed bundle layouts:
  - `[tx_with_dont_front, tip]`
  - `[tx_with_dont_front, arbitrage, tip]`
  - several `jitodontfront` transactions at the front of the bundle, if they share at least one signer
- Disallowed bundle layouts:
  - `[tip, tx_with_dont_front]`
  - `[txA_with_signer1, txB_with_signer2]`
  - `[trade, tx_with_dont_front, arbitrage, tip]`
- — [Jito docs](https://docs.jito.wtf/lowlatencytxnsend/)

**BAM (Block Assembly Marketplace) in 2026 (FLAG: fast-moving)**
- The BAM node "Ingests Bundles/Transactions, Solana cluster state and current leader state. Validates, sequences and finally sends the Bundles/Transactions to the leader BAM Validator". When a connected validator is leader soon, "transactions submitted via RPC are routed through BAM". — [BAM overview](https://bam.dev/docs/bam/bam-overview/)
- BAM describes itself as "Private". It "removes transaction supply-chain snooping and mitigates negative MEV" and schedules transactions inside Trusted Execution Environments (TEEs). Plugins are "Programmable interfaces to the BAM Nodes' scheduler". — [bam.dev](https://bam.dev/)
- Adoption:
  - Q1 2026: 27.7% of stake per Solana Compass; a Crypto Briefing search snippet says 28.1%. — [Solana Compass, Aug 10 2026](https://solanacompass.com/news/jito-q2-2026-protocol-revenue-falls-45-to-128m-as-bam-reaches-33-of-solana-stake); (snippet only) [Crypto Briefing](https://cryptobriefing.com/jito-bam-adoption-doubles-q1-2026/)
  - Q2 2026: "378 validators" and "33% of Solana's total stake weight". FireBAM, "a Frankendancer-compatible version of the BAM client", shipped in Q2. — [Solana Compass, Aug 10 2026](https://solanacompass.com/news/jito-q2-2026-protocol-revenue-falls-45-to-128m-as-bam-reaches-33-of-solana-stake)
  - Preconfirmations launched "September 9", when BAM covered "34.1% of all staked SOL across 383 of 665 active validators". — [Solana Compass, Sep 11 2026](https://solanacompass.com/news/jito-bam-preconfirmations-go-live-on-solana-covering-34-of-network-stake)
- Preconfirmations:
  - A preconfirmation is "the stream of transactions the current BAM-enabled leader has committed to executing". It is distributed through Helius and Triton.
  - It has "a p50 advantage of 5–10ms over their existing shred streams".
  - It "says what will execute if the block lands, not that the block will land". A BAM Verifier can disconnect validators that deviate from their commitments.
  - — [BAM preconfirmations](https://bam.dev/docs/bam/preconfirmations/)
- Market context:
  - Q2 2026 Jito MEV tip revenue (TOV) was "$9.9M", down "50%", while transaction count held at about 1.045B.
  - JTX, Jito's self-custody trading platform, opened early access on July 14, 2026.
  - — [Solana Compass, Aug 10 2026](https://solanacompass.com/news/jito-q2-2026-protocol-revenue-falls-45-to-128m-as-bam-reaches-33-of-solana-stake)
- Jito's low-latency send documentation contains no mention of BAM. — [Jito docs](https://docs.jito.wtf/lowlatencytxnsend/)

### Inferences
- **Tip-floor units.** The tip_floor values are in SOL: the 25th percentile (1.0e-6 SOL) equals the documented 1,000-lamport minimum. In lamports, the snapshot is p50 ≈ 6,146, p75 ≈ 67,913, p95 ≈ 128,750, p99 ≈ 264,369, and EMA-p50 ≈ 5,021. Tip presets should follow live `tip_stream` percentiles rather than fixed constants.
- **Rate limit.** The default 1 rps per IP per region is the binding limit for a single-user backend. Because limits are per region, bursts can be spread over two nearby regions (Frankfurt and Amsterdam), or flow can go through Helius Sender, which adds Jito tips itself.
- **A real Jito-only path.** A protected Jito-only path needs `bundleOnly=true` (or `sendBundle`), a read-only `jitodontfront...` account, and the tip inside the same transaction. Plain `sendTransaction` can also reach the leader outside the bundle auction, where `jitodontfront` gives no protection (see the Axiom data in section 8).
- **BAM share.** Roughly a third of leader slots are now sequenced by BAM. In those slots, ordering happens inside TEEs, which should reduce validator-side snooping. There is no public quantification yet.

### Gaps
- No public documentation describes BAM's ordering rules for ordinary transactions and bundles (fee or tip priority, batching), or any new submission endpoints.
- It is unknown whether BAM nodes enforce `jitodontfront` on non-bundle transactions.
- Jito's docs give no figures on how BAM affects landing latency.

---

## 3. Other landing services (Nozomi, bloXroute, NextBlock, 0slot, Astralane, BlockRazor, Falcon, Triton, QuickNode, newer 2026 entrants) and benchmarks

### Takeaway
The relays have converged on the same pattern:
- a tip, usually 0.001 SOL or more (Jito, Helius SWQoS-only and Astralane are far cheaper), sent to a rotating set of the relay's own tip accounts;
- JSON-RPC or raw-body HTTP endpoints in Frankfurt, Amsterdam, New York, Tokyo and similar cities;
- plain HTTP with keep-alive for the lowest latency;
- an optional anti-MEV mode.

No independent, reproducible 2026 benchmark was found. Published numbers are either run by the vendor (BlockRazor, RPC Fast) or marketing (AllenHark).

### Cited Findings
**Quick-reference table** (details and sources follow in the per-service bullets)

| Service | Server endpoint example | Auth | Body | Min tip | Tip accts | Default limit | Anti-MEV option |
|---|---|---|---|---|---|---|---|
| Helius Sender | `http://fra-sender.helius-rpc.com/fast` | none (optional `?api-key=`) | JSON-RPC, base64 | 0.001 SOL (Max) / 0.000005 SOL (SWQoS-only) | 10 | 50 TPS | `?mev-protect=true` |
| Jito BE | `https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/transactions` | optional `x-jito-auth` / `?uuid=` | JSON-RPC, base64 | 1,000 lamports | 8 | 1 rps/IP/region | `jitodontfront` + `bundleOnly` |
| Nozomi | `http://fra2.nozomi.temporal.xyz/api/sendTransaction2?c=KEY` | `?c=` | text/plain base64 (JSON-RPC at `/`) | 0.001 SOL | 17 | 5 rps/key/region | MEV Protect key (on request) |
| bloXroute | `http://germany.solana.dex.blxrbdn.com/api/v2/submit` | `Authorization` header | `{transaction:{content}}` | 0.001 SOL | 17 (+1 conflicting) | not stated | `frontRunningProtection`, `submitProtection` |
| NextBlock | `https://frankfurt.nextblock.io/api/v2/submit` | `Authorization` header | `{transaction:{content}}` | not stated | 8 | not stated | `frontRunningProtection` |
| 0slot | `https://de.0slot.trade?api-key=KEY` | `?api-key=` | JSON-RPC, base64 | 0.001 SOL (Advanced 0.0001) | 21 | 5 TPS (Advanced 20) | Anti-MEV (cookbook) |
| Astralane | `http://fr.gateway.astralane.io/iris?api-key=KEY` | `?api-key=` or header | JSON-RPC, base64, `skipPreflight:true` | 10,000 lamports | 17 | per plan | `mev-protect=true` |
| BlockRazor | `http://frankfurt.solana.blockrazor.xyz:443/sendTransaction` | `apikey` header | `{transaction, mode, safeWindow, revertProtection}` | not stated (example 100,000 lamports) | 14 | 3 TPS | `mode: sandwichMitigation` |
| Falcon | not extracted | UUID/API key | JSON-RPC, `/binary`, `/plaintext`, QUIC, UDP | 1,000,000 lamports | not extracted | dashboard allowances | not stated |
| Triton | `<Triton RPC>/sendtx` | Triton RPC credentials | raw octet-stream or text/plain | none (RPC plan) | n/a | plan-based | Shield policy header |
| RPC Fast Beam | not extracted | RPC Fast key | `sendTransaction` | tip set by the chosen provider | n/a | 60–500 tx/min | `mev_protect` mode |

**Nozomi (Temporal)**
- Base URLs: `https://nozomi.temporal.xyz` (auto-routed through Cloudflare) and `https://edge.nozomi.temporal.xyz` (geo-DNS). — [Nozomi endpoints](https://use.temporal.xyz/nozomi/endpoints)
- Regional hosts:
  - Direct (http or https): `pit1.nozomi.temporal.xyz`, `ewr1.`, `ash1.`, `lax1.`, `fra2.`, `ams1.`, `lon1.`, `tyo1.`, `sgp1.nozomi.temporal.xyz`
  - Cloudflare (https): `pit.`, `ewr.`, `ash.`, `lax.`, `fra.`, `ams.`, `lon.`, `tyo.`, `sgp.nozomi.temporal.xyz`
  - Regions: Pittsburgh, Newark, Ashburn, Los Angeles, Frankfurt, Amsterdam, London, Tokyo, Singapore.
  - — [Nozomi endpoints](https://use.temporal.xyz/nozomi/endpoints)
- API paths. Every request needs `?c=<YOUR_API_KEY>`; a 401 means an invalid or missing key.
  - `/` — JSON-RPC that returns the signature. Body: `{"jsonrpc":"2.0","id":1,"method":"sendTransaction","params":["<BASE64_TXN>",{"encoding":"base64"}]}`. Docs: "Specify "encoding": "base64" explicitly".
  - `/api/sendTransaction2` — `text/plain` base64 body; returns an empty 200.
  - `/api/sendBatch` — `application/octet-stream` with length-prefixed transactions (`[u16_len_hi][u16_len_lo][tx_bytes...]`). At most 16 transactions and a 65,568-byte body. Returns an empty 200.
  - `/api/sendBundle` — same binary format with 1–4 transactions. They land "atomically in order, or none land". At least one member must tip 0.001 SOL or more.
  - — [Nozomi llms-full.txt](https://use.temporal.xyz/llms-full.txt); [Nozomi endpoints](https://use.temporal.xyz/nozomi/endpoints)
- Lowest-latency guidance: "Use Batch Send over direct `http://` endpoint on a warm, reused connection". Send to multiple regions at the same time, since rate limits apply per region. — [Nozomi endpoints](https://use.temporal.xyz/nozomi/endpoints)
- Tips and retries:
  - Minimum tip is 0.001 SOL. "Transactions that tip below the minimum are silently dropped: you will not receive an error."
  - Begin with "100% of your bid in the Nozomi tip". The priority fee is evaluated per CU, so avoid over-requesting compute units.
  - Nozomi handles retries automatically: "do not resubmit client-side".
  - Durable nonces "May reduce landing rates on some paths; benchmark both approaches".
  - "MEV Protect" is available on request and is "slower but offers sandwich protection".
  - — [Nozomi tipping/FAQ](https://use.temporal.xyz/nozomi/tipping-and-faq)
- Tip addresses (17): `TEMPaMeCRFAS9EKF53Jd6KpHxgL47uWLcpFArU1Fanq`, `noz3jAjPiHuBPqiSPkkugaJDkJscPuRhYnSpbi8UvC4`, `noz3str9KXfpKknefHji8L1mPgimezaiUyCHYMDv1GE`, `noz6uoYCDijhu1V7cutCpwxNiSovEwLdRHPwmgCGDNo`, `noz9EPNcT7WH6Sou3sr3GGjHQYVkN3DNirpbvDkv9YJ`, `nozc5yT15LazbLTFVZzoNZCwjh3yUtW86LoUyqsBu4L`, `nozFrhfnNGoyqwVuwPAW4aaGqempx4PU6g6D9CJMv7Z`, `nozievPk7HyK1Rqy1MPJwVQ7qQg2QoJGyP71oeDwbsu`, `noznbgwYnBLDHu8wcQVCEw6kDrXkPdKkydGJGNXGvL7`, `nozNVWs5N8mgzuD3qigrCG2UoKxZttxzZ85pvAQVrbP`, `nozpEGbwx4BcGp6pvEdAh1JoC2CQGZdU6HbNP1v2p6P`, `nozrhjhkCr3zXT3BiT4WCodYCUFeQvcdUkM7MqhKqge`, `nozrwQtWhEdrA6W8dkbt9gnUaMs52PdAv5byipnadq3`, `nozUacTVWub3cL4mJmGCYjKZTnE9RbdY5AP46iQgbPJ`, `nozWCyTPppJjRuw2fpzDhhWbW355fzosWSzrrMYB1Qk`, `nozWNju6dY353eMkMqURqwQEoM3SFgEKC6psLCSfUne`, `nozxNBgWohjR75vdspfxR5H9ceC7XXH99xpxhVGt3Bb`. — [Nozomi tipping/FAQ](https://use.temporal.xyz/nozomi/tipping-and-faq)
- Keep-alive, limits and extras:
  - TCP idle timeout is 65 seconds; `GET /ping` "every 60 seconds".
  - Rate limit: "5 requests/second per key per region".
  - Tip stream: REST `https://api.nozomi.temporal.xyz/tip_floor`, WebSocket `wss://api.nozomi.temporal.xyz/tip_stream`.
  - The QUIC client (`github.com/temporalxyz/nozomi-quic-client`) is "not faster than warm HTTP".
  - Accepts v1 transactions up to 4,096 bytes; bundle members are limited to 1,232 bytes.
  - — [Nozomi llms-full.txt](https://use.temporal.xyz/llms-full.txt)

**bloXroute Trader API**
- Submission is `POST /api/v2/submit`, for example `http://ny.solana.dex.blxrbdn.com/api/v2/submit` or `http://uk.solana.dex.blxrbdn.com/api/v2/submit`. "Use HTTP rather than HTTPS for optimal performance". Authenticate with an `Authorization` header. — [bloXroute submit](https://docs.bloxroute.com/solana/trader-api/api-endpoints/transaction-submisson/submit)
- Submission hosts: `uk.solana.dex.blxrbdn.com`, `ny.solana.dex.blxrbdn.com`, `germany.solana.dex.blxrbdn.com` (Frankfurt), `amsterdam.solana.dex.blxrbdn.com`, `tokyo.solana.dex.blxrbdn.com`, `global.solana.dex.blxrbdn.com`. Guidance: "Submit to all regions simultaneously for the best performance", or at least send to your closest region and the global endpoint in parallel. — [bloXroute regions](https://docs.bloxroute.com/solana/trader-api/introduction/regions)
- Body fields:
  - `transaction.content` — base64 transaction.
  - `skipPreFlight`.
  - `frontRunningProtection` — "Evaluates validator risk in real-time, delaying or skipping high-risk leaders while accelerating through staked connections".
  - `revertProtection`.
  - `submitProtection` — `SP_LOW` (none), `SP_MEDIUM` (3-slot buffer), or `SP_HIGH` (8-slot buffer, the default).
  - `useStakedRPCs` — requires a tip of 0.001 SOL or more and `frontRunningProtection=false`.
  - `allowBackRun` plus `revenueAddress` — MEV rebate.
  - — [bloXroute submit](https://docs.bloxroute.com/solana/trader-api/api-endpoints/transaction-submisson/submit)
- Fastest configuration: `frontRunningProtection: False`, `useStakedRPCs: True`, `submitProtection: SP_LOW`. Other guidance:
  - Keep connections alive "every 30-seconds".
  - QUIC is recommended for "absolute minimum submission latency".
  - "Avoid address lookup tables in tip instructions".
  - — [bloXroute best performance](https://docs.bloxroute.com/solana/trader-api/best-performance-for-landing-transactions)
- Minimum tip is 0.001 SOL (1,000,000 lamports). Tip addresses (17): `3UQUKjhMKaY2S6bjcQD6yHB7utcZt5bfarRCmctpRtUd`, `FogxVNs6Mm2w9rnGL1vkARSwJxvLE8mujTv3LK8RnUhF`, `bLx7MvxGaKdKL7mEbpk9tC79z6MnBSJoJkuaEAPu6Nd`, `bLx7XBqSg3LUPVf1bRgCnkJmgVZR8QEgDJBPqcRLHvp`, `bLx8KeZxinPwy6kkUgyzMLeqb2ARNsWjADG1dhSsVba`, `bLxADBknoNj8WAGw2W6GBYeq848Xx6ajhaymV1YvrHm`, `bLxAc88vRBwvcUQJEgcxNfBLvHPikY4csNsUmPeWea2`, `bLxQ88oCiTsL8Xj4YWekKi1hjrgmbE3J3FFZ2xZHR3h`, `bLxS7NoLuynNRJ4mCnEE2YbtwJFttYsEyp2ME7rp2yt`, `bLxW6mCov7VEbrKc3S9tcBRcfSzRnLCbNp3Dfn3SJG5`, `bLxXSGXs4mYPTC5okZXed1qzvjNwNJ48QJ82hT2V7w7`, `bLxYi3vojbbB7hVzVDVTdBLVPhp7GJ3ZB3BwdK5sFXi`, `bLxhLPgBXtUpX4b1bH3HatuMGMSKT9GnwtuCGiMSAqe`, `bLxpY1mniuFW4PgkNA4JiNxoeKHFszryi6tNgyZAiAA`, `bLxuETxd2tgWxBALNwPzAfHhsik4BzD3nrEBCiPNZQD`, `bLxuL2gK5FW7xfahvwLrxLyW76vcCpNsKQY2CmnE6kV`, `bLxv4Hnub7nDJWHs8s17o9bGU65Bnx6Yqp2fqtMgHmm`. — [bloXroute tips](https://docs.bloxroute.com/solana/trader-api/introduction/tip-and-tipping-addresses)
  - CONFLICT: the best-performance page names `HWEoBxYs7ssKuudEjzjmpfJVX7Dvi7wescFsVx2L5yoY` (bloxroute.sol) as the tip wallet, with the note "verify current address in docs". That address is missing from the 17-address list. — [bloXroute best performance](https://docs.bloxroute.com/solana/trader-api/best-performance-for-landing-transactions)

**NextBlock**
- Hosts: `frankfurt.nextblock.io`, `amsterdam.`, `london.`, `singapore.`, `tokyo.`, `ny.`, `slc.`, `dublin.`, `vilnius.nextblock.io`. — [NextBlock quickstart](https://docs.nextblock.io/getting-started/quickstart)
- Endpoints (auth header `Authorization: your-api-key-here`):
  - `POST /api/v2/submit` with `{"transaction":{"content":"<base64>"},"frontRunningProtection":bool}`. Returns `signature` and `uuid`.
  - `POST /api/v2/submit-batch` with an `entries` array.
  - `GET /api/v2/tipfloor` returns the 25th/50th/75th/95th/99th percentiles plus an EMA.
  - — [NextBlock HTTP](https://docs.nextblock.io/api/examples/http)
- Anti-MEV behavior:
  - With it on: "If anti-MEV is enabled, priority fee does not matter, only the NextBlock Tip matters."
  - With it off: "your transaction is sent via all channels: our internal validator network, Jito Bundles, and as a normal transaction to upcoming leaders."
  - No explicit minimum tip is stated: "Higher tips = higher priority."
  - — [NextBlock quickstart](https://docs.nextblock.io/getting-started/quickstart)
- Tip wallets (8): `NextbLoCkVtMGcV47JzewQdvBpLqT9TxQFozQkN98pE`, `NexTbLoCkWykbLuB1NkjXgFWkX9oAtcoagQegygXXA2`, `NeXTBLoCKs9F1y5PJS9CKrFNNLU1keHW71rfh7KgA1X`, `NexTBLockJYZ7QD7p2byrUa6df8ndV2WSd8GkbWqfbb`, `neXtBLock1LeC67jYd1QdAa32kbVeubsfPNTJC1V5At`, `nEXTBLockYgngeRmRrjDV31mGSekVPqZoMGhQEZtPVG`, `NEXTbLoCkB51HpLBLojQfpyVAMorm3zzKg7w9NFdqid`, `nextBLoCkPMgmG8ZgJtABeScP35qLa2AMCNKntAP7Xc`. — [NextBlock quickstart](https://docs.nextblock.io/getting-started/quickstart)

**0slot**
- Endpoints: `https://ny.0slot.trade`, `https://de.0slot.trade`, `https://ams.0slot.trade`, `https://jp.0slot.trade`, `https://la.0slot.trade`, each with an `api-key` parameter. — [0slot docs](https://0slot.trade/docs.php)
- Request: JSON-RPC `sendTransaction` with base64 data and `{"encoding":"base64"}`. — [0slot docs](https://0slot.trade/docs.php)
- Minimum tip is 0.001 SOL; the Advanced plan's minimum is 0.0001 SOL. — [0slot docs](https://0slot.trade/docs.php)
- Rate limit is 5 TPS on Trial, Entry and Intermediate plans and 20 TPS on Advanced. — [0slot docs](https://0slot.trade/docs.php)
- The docs reference cookbook articles on Binary-Tx and Anti-MEV. — [0slot docs](https://0slot.trade/docs.php)
- Tip accounts (21): `6fQaVhYZA4w3MBSXjJ81Vf6W1EDYeUPXpgVQ6UQyU1Av`, `4HiwLEP2Bzqj3hM2ENxJuzhcPCdsafwiet3oGkMkuQY4`, `7toBU3inhmrARGngC7z6SjyP85HgGMmCTEwGNRAcYnEK`, `8mR3wB1nh4D6J9RUCugxUpc6ya8w38LPxZ3ZjcBhgzws`, `6SiVU5WEwqfFapRuYCndomztEwDjvS5xgtEof3PLEGm9`, `TpdxgNJBWZRL8UXF5mrEsyWxDWx9HQexA9P1eTWQ42p`, `D8f3WkQu6dCF33cZxuAsrKHrGsqGP2yvAHf8mX6RXnwf`, `GQPFicsy3P3NXxB5piJohoxACqTvWE9fKpLgdsMduoHE`, `Ey2JEr8hDkgN8qKJGrLf2yFjRhW7rab99HVxwi5rcvJE`, `4iUgjMT8q2hNZnLuhpqZ1QtiV8deFPy2ajvvjEpKKgsS`, `3Rz8uD83QsU8wKvZbgWAPvCNDU6Fy8TSZTMcPm3RB6zt`, `DiTmWENJsHQdawVUUKnUXkconcpW4Jv52TnMWhkncF6t`, `HRyRhQ86t3H4aAtgvHVpUJmw64BDrb61gRiKcdKUXs5c`, `7y4whZmw388w1ggjToDLSBLv47drw5SUXcLk6jtmwixd`, `J9BMEWFbCBEjtQ1fG5Lo9kouX1HfrKQxeUxetwXrifBw`, `8U1JPQh3mVQ4F5jwRdFTBzvNRQaYFQppHQYoH38DJGSQ`, `Eb2KpSC8uMt9GmzyAEm5Eb1AAAgTjRaXWFjKyFXHZxF3`, `FCjUJZ1qozm1e8romw216qyfQMaaWKxWsuySnumVCCNe`, `ENxTEjSQ1YabmUpXAdCgevnHQ9MHdLv8tzFiuiYJqa13`, `6rYLG55Q9RpsPGvqdPNJs4z5WTxJVatMB8zV3WJhs5EK`, `Cix2bHfqPcKcM233mzxbLk14kSggUUiz2A87fJtGivXr`. — [0slot docs](https://0slot.trade/docs.php)

**Astralane (Iris)**
- Endpoints (append `?api-key=xxxx`):
  - Global edge: `https://edge.astralane.io/iris`
  - Regional: `http://fr.gateway.astralane.io/iris`, `http://fr2.gateway.astralane.io/iris`, `http://la.gateway.astralane.io/iris`, `http://jp.gateway.astralane.io/iris`, `http://ny.gateway.astralane.io/iris`, `http://ams.gateway.astralane.io/iris`, `http://ams2.gateway.astralane.io/iris`, `http://lim.gateway.astralane.io/iris`, `http://sg.gateway.astralane.io/iris`, `http://lit.gateway.astralane.io/iris`, `http://lon.gateway.astralane.io/iris`
  - "You can also use HTTPS on above endpoints".
  - "Its recommended to broadcast your txns to both global edge endpoint as well as to the closest endpoint".
  - — [Astralane endpoints](https://astralane.gitbook.io/docs/low-latency/endpoints-and-configs)
- Methods:
  - `sendTransaction` routes through "SWQoS clients (Jito, Paladin) and block builders (Harmonic, BAM)". Optional flags: `mev-protect` and `swqos-only`.
  - `sendBundle` takes up to 4 transactions, with optional `revertProtection`.
  - `sendIdeal` is a dual-transaction durable-nonce strategy, supported by a managed nonce service (`getNonce`).
  - `sendBatch` allows up to 25 transactions and is available on request.
  - Requests use `"encoding": "base64"` and `"skipPreflight": true`.
  - The submit page states a "Minimum Tip: 10,000 lamports (spam prevention)" and names tip account `astra4uejePWneqNaJKuFFA8oonqCE1sqF6b45kDMZm`.
  - — [Astralane submit](https://astralane.gitbook.io/docs/low-latency/submit-transactions)
- Tip addresses listed on the endpoints page (17): `astrazznxsGUhWShqgNtAdfrzP2G83DzcWVJDxwV9bF`, `astra4uejePWneqNaJKuFFA8oonqCE1sqF6b45kDMZm`, `astra9xWY93QyfG6yM8zwsKsRodscjQ2uU2HKNL5prk`, `astraRVUuTHjpwEVvNBeQEgwYx9w9CFyfxjYoobCZhL`, `astraEJ2fEj8Xmy6KLG7B3VfbKfsHXhHrNdCQx7iGJK`, `astraubkDw81n4LuutzSQ8uzHCv4BhPVhfvTcYv8SKC`, `astraZW5GLFefxNPAatceHhYjfA1ciq9gvfEg2S47xk`, `astrawVNP4xDBKT7rAdxrLYiTSTdqtUr63fSMduivXK`, `AstrA1ejL4UeXC2SBP4cpeEmtcFPZVLxx3XGKXyCW6to`, `AsTra79FET4aCKWspPqeSFvjJNyp96SvAnrmyAxqg5b7`, `AstrABAu8CBTyuPXpV4eSCJ5fePEPnxN8NqBaPKQ9fHR`, `AsTRADtvb6tTmrsqULQ9Wji9PigDMjhfEMza6zkynEvV`, `AsTRAEoyMofR3vUPpf9k68Gsfb6ymTZttEtsAbv8Bk4d`, `AStrAJv2RN2hKCHxwUMtqmSxgdcNZbihCwc1mCSnG83W`, `Astran35aiQUF57XZsmkWMtNCtXGLzs8upfiqXxth2bz`, `AStRAnpi6kFrKypragExgeRoJ1QnKH7pbSjLAKQVWUum`, `ASTRaoF93eYt73TYvwtsv6fMWHWbGmMUZfVZPo3CRU9C`. — [Astralane endpoints](https://astralane.gitbook.io/docs/low-latency/endpoints-and-configs)

**BlockRazor**
- Frankfurt example:
  - HTTP: `http://frankfurt.solana.blockrazor.xyz:443/sendTransaction`
  - Health: `http://frankfurt.solana.blockrazor.xyz:443/health`
  - gRPC: `frankfurt.solana-grpc.blockrazor.xyz:80`
  - Auth header: `apikey`
  - Example body: `{"transaction":"<base64>","mode":"fast","safeWindow":5,"RevertProtection":false}`. The example tip is 100,000 lamports.
  - — [BlockRazor JS example](https://docs.blockrazor.io/transaction-submission/transaction-sending/solana/send-transaction/request-example/js)
- Modes and parameters:
  - `fast` (default): transactions use a "globally distributed high-performance network and high-quality SWQoS".
  - `sandwichMitigation`: routes to trusted nodes and skips blacklisted leader slots. `safeWindow` is 3–13 (default 3); the JS example's comment says 3–5 blocks. The docs warn: "DO NOT send transactions using durable nonce, as it will cause the sandwich protection to become ineffective".
  - `revertProtection`: "the speed of inclusion will be affected".
  - Default rate limit is 3 TPS and is not tied to a subscription plan.
  - — [BlockRazor send-transaction](https://docs.blockrazor.io/transaction-submission/transaction-sending/solana/send-transaction.md)
- Tip accounts (14): `Gywj98ophM7GmkDdaWs4isqZnDdFCW7B46TXmKfvyqSm`, `FjmZZrFvhnqqb9ThCuMVnENaM3JGVuGWNyCAxRJcFpg9`, `6No2i3aawzHsjtThw81iq1EXPJN6rh8eSJCLaYZfKDTG`, `A9cWowVAiHe9pJfKAj3TJiN9VpbzMUq6E4kEvf5mUT22`, `68Pwb4jS7eZATjDfhmTXgRJjCiZmw1L7Huy4HNpnxJ3o`, `4ABhJh5rZPjv63RBJBuyWzBK3g9gWMUQdTZP2kiW31V9`, `B2M4NG5eyZp5SBQrSdtemzk5TqVuaWGQnowGaCBt8GyM`, `5jA59cXMKQqZAVdtopv8q3yyw9SYfiE3vUCbt7p8MfVf`, `5YktoWygr1Bp9wiS1xtMtUki1PeYuuzuCF98tqwYxf61`, `295Avbam4qGShBYK7E9H5Ldew4B3WyJGmgmXfiWdeeyV`, `EDi4rSy2LZgKJX74mbLTFk4mxoTgT6F7HxxzG2HBAFyK`, `BnGKHAC386n4Qmv9xtpBVbRaUTKixjBe3oagkPFKtoy6`, `Dd7K2Fp7AtoN8xCghKDRmyqr5U169t48Tw5fEd3wT9mq`, `AP6qExwrbRgBAVaehg4b5xHENX815sMabtBzUzVB4v8S`. — [BlockRazor JS example](https://docs.blockrazor.io/transaction-submission/transaction-sending/solana/send-transaction/request-example/js)

**Falcon (Corvus Labs; newer)**
- Falcon "submits them through stake-weighted QoS backed by over 1,000,000 SOL, plus the Jito and Harmonic bundle engines", across nine metros. — [Falcon docs](https://docs.corvus-labs.io/falcon)
- Transports: JSON-RPC, HTTP `/binary` and `/plaintext`, QUIC (client certificates), and native UDP. — [Falcon docs](https://docs.corvus-labs.io/falcon)
- Transactions must be 1,232 bytes or less. The minimum tip is 1,000,000 lamports. "Acceptance is not confirmation". — [Falcon docs](https://docs.corvus-labs.io/falcon)

**Triton (FLAG: Cascade Marketplace retired)**
- "Cascade Marketplace was retired as of February 28th" (2026 is implied by the article). SWQoS is now on by default and free for all Triton customers, and Jet powers routing.
- "Under current Agave, staked senders receive 2,000 connections, while unstaked senders share 500 connections (200 TPS across up to 8 connections)".
- "At p50, staked and unstaked sending perform nearly the same".
- — [Triton blog, updated May 5 2026](https://blog.triton.one/swqos-for-everyone-why-we-retired-cascade-marketplace/)
- `POST /sendtx` takes a raw body (`application/octet-stream` or `text/plain`). Query parameters: `encoding` (base58 by default, or base64), `response=signature`, and `max_retries`. The optional header `solana-forwardingpolicies` carries Shield policy addresses. — [Triton tx submission](https://docs.triton.one/chains/solana/cascade/transaction-submission)
- Yellowstone Shield:
  - Policies are on-chain validator allow or block lists, applied with the `Solana-ForwardingPolicies` header or a `forwardingPolicies` parameter.
  - "If the current validator doesn't meet your criteria, the transaction is dropped".
  - Only Shield-enabled RPCs honor policies (Yellowstone Jet, Triton with Cascade). "Standard Solana RPCs will ignore the policy parameter".
  - — [Triton Shield](https://docs.triton.one/project-yellowstone/shield-transaction-policies.md)

**QuickNode Lil' JIT**
- "From $89/mo". It is "A useful bundle of RPC methods for interacting with Jito via your existing Quicknode endpoint", including sendBundle, simulateBundle and getInflightBundleStatuses. — [QuickNode add-on](https://www.quicknode.com/add-ons/lil-jit-jito-bundles-and-transactions)
- Plan tiers: Freshman $89, Rookie $299, Grown $599, Galactic $2,500. — (snippet only, QuickNode marketplace)
- A bundle tip to one of the 8 Jito tip accounts is required. — (snippet only) [QuickNode sendBundle](https://www.quicknode.com/docs/solana/sendBundle)

**RPC Fast Beam (new in 2026)**
- Status: beta "on all RPC Fast plans"; article dated April 24, 2026, updated July 27, 2026. — [RPC Fast Beam](https://rpcfast.com/blog/rpc-fast-beam)
- Routing: Astralane, bloXroute and Falcon, plus Jito, Harmonic and Rakurai paths. Modes are `fastest` and `mev_protect`. — [RPC Fast Beam](https://rpcfast.com/blog/rpc-fast-beam)
- Tips: "Beam does not inject tips automatically", so your application must append the tip instruction before signing. — [RPC Fast Beam](https://rpcfast.com/blog/rpc-fast-beam)
- Pricing and limits: each `sendTransaction` costs 5 compute units. Limits are 60 tx/min (Start) to 500 tx/min (Stream/Aperture). — [RPC Fast Beam](https://rpcfast.com/blog/rpc-fast-beam)
- Claims (no methodology given): "330 ms" landing latency and a "95%" success rate. — [RPC Fast Beam](https://rpcfast.com/blog/rpc-fast-beam)

**Other lanes (UNVERIFIED; named by an open-source SDK)**
- sol-trade-sdk supports "Jito, Nextblock, ZeroSlot, Temporal, Bloxroute, FlashBlock, BlockRazor, Node1, Astralane, Glaive, SpeedLanding" and LunarLander. It cites minimum tips of 0.0001 SOL for Glaive and 0.001 SOL for LunarLander. — [sol-trade-sdk README](https://github.com/0xfnzero/sol-trade-sdk)

**Benchmarks found (none independent)**
- BlockRazor (vendor-run), August 1, 2025:
  - Setup: transfers with DurableNonce, a 0.001 SOL Jito tip and 0.001 SOL priority fee, one transaction every 1.6 seconds; Jito transactions were filtered out.
  - Result: BlockRazor reached the leader first on "30.12%" of transactions in Frankfurt and "39.83%" in New York, compared with bloXroute, 0slot and Temporal. Competitors' own percentages are not shown.
  - — [BlockRazor benchmark](https://blockrazor.io/blog/20250801Benchmarking/)
- A sponsored dev.to post gives latency ranges without methodology ("Jito Bundles: 50–200ms", "Direct Leader Connection: 20–100ms", "TPU Direct via UDP: 1–50ms"). It promotes AllenHark Slipstream. — [dev.to](https://dev.to/techmystique_/the-fastest-way-to-land-solana-transactions-in-2026-5gg9)
- AllenHark's own March 5, 2026 article contains no measurements. — [AllenHark](https://allenhark.com/blog/fastest-way-to-land-solana-transactions-2026)

### Inferences
- **One adapter interface is enough.** Every relay wants a base64 transaction plus a `SystemProgram.transfer` tip to one of its accounts. The adapters differ only in:
  - URL;
  - where the auth goes (query `c=` or `api-key=`, or header `Authorization`, `apikey` or `x-jito-auth`);
  - body shape (JSON-RPC, `{transaction:{content}}`, or raw `text/plain`/octet-stream);
  - minimum tip and rate limit.
- **Minimum tips span about 1,000x.** Jito needs 1,000 lamports, Helius SWQoS-only 5,000 and Astralane 10,000. Helius Sender Max, Nozomi, bloXroute, 0slot and Falcon all need 1,000,000. Racing several 0.001-SOL relays is expensive unless only the winning variant pays, which is the durable-nonce pattern in section 5.
- **Extra relays add less than it seems.** Several relays already forward to Jito and to each other's pathways (Helius Sender Max, NextBlock without anti-MEV, Falcon, Astralane, RPC Fast Beam). The landing gain from each additional relay is probably small and must be measured, not assumed.

### Gaps
- No independent 2026 benchmark compares landing rate or latency across Sender, Jito, Nozomi, bloXroute, Astralane, 0slot, NextBlock, BlockRazor and Falcon. The final report should say this explicitly.
- Missing details:
  - Falcon: endpoint hostnames and tip accounts.
  - BlockRazor: hosts outside Frankfurt, and a minimum tip.
  - NextBlock: a minimum tip.
  - 0slot: anti-MEV mechanics and pricing (one extraction suggested plans were "free"; UNVERIFIED).
  - bloXroute: pricing and rate limits.
  - QuickNode Lil' JIT: rate limits.
- Harmonic and Rakurai are known only as pathways named by Helius, Astralane, Falcon and RPC Fast; their own docs were not reviewed.

---

## 4. Stake-weighted QoS (SWQoS) and sending direct to leaders via QUIC/TPU

### Takeaway
Leaders reserve about 80% of their TPU (QUIC) capacity for staked peers, in proportion to stake, so an unstaked self-hosted sender competes for the remainder. Getting virtual stake requires a trusted validator to list you in its `staked-nodes-overrides`, which is impractical for one user. In 2026, the realistic way to benefit from SWQoS is to use relays and staked RPCs. Direct TPU sending is at most a supplementary lane.

### Cited Findings
- SWQoS gives "80% of a leader's TPU capacity" to staked peers, proportional to stake and to `staked-nodes-overrides`; the rest goes to unstaked nodes. A validator with "1% stake will have the right to transmit up to 1% of the packets to the leader". — [Solana SWQoS guide](https://solana.com/developers/guides/advanced/stake-weighted-qos)
- How an RPC gets virtual stake: the validator runs with `--staked-nodes-overrides /path/to/overrides.yml`, and the RPC runs with `--rpc-send-transaction-tpu-peer HOST:PORT`. "Commercial RPC infrastructure operators and exchanges will likely be among the major beneficiaries." — [Solana SWQoS guide](https://solana.com/developers/guides/advanced/stake-weighted-qos)
- Under current Agave, staked senders get 2,000 connections and unstaked senders share 500 (200 TPS across up to 8 connections). "Recent Anza improvements have significantly increased bandwidth for staked senders". "At p50, staked and unstaked sending perform nearly the same". — [Triton blog](https://blog.triton.one/swqos-for-everyone-why-we-retired-cascade-marketplace/)
- Nozomi's QUIC client is "not faster than warm HTTP" and is meant only for clients that cannot keep a persistent connection. — [Nozomi llms-full.txt](https://use.temporal.xyz/llms-full.txt)
- Yellowstone Jet is an open-source "Solana QUIC transaction sender, with built in proxy and SwQoS support". — (snippet only) [GitHub rpcpool/yellowstone-jet](https://github.com/rpcpool/yellowstone-jet)
- Relays sell staked capacity:
  - Falcon cites more than 1,000,000 SOL of SWQoS stake. — [Falcon docs](https://docs.corvus-labs.io/falcon)
  - bloXroute exposes `useStakedRPCs`. — [bloXroute submit](https://docs.bloxroute.com/solana/trader-api/api-endpoints/transaction-submisson/submit)
  - Helius basic sending uses a "priority lane". — [Helius overview](https://www.helius.dev/docs/sending-transactions/overview.md)
- Leader rotation is still "four slots" per leader. — [Solana reduced slot times](https://solana.com/upgrades/reduced-slot-times) At 250 ms slots, the leader window is 1.0 s instead of 1.6 s. — [Solana Compass](https://solanacompass.com/news/solana-activates-250ms-slot-time-at-epoch-1037-fourth-step-of-simd-0525)

### Inferences
- **Direct TPU without stake.** A custom TPU client for one user (leader schedule plus QUIC to the current and next leaders) lands in the shared unstaked pool. Triton's p50-parity claim suggests this is workable in calm periods. Under congestion, such as memecoin launches, staked paths should win.
- **Hidden costs.** Direct TPU sending also means tracking the leader schedule, managing QUIC connections, and exposing every transaction to every upcoming leader (MEV risk; see section 8). For a single-user terminal that cost is not justified.
- **If you build it anyway.** Run it as one optional "direct" lane on top of Yellowstone Jet or Agave's TPU client rather than a hand-rolled client, and measure its win rate.

### Gaps
- No 2026 measurement of unstaked direct-TPU landing rates under congestion was found.
- No primary source for the current per-connection QUIC stream limits was found; only Triton's summary.

---

## 5. Multi-relay racing without double execution

### Takeaway
To race one trade across relays that each require their own tip, use a durable nonce:
- one nonce account;
- N transaction variants that differ only in tip destination and amount, so each has its own signature;
- every variant uses the same nonce as its `recentBlockhash`.

Whichever variant lands first advances the nonce, which invalidates all the others. Astralane's `sendIdeal` offers this pattern as a product, and open-source SDKs (sol-trade-sdk) require it for multi-lane sends. Two relays document caveats: Nozomi says nonces "may reduce landing rates on some paths", and BlockRazor says nonces make its sandwich protection ineffective.

### Cited Findings
- sol-trade-sdk:
  - "When using multiple MEV services ... you need to use `Durable Nonce`."
  - Each lane receives a transaction with the same nonce but its own tip, and "only the first successful submission increments it on-chain".
  - It can "Submit through every configured SWQoS provider plus the default RPC lane; the first accepted result can return early while slower routes continue submitting".
  - Warning: PumpFun V2 with ATA creation plus a durable nonce "may exceed `PACKET_DATA_SIZE`".
  - — [sol-trade-sdk](https://github.com/0xfnzero/sol-trade-sdk)
- Astralane `sendIdeal` sends two transactions that share a durable nonce: one with a high priority fee and the minimum tip, and one with a high tip and a lower priority fee. A managed nonce service is available through `getNonce`, used together with `partial_sign`. — [Astralane submit](https://astralane.gitbook.io/docs/low-latency/submit-transactions)
- Solana durable-nonce rules:
  - "the first instruction of the transaction needs to be a `nonceAdvance` instruction";
  - "use the nonceAccount's stored nonce as the recentBlockhash";
  - the nonce authority must sign;
  - after a transaction lands, the nonce advances, so other transactions with the same nonce become invalid;
  - the nonce account is rent-exempt and needs "around 0.0015 SOL".
  - — [Solana durable nonces guide](https://solana.com/developers/guides/advanced/introduction-to-durable-nonces)
- Relay caveats:
  - Nozomi: "Durable nonces: May reduce landing rates on some paths; benchmark both approaches". — [Nozomi tipping/FAQ](https://use.temporal.xyz/nozomi/tipping-and-faq)
  - BlockRazor `sandwichMitigation`: "DO NOT send transactions using durable nonce". — [BlockRazor](https://docs.blockrazor.io/transaction-submission/transaction-sending/solana/send-transaction.md)
- Without a nonce, Helius advises storing `lastValidBlockHeight` and re-signing only "after the blockhash expires to prevent double-confirmation". — [Helius optimizing](https://www.helius.dev/docs/sending-transactions/optimizing-transactions.md)
- Jito bundles are atomic, and Jito advises putting the tip inside the main transaction to avoid "uncle bandit" exposure. — [Jito docs](https://docs.jito.wtf/lowlatencytxnsend/)
- BlockRazor's benchmark itself used "Transfer with DurableNonce" transactions. — [BlockRazor benchmark](https://blockrazor.io/blog/20250801Benchmarking/)

### Inferences
- **Option A: no nonce, identical bytes.** Sign one transaction that tips several relays (for example Helius, Nozomi and bloXroute) and send the same bytes to each. The runtime dedupes by signature, so double execution is impossible. The cost is the sum of every relay's minimum (for example 3 x 0.001 SOL), paid whenever the transaction lands.
- **Option B: durable nonce, one variant per relay.** Each variant pays only its own relay's tip, and only the winner pays. Pitfalls:
  - Nonce transactions never expire. On timeout you must cancel actively by sending a transaction that only advances the nonce. Otherwise a stale variant can still land later.
  - One nonce account supports one in-flight trade at a time. Keep a pool of nonce accounts per wallet so concurrent orders don't collide.
  - After each use you need the new nonce value: one RPC read, or derive it from the landed transaction.
  - The nonce instruction adds accounts and bytes, so watch the 1,232-byte limit for legacy and v0 transactions.
  - Every variant write-locks the nonce account.
  - Nonce flows conflict with some anti-sandwich modes (BlockRazor). The likely reason is that a non-expiring transaction can be held and replayed by a leader. Disable racing in Protected mode.
- **Winner attribution.** Each variant pays a different relay's tip account, so the landed transaction shows which relay won. Log this to compute per-relay win rates.
- **Protected flows can't race.** Jito bundles with `jitodontfront` cannot be raced against non-Jito lanes without losing the protection.

### Gaps
- The Solana guide does not say whether a nonce transaction that fails during execution (but pays fees) still advances the nonce. Verify on devnet before assuming "failed means consumed".
- No quantitative data shows how much durable nonces reduce landing on specific relays; Nozomi only says "may".

---

## 6. Priority fees, CU-limit tuning, loaded-accounts-data-size, ALTs/v0 (and the new v1 format)

### Takeaway
The priority fee is `ceil(cu_price x cu_limit / 1e6)` lamports, charged on the requested CU limit rather than on CUs actually used. So the levers are:
- simulate, then set the limit to consumed x 1.1;
- price each CU from a percentile estimator (Helius `getPriorityFeeEstimate` on the serialized transaction, or `getRecentPrioritizationFees` over the writable accounts);
- cap the result at a user-set maximum.

Relays weight priority fee against tip differently:
- Jito: 70/30 priority fee to tip for `sendTransaction`; tip only for bundles.
- Nozomi: put the bid into the tip first.
- NextBlock anti-MEV: tip only.

Pump.fun CU numbers come only from open-source bot configs: a buy is about 100k CU including ATA creation, a sell about 60k. The new v1 transaction format (live since 2026-09-15) moves the compute-budget fields into the header but does not support ALTs.

### Cited Findings
**Fee math (official)**
- Base fee is "5,000 lamports per signature", split "50% burned / 50% to the validator".
- Priority fee is "ceil(compute_unit_price * compute_unit_limit / 1,000,000) lamports", with "100% to the validator".
- Fees are charged on the requested CU limit.
- Default compute budget is 200,000 CU per instruction; the per-transaction maximum is 1,400,000.
- — [Solana fees](https://solana.com/docs/core/fees)

**`getRecentPrioritizationFees`**
- The node's cache "stores data from up to 150 blocks". It accepts at most 128 addresses. When addresses are given, "the response reflects fees observed for transactions that lock all of the supplied accounts as writable". — [Solana RPC](https://solana.com/docs/rpc/http/getrecentprioritizationfees)

**Helius estimator**
- Levels: Min, Low (25th percentile), Medium (50th; the recommended default), High (75th), VeryHigh (95th), UnsafeMax. The serialized-transaction method is the "primary" one, for "highest accuracy". — [Helius priority fee API](https://www.helius.dev/docs/priority-fee-api)
- Request:
  - `method: "getPriorityFeeEstimate"`
  - params: `[{ transaction: <base58 serialized tx>, options: { priorityLevel, includeAllPriorityFeeLevels, includeDetails, lookbackSlots (1–150), recommended } }]`
  - Response fields: `priorityFeeEstimate` (micro-lamports) and `priorityFeeLevels` (min, low, medium, high, veryHigh, unsafeMax).
  - Endpoint: `https://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY`.
  - — [Helius serialized-tx estimation](https://www.helius.dev/docs/priority-fee/estimating-fees-using-serialized-transaction.md)

**CU tuning**
- Simulate with the maximum limit (1.4M), then set `let customersCU = Math.ceil(unitsConsumed * 1.1);`. Put the compute-limit instruction before the other instructions. — [Helius optimizing](https://www.helius.dev/docs/sending-transactions/optimizing-transactions.md)
- The same guidance appears as "Add a 10% buffer to the CU estimate". — [Helius send-manually](https://www.helius.dev/docs/sending-transactions/send-manually.md)

**How relays weight fees**
- Jito: 70/30 priority fee to tip for `sendTransaction`; for bundles, "Only the Jito tip matters". — [Jito docs](https://docs.jito.wtf/lowlatencytxnsend/)
- Nozomi: begin with "100% of your bid in the Nozomi tip", and avoid over-requesting CUs. — [Nozomi tipping/FAQ](https://use.temporal.xyz/nozomi/tipping-and-faq)
- NextBlock anti-MEV: "priority fee does not matter". — [NextBlock](https://docs.nextblock.io/getting-started/quickstart)

**Pump.fun CU and fee figures (open-source configs, not official)**
- The Chainstack pumpfun-bonkfun-bot config contains these commented defaults:
  - `buy: 100_000 # Buy operations (ATA creation + trading)`
  - `sell: 60_000 # Sell operations (just trading)`
  - `account_data_size: 12_500_000 # Disabled: causes MaxLoadedAccountsDataSizeExceeded`
- Its notes on loaded account data:
  - "Reduces CU cost from 16k to ~128 CU by limiting loaded account data. Default is 64MB (16k CU)"
  - "with data size set to 512KB, transactions fail - increasing to 12.5MB resolves the issue"
- Its fee example: `fixed_amount: 1_000_000`, `hard_cap: 1_000_000`.
- — [Chainstack bot config](https://raw.githubusercontent.com/chainstacklabs/pumpfun-bonkfun-bot/main/bots/bot-sniper-1-geyser.yaml)
- sol-trade-sdk's example `set_global_fee_strategy(150000, 150000, 500000, 500000, 0.001, 0.001)` maps to: buy and sell CU limit 150,000, buy and sell CU price 500,000 micro-lamports, and buy and sell relay tip 0.001 SOL. — [sol-trade-sdk](https://github.com/0xfnzero/sol-trade-sdk)

**Retail terminal fee norms (GMGN)**
- Priority fee "minimum 0.0001 SOL". Tip fee "minimum 0.0001 SOL". Maximum "2 SOL". — [GMGN fees & settings](https://docs.gmgn.ai/index/gmgn-fees-settings)
- Anti-MEV requires a priority fee of at least 0.002 SOL. — [GMGN fees & settings](https://docs.gmgn.ai/index/gmgn-fees-settings)
- "For transactions with no speed requirement, a total on-chain fee of 0.002 - 0.005 SOL is generally sufficient." — [GMGN fees & settings](https://docs.gmgn.ai/index/gmgn-fees-settings)

**ALTs and v0**
- bloXroute supports ALTs but recommends against them in tip instructions ("Avoid address lookup tables in tip instructions"). — [bloXroute tips](https://docs.bloxroute.com/solana/trader-api/introduction/tip-and-tipping-addresses); [bloXroute best performance](https://docs.bloxroute.com/solana/trader-api/best-performance-for-landing-transactions)

**Transaction v1 (FLAG: live since 2026-09-15)**
- Activated at "start of epoch 1035 on September 15, 2026 at approximately 01:00 UTC". Maximum size is "4096 bytes, up from 1232".
- The CU limit, loaded-accounts-data-size limit, heap size and priority fee are fixed header fields. The priority fee is an "absolute total in lamports".
- ALTs are "not supported"; up to 64 inline accounts are allowed.
- If omitted, the CU limit defaults to 0 and the data-size limit to 0 bytes ("vs. 64 MiB in legacy/v0"), so the transaction fails.
- RPC reads must pass `maxSupportedTransactionVersion: 1`; otherwise "v1 Transaction fails with error -32015".
- Validators need Agave or Jito-Solana v4.2.2 or later.
- Legacy and v0 "remain appropriate for standard transactions".
- — [Solana larger tx sizes](https://solana.com/upgrades/larger-transaction-sizes)
- The original target date was September 9. — [Solana Compass](https://solanacompass.com/news/anza-developer-sets-mainnet-dates-transaction-v1-september-9-rent-reduction-this-week-alpenglow-in-october)
- base58 encoding is capped at 1,232 bytes, so use base64 for larger transactions. — [Solana sendTransaction](https://solana.com/docs/rpc/http/sendtransaction)

### Inferences
- **Worked example.** With sol-trade-sdk's numbers: 150,000 CU x 500,000 micro-lamports / 1e6 = 75,000 lamports (0.000075 SOL) of priority fee, against a 0.001 SOL tip. The tip dominates total cost.
- **Over-requesting CUs costs money.** Because the fee is charged on the requested limit, over-requesting directly inflates it. Cache per-route CU profiles from simulation: pump.fun buy with and without ATA creation, pump.fun sell, PumpSwap and Raydium routes.
- **Loaded-accounts-data-size.** Setting this limit can cut scheduler cost, but values that are too small fail (512 KB failed; 12.5 MB worked in Chainstack's note). Calibrate it per route by simulation, or leave the default.
- **User fee cap.** Compute `cu_price = min(estimate, floor(maxPriorityLamports x 1e6 / cu_limit))`, and cap the tip separately.
- **Keep v0.** Keep building v0 transactions with ALTs for multi-hop swaps. Consider v1 only when 1,232 bytes is binding (for example nonce + ATA creation + several tips), and check each relay's v1 support first: Nozomi documents it, most others do not.

### Gaps
- No official pump.fun CU numbers were found; measure them by simulation.
- The fetched pages do not clearly state what `recommended: true` returns (for example whether it applies a floor) or Helius' default `lookbackSlots` (one extraction said 150).
- No relay other than Nozomi documents v1 support.

---

## 7. Blockhash management, confirmation tracking, retries, skipPreflight/maxRetries, and latency measurement

### Takeaway
**Blockhash.** Fetch blockhashes at `confirmed` commitment and keep `lastValidBlockHeight`. A blockhash stays valid for 150 blocks (151 hashes), and that window shrinks in wall-clock terms as slots get shorter: roughly 40–60 seconds at 200–300 ms slots.

**Sending and retries.** Send with `maxRetries: 0`, and with `skipPreflight: true` once you have simulated yourself. Rebroadcast to relays that do not retry on their own (Nozomi does retry, so don't resend there), and stop once block height passes `lastValidBlockHeight`.

**Confirmation.** Track confirmation with a signature subscription plus a stream (gRPC or preconfirmations), and fall back to polling `getSignatureStatuses`. Preconfirmations from Helius and BAM give the earliest signal but no guarantee. Once Alpenglow activates, `confirmed` and `finalized` collapse into one level.

### Cited Findings
**Expiry and commitment**
- "there are actually 151 blockhashes that are considered 'recent enough'". The BlockhashQueue stores the 300 most recent. At 400–600 ms slots, a blockhash is usable for "about 60 to 90 seconds". — [Solana confirmation guide](https://solana.com/developers/guides/advanced/confirmation)
- Use `confirmed`, because "it's usually only a few slots behind the processed commitment and has a very low chance of belonging to a dropped fork". With `processed`, "roughly 5% of blocks don't end up being finalized". `finalized` adds "at least a 32 slot difference". — [Solana confirmation guide](https://solana.com/developers/guides/advanced/confirmation)
- Note `lastValidBlockHeight`, then "poll the getBlockHeight RPC API with the confirmed commitment level until it returns a block height greater than" that value. "ALWAYS set the preflightCommitment parameter to the same commitment level used to fetch your transaction's blockhash". — [Solana confirmation guide](https://solana.com/developers/guides/advanced/confirmation)
- FLAG: with shorter slots, "Blockhash expiration arrives sooner". The window "remains 150 blocks"; the page puts it at about 80 seconds at 400 ms, "about 60 seconds" at 300 ms, and "roughly 40 seconds" at 200 ms. Use `getBlockTime` instead of hardcoded 400 ms constants. — [Solana reduced slot times](https://solana.com/upgrades/reduced-slot-times)

**sendTransaction semantics**
- `skipPreflight` defaults to false. `preflightCommitment` defaults to finalized and is ignored when preflight is skipped. — [Solana sendTransaction](https://solana.com/docs/rpc/http/sendtransaction)
- `maxRetries`: "If not provided, the RPC node retries the transaction until finalized or until the blockhash expires". — [Solana sendTransaction](https://solana.com/docs/rpc/http/sendtransaction)
- "A successful response from this method does not guarantee the transaction is processed or confirmed". — [Solana sendTransaction](https://solana.com/docs/rpc/http/sendtransaction)

**Retry policies**
- Helius: "Do not rely on the RPC provider's default retry logic", and "re-send the same transaction periodically until the blockhash expires". — [Helius send-manually](https://www.helius.dev/docs/sending-transactions/send-manually.md)
- Helius `sendSmartTransaction` polls `getSignatureStatuses` every 5 seconds for up to 15 seconds and retries the whole send for up to 60 seconds. — [Helius optimizing](https://www.helius.dev/docs/sending-transactions/optimizing-transactions.md)
- Nozomi: "do not resubmit client-side". — [Nozomi tipping/FAQ](https://use.temporal.xyz/nozomi/tipping-and-faq)
- Some endpoints return no signature, so you must derive it client-side:
  - Nozomi `sendTransaction2` and `sendBatch` return an empty 200. — [Nozomi llms-full.txt](https://use.temporal.xyz/llms-full.txt)
  - Triton `/sendtx` without `response=signature` returns an empty body ("derive signature client-side"). — [Triton](https://docs.triton.one/chains/solana/cascade/transaction-submission)

**Confirmation APIs**
- `signatureSubscribe`:
  - commitment defaults to "finalized";
  - `enableReceivedNotification` adds an early `receivedSignature` notification;
  - "the subscription ends after the terminal confirmation notification".
  - — [Solana signatureSubscribe](https://solana.com/docs/rpc/websocket/signaturesubscribe)
- `getSignatureStatuses`:
  - at most 256 signatures per call;
  - with `searchTransactionHistory: false` it "only searches the recent status cache";
  - returns `slot`, `confirmations`, `err` and `confirmationStatus`.
  - — [Solana getSignatureStatuses](https://solana.com/docs/rpc/http/getsignaturestatuses)
- For bundles, Jito offers `getBundleStatuses` and `getInflightBundleStatuses` (last 5 minutes). — [Jito docs](https://docs.jito.wtf/lowlatencytxnsend/)

**Earliest signals (FLAG: new in 2026)**
- Helius preconfirmations:
  - endpoint `wss://beta.helius-rpc.com`, method `preconfSubscribe`;
  - merges Helius signals (after execution, with status) and BAM signals (commit-to-execute, without status); `includeBam: false` filters to Helius only;
  - requires the Professional plan or higher; "10 credits per message";
  - "A preconfirmation is an early signal, not a guarantee".
  - — [Helius preconfirmations](https://www.helius.dev/docs/pre-confirmations/overview)
- BAM preconfirmations show a p50 lead of 5–10 ms over shred streams. — [BAM preconfirmations](https://bam.dev/docs/bam/preconfirmations/)
- Helius "Preprocessed Transactions" arrive "up to 8ms before the processed commitment level". — [Helius zero-slot blog](https://www.helius.dev/blog/zero-slot)

**Alpenglow effect on commitment (once activated)**
- "confirmed and finalized become the same thing"; `confirmed` will later be deprecated and removed.
- Votes stop being transactions.
- Events gain a `bank_id` because "a slot can carry more than one candidate block".
- A new RPC method, `getAgGenesisCert`, is added.
- "Sending transactions and running onchain programs are not affected".
- — [Solana Alpenglow](https://solana.com/upgrades/alpenglow)

**Latency instrumentation precedent**
- sol-trade-sdk exposes a "start_to_submit" metric, defined as "end-to-end from gRPC event to submit". — [sol-trade-sdk](https://github.com/0xfnzero/sol-trade-sdk)

### Inferences
- **Treat wall-clock expiry as approximate.** The solana.com wall-clock figures (80/60/40 s) imply about 200 slots, not 150 x slot time (150 x 0.3 s = 45 s). Always gate on block height versus `lastValidBlockHeight`. In practice, budget about 40–45 seconds of usable life at 250–300 ms slots, minus fetch lag.
- **Blockhash refresh cadence.** Refresh the cached `confirmed` blockhash every 1–2 seconds, or on each slot or block event from the stream, so new transactions start with nearly the full window.
- **Confirmation pipeline:**
  1. Compute the signature locally (the first signature, bs58-encoded) before sending.
  2. Subscribe via the stream (a gRPC transaction filter on the wallet, or preconfirmations) and via `signatureSubscribe` at `processed` and at `confirmed`.
  3. Poll `getSignatureStatuses` in batches every ~400 ms as a backstop.
  4. Declare failure when `getBlockHeight(confirmed) > lastValidBlockHeight`. For nonce flows, use your own deadline plus a nonce-advance cancel.
- **End-to-end latency instrumentation:**
  - Record t_request, t_quote/route, t_built, t_signed, t_sent[lane], t_ack[lane], t_first_seen (preconfirmation, processed, or stream), and t_confirmed.
  - Also record slot_at_send and landed_slot, which gives the slot delta (0-slot, 1-slot, and so on).
  - Attribute the winning lane by which tip account received funds.

### Gaps
- No official statement covers how Alpenglow affects blockhash expiry, or how `processed` behaves when a slot has several candidate blocks. Re-check when Alpenglow activates.
- No neutral source gives measured 2026 p50/p95 send-to-confirmed latencies.

---

## 8. MEV protection on Solana in 2026: prevalence, mechanics, product modes, trade-offs

### Takeaway
Sandwiching is still common on Solana. From July 2023 to June 2026 there were 28.0M sandwiches against flow that was supposed to be protected, for roughly $345M net profit.

With no public mempool, the attacks now come mostly from transactions forwarded to, or leaked near, malicious leaders. Most span multiple blocks (96% after the validator delistings), and they concentrate on memecoin terminals: Axiom users are sandwiched 18.9x more than their share of trading would predict.

`jitodontfront` only helps when the transaction actually travels through Jito. 98.5% of sandwiched Axiom transactions carried the flag, but only 16.5% carried a Jito tip.

Effective protection means accepting slower landing in exchange for:
- routing only through protected paths: Jito bundle-only with `jitodontfront`, validator-filtered SWQoS (Helius `mev-protect`), Shield policies, or the bloXroute and BlockRazor protected modes;
- keeping slippage tight.

### Cited Findings
**Prevalence and mechanics**
- From July 1, 2023 to June 30, 2026: 28,042,725 sandwich attacks by 8,631 bots. Gross profit $383,433,932; net $345,185,014. — [arXiv 2609.28115 (Sep 23 2026)](https://arxiv.org/html/2609.28115v1)
- Daily averages by era:

  | Era | Daily average | Notes |
  |---|---|---|
  | Mempool closed (03/24–06/24) | about 28,000 | |
  | SFDP delisting (06/24–02/25) | about 46,000 | |
  | Marinade MIP.9 (02/25–10/25) | about 26,000 | |
  | JitoSOL delisting (10/25–06/26) | about 20,000 | only 1% "tight" |

  - The peak was "125,169 attacks per day just before Jito shuts down their temporary public mempool".
  - After the delistings, "96% of attacks span blocks".
  - — [arXiv 2609.28115](https://arxiv.org/html/2609.28115v1)
- On Solana, clients forward transactions "directly to validators/leaders of upcoming slots rather than broadcasting them network-wide". Exposure shifted from the validator level (dominant through early 2025) to the application level. "50% of attacks occur in slots led by validators that are over-represented relative to their share of blocks". — [arXiv 2609.28115](https://arxiv.org/html/2609.28115v1)
- By application:
  - Axiom accounted for "41.4% of victims in Q2 2025 and remaining above 37% thereafter", with an excess ratio of 13.6–20.9.
  - Photon, GMGN and BullX peaked at excess ratios of 20.3, 14.5 and 13.9.
  - — [arXiv 2609.28115](https://arxiv.org/html/2609.28115v1)
  - Overall excess ratios: Axiom 18.9, Photon 11.1, BullX and GMGN above 10, Jupiter Ultra 0.7. — [Crypto Briefing, Sep 28 2026](https://cryptobriefing.com/jupiter-ultra-sandwich-attacks-study/)
- `jitodontfront` in practice: 98.5% of Axiom's 21.5M victim transactions carried the flag, yet "only 16.5% carry a Jito tip". The paper concludes that existing protections "provide substantially weaker guarantees than users expect". — [arXiv 2609.28115](https://arxiv.org/html/2609.28115v1)
- Validator cohort: at epoch 841 (about September 2025), sandwiched.me's v2 detector flagged "82 validators" holding "~4.61M SOL", about "~1.14% of total network stake". It observed 25,088 sandwiching blocks in 30 days. — [sandwiched.me](https://sandwiched.me/research/sandwich_detector_v2)
- A live counter in mid-September 2026 reportedly showed about 8,700 SOL/day extracted from about 74,000 victim wallets. — (snippet only; UNVERIFIED secondary)
- Historical (December 7, 2024 to January 5, 2025):
  - DeezNode's "Vpe" bot ran "1.55 million sandwich transactions" for "65,880 SOL" profit and paid 22,760 SOL in Jito tips.
  - "Nearly half of all sandwich attacks" were attributed to that one program.
  - "MEV Protect" in terminals then meant transactions were "routed exclusively to Jito block engines".
  - — [Helius MEV report](https://www.helius.dev/blog/solana-mev-report)

**Terminal modes**
- GMGN Anti-MEV levels — [GMGN fees & settings](https://docs.gmgn.ai/index/gmgn-fees-settings):
  - "Off protection": sent to all nodes, very fast.
  - "Reduced protection": "sent to limited nodes, fast, may be front-run".
  - "Secure protection": "sent to safe nodes, slightly slower, with compensation".
  - Turning Anti-MEV on requires a priority fee of at least 0.002 SOL.
- Axiom uses Jito's `jitodontfront`. — [arXiv 2609.28115](https://arxiv.org/html/2609.28115v1)
- Jupiter Ultra V3 (launched October 17, 2025) added private routing and dynamic slippage estimation. — [Crypto Briefing](https://cryptobriefing.com/jupiter-ultra-sandwich-attacks-study/)

**Protection modes available to a self-hosted backend**
- Helius `mev-protect=true`: excludes about 3–4M SOL of stake statistically linked to sandwiching. — [Helius MEV Protect](https://www.helius.dev/docs/sending-transactions/mev-protect.md)
- Jito: `jitodontfront` plus `bundleOnly`. — [Jito docs](https://docs.jito.wtf/lowlatencytxnsend/)
- bloXroute: `frontRunningProtection` with `submitProtection` SP_MEDIUM (3-slot buffer) or SP_HIGH (8-slot buffer). — [bloXroute submit](https://docs.bloxroute.com/solana/trader-api/api-endpoints/transaction-submisson/submit)
- BlockRazor: `sandwichMitigation` with `safeWindow` 3–13. — [BlockRazor](https://docs.blockrazor.io/transaction-submission/transaction-sending/solana/send-transaction.md)
- NextBlock: `frontRunningProtection`. — [NextBlock](https://docs.nextblock.io/getting-started/quickstart)
- Astralane: `mev-protect`. — [Astralane](https://astralane.gitbook.io/docs/low-latency/submit-transactions)
- Nozomi: a separate MEV Protect key, on request. — [Nozomi](https://use.temporal.xyz/nozomi/tipping-and-faq)
- Triton: Shield policies, which drop the transaction if the leader is not allowed. — [Triton Shield](https://docs.triton.one/project-yellowstone/shield-transaction-policies.md)
- RPC Fast Beam: `mev_protect` mode. — [RPC Fast](https://rpcfast.com/blog/rpc-fast-beam)
- BAM: TEE scheduling that "mitigates negative MEV". — [bam.dev](https://bam.dev/)
- Positive MEV (rebates): Helius backrun rebates (50%) and bloXroute `allowBackRun`. — [Helius](https://www.helius.dev/docs/sending-transactions/backrun-rebates.md); [bloXroute](https://docs.bloxroute.com/solana/trader-api/api-endpoints/transaction-submisson/submit)

### Inferences
- **Speed vs protection.** Protected modes either restrict which leaders see the transaction (validator filters, or waiting through 3–13-slot safe windows) or restrict the path (the Jito bundle auction only, which reaches only Jito- or BAM-connected leaders). Both add expected slots-to-land. Fast modes fan out to every leader's TPU, flagged leaders included.
- **Why forwarding matters.** Because 96% of sandwiches span blocks, a flagged leader that receives your transaction early can front-run it in its own slot even if your transaction lands later. Early delivery to upcoming leaders is normal forwarding. Excluding flagged leaders from forwarding (Helius `mev-protect`, Shield, BlockRazor) targets exactly this.
- **Order-of-magnitude agreement.** Helius' roughly 3–4M SOL exclusion set is consistent with the roughly 4.61M SOL that sandwiched.me flagged.
- **Protected mode must stay Jito-only.** A `jitodontfront` flag is worthless if the same transaction also goes out on SWQoS lanes. In Protected mode, send only via Jito bundle-only (or a relay's protected mode), never race it on fast lanes, and never reuse a durable nonce.
- **Slippage still matters most.** Slippage remains the main economic limit on sandwich profit. Default memecoin swaps to tight or dynamic slippage.

### Gaps
- No official technical docs were retrieved for Photon's or BullX's MEV-protect implementations, and Axiom's docs root had no MEV details.
- No measured landing-latency penalty for protected modes was found from any source.
- Sandwich data after June 2026 is limited to the unverified live-counter snippet.

---

## 9. Network-level changes 2025–2026 and what they mean for a trading backend

### Takeaway
Big changes in the last quarter:
- Slot time fell from 400 ms to 300 ms; Solana Compass reports 250 ms since 2026-09-18.
- The block CU limit rose to 100M on 2026-07-29.
- v1 transactions (up to 4 KB) went live on 2026-09-15.
- BAM covers about 34% of stake, and DoubleZero carries 59%.

Alpenglow (Votor) is live on testnet but missed its 2026-09-28 mainnet window; the next activation window opens 2026-11-09. Full Firedancer holds about 12% of stake.

### Cited Findings
**Slot times (SIMD-0525)**
- 350 ms took effect on August 19, 2026 (epoch 1019) and 300 ms on August 25, 2026 (epoch 1023). The page lists 250 ms and 200 ms as "To be determined". Leader rotation stays at "four slots", and slots per epoch stay at 432,000. — [Solana reduced slot times](https://solana.com/upgrades/reduced-slot-times)
- CONFLICT: Solana Compass reports that 250 ms went live at epoch 1037, on September 18, 2026 at 05:06 UTC — [Solana Compass, Sep 18 2026](https://solanacompass.com/news/solana-activates-250ms-slot-time-at-epoch-1037-fourth-step-of-simd-0525):
  - leader window 1.0 s; epoch about 30 hours;
  - "At 250ms, the maximum block compute units are 37.5 million, down from 60 million at the 400ms baseline", with per-slot limits scaling proportionally;
  - no date has been announced for 200 ms.

**Block CU limit**
- Raised from 60M to 100M CUs on "July 29, 2026 (epoch 1009)". The per-writable-account limit is unchanged at "12M CUs". — [Solana 100M CU blocks](https://solana.com/upgrades/100m-cu-blocks)

**Transaction v1**
- 4,096-byte transactions went live at epoch 1035 (September 15, 2026). — [Solana larger tx sizes](https://solana.com/upgrades/larger-transaction-sizes)

**Alpenglow**
- What it is — [Solana Alpenglow](https://solana.com/upgrades/alpenglow):
  - Feature gate `A1pengvuM6JEcyNuTnMqepBKhwHE3N6PmUrdATGawhJS`.
  - Phase 1 (Votor) is in Agave 4.3; Rotor comes in a later release.
  - Finality drops from "roughly 12.8 seconds" to a "target of roughly 150 milliseconds".
  - `confirmed` becomes the same as `finalized`, and votes stop being transactions.
  - The page still says "Mainnet Activation: Q3 2026", which is now stale.
- Status — [CryptoTicker, Sep 29 2026](https://cryptoticker.io/en/solana-alpenglow-mainnet-date-missed/):
  - Live on testnet since September 22, 2026.
  - There was no mainnet activation on September 28; that date was only Agave's "resume feature activation" window.
  - The proposal is SIMD-0326. The next mainnet window opens November 9, 2026 (Agave v4.4).
- The test cluster showed "96% fast-path finalization at 214ms". — [Solana Compass, Aug 29 2026](https://solanacompass.com/news/anza-developer-sets-mainnet-dates-transaction-v1-september-9-rent-reduction-this-week-alpenglow-in-october)
- As of September 1, only "0.39 percent" of active stake ran Agave 4.3 builds. — [CryptoTicker, Sep 1 2026](https://cryptoticker.io/en/solana-alpenglow-activation-date-validator-check/)

**Firedancer**
- As of August 10, 2026, full Firedancer ran on 57 of 698 validators with "11.64% of total staked SOL". It launched on mainnet in December 2025. Frankendancer had "roughly 26% validator adoption" by then; its current share was not given. — [Solana Compass Firedancer](https://solanacompass.com/projects/firedancer)

**DoubleZero**
- Q2 2026: "59% of Solana mainnet stake weight" across 462 validators, 434 of them publishing shreds to DoubleZero Edge. Edge launched in April as a real-time block data feed paid in USDC and has "447 distinct subscribers". DoubleZero reports "an average speed improvement of 20% over the public internet". — [Solana Compass, Jul 3 2026](https://solanacompass.com/news/doublezero-posts-217b-total-connected-value-and-59-solana-mainnet-stake-weight-in-q2-2026)
- Geographic expansion over DoubleZero links "could reduce average network latency by ~11%". — [DoubleZero journal, Feb 26 2026](https://doublezero.xyz/journal/extending-solanas-network-performance-to-the-edge)

**Rent reduction (SIMD-0437)**
- Step 1 cuts `lamports_per_byte` from 6,960 to 6,333, on the way to a final 696 (a 90% reduction). This makes ATA creation cheaper on buys. — [Solana Compass, Aug 29 2026](https://solanacompass.com/news/anza-developer-sets-mainnet-dates-transaction-v1-september-9-rent-reduction-this-week-alpenglow-in-october)

### Inferences
- **Shorter slots shrink every timing budget.** Blockhash life is shorter (section 7), leader windows are 1.0–1.2 s, and a relay has less time per slot to reach the right leader. This favors relays with many staked connections and co-location, and rules out hardcoded 400 ms timing anywhere in the code.
- **Hot-account capacity may shrink (UNVERIFIED).** If per-slot limits scale with slot time, the per-writable-account cap (12M at 400 ms) would be about 7.5M at 250 ms. At about 100k CU per pump.fun buy, that is roughly 75 buys per bonding-curve account per block, which matters during launches. This depends on resolving the 37.5M-vs-100M baseline conflict.
- **When Alpenglow activates.** Collapse the UI's commitment levels into a single "confirmed/final" state (target about 150 ms). Stream consumers must handle `bank_id` and multiple candidate blocks per slot. No change to the send path is expected.

### Gaps
- Two conflicts need resolving: (a) whether 250 ms is live (Solana Compass) or still to be determined (solana.com page); (b) the block CU limit after SIMD-0525 scaling (the 37.5M claim vs a 100M baseline).
- No current Frankendancer stake share was found.
- No data was found on how DoubleZero affects end-user transaction landing.

---

## 10. Where to host the backend, with real-world latency numbers

### Takeaway
Host in Frankfurt, with Amsterdam as the standby. Frankfurt has the largest concentration of validator stake (its two data-center entries in validators.app's top 10 total about 14.7% of stake), and every relay surveyed has a Frankfurt point of presence. Vendor-reported round trips from cloud hosts to the Frankfurt cluster are 1–2.5 ms. New York/Newark and Tokyo are also served by every relay if a second region is needed.

### Cited Findings
- validators.app top data centers by active stake — [validators.app](https://www.validators.app/data-centers?network=mainnet):

  | Data center (ASN) | Stake | Validators |
  |---|---|---|
  | Frankfurt am Main (20326) | 11.19% | 19 |
  | Amsterdam (20326) | 7.13% | 30 |
  | Paris (16276) | 4.45% | 6 |
  | Frankfurt am Main (213896) | 3.52% | 20 |
  | London (400963) | 3.26% | 5 |
  | Tokyo (20326) | 2.90% | 9 |
  | Chicago (1072) | 2.85% | 2 |
  | Ashburn (14618) | 2.79% | 1 |
  | Vilnius (16125) | 2.78% | 5 |
  | Singapore (20326) | 1.51% | 6 |

- RPC Fast co-location guide (vendor; published December 12, 2025, updated September 7, 2026) — [RPC Fast co-location](https://rpcfast.com/blog/solana-trading-co-location-low-latency):
  - Hetzner Falkenstein to Frankfurt: 1.2 ms.
  - AWS Frankfurt to Solana Frankfurt: 1.5–2.5 ms.
  - GCP Amsterdam to Solana Amsterdam: 3.5 ms.
  - AWS Singapore to EU clusters: 190–220 ms.
  - "AWS Ashburn to Solana New Jersey": 60–75 ms (see Inferences).
  - Claimed end-to-end, transaction submission to block inclusion: "~20–35ms".
- Relay endpoints by city, compiled from the endpoint lists in sections 1–3:

  | City | Relay endpoints |
  |---|---|
  | Frankfurt | Helius `fra-sender`, Jito `frankfurt`, Nozomi `fra2`/`fra`, bloXroute `germany`, NextBlock `frankfurt`, 0slot `de`, Astralane `fr`/`fr2`, BlockRazor `frankfurt` |
  | Amsterdam | Helius `ams-sender`, Jito `amsterdam`, Nozomi `ams1`, bloXroute `amsterdam`, NextBlock `amsterdam`, 0slot `ams`, Astralane `ams`/`ams2` |
  | New York/Newark | Helius `ewr-sender`, Jito `ny`, Nozomi `ewr1` (also `pit1`, `ash1`), bloXroute `ny`, NextBlock `ny`, 0slot `ny`, Astralane `ny` |
  | Tokyo | Helius `tyo-sender`, Jito `tokyo`, Nozomi `tyo1`, bloXroute `tokyo`, NextBlock `tokyo`, 0slot `jp`, Astralane `jp` |

  Sources: [Helius](https://www.helius.dev/docs/sending-transactions/sender.md), [Jito](https://docs.jito.wtf/lowlatencytxnsend/), [Nozomi](https://use.temporal.xyz/nozomi/endpoints), [bloXroute](https://docs.bloxroute.com/solana/trader-api/introduction/regions), [NextBlock](https://docs.nextblock.io/getting-started/quickstart), [0slot](https://0slot.trade/docs.php), [Astralane](https://astralane.gitbook.io/docs/low-latency/endpoints-and-configs), [BlockRazor](https://docs.blockrazor.io/transaction-submission/transaction-sending/solana/send-transaction/request-example/js)
- Helius LaserStream regions include EWR (New Jersey), Salt Lake City, Tokyo and Frankfurt. — [Helius zero-slot blog](https://www.helius.dev/blog/zero-slot)

### Inferences
- **Discard one vendor number.** The "AWS Ashburn to Solana New Jersey 60–75 ms" figure is implausible for a fiber path of roughly 350 km, which normally has single-digit-ms round trips. It is probably an error and should not be cited.
- **Why Frankfurt.** Leader slots are allocated by stake, so a Frankfurt backend sits a few ms from the largest single block of leaders and from every relay's ingress. The relays carry the remaining global hop. In the validators.app top 10, EU data centers total about 32% of stake, US about 5.6% and Asia about 4.4%.
- **Users outside Europe.** If the user trades from the US or Asia, the user-to-backend hop matters less than the backend-to-relay hop. Keep the backend in Frankfurt and accept the user-side round trip. Add a second relay-facing region (New York) only if measurements show it helps.

### Gaps
- No neutral 2026 measurements were found of backend-to-relay round trips, or of the slot-landing distribution by hosting region.
- The validators.app numbers are per data-center ASN entry and cover only the top 10, not full city totals. The page showed no date; it was fetched on 2026-10-03.

---

## Implications for the build

**Recommended sender architecture (Bun/TypeScript, server-side signing)**
- **One router, pluggable lanes.** Build a single `SubmitRouter` with lane adapters. Each adapter holds:
  - base URL;
  - where auth goes;
  - body encoder (JSON-RPC, `{transaction:{content}}`, or raw text/octet-stream);
  - tip-account list and minimum tip;
  - rate limiter and keep-alive pinger.
- **Start with three lanes, all in Frankfurt:**
  - Helius Sender `http://fra-sender.helius-rpc.com/fast`, in SWQoS-only, Max or `mev-protect` mode.
  - Jito `https://frankfurt.mainnet.block-engine.jito.wtf`, plus `amsterdam` for rate-limit headroom. Use `sendTransaction`, `bundleOnly=true` or `sendBundle`, with a UUID.
  - One more independent relay: Nozomi `fra2` (`/api/sendTransaction2` or `sendBatch`), or Astralane `fr` plus `edge`.
  - Add bloXroute (`germany` plus `global`), 0slot (`de`), NextBlock, BlockRazor or Falcon only if per-lane win-rate telemetry justifies them.
- **Connections.** Keep HTTP connections alive and warm:
  - Helius `/ping` at least every 5 s while idle;
  - Nozomi `/ping` every 60 s;
  - bloXroute keep-alive every 30 s;
  - use plain HTTP for server lanes wherever it is offered.
- **Send order.** Compute the signature locally, start the watchers, then fire all lanes at once: `Promise.any` for the first acknowledgement and `Promise.allSettled` for telemetry.
- **Race mode ("Turbo"):**
  - one durable-nonce variant per lane, each with that lane's tip;
  - a pool of nonce accounts per wallet;
  - winner attribution by tip account;
  - cancel with an `advanceNonce` transaction when the deadline passes.
- **Standard mode.** Send a single transaction to Helius Sender, which already fans out to Jito and other paths. Optionally send identical bytes to one more relay, but only if the transaction also pays that relay's tip.
- **Tip accounts.** Fetch Jito's with `getTipAccounts` at startup. Keep the other relays' lists in config, with a CI check that diffs them against the docs.

**Default fee and tip policy**
- **CU limit.** Simulate, then set `ceil(unitsConsumed x 1.1)`, and cache per-route profiles. Starting points to validate by simulation: about 100k CU for a pump.fun buy with ATA creation, about 60k for a sell.
- **CU price.** Call Helius `getPriorityFeeEstimate` on the serialized transaction:
  - Eco = Medium (p50), Fast = High (p75), Turbo = VeryHigh (p95);
  - clamp so `cu_price x cu_limit / 1e6` never exceeds the user's maximum priority fee;
  - refresh every few slots, or from a stream.
- **Tip size.** Read Jito `tip_stream` (and Nozomi `tip_floor`):
  - Eco = max(lane minimum, p50), Fast = p75, Turbo = p95–p99, all clamped to the user's maximum tip;
  - use Sender Max only when the tip is at least 0.001 SOL; otherwise use SWQoS-only (5,000-lamport minimum).
- **Tip rules.** Use the 70/30 priority-fee-to-tip split on Jito `sendTransaction`; for bundles, tip only. Always put the tip inside the same transaction.
- **Blockhash.** Cache a `confirmed` blockhash and refresh it every 1–2 s or on slot events. Keep `lastValidBlockHeight`, and assume about 40–45 s of validity at current slot times.
- **Retries.** Use `maxRetries: 0`, and `skipPreflight: true` after your own simulation. Rebroadcast every 1–2 slots to lanes that do not retry themselves (so not Nozomi) until block height passes `lastValidBlockHeight`.

**MEV protection modes to offer**
- **Fast (no protection):** all lanes, Sender Max or race mode. Show a warning on memecoin swaps.
- **Protected (default for memecoin and pump.fun trades):**
  - Jito only: `bundleOnly=true` or `sendBundle`;
  - a read-only `jitodontfront...` account in the swap instruction;
  - tip at p75 or higher;
  - no SWQoS lanes and no durable nonce;
  - tight or dynamic slippage;
  - show the user that landing will be slower.
- **Reduced (balanced):** Helius Sender with `?mev-protect=true` (SWQoS-only or Max), still including the `jitodontfront` marker. Optional alternatives: bloXroute `frontRunningProtection` with `SP_MEDIUM`, or BlockRazor `sandwichMitigation`.
- **Positive MEV (optional opt-in):** pass a Helius `rebate-address` to receive 50% of backrun value.
- **Verification:** detect sandwiches after the fact by comparing pool state around the front and back legs, and use the results to validate each mode.

**Hosting region**
- Primary: Frankfurt, bare-metal or cloud. Warm standby: Amsterdam.
- Measure round-trip time to each relay's Frankfurt and Amsterdam endpoints at boot and every few minutes, and pick the lowest per lane.

**Watch list (likely to change soon)**
- Alpenglow mainnet activation (window opens 2026-11-09), which merges `confirmed` and `finalized`.
- The 200 ms slot-time step.
- BAM ordering and protection semantics, and how preconfirmations are accessed.
- Changes to relay tip accounts and minimums (Helius' tiers already changed in 2026).
- Relay support for v1 transactions.
