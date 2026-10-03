# Data feeds, event detection and derived market data for a self-hosted Solana memecoin terminal (as of 3 Oct 2026)

Scope: the data layer only (ingest → detect → parse → derive → store → stream). Pump.fun program internals (full IDLs, account layouts, fee math) and transaction sending are covered by other researchers. Wherever a fact comes only from a search-engine result summary (the page itself was not fetched), it is marked "(search summary)". Treat those as lower confidence. Dates are given wherever the source shows one.

---

## 1. Real-time sources ranked by latency (shreds, Yellowstone gRPC, LaserStream, Triton and other gRPC providers, websockets, PumpPortal, data APIs), with measured comparisons

### Takeaway
The biggest 2026 change: **Jito ShredStream shut down on 5 Sep 2026**. Shred-level speed now comes from DoubleZero Edge (raw multicast shreds you decode yourself, $450–$1,500/mo per IP) or from managed "deshredded" pre-execution streams (Shyft RabbitStream, Triton Deshred, Helius preprocessed transactions, OrbitFlare Jetstream). None of these carry logs or execution metadata. For a terminal, the main feed should still be **Yellowstone-compatible gRPC transactions with full meta**. Flat-rate providers make that cheap: Chainstack from $49/mo, Solana Vibe Station from $150/mo, Shyft from $199/mo. Websockets and third-party APIs are fine as a cheap phase-1 or backup path but are measurably slower.

### Cited Findings

**Latency ladder (fastest → slowest), with the evidence for each step**
- Raw shreds over a private network: DoubleZero Edge claims a "73.5% win rate" on first-seen shreds against Jito ShredStream + Turbine. It also claims to be "11.6ms faster (p50)" and 42.8 ms faster at p95 than Jito ShredStream (data dated 6 Jul 2026; live scoreboard at data.doublezero.xyz) — [DoubleZero migration page](https://doublezero.xyz/jito-shredstream)
- Decoded shred streams: Shyft says RabbitStream had a "96.7% average win rate" against Jito ShredStream and was faster by 5.46 ms (Frankfurt p50), 7.24 ms (New York p50) and 5.99 ms (Amsterdam p50) — [Shyft RabbitStream](https://shyft.to/solana-shreds-rabbitstream). Helius says preprocessed transactions arrive "up to 8ms before the `processed` commitment level" — [Helius: Solana Shreds](https://www.helius.dev/blog/solana-shreds)
- Shred-fed gRPC vs plain gRPC: RPC Fast reports that adding Jito ShredStream to its nodes cut Yellowstone gRPC transaction arrival time by "an average of 120 ms", with a p99 gain of "around 270 ms", across 185k matched transactions. The article was published 16 Dec 2025, updated 29 Jul 2026, and this measurement predates the ShredStream sunset — [RPC Fast](https://rpcfast.com/blog/shredstream-vs-geyser-vs-standard-rpc)
- gRPC vs websockets vs RPC polling (Triton guide, updated 6 May 2026). Slot p90: standard RPC ~150 ms, native WebSockets ~10 ms, Dragon's Mouth gRPC ~5 ms. Account p90: WebSockets ~374 ms, gRPC ~215 ms — [Triton complete guide](https://blog.triton.one/complete-guide-to-solana-streaming-and-yellowstone-grpc/). NoLimitNodes repeats the same 215 ms / 374 ms account figures (18 Jun 2026) — [NoLimitNodes](https://nolimitnodes.com/blog/yellowstone-grpc-providers-compared)
- Helius moved all its WebSockets onto LaserStream infrastructure on 31 Mar 2026 and says "Standard WSS methods are up to 200ms faster" — [Helius blog](https://www.helius.dev/blog/laserstream-websockets)
- Vendor-to-vendor gRPC benchmark: a search snippet reports Helius LaserStream at p50 2.92 ms, p95 26.58 ms and p99 45.08 ms in a 10,000-transaction Frankfurt test run by Shreder (a competitor). The page failed TLS verification when fetched, so the method and baseline could not be checked. **Unverified** — [Shreder benchmark](https://shreder.xyz/benchmarks/shreder-fastlane-vs-helius-laserstream/) (search summary)

**Jito ShredStream (historical; now shut down)**
- Jito's docs: ShredStream "is being sunset on September 5, 2026"; users must migrate to DoubleZero Edge — [Jito docs](https://docs.jito.wtf/lowlatencytxnfeed/). A 27 Jul 2026 migration guide confirms the shutdown date and says `shredstream-proxy` "will not work after shutdown" — [OrbitFlare](https://orbitflare.com/blog/developers/jito-shredstream-shutdown-migration-guide)
- How it worked, for reference (other shred sources reuse the same concepts):
  - Access needed an approved pubkey (via Discord), an `AUTH_KEYPAIR`, inbound UDP on port 20000, and no NAT.
  - Proxy settings: `BLOCK_ENGINE_URL=https://mainnet.block-engine.jito.wtf`, `DESIRED_REGIONS` (max 2) and `DEST_IP_PORTS`.
  - Regions: Amsterdam, Dublin, Frankfurt, London, New York, Salt Lake City, Singapore, Tokyo.
  - Setting `GRPC_SERVICE_PORT` turned on a gRPC server that streamed decoded transactions (see the `deshred.rs` example).
  - Source: [Jito docs](https://docs.jito.wtf/lowlatencytxnfeed/)
- Proto: `ShredstreamProxy.SubscribeEntries(SubscribeEntriesRequest) returns (stream Entry)`. `Entry` = `{ uint64 slot; bytes entries }`, where `entries` holds "Serialized bytes of Vec<Entry>" (solana_entry::Entry). The request has no filters yet — [mev-protos/shredstream.proto](https://github.com/jito-labs/mev-protos/blob/master/shredstream.proto)

**Shred contents and deshredding**
- Data shreds carry serialized entry batches. Coding shreds add Reed-Solomon parity, typically in 32:32 FEC sets.
- Deshredding steps: verify signatures → recover missing data shreds with Reed-Solomon → concatenate data payloads by index → deserialize entries/transactions → assemble blocks.
- Raw shreds do **not** contain "logs, inner instructions, account balances, and transaction success/failure status".
- Source: [Helius: Solana Shreds](https://www.helius.dev/blog/solana-shreds)

**Current shred and pre-execution options (Oct 2026)**
- **DoubleZero Edge** (raw shreds):
  - Shreds arrive as GRE-encapsulated multicast on UDP 7733 on the `doublezero1` interface. Leader shreds: `233.84.178.1:7733`; root shreds: `233.84.178.16:7733`.
  - Setup: install the DoubleZero client; the firewall must allow GRE, BGP, PIM and shred traffic; the machine holds the DoubleZero ID private key.
  - Price per machine: $1,500/mo (Frankfurt/Amsterdam), $900 (London/NY/Singapore/Tokyo), $450 (other metros) — [DoubleZero docs](https://docs.doublezero.xyz/Edge%20Subscriber%20Connection/)
  - Free trial for former Jito ShredStream users (eligibility based on IP snapshots); free 90 days for validators — [DoubleZero](https://doublezero.xyz/jito-shredstream)
- **Helius** "Shred Delivery": $1,000/mo per IP ($800 on Professional) — [Helius plans](https://www.helius.dev/docs/billing/plans). LaserStream preprocessed transactions cost "0.1 credits per message" — [LaserStream docs](https://www.helius.dev/docs/laserstream)
- **Shyft RabbitStream**:
  - Listens to raw UDP shreds and delivers decoded transactions over Yellowstone-compatible gRPC with full Address Lookup Table (ALT) resolution and gRPC-style filters.
  - No transaction meta: no "logs, fees, final balances".
  - Included in Build ($199/mo) and higher. Regions: NY, Ashburn VA, Amsterdam, Frankfurt — [Shyft RabbitStream](https://shyft.to/solana-shreds-rabbitstream)
- **Triton Deshred** (`SubscribeDeshred`):
  - Pre-execution stream with fields `slot`, `signature`, vote flag, raw transaction, `loaded_writable_addresses`, `loaded_readonly_addresses`.
  - Filters: `vote`, `account_include`, `account_exclude`, `account_required`.
  - "Currently available only on Triton One gRPC servers and is in paid beta" — [Triton docs](https://docs.triton.one/project-yellowstone/dragons-mouth-grpc-subscriptions). The open-source Yellowstone server returns `UNIMPLEMENTED` — [yellowstone-grpc README](https://github.com/rpcpool/yellowstone-grpc)
- **OrbitFlare**: Shredstream (standard shreds that existing parsers can consume) and Jetstream V2 ("decoded transactions over gRPC") — [OrbitFlare](https://orbitflare.com/blog/developers/jito-shredstream-shutdown-migration-guide)
- **RPC Fast Aperture**: from $399/mo; "shred-level arrival paired with roughly 95% transaction status simulation"; Frankfurt (Equinix FR13) with a DoubleZero path — [RPC Fast providers list (11 Aug 2026, updated 7 Sep 2026)](https://rpcfast.com/blog/best-solana-grpc-providers)

**Yellowstone / Dragon's Mouth gRPC (protocol facts)**
- `SubscribeRequest` fields: `accounts`, `slots`, `transactions`, `transactions_status`, `blocks`, `blocks_meta`, `entry`, `commitment`, `accounts_data_slice`, `ping`, `from_slot`, `block_footer` — [geyser.proto](https://github.com/rpcpool/yellowstone-grpc/blob/master/yellowstone-grpc-proto/proto/geyser.proto)
- Transaction filter fields: `vote`, `failed`, `signature`, `account_include`, `account_exclude`, `account_required`, plus `cuckoo_account_include` and `token_accounts`.
- Account filter fields: `account`, `owner`, `filters` (memcmp {offset, bytes|base58|base64}, datasize, `token_account_state`, lamports eq/ne/lt/gt), `nonempty_txn_signature`.
- Slot filter fields: `filter_by_commitment`, `interslot_updates`.
- `SlotStatus` values: `SLOT_PROCESSED`, `SLOT_CONFIRMED`, `SLOT_FINALIZED`, `SLOT_FIRST_SHRED_RECEIVED`, `SLOT_COMPLETED`, `SLOT_CREATED_BANK`, `SLOT_DEAD`.
- Transaction updates carry `signature`, `is_vote`, `transaction`, `meta`, `index`.
- Unary RPCs: `SubscribeReplayInfo`, `GetLatestBlockhash`, `GetSlot`.
- Source for the five items above: [geyser.proto](https://github.com/rpcpool/yellowstone-grpc/blob/master/yellowstone-grpc-proto/proto/geyser.proto)
- Semantics: filter fields combine "as logical `AND`, and values in arrays as logical `OR`". Commitment is 0=PROCESSED, 1=CONFIRMED, 2=FINALIZED. Send a ping about every 30 s (Cloudflare closes idle streams). `from_slot` replays only within "the server's retained replay window"; `SubscribeReplayInfo` returns `first_available`. Replay "starts at a slot boundary", so clients must dedupe — [Triton docs](https://docs.triton.one/project-yellowstone/dragons-mouth-grpc-subscriptions)
- The entry stream has no filters ("all entries are broadcast"). The server sends Ping every 15 s — [yellowstone-grpc README](https://github.com/rpcpool/yellowstone-grpc)
- Self-hosted servers must set `replay_stored_slots > 0` for replay. On some shared providers the buffer is ~100 slots (about a minute) — (search summary)
- TypeScript client: `@triton-one/yellowstone-grpc`. Triton cites a NAPI upgrade with "4x throughput" — [Triton guide](https://blog.triton.one/complete-guide-to-solana-streaming-and-yellowstone-grpc/). Helius says the old Yellowstone JS client "maxes out at 30 MB/s" against 1.3 GB/s for its own SDK — [laserstream-sdk](https://github.com/helius-labs/laserstream-sdk)
- Triton's other products:
  - Whirligig: a WebSocket proxy that translates gRPC into Solana JSON-RPC WS for frontends.
  - Fumarole: persistent, deduplicated, cursor-tracked streams — [Triton guide](https://blog.triton.one/complete-guide-to-solana-streaming-and-yellowstone-grpc/). Fumarole has a "server-side cursor, 4-day retention, at-least-once" — [RPC Fast](https://rpcfast.com/blog/best-solana-grpc-providers)
  - Old Faithful: historical replay — [Triton guide](https://blog.triton.one/complete-guide-to-solana-streaming-and-yellowstone-grpc/)

**Helius LaserStream**
- "Wire-compatible with the open Yellowstone gRPC protocol". Streams transactions, slots, blocks and accounts at processed, confirmed or finalized commitment.
- Mainnet requires the Business or Professional plan.
- Add-ons: compressed filters ("hundreds of thousands of accounts"), `tokenAccounts` expansion and `matchMints`. LaserStream Plus offers 5–100 TB+ allowances.
- Source: [LaserStream docs](https://www.helius.dev/docs/laserstream)
- **The replay window is reported inconsistently:**
  - The docs say "up to 48 hours (~691,200 slots)". That slot count only works at 250 ms slots; 48 h at 400 ms is ~432,000 — [LaserStream docs](https://www.helius.dev/docs/laserstream)
  - The SDK README says "Backfill missed data up to 3000 slots (~20 minutes)" — [laserstream-sdk](https://github.com/helius-labs/laserstream-sdk)
  - Third parties say 24 h — [RPC Fast](https://rpcfast.com/blog/best-solana-grpc-providers); [NoLimitNodes](https://nolimitnodes.com/blog/yellowstone-grpc-providers-compared)
- SDK: `npm install helius-laserstream`. Usage is `subscribe({apiKey, endpoint}, request, onData, onError)`. Reconnects automatically and replays from the last processed slot. Zstd compression gives "70-80% bandwidth reduction" — [laserstream-sdk](https://github.com/helius-labs/laserstream-sdk)

**Helius plans (current, from 7 Apr 2026)**

| Plan | Price | Credits/mo | RPC req/s | DAS req/s | Mainnet LaserStream gRPC | Enhanced WSS (`transactionSubscribe`) |
|---|---|---|---|---|---|---|
| Free | $0 | 1M | 10 | 2 | — | — |
| Developer | $49 | 10M | 50 | 10 | devnet only | yes |
| Business | $499 | 100M | 200 | 50 | yes (up to 10 conns) | yes |
| Professional | $999 | 200M | 500 | 100 | yes (up to 100 conns) | yes |

Sources: [Helius plans](https://www.helius.dev/docs/billing/plans); [Helius blog, 31 Mar 2026](https://www.helius.dev/blog/laserstream-websockets)
- All streaming (gRPC and WSS) is metered at 20 credits/MB ("2 credits per 0.1 MB" uncompressed). Opening a WSS connection costs 1 credit — [Helius enhanced websockets docs](https://www.helius.dev/docs/enhanced-websockets); [Helius blog](https://www.helius.dev/blog/laserstream-websockets)
- Data add-ons (Professional only): 5 TB $400, 10 TB $750, 25 TB $1,750, 50 TB $3,250, 100 TB $6,000 — [Helius plans](https://www.helius.dev/docs/billing/plans)
- Limits: 1,000 subscriptions per WSS connection on all plans — [Helius blog](https://www.helius.dev/blog/laserstream-websockets)

**WebSockets**
- Standard `logsSubscribe` filters: `all`, `allWithVotes`, `mentions`. "The `mentions` filter currently supports exactly one address." Each notification carries only `signature`, `err` and `logs` — [solana.com logsSubscribe](https://solana.com/docs/rpc/websocket/logssubscribe)
- Chainstack's pump.fun detector:
  - Matches `"Program log: Instruction: Create"` and then base64-decodes the following `Program data:` line into name/symbol/uri/mint/bondingCurve/user.
  - Logs "do not contain the associated bonding curve address", so it has to be derived.
  - `blockSubscribe` was unreliable on high-traffic programs (errors 1006/1009, skipped data).
  - Source: [Chainstack docs](https://docs.chainstack.com/docs/solana-listening-to-pumpfun-token-mint-using-only-logssubscribe)
- Helius Enhanced WSS:
  - Endpoint: `wss://mainnet.helius-rpc.com/?api-key=<KEY>`.
  - `transactionSubscribe` filters: `accountInclude`, `accountExclude`, `accountRequired`, `vote`, `failed`, `signature`. Options: `commitment`, `encoding`, `transactionDetails`, `showRewards`, `maxSupportedTransactionVersion`.
  - "10-minute inactivity timer"; send a ping at least once a minute.
  - Source: [Helius enhanced websockets](https://www.helius.dev/docs/enhanced-websockets)

**Other Yellowstone gRPC providers (2026 pricing)**

| Provider | Price | Streams / limits | Replay | Notes | Source |
|---|---|---|---|---|---|
| Chainstack | $49 / $149 / $449 per mo | 2 / 7 / 25 concurrent streams; unlimited events; up to 200 accounts per filter; requires Growth plan or higher | `from_slot`, ~100-slot ring buffer | Article says "Geyser + Jito ShredStream by default" (dated 11 Aug 2026, so possibly stale after 5 Sep) | [Chainstack](https://chainstack.com/yellowstone-grpc-more-streams-same-price/) (search summary); [RPC Fast](https://rpcfast.com/blog/best-solana-grpc-providers) |
| Solana Vibe Station | Basic $150/mo ($15/day, $40/week); Ultra $200; Elite $250 | 5 / 10 / 15 connections (search summary) | n/a | Day passes are useful for testing | [SVS purchasing](https://docs.solanavibestation.com/introduction/purchasing) |
| Shyft | Build $199, Grow $349, Accelerate $649 per mo | 10 / 20 / 50 gRPC connections; +$100 per 10 connections; no bandwidth metering | backfill up to 150 slots | RabbitStream included; 7 regions; dedicated nodes from $1,800 | [Shyft pricing](https://shyft.to/solana-rpc-grpc-pricing); [RPC Fast](https://rpcfast.com/blog/best-solana-grpc-providers) |
| Solana Tracker | €200/mo standalone | 25 concurrent connections (EU + US) | n/a | Free with their RPC Business+ | [Solana Tracker pricing](https://docs.solanatracker.io/pricing) |
| QuickNode | included in Scale ($499) and Business ($999) since 1 Jun 2026; $499 add-on on lower plans | Scale: 10 streams × 10 accounts each; Business: 25 × 50 | ~100 slots | "metered in bytes" | [QuickNode blog](https://blog.quicknode.com/solana-grpc-is-now-included-with-scale-and-business-plans/) (search summary); [NoLimitNodes](https://nolimitnodes.com/blog/yellowstone-grpc-providers-compared) |
| Triton (Dragon's Mouth) | usage-based: streaming $0.08/GB; $125 prepaid; dedicated nodes ~$2,900/mo | — | ~1,000 slots (~7 min); Fumarole keeps 4 days | Deshred in paid beta | [Triton guide](https://blog.triton.one/complete-guide-to-solana-streaming-and-yellowstone-grpc/); [Triton pricing post](https://blog.triton.one/the-end-of-the-black-box-why-rpc-pricing-needs-radical-transparency-2/) (search summary); [NoLimitNodes](https://nolimitnodes.com/blog/yellowstone-grpc-providers-compared) |
| Alchemy | $0.08/GB (per Triton's comparison) | — | ~48 h (~432,000 slots) | | [Alchemy replay docs](https://www.alchemy.com/docs/reference/yellowstone-grpc-historical-replay); [Triton guide](https://blog.triton.one/complete-guide-to-solana-streaming-and-yellowstone-grpc/) |
| NOWNodes | free tier; Pro from €20/mo | — | window not published | | [RPC Fast](https://rpcfast.com/blog/best-solana-grpc-providers) |
| Subglow | "$99/mo flat. No credits" | — | — | Taken from the page title only | [Subglow](https://subglow.io/) (search summary) |
| NoLimitNodes | n/a | — | plugin-level | Ships *decoded* streams: "37 programs, 1,074 event types" | [NoLimitNodes](https://nolimitnodes.com/blog/yellowstone-grpc-providers-compared) |

**PumpPortal (pump.fun-focused WebSocket)**
- Endpoint: `wss://pumpportal.fun/api/data?api-key=...`
- Free methods: `subscribeNewToken` and `subscribeMigration`. Metered: `subscribeTokenTrade` and `subscribeAccountTrade` at "0.01 SOL per 10000 events". Unsubscribe methods also exist. Payload shape: `{"method":"subscribeTokenTrade","keys":["<mint>"]}`.
- Requires an API key plus a linked wallet funded with at least 0.02 SOL.
- "ONLY USE ONE WEBSOCKET CONNECTION AT A TIME". Clients that open many connections get timed out, and "Bans expire every hour".
- Covers Pump.fun, PumpSwap and LetsBonk.fun.
- Source: [PumpPortal real-time API](https://pumpportal.fun/data-api/real-time)

**Third-party data APIs (stream-capable)**
- **Bitquery**: GraphQL subscriptions such as `DEXTrades` with `ProtocolName: "pump"`, `Instructions` filtered to `create`/`create_v2`, `TokenSupplyUpdates`, and `DEXPools` for bonding progress. gRPC and Kafka delivery are mentioned. Latency and pricing are listed on a separate product page that was not retrieved — [Bitquery Pump.fun API](https://docs.bitquery.io/docs/blockchain/Solana/Pumpfun/Pump-Fun-API/)
- **Solana Tracker Datastream**:
  - WebSocket rooms include a latest-tokens room (metadata, socials, creator, pool, liquidity, market cap) and `price:aggregated:{token}`. "20+ room types" — (search summary of [docs](https://docs.solanatracker.io/datastream/websockets/latesttokens))
  - The WebSocket needs the Premium plan (€397/mo) or higher. It is "Unlimited on Premium+ (no per-message fees)" — [Solana Tracker pricing](https://docs.solanatracker.io/pricing)
- **Mobula Pulse Stream V2**:
  - Preset views `new`, `bonding`, `bonded`. Messages: `init` snapshot, periodic `sync` (~30 s) and `update-token` deltas. Payload includes bonding %, holder counts, top-holder percentages, socials and security flags.
  - Limits: max 10 views per connection, 100 tokens per view, 1,000 tokens total. Growth or Enterprise plan only.
  - The endpoint is listed as `wss://api.mobula.io` in the docs — [Mobula docs](https://docs.mobula.io/indexing-stream/stream/websocket/pulse-stream-v2). A search summary instead gave `wss://pulse-v2-api.mobula.io`, so the two conflict.
- **Codex `onLaunchpadTokenEvent`**:
  - Event types: `Deployed, Created, Updated, Completed, Migrated, UnconfirmedDeployed, UnconfirmedMetadata, UnconfirmedCompleted`. "Only migrated events are actively emitted via subscriptions" for graduations.
  - Fields include holders, volume and buy/sell counts, plus sniper, bundler and insider counts and held-percentages.
  - Protocol enum includes `Pump` and `PumpMayhem`. Streams from creation until 6 h after migration.
  - "Requires a Growth or Enterprise plan"; a flat-rate option exists.
  - Source: [Codex docs](https://docs.codex.io/api-reference/subscriptions/onlaunchpadtokenevent)
- **Birdeye**: WebSocket subscriptions include `SUBSCRIBE_TOKEN_NEW_LISTING`. WebSocket access on Premium ($199/mo, 500 connections) and Business ($499/mo, 2,000 connections) — (search summary; the pricing page returned 403)
- **Small pump.fun WS vendors**: pumpdev.io (`wss://pumpdev.io/ws`, "no API key", free) and Anaxer ("sub-450ms from chain confirmation"). Vendor claims only — (search summary: [pumpdev](https://pumpdev.io/), [Anaxer](https://anaxer.com/pumpfun-websocket))

### Inferences
- **Practical latency tiers for this build:**
  - (a) Raw shreds via DoubleZero Edge, roughly 10–40 ms ahead of former ShredStream at p50/p95. Requires bare-metal-style networking (GRE/PIM) and your own deshredder.
  - (b) Managed deshredded pre-execution streams, a few ms behind (a). No meta.
  - (c) Processed-commitment gRPC with full meta from a shred-accelerated, well-located node. Expect on the order of 100+ ms behind shreds, based on RPC Fast's 120 ms average gain from adding shreds.
  - (d) LaserStream-backed or standard websockets. Hundreds of ms behind gRPC on account updates (215 vs 374 ms p90).
  - (e) Third-party indexed APIs (PumpPortal, Mobula, Codex, Birdeye, Bitquery). Each adds its own indexing hop. No independent measurements were found.
- **Shred streams have no fill data.** They give instruction arguments, such as a buy's max SOL cost, not actual amounts. Use them for *earliest create/buy signals* and mark those UI rows "unconfirmed". Reconcile against the processed gRPC transaction (with meta) a few hundred ms later.
- **Cost per TB on Helius: ~$98–100.** 20 credits/MB means 1 TB = 20M credits; at Developer pricing ($49 per 10M credits) that is ~$98. In capacity terms, Developer's 10M credits ≈ 500 GB/month of WSS streaming (~16 GB/day) and Business ≈ 5 TB/month.
- **Flat-rate gRPC beats Helius for a firehose.** Assume (unverified) 5–15M launchpad/PumpSwap transactions per day at 2–4 KB each with full meta. That is ~10–60 GB/day, beyond the Developer allowance; it fits Business ($499) but costs more than an unmetered flat-rate gRPC ($49–$199). Helius makes sense when you also need DAS, webhooks or replay.
- **PumpPortal fits only part of the job.** Use its free create/migration streams as a phase-1 discovery feed or cross-check. Paid trade subscriptions (0.01 SOL per 10k events) only make sense per focused token. A firehose of several million trades a day would cost several SOL per day.
- **Example Yellowstone subscription for the main feed** (TS client field names are camelCase):
  ```ts
  { transactions: { lp: { vote:false, failed:false,
      accountInclude:[PUMP, PUMP_AMM, LAUNCHLAB, METEORA_DBC, MOONIT, BOOP, RAY_V4, RAY_CPMM, RAY_CLMM, DLMM, DAMM_V2, WHIRLPOOL],
      accountExclude:[], accountRequired:[] } },
    slots: { s: { filterByCommitment:false } },   // receive every SlotStatus incl. SLOT_DEAD
    blocksMeta: { m: {} },                        // block_time per slot
    accounts:{}, blocks:{}, transactionsStatus:{}, entry:{}, accountsDataSlice:[],
    commitment: CommitmentLevel.PROCESSED,
    fromSlot: lastSlotSeen ? String(lastSlotSeen) : undefined }
  ```
  Ping every ~15–30 s. Persist `lastSlotSeen` and resubscribe with `fromSlot` after a disconnect. Dedupe replayed transactions by signature.
- Check whether "accounts per filter/stream" caps (QuickNode Scale: 10 per stream) count program IDs listed in `account_include`. If they do, a 12-program include list would need to be split across streams on that provider.

### Gaps
- No independent, methodology-transparent 2026 benchmark covers all providers. Most numbers are vendor-published. The Shreder vs LaserStream page could not be fetched (TLS error).
- Birdeye and Bitquery current pricing and latency could not be retrieved. Chainstack Growth plan price was not captured. Solana Vibe Station connection limits come from a search summary.
- Whether Chainstack and others still advertise "Jito ShredStream" acceleration after the sunset, and what replaced it, is unconfirmed.
- Bun compatibility of the NAPI-based Yellowstone and LaserStream JS clients was not verified. Test before committing; a small Rust or Node sidecar is the fallback.
- Whether Alpenglow consensus is active by Oct 2026, which would change confirmed/finalized timing semantics, was not researched.

---

## 2. Event detection and transaction parsing across launchpads and DEXes (pump.fun, PumpSwap, LaunchLab, Meteora DBC, Moonshot, Boop, Raydium/Meteora/Orca); most robust approach; open-source parsers

### Takeaway
Every major launchpad program here (pump.fun, PumpSwap, Raydium LaunchLab, Meteora DBC) emits **Anchor self-CPI events**. The 8-byte tag `e445a52e51cb9a1d` sits in inner-instruction data, followed by an 8-byte event discriminator and a Borsh payload. These events carry post-trade reserves and exact amounts. The most robust parser keys on program ID plus CPI-event discriminator in `meta.innerInstructions`, falls back to top-level instruction decoding, and uses pre/post token-balance diffs only for long-tail AMMs. Log parsing is the least reliable option (logs can be truncated, carry no account keys, and `mentions` takes a single address). Pump.fun's 2026 program adds `create_v2` (Token-2022), `buy_exact_sol_in`, `buy_v2`/`sell_v2`/`buy_exact_quote_in_v2`, `migrate_v2` and quote-mint fields. Parsers written for 2024 layouts will silently miss events.

### Cited Findings

**Program IDs**
- Pump.fun bonding curve: `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`
- PumpSwap AMM: `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`
- Pump fee program: `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ`
- Pump PDAs: `global` = `4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf`; `bonding_curve` seeds `["bonding-curve", mint]`; `event_authority` seeds `["__event_authority"]`
- Source for the pump.fun items: [Solana Tracker pump.fun guide](https://docs.solanatracker.io/guides/pumpfun-program)
- Raydium LaunchLab: `LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj` — [Carbon raydium-launchpad-decoder lib.rs](https://raw.githubusercontent.com/sevenlabs-hq/carbon/main/decoders/raydium-launchpad-decoder/src/lib.rs)
- Meteora DBC: `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` (same on mainnet and devnet) — [MeteoraAg/dynamic-bonding-curve](https://github.com/MeteoraAg/dynamic-bonding-curve)
- From the solana-dex-parser constants file — [programId.ts](https://github.com/cxcx-ai/solana-dex-parser/blob/main/src/constants/programId.ts):
  - Moonit/Moonshot: `MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG`
  - Boop: `boop8hVGQGqehUK2iVEMEnMrL5RbjywRzHKBmBE7ry4`
  - Heaven: `HEAVENoP2qxoeuF8Dj2oT1GHEnu49U5mJYkdeC8BAX2o`
  - Sugar: `deus4Bvftd5QKcEkE5muQaWGWDoma8GrySvPFrBPjhS`
  - Raydium AMM v4: `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8`
  - Raydium CPMM: `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C`
  - Raydium CLMM: `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK`
  - Orca Whirlpool: `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc`
  - Meteora DLMM: `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`
  - Meteora DAMM v1: `Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB`
  - Meteora DAMM v2: `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`
  - Jupiter v6: `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`

**pump.fun: instructions and events (2026 state)**
- Instruction discriminators: `buy` `0x66063d1201daebea`, `sell` `0x33e685a4017f83ad`, `create` `0x181ec828051c0777`, `create_v2` `0xd6904cec5f8b31b4`, `buy_exact_sol_in` `0x38fc74089edfcd5f`, `migrate` `0x9beae792ec9ea21e`. "On mainnet, many curve swaps use `buy_exact_sol_in` rather than classic `buy`. Parsers should handle both." — [Solana Tracker guide](https://docs.solanatracker.io/guides/pumpfun-program)
- Carbon's current pumpfun decoder lists instructions including `buy_v2`, `sell_v2`, `buy_exact_quote_in_v2`, `migrate_v2`, `add_quote_mint`, `remove_quote_mint`, `set_virtual_quote_reserves`, `toggle_create_v2`, `toggle_mayhem_mode`, `set_mayhem_virtual_params`, `claim_cashback`, `toggle_cashback_enabled`, `update_buyback_config` and `extend_account` — [Carbon pumpfun-decoder/instructions](https://github.com/sevenlabs-hq/carbon/tree/main/decoders/pumpfun-decoder/src/instructions)
- CPI events (23) include `CreateEvent`, `TradeEvent`, `CompleteEvent`, `CompletePumpAmmMigrationEvent`, `SetParamsEvent`, `CollectCreatorFeeEvent`, `UpdateMayhemVirtualParamsEvent` and `ClaimCashbackEvent`. The CPI tag is `[228,69,165,46,81,203,154,29]` at offset 0–7 — [Carbon pumpfun cpi_event.rs](https://raw.githubusercontent.com/sevenlabs-hq/carbon/main/decoders/pumpfun-decoder/src/instructions/cpi_event.rs)
- `TradeEvent` (discriminator `[189,219,127,211,78,230,97,238]`) fields, in order — [Carbon trade_event.rs](https://raw.githubusercontent.com/sevenlabs-hq/carbon/main/decoders/pumpfun-decoder/src/events/trade_event.rs):
  - core: `mint`, `sol_amount`, `token_amount`, `is_buy`, `user`, `timestamp (i64)`
  - reserves: `virtual_sol_reserves`, `virtual_token_reserves`, `real_sol_reserves`, `real_token_reserves`
  - fees: `fee_recipient`, `fee_basis_points`, `fee`, `creator`, `creator_fee_basis_points`, `creator_fee`
  - volume tracking: `track_volume`, `total_unclaimed_tokens`, `total_claimed_tokens`, `current_sol_volume`, `last_update_timestamp`
  - variants: `ix_name (String)`, `mayhem_mode`, `cashback_fee_basis_points`, `cashback`, `buyback_fee_basis_points`, `buyback_fee`, `shareholders (Vec<Shareholder>)`
  - quote mint: `quote_mint`, `quote_amount`, `virtual_quote_reserves`, `real_quote_reserves`
- `CreateEvent` (discriminator `[27,114,169,77,222,235,99,118]`) fields: `name`, `symbol`, `uri`, `mint`, `bonding_curve`, `user`, `creator`, `timestamp`, `virtual_token_reserves`, `virtual_sol_reserves`, `real_token_reserves`, `token_total_supply`, `token_program`, `is_mayhem_mode`, `is_cashback_enabled`, `quote_mint`, `virtual_quote_reserves` — [Carbon create_event.rs](https://raw.githubusercontent.com/sevenlabs-hq/carbon/main/decoders/pumpfun-decoder/src/events/create_event.rs)
- `create_v2` "uses the Token2022 program instead of the legacy Metaplex standard". The associated bonding curve account is owned by Token-2022, and user ATAs must be derived to match. Mayhem Mode tokens launch with 2B supply, and an AI agent trades them for the first 24 h (article dated 26 Nov 2025) — [Chainstack](https://chainstack.com/trading-bot-update-full-mayhem-mode-support-for-pump-fun/)

**PumpSwap**
- Instructions include `create_pool`, `buy`, `buy_exact_quote_in`, `sell`, `deposit`, `withdraw` and `migrate_pool_coin_creator` — [Carbon pump-swap-decoder/instructions](https://github.com/sevenlabs-hq/carbon/tree/main/decoders/pump-swap-decoder/src/instructions)
- Events include `CreatePoolEvent`, `BuyEvent`, `SellEvent`, `DepositEvent`, `WithdrawEvent` and `UpdateFeeConfigEvent`, with the same CPI tag — [Carbon pump-swap cpi_event.rs](https://raw.githubusercontent.com/sevenlabs-hq/carbon/main/decoders/pump-swap-decoder/src/instructions/cpi_event.rs)
- `BuyEvent` (discriminator `[103,244,82,31,44,245,119,119]`) includes `timestamp`, `base_amount_out`, `quote_amount_in`, `pool_base_token_reserves`, `pool_quote_token_reserves`, `lp_fee`, `protocol_fee`, `pool`, `user`, `coin_creator`, `coin_creator_fee`, `ix_name` and `cashback` — [Carbon buy_event.rs](https://raw.githubusercontent.com/sevenlabs-hq/carbon/main/decoders/pump-swap-decoder/src/events/buy_event.rs)

**Other launchpads**
- **Raydium LaunchLab**:
  - Instructions: `initialize`, `initialize_v2`, `initialize_with_token2022`, `buy_exact_in`, `buy_exact_out`, `sell_exact_in`, `sell_exact_out`, `migrate_to_amm`, `migrate_to_cpswap` — [Carbon raydium-launchpad-decoder/instructions](https://github.com/sevenlabs-hq/carbon/tree/main/decoders/raydium-launchpad-decoder/src/instructions)
  - Events: `TradeEvent`, `PoolCreateEvent`, `ClaimVestedEvent`, `CreateVestingEvent` — [cpi_event.rs](https://raw.githubusercontent.com/sevenlabs-hq/carbon/main/decoders/raydium-launchpad-decoder/src/instructions/cpi_event.rs)
  - `TradeEvent` fields: `pool_state`, `total_base_sell`, `virtual_base`, `virtual_quote`, `real_base_before`, `real_quote_before`, `real_base_after`, `real_quote_after`, `amount_in`, `amount_out`, `protocol_fee`, `platform_fee`, `creator_fee`, `share_fee`, `trade_direction`, `pool_status`, `exact_in` — [trade_event.rs](https://raw.githubusercontent.com/sevenlabs-hq/carbon/main/decoders/raydium-launchpad-decoder/src/events/trade_event.rs)
  - solana-streamer tags LaunchLab events "with StonkFun attribution" — [solana-streamer](https://github.com/0xfnzero/solana-streamer). StonkFun briefly out-earned pump.fun with $1,508,195 of revenue on 6 Sep 2026 — (search summary, [CoinDCX](https://coindcx.com/blog/crypto-news-global/solana-launchpad-stonkfun-out-earned-pump-fun-for-a-day/))
- **Meteora DBC**:
  - Instructions: `initialize_virtual_pool_with_spl_token`, `initialize_virtual_pool_with_token2022`, `swap`, `swap2`, `migrate_meteora_damm`, `migration_damm_v2` — [Carbon meteora-dbc-decoder/instructions](https://github.com/sevenlabs-hq/carbon/tree/main/decoders/meteora-dbc-decoder/src/instructions)
  - Events include `EvtInitializePool`, `EvtSwap`, `EvtSwap2`, `EvtCurveComplete` and `EvtCreateMeteoraMigrationMetadata` — [cpi_event.rs](https://raw.githubusercontent.com/sevenlabs-hq/carbon/main/decoders/meteora-dbc-decoder/src/instructions/cpi_event.rs)
  - Graduation happens when the virtual pool's quote reserve reaches the configured "migration quote threshold". DAMM v1 is deprecated for new configs, so new pools go to DAMM v2. `token_type` 0 = SPL Token, 1 = Token-2022 — [MeteoraAg/dynamic-bonding-curve](https://github.com/MeteoraAg/dynamic-bonding-curve)
  - Meteora's migrator service performs the migration — (search summary of [Meteora docs](https://docs.meteora.ag/core-products/dbc/migration-and-liquidity))

**Parsing mechanics**
- Anchor's `emit!` writes base64 `Program data:` logs. `emit_cpi!` writes the event into self-CPI instruction data. `emit_cpi!` was introduced because program logs "can sometimes be truncated by data providers". "Event data emitted through CPIs cannot be directly subscribed to"; you read it from `innerInstructions` and decode it with `program.coder.events.decode()` — [Anchor docs](https://www.anchor-lang.com/docs/features/events)
- Transaction meta structure — [solana.com JSON structures](https://solana.com/docs/rpc/json-structures):
  - `innerInstructions[{index, instructions[{programIdIndex, accounts, data (base58 in JSON), stackHeight}]}]`
  - `pre/postTokenBalances[{accountIndex, mint, owner, programId, uiTokenAmount{amount, decimals, uiAmountString}}]`
  - `loadedAddresses{writable, readonly}`, `logMessages`, `pre/postBalances`, `computeUnitsConsumed`

**Open-source parsers and frameworks (currency as of Oct 2026)**
- **Carbon** (sevenlabs-hq), Rust:
  - Pipeline: datasources → decoders → processors. `carbon-cli parse` generates decoders from Anchor or Codama IDLs; the CLI is published on npm as `@sevenlabs-hq/carbon-cli` — [Carbon](https://github.com/sevenlabs-hq/carbon)
  - Decoders include `pumpfun`, `pump-swap`, `pump-fees`, `raydium-launchpad`, `meteora-dbc`, `meteora-damm-v2`, `meteora-dlmm`, `meteora-pools`, `moonshot`, `boop`, `heaven`, `orca-whirlpool`, `raydium-amm-v4`, `raydium-cpmm`, `raydium-clmm`, `jupiter-swap`, `okx-dex`, `vertigo`, `wavebreak`, `token-2022` and `mpl-token-metadata` — [decoders dir](https://github.com/sevenlabs-hq/carbon/tree/main/decoders)
  - Datasources include `yellowstone-grpc`, `helius-laserstream`, `helius-atlas-ws`, `jito-shredstream-grpc`, `rpc-block-subscribe`, `rpc-program-subscribe`, `rpc-transaction-crawler`, `jetstreamer` and `validator-snapshot` — [datasources dir](https://github.com/sevenlabs-hq/carbon/tree/main/datasources)
  - The pumpfun decoder already includes the 2026 instructions (`buy_v2`, `migrate_v2`, quote-mint fields), so it is current.
- **solana-dex-parser** (cxcx-ai), TypeScript:
  - Covers PumpSwap, Raydium V4/CPMM/CL, Orca, Meteora DLMM/Pools/DAMM V2, Pumpfun, Raydium Launchpad, Meteora DBC, Moonit, Heaven, Sugar, Bonk, BoopFun, Jupiter and OKX.
  - Outputs trades, liquidity events, transfers and `memeEvents` (create/buy/sell/migrate/complete). "Most swap records are parsed from transfer actions except for Jupiter, Pumpfun, and Moonit."
  - Accepts `getTransaction`/`getParsedTransaction`/`getBlock` shapes. API: `new DexParser().parseAll(tx)`.
  - Source: [solana-dex-parser](https://github.com/cxcx-ai/solana-dex-parser)
- **solana-streamer** v3.0.6 (on sol-parser-sdk 0.7.7), Rust:
  - Sources: Yellowstone gRPC, Jito ShredStream, RPC.
  - Protocols: PumpFun, PumpSwap, LaunchLab, Raydium CPMM/CLMM/AMM V4, Meteora DAMM v2/DLMM/DBC/Pools, Orca.
  - On ShredStream, "ALT-loaded accounts are parsed best-effort with default account placeholders".
  - Source: [solana-streamer](https://github.com/0xfnzero/solana-streamer)
- **Yellowstone Vixen**: the `rpcpool/yellowstone-vixen` URL now presents as "Shipstern", a Rust pipeline framework. Sources: Dragon's Mouth, Fumarole, RPC, snapshots, Jetstreamer. It serves parsed events over gRPC and generates parsers from Codama IDLs. The built-in parsers cover Token/Token-2022/stake etc., **not** launchpads — [repo](https://github.com/rpcpool/yellowstone-vixen)

### Inferences
- **Recommended parser pipeline (TypeScript):**
  1. Rebuild the full account-key list: static keys, then `loadedAddresses.writable`, then `loadedAddresses.readonly`.
  2. Walk `meta.innerInstructions` and match `programId ∈ WATCHED` with `data[0..8] == e4 45 a5 2e 51 cb 9a 1d`.
  3. Dispatch on `data[8..16]`. Examples: pump `TradeEvent` = `bddb7fd34ee661ee`, `CreateEvent` = `1b72a94ddeeb6376`; PumpSwap `BuyEvent` = `67f4521f2cf57777`.
  4. Borsh-decode `data[16..]`.
  - Decode the known leading fields and tolerate trailing bytes. The pump `TradeEvent` has grown many fields over time (quote-mint, cashback, buyback, shareholders) and contains variable-length `String` and `Vec` fields, so fixed-offset readers break.
  - In gRPC, instruction data is raw bytes; in JSON-RPC it is base58.
- **Event-to-detection mapping:**
  - New token: pump `CreateEvent` (both `create` and `create_v2`), LaunchLab `PoolCreateEvent`, DBC `EvtInitializePool`, and the Moonshot/Boop create instructions.
  - Trade: pump `TradeEvent`, PumpSwap `BuyEvent`/`SellEvent`, LaunchLab `TradeEvent`, DBC `EvtSwap`/`EvtSwap2`.
  - Curve complete: pump `CompleteEvent`, DBC `EvtCurveComplete`; LaunchLab via `pool_status` in `TradeEvent`.
  - Migration: pump `CompletePumpAmmMigrationEvent` (plus `migrate`/`migrate_v2` instructions) followed by a PumpSwap `CreatePoolEvent`; LaunchLab `migrate_to_amm`/`migrate_to_cpswap`; DBC `migrate_meteora_damm`/`migration_damm_v2`.
- **Long-tail DEXes:** use Carbon or solana-dex-parser logic, or fall back to a generic swap detector. Diff `pre/postTokenBalances` for the signer's owner across the two mints, cross-checked against vault balance changes. This is robust to unknown programs but cannot attribute trades to a pool or venue reliably.
- **Logs are a last resort only.** Use them for the `logsSubscribe` phase-0 path or if inner instructions are unavailable. They have no account keys, can be truncated, and `mentions` takes one address.
- **Language choice:** if you stay all-TypeScript, use solana-dex-parser as a reference and fixture source and hand-write decoders for the roughly 10 hot programs. If you accept a Rust sidecar, Carbon gives the broadest, currently maintained decoder set plus gRPC/LaserStream/shredstream datasources. It could emit normalized events to the Bun process over a Unix socket.
- **Shred-stream instructions need extra care.** Pre-execution transactions with ALTs need lookup-table resolution (RabbitStream does this server-side). Instruction arguments such as `create_v2` name/symbol/uri and buy amounts can be decoded from top-level instructions, but no events or reserves exist yet.

### Gaps
- Moonshot and Boop event layouts and current 2026 activity levels were not verified. Carbon has decoders for both, but their status is unknown.
- How StonkFun and other new 2026 launchpads such as Pons are implemented on-chain (own program vs LaunchLab/DBC configs) was not verified beyond the solana-streamer note.
- Field-level layouts for PumpSwap `SellEvent`/`CreatePoolEvent`, DBC `EvtSwap2`/`EvtCurveComplete` and pump `CompleteEvent` were not fetched. Read the Carbon `events/` files or the IDLs when implementing.
- Whether PumpSwap `BuyEvent.pool_*_reserves` are pre-trade or post-trade values is not stated in the source. Verify empirically.

---

## 3. Derived market data (SOL/USD, price, market cap, volume, OHLCV, holders, bonding progress, metadata, socials)

### Takeaway
Compute almost everything from parsed events. Pump.fun `TradeEvent` and LaunchLab `TradeEvent` carry post-trade virtual and real reserves. Pump.fun `CreateEvent` carries initial reserves, total supply, token program and mayhem/quote-mint flags. Price, market cap and bonding progress are therefore pure functions of the latest event, with no RPC calls. You still need:
- an external SOL/USD (or quote-mint) price: Pyth Hermes (now API-key gated), Pyth Pro, or a CEX websocket;
- incremental holder tracking from `pre/postTokenBalances`, with periodic reconciliation via getProgramAccounts or DAS;
- a cached, multi-gateway metadata fetcher.

### Cited Findings
- **Pyth Hermes:** "Hermes now requires an API Key", sent as an `Authorization: Bearer` header, at endpoint `https://pyth.dourolabs.app/hermes`. The SSE stream is `/v2/updates/price/stream?ids[]=...` and "will automatically close after 24 hours". TS client: `HermesClient(...).getStreamingPriceUpdates()` — [Pyth docs](https://docs.pyth.network/price-feeds/core/fetch-price-updates). SOL/USD feed id: `0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d` — (search summary)
- **Pyth Pro** (formerly Lazer): subscription service. Channels: `real-time` (1–50 ms), `fixed_rate@1ms`, `@50ms`, `@200ms`, `@1000ms`, delivered over websocket with an API key — (search summary of [Pyth Pro docs](https://docs.pyth.network/price-feeds/pro))
- **Binance spot streams:** `wss://stream.binance.com:9443` with `{symbol}@trade`, `{symbol}@aggTrade`, `{symbol}@bookTicker` — [Binance docs](https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams)
- **Bonding progress (pump.fun, Bitquery's formula):** "Bonding curve progress = 100 - (((base_balance - 206900000) × 100) / 793100000)", where `base_balance` is the curve's token balance — [Bitquery](https://docs.bitquery.io/docs/blockchain/Solana/Pumpfun/Pump-Fun-API/)
- **Reserve inputs:**
  - Pump `CreateEvent` gives initial `virtual_token_reserves`, `virtual_sol_reserves`, `real_token_reserves`, `token_total_supply`, `token_program`, `is_mayhem_mode`, `quote_mint`, `virtual_quote_reserves` — [Carbon create_event.rs](https://raw.githubusercontent.com/sevenlabs-hq/carbon/main/decoders/pumpfun-decoder/src/events/create_event.rs)
  - Each pump `TradeEvent` gives post-trade virtual/real SOL and token reserves plus `quote_*` reserves and `timestamp` — [Carbon trade_event.rs](https://raw.githubusercontent.com/sevenlabs-hq/carbon/main/decoders/pumpfun-decoder/src/events/trade_event.rs)
  - Mayhem tokens have 2B supply instead of 1B — [Chainstack](https://chainstack.com/trading-bot-update-full-mayhem-mode-support-for-pump-fun/)
  - LaunchLab `TradeEvent` gives `virtual_base`, `virtual_quote` and real before/after values — [Carbon](https://raw.githubusercontent.com/sevenlabs-hq/carbon/main/decoders/raydium-launchpad-decoder/src/events/trade_event.rs)
  - PumpSwap `BuyEvent` gives `pool_base_token_reserves` and `pool_quote_token_reserves` — [Carbon](https://raw.githubusercontent.com/sevenlabs-hq/carbon/main/decoders/pump-swap-decoder/src/events/buy_event.rs)
- **Timing inputs:**
  - Yellowstone transaction updates carry `index` (position in block) but no block time. `blocks_meta` subscriptions provide per-slot metadata. `SLOT_DEAD` flags abandoned forks — [geyser.proto](https://github.com/rpcpool/yellowstone-grpc/blob/master/yellowstone-grpc-proto/proto/geyser.proto)
  - Replay requires dedupe because it "starts at a slot boundary" — [Triton docs](https://docs.triton.one/project-yellowstone/dragons-mouth-grpc-subscriptions)
- **Holder data sources:**
  - `getTokenLargestAccounts` returns "the 20 largest token accounts for an SPL Token mint" (address, amount, decimals); default commitment is finalized — [solana.com](https://solana.com/docs/rpc/http/gettokenlargestaccounts)
  - SPL Token holder enumeration via `getProgramAccounts` with `dataSize: 165` plus `memcmp {offset: 0, bytes: mint}` — (search summary of [Helius gPA guide](https://www.helius.dev/docs/rpc/guides/getprogramaccounts))
  - Helius DAS `getTokenAccounts({mint, limit, cursor, options:{showZeroBalance}})` returns `total`, `token_accounts[{address, mint, owner, amount, frozen, burnt}]` and `last_indexed_slot`. Pagination is cursor-based; the docs' example uses `limit` 100 — [Helius DAS](https://www.helius.dev/docs/api-reference/das/gettokenaccounts). DAS rate limits: 2/10/50/100 req/s by plan — [Helius plans](https://www.helius.dev/docs/billing/plans)
  - Transaction meta token balances include `owner`, `mint`, `programId` and raw `amount` — [solana.com JSON structures](https://solana.com/docs/rpc/json-structures)
  - Yellowstone account filters support `owner` + memcmp + `token_account_state` for streaming token-account changes — [geyser.proto](https://github.com/rpcpool/yellowstone-grpc/blob/master/yellowstone-grpc-proto/proto/geyser.proto)
- **Metadata sources:**
  - Pump `CreateEvent` includes `name`, `symbol`, `uri` — [Carbon](https://raw.githubusercontent.com/sevenlabs-hq/carbon/main/decoders/pumpfun-decoder/src/events/create_event.rs)
  - Token-2022 `TokenMetadata` stores "the token's `name`, `symbol`, `uri`, `update_authority`, and custom metadata on the mint account itself". `MetadataPointer` points to the metadata account. Read with `getTokenMetadata()` or by parsing the mint's TLV extensions — [solana.com guide](https://solana.com/developers/guides/token-extensions/metadata-pointer)
  - Metaplex Fungible JSON standard fields: `name`, `symbol`, `description`, `image` — [Metaplex token standard](https://metaplex.com/docs/smart-contracts/token-metadata/token-standard)
  - Helius `getAsset` returns `content.json_uri`, `content.files[].cdn_uri` (images proxied via `https://cdn.helius-rpc.com/cdn-cgi/image//`), `links.image`, and `token_info` (supply, decimals, token_program, authorities, `price_info` for the top 10k tokens) — [Helius getAsset](https://www.helius.dev/docs/api-reference/das/getasset)
  - Cloudflare's `cloudflare-ipfs.com`/`cf-ipfs.com` gateways redirected to ipfs.io/dweb.link and stopped serving IPFS on 14 Aug 2024 — [Cloudflare blog](https://blog.cloudflare.com/cloudflares-public-ipfs-gateways-and-supporting-interplanetary-shipyard/)
- **Social links:** vendor payloads expose twitter/website/telegram (Mobula) and social links in latest-token payloads (Solana Tracker) — [Mobula](https://docs.mobula.io/indexing-stream/stream/websocket/pulse-stream-v2); [Solana Tracker](https://docs.solanatracker.io/datastream/websockets/latesttokens) (search summary)
- **Risk metrics:** Codex streams sniper/bundler/insider counts and held-percentages per launchpad token — [Codex](https://docs.codex.io/api-reference/subscriptions/onlaunchpadtokenevent)

### Inferences
- **Price (quote per token).** On bonding curves: `price = virtual_quote_reserves / virtual_token_reserves × 10^(tokenDecimals − quoteDecimals)`. For SOL-quoted pump curves, `virtual_sol_reserves` is the quote reserve. Get decimals from the mint or from `uiTokenAmount.decimals`.
  - On AMMs: `price = pool_quote_reserves / pool_base_reserves` (decimal-adjusted).
  - `priceUsd = price × quoteUsd`, with quoteUsd from Pyth/CEX for SOL and 1.0 for USDC.
  - **Do not assume SOL as quote.** Pump events now carry `quote_mint` and `quote_*` fields.
- **Market cap** = `priceUsd × token_total_supply` (from `CreateEvent`; 2B for mayhem tokens). Most terminals show FDV-style market cap for memecoins. Don't hardcode 1B.
- **Bonding progress.** Pump: `progress = 1 − real_token_reserves_now / real_token_reserves_initial`, with the initial value taken from `CreateEvent`. This equals Bitquery's 793.1M/206.9M formula for standard tokens but also handles mayhem and quote-mint variants.
  - LaunchLab: `real_quote_after` / the pool's quote fundraising target. The target comes from the pool or config, so it needs one account read per pool.
  - DBC: quote reserve / migration quote threshold, from the pool config.
- **Volume.** Sum the quote amount (`sol_amount` or `quote_amount`, or `amount_in`/`amount_out` by direction) per trade into per-token minute buckets. Keep a ring buffer of 1,440 one-minute buckets per active token for O(1) 5m/1h/6h/24h windows. Also track buy/sell counts, unique traders (HyperLogLog or a Set per window), and dev/sniper flags.
- **OHLCV.**
  - Ordering key: `(slot, txIndex, innerIxIndex)`, from Yellowstone `index` plus the inner instruction position.
  - Bucket by event `timestamp` (pump) or `blocks_meta` block time.
  - Keep per-token open candles in memory for 1s/15s/1m/5m and derive larger timeframes by rollup.
  - On a late or out-of-order event, update the bucket in place (OHLC needs first/last by ordering key, not arrival order). Emit a correction delta for that bucket.
  - On `SLOT_DEAD`, drop that slot's trades and recompute touched buckets. Persist a candle only once its slot range is confirmed.
- **Holders (layered):**
  1. *Incremental:* for every parsed transaction touching a mint, apply `postTokenBalances` per (mint, owner) into `Map<mint, Map<owner, amount>>`. Exclude curve, pool and vault owners. Holders = count(amount > 0); top-10% comes from the same map.
  2. *Drift:* plain wallet-to-wallet SPL transfers don't touch launchpad programs, so a program-filtered stream won't see them. For watched tokens, add a Yellowstone accounts subscription (owner = Token/Token-2022 program, memcmp offset 0 = mint), or reconcile every N minutes.
  3. *Bootstrap:* for tokens first seen mid-life, use `getProgramAccounts` (SPL Token: dataSize 165 + memcmp 0; Token-2022 accounts carry extensions and vary in size, so use memcmp only) or DAS `getTokenAccounts` paginated by mint.
  4. `getTokenLargestAccounts` is only good for a quick top-20.
- **Metadata pipeline.**
  - On create, take name/symbol/uri straight from the event; there is no RPC round-trip for pump.
  - For non-pump tokens, read Token-2022 TLV metadata or the Metaplex metadata PDA.
  - Fetch the JSON with a gateway-rewrite layer: normalize `ipfs://`, `/ipfs/<cid>`, `ar://` and Arweave URLs, and race 2–3 gateways (e.g., ipfs.io and dweb.link plus a paid or dedicated gateway) with ~1.5–3 s timeouts.
  - Cache JSON by CID forever, since it is content-addressed. Cache images resized (e.g., 64/128 px WebP) locally. Mark failures for retry with backoff. Helius `cdn_uri` is a paid fallback.
  - Never block token display on metadata; push a `meta` delta when it lands.
- **Social links.** Parse JSON fields (`twitter`, `telegram`, `website` are the de-facto pump.fun keys, unverified), any `extensions` object, and regex x.com/twitter.com/t.me/discord URLs in `description`. Normalize handles and flag reused socials across tokens (a common scam signal).

### Gaps
- The SOL/USD feed id and the Pyth Pro channels come from search summaries. The Pyth Solana push-feed (on-chain) account address for SOL/USD could not be retrieved; it would let you read SOL/USD via the same gRPC account stream.
- Hermes rate limits, API-key pricing, and whether the old public `hermes.pyth.network` endpoint still works keylessly were not determined.
- pump.fun's off-chain metadata JSON schema (exact social keys) and current URI host/gateway were not verified from a primary source.
- The LaunchLab fundraising-target field and the DBC config field names for progress were not fetched.

---

## 4. Throughput in 2026, resulting storage volume, and storage engine choice (SQLite vs DuckDB / Postgres+Timescale / ClickHouse; hot vs cold design)

### Takeaway
Token creation runs at tens of thousands per day: pump.fun ~34–42k/day, plus a few thousand on other launchpads. Trade counts are in the millions per day across pump.fun curves and PumpSwap, on a chain doing ~170–190M non-vote transactions per day. A single-user terminal that keeps hot state in memory and persists compact trades for a rolling window, plus candles and token rows long-term, writes ~100–2,000 rows/s. SQLite in WAL mode with batched transactions handles that easily. ClickHouse, DuckDB or Parquet only become necessary if you keep the full trade firehose for months for analytics.

### Cited Findings
- **Pump.fun launch counts:**
  - ~42,000 tokens in one day ("nearly one token every two seconds"). Graduation rate "roughly 1.4%" (Dune). 11.9M total launches (article dated 10 Jun 2026) — [Solana Compass](https://solanacompass.com/news/pumpfun-launched-42000-tokens-in-one-day-fewer-than-2-will-ever-reach-a-dex)
  - Pump.fun accounted for "as much as 83% of all tokens minted across the Solana network" on peak days — [Solana Compass](https://solanacompass.com/news/pumpfun-launched-42000-tokens-in-one-day-fewer-than-2-will-ever-reach-a-dex)
- **Network-wide token creation:** on 9 Sep 2026 Solana saw "over 263,000 new tokens in a single day", which includes non-meme assets such as tokenized equities — [Cryptonomist, 10 Sep 2026](https://en.cryptonomist.ch/2026/09/10/solana-token-launches-record/)
  - A search summary attributes to Blockworks "40,360 tokens issued via launchpads, with Pump.fun accounting for 34,184" that day. The fetched KuCoin page did not contain this breakdown. **Unverified** — [KuCoin flash](https://www.kucoin.com/news/flash/solana-hits-263-000-new-token-launches-in-one-day-expanding-beyond-meme-coins)
- **Chain throughput:** Solana processed 5.2B non-vote transactions in August 2026, and the 7-day average hit 191M/day in late August. SIMD-0286 (29 Jul 2026) raised the block compute limit from 60M to 100M CU — [Solana Compass](https://solanacompass.com/news/solana-processes-52-billion-non-vote-transactions-in-august-surpassing-all-other-l1s-and-l2s-combined)
  - Non-vote TPS ~1,600–3,800 in mid-2026 — (search summary)
- **PumpSwap trade counts:** record of "over 6.1 million" swaps on 12 Apr 2025 and 5.7M on 14 Apr 2025. **This is 2025 data** — [Cointelegraph, 15 Apr 2025](https://cointelegraph.com/news/pump-fun-s-pump-swap-dex-processed-2-46-b-of-trades-last-week-up-45)
  - 2026 PumpSwap volume claims ($2.03B daily ATH on 6 Jan 2026; "$15B in September" leading Solana DEXs) — (search summary, unverified)
- **Launchpad market share:** pump.fun held 64.2% of launchpad revenue from mid-Aug to early Sep 2026, against StonkFun's 7.58% — (search summary). Pump.fun took ~$2.4M in fees on one day in Aug 2026, its highest since Sep 2025 — (search summary, [CryptoRank](https://cryptorank.io/news/feed/c26ab-pump-fun-daily-fee-revenue-august-2026))
- **bun:sqlite:** "roughly 3-6x faster than `better-sqlite3`" for reads. "We recommend enabling WAL mode" via `db.run("PRAGMA journal_mode = WAL;")`. `db.transaction(fn)` supports `.immediate()`. `db.query()` caches compiled statements (20 most recent by default). `safeIntegers: true` returns `bigint`, which suits u64 lamports — [Bun docs](https://bun.sh/docs/api/sqlite)
- **SQLite vs Postgres benchmark** (Apple M2 Pro; WAL, `synchronous=NORMAL`, 64 MB cache, 256 MB mmap; single-row, non-batched):
  - Sequential inserts: SQLite 23,403 ops/s vs Postgres 7,740.
  - Mixed 80/20: 96,051 vs 11,824.
  - Postgres reaches 35,370 ops/s with 16 connections.
  - Source: [andrecasal benchmark](https://github.com/andrecasal/sqlite-vs-postgres-benchmark)
- **Batching effect:** wrapping inserts in one transaction moves SQLite from ~85 to ~50,000 inserts/s; transaction + WAL + prepared statements reached 200k+ rows/s — (search summary, [secondary blog](https://www.macsqlclient.com/blog/50-how-to-improve-sqlite-insert-performance))

### Inferences
- **Load model (assumptions, label as estimates):**
  - Creations: ~40–50k/day across launchpads, about 0.5/s average with bursts of several per second.
  - Trades: assume 5–20M/day across pump.fun curve + PumpSwap + LaunchLab/DBC. This is anchored on PumpSwap's 6.1M/day 2025 record and 2026 chain growth (non-vote transactions +117% YoY). That is ~60–230 trades/s average with peaks of 1–2k/s.
  - Your filtered gRPC stream will be roughly this transaction rate (plus failed transactions if not filtered).
- **Storage volume:**
  - A compact trade row is ~100–130 bytes: integer token id, integer trader id, slot, tx index, timestamp, side, quote amount, token amount, price, 8-byte signature prefix or full 64-byte signature. With indexes that becomes ~250–350 bytes.
  - At 5–20M trades/day this is **~1.5–7 GB/day** if you keep everything.
  - Keep full trades for 24–72 h for all tokens (rolling deletes in small batches, or day-partitioned tables/files that are dropped whole), keep watched/held tokens indefinitely, and keep candles (1m+) and token rows long-term.
  - Candles: ~50k new tokens/day × a few hundred 1m candles each for the short-lived majority. Small.
- **SQLite design (single writer):**
  - One Bun writer task drains an in-memory queue every 100–250 ms into `BEGIN IMMEDIATE` … prepared inserts … `COMMIT`.
  - PRAGMAs: `journal_mode=WAL`, `synchronous=NORMAL`, larger `cache_size`, `mmap_size`, `temp_store=MEMORY`, and periodic `wal_checkpoint(TRUNCATE)` during quiet periods.
  - Readers (API and backfill queries) use separate connections. Integer surrogate keys for mints and wallets keep rows small.
  - At ≤2k rows/s this is far below SQLite's batched capacity.
- **Hot vs cold:**
  - In memory: token state (reserves, price, market cap, progress, volume ring buffers, holder maps for active tokens), open candles, per-token recent-trade ring buffers (e.g., last 500), the "new/final stretch/migrated" lists, and the SOL/USD price.
  - On disk: the token registry and metadata cache, compact trades for the window, closed candles, migrations, and user wallets/positions.
  - Evict tokens that are inactive for more than N hours from memory. Rebuild hot state on restart from SQLite plus `from_slot` replay.
- **When to move off SQLite.** Choose DuckDB when you want ad-hoc analytics over months of trades: append Parquet day-files and query them with DuckDB, keeping SQLite for OLTP. Choose ClickHouse or Timescale if you ever store the full firehose long-term or serve multiple users. Postgres+Timescale adds operational weight with no benefit for one user.

### Gaps
- No primary 2026 source was found for daily trade counts on pump.fun curves, PumpSwap, LaunchLab or DBC. Blockworks and Dune dashboards weren't machine-readable via fetch. The trade-rate model above is an assumption to validate in week one by counting stream messages.
- Daily launch counts for non-pump launchpads (LaunchLab/Bonk, DBC-based apps, StonkFun, Moonshot, Boop) in 2026 were not verified.
- No Bun-specific batched-insert benchmark was found.

---

## 5. Backend → frontend streaming patterns (fan-out, deltas, per-view subscriptions, throttling/coalescing, binary encoding)

### Takeaway
The commercial and API products examined follow a **snapshot + delta** model with per-view or per-room subscriptions: Mobula's `init`/`sync`/`update-token`, Solana Tracker rooms such as `price:aggregated:{token}`, Codex's unconfirmed→confirmed event types. Bun's built-in uWebSockets pub/sub (topic subscribe/publish, backpressure signals, optional permessage-deflate) covers this natively for a single-user app. Coalesce list views to a few frames per second, stream the focused token's trades near real time, and version every entity so late corrections (forks, out-of-order events) are cheap.

### Cited Findings
- **Bun WebSocket server:**
  - Pub/sub API: `ws.subscribe(topic)`, `ws.publish(topic, msg)` (excludes the sender), `server.publish(topic, msg)`, `ws.unsubscribe`.
  - Backpressure: `ws.send` returns `-1` (enqueued under backpressure), `0` (dropped) or bytes sent. Options: `backpressureLimit` (default 16 MB), `closeOnBackpressureLimit`, and a `drain` handler.
  - Compression: `perMessageDeflate` with shared or dedicated compressors.
  - Defaults: `idleTimeout` 120 s, `maxPayloadLength` 16 MB.
  - Binary sends (ArrayBuffer/TypedArray) are supported. Built on uWebSockets; ~700k msg/s vs ~100k for Node `ws` in an old Bun v0.2.1 benchmark.
  - Source: [Bun docs](https://bun.sh/docs/api/websockets)
- **Mobula Pulse V2:** `init` full snapshot, `sync` periodic authoritative refresh (~30 s), `update-token` deltas. Caps of 10 views per connection and 100 tokens per view — [Mobula](https://docs.mobula.io/indexing-stream/stream/websocket/pulse-stream-v2)
- **Codex:** emits `Unconfirmed*` events before confirmation and then confirmed events (`Deployed`, `Created`, `Migrated`, …) — [Codex](https://docs.codex.io/api-reference/subscriptions/onlaunchpadtokenevent)
- **Solana Tracker Datastream:** topic-style rooms (e.g., `price:aggregated:{token}`, a latest-tokens room) — (search summary, [docs](https://docs.solanatracker.io/datastream/websockets/latesttokens))
- **Triton Whirligig:** translates gRPC streams into Solana JSON-RPC WebSocket messages for frontends — [Triton guide](https://blog.triton.one/complete-guide-to-solana-streaming-and-yellowstone-grpc/)
- **Axiom:** third-party SDKs show it uses multiple websocket "cluster" hosts (fallback to cluster3/5/7) and a `subscribe_new_tokens`-style API. Internals are not publicly documented — (search summary of [AxiomTradeAPI](https://pypi.org/project/axiomtradeapi/))

### Inferences
- **Topic layout** (one WebSocket, many topics):
  - `lists:new`, `lists:stretch`, `lists:migrated` — Pulse-style columns
  - `tok:{mint}` — header stats
  - `trades:{mint}` — trade tape
  - `candles:{mint}:{tf}`
  - `holders:{mint}`
  - `wallet:{addr}` — the user's positions and fills
  - `sol` — SOL/USD price
  - The client sends `{op:"sub", topic}` / `{op:"unsub"}` as views mount and unmount; the server calls `ws.subscribe`.
- **Snapshot + delta with sequence numbers.** On subscribe, send a snapshot (e.g., the top 50–100 tokens per column, last 200 trades, last 300 candles) tagged `seq`. Then send deltas `{t, id, seq, fields…}`. The client drops stale `seq` values and requests a resync on a gap. Send a periodic `sync` (every 15–30 s) for list views to self-heal.
- **Coalescing:**
  - List columns: accumulate per-token field changes in a `Map<mint, partial>` and flush at 4–10 Hz.
  - Candles: flush the current bar at ≤10 Hz.
  - Trade tape for the focused token: flush every 50–100 ms in micro-batches (an array per frame).
  - SOL/USD: ≤4 Hz.
  - This caps frontend React work regardless of chain bursts.
- **Fork and out-of-order handling in the UI:** send `candle:upsert` for a corrected bucket and `trade:remove` for trades in dead slots. Mark rows from shred/pre-execution sources `unconfirmed` until the gRPC-with-meta copy arrives (Codex-style).
- **Encoding:**
  - JSON is fine on localhost.
  - For remote access, enable `perMessageDeflate` or switch to MessagePack or a small custom binary frame for trade batches and candles (e.g., Float64Array/Int32Array columns).
  - Use integer token ids per session (a dictionary message maps id→mint) to shrink payloads.
  - Respect backpressure: if `send` returns `-1`, skip non-critical list flushes for that socket until `drain`.
- **Single user** means fan-out is trivial. The real cost is serialization and React re-renders, so do coalescing server-side and keep a normalized store client-side (e.g., an external store with per-token selectors).

### Gaps
- No primary documentation was found for how Axiom, Photon, GMGN or BullX structure their websocket protocols. All observations are indirect.
- No measured comparison of MessagePack vs JSON+deflate payload sizes for this data shape was found.

---

## Implications for the build

**Phase 1 (cheap, ~$49–$200/mo)**
- **Primary feed:** one flat-rate Yellowstone gRPC subscription. Candidates:
  - Chainstack $49 (2 streams, unlimited events, ≤200 accounts per filter)
  - Solana Vibe Station $150 (or $15 day passes for testing)
  - Shyft $199 (unmetered, and includes RabbitStream for phase 2)
- **Subscription settings:** `transactions` with `account_include` = launchpad + AMM program IDs, `vote=false`, `failed=false`, `commitment=PROCESSED`, plus `slots` (to receive `SLOT_DEAD`/confirmed) and `blocks_meta`. Persist the last slot and resume with `from_slot` (buffers are short, ~100–150 slots, so accept gaps after long outages).
- **Discovery cross-check:** PumpPortal free `subscribeNewToken` + `subscribeMigration` over one connection.
- **SOL/USD:** Pyth Hermes SSE (API key; reconnect every 24 h) with a CEX websocket as fallback.
- **Metadata and holder bootstrap:** a free or low-tier RPC for `getProgramAccounts`/`getTokenLargestAccounts`, or Helius Developer ($49) for DAS `getAsset`/`getTokenAccounts` plus image CDN.

**Phase 2 (fast)**
- **Pre-execution layer:** Shyft RabbitStream (in the $199 plan), Triton Deshred (paid beta), or Helius preprocessed transactions (Business $499+). Run these alongside the gRPC-with-meta feed for earliest create/buy signals, labeled "unconfirmed".
- **Raw shreds:** for the lowest possible latency, DoubleZero Edge raw shreds ($450–$1,500/mo per IP) plus your own deshredder (or OrbitFlare's) on a bare-metal box in Frankfurt/Amsterdam/NY.
- **Jito ShredStream is gone** (sunset 5 Sep 2026). Do not design around `shredstream-proxy`.

**Parser**
- A TypeScript event-first decoder: rebuild account keys including ALTs, then match inner instructions on `program ∈ watched` and tag `e445a52e51cb9a1d`, dispatch on discriminator, and Borsh-decode with tolerant trailing bytes.
- Cover pump (`create`/`create_v2`, `buy`/`buy_exact_sol_in`/`buy_v2`/`buy_exact_quote_in_v2`, `sell`/`sell_v2`, `migrate`/`migrate_v2`, and Create/Trade/Complete/CompletePumpAmmMigration events), PumpSwap (CreatePool/Buy/Sell), LaunchLab (PoolCreate/Trade, `migrate_to_amm`/`migrate_to_cpswap`) and DBC (EvtInitializePool/EvtSwap/EvtSwap2/EvtCurveComplete, migrations).
- Long-tail DEXes: Carbon or solana-dex-parser logic, or a token-balance-diff fallback.
- Treat Carbon (Rust sidecar) as the option if TS decoding becomes the bottleneck or decoder upkeep becomes a burden.
- Handle the quote-mint generalization in pump events from day one.

**Storage**
- `bun:sqlite` in WAL mode, `synchronous=NORMAL`, with a single writer batching every 100–250 ms.
- Hot state in memory: token state, candles, ring buffers, holder maps.
- Keep compact trades for a 24–72 h window, plus watched/held tokens indefinitely. Keep candles and tokens long-term.
- Prune in small batches or by day-partition. Add Parquet + DuckDB only if long-horizon analytics are wanted.

**Streaming**
- One Bun WebSocket with topic pub/sub per view and snapshot + seq-numbered deltas.
- Coalesce lists at 4–10 Hz and focused-token trades every 50–100 ms; send periodic `sync` frames.
- Send correction messages for dead slots and late events, and track an unconfirmed→confirmed state per row.
- JSON on localhost; permessage-deflate or MessagePack when remote. Back off on `send() === -1`.
