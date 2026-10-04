# Notes: measured latencies and what changed them

Newest first. Record the setup (RPC, region, mode) with every measurement.

## 2026-10-03: Jupiter hops are not checked by Jupiter (mainnet simulation)

`bun run packages/core/scripts/jupiter-hop-redirect.ts <wallet> <mint> <other holder>` builds a real `/build` route, then points only the hop's output account at another holder's token account. `user_destination_token_account` stays the wallet's ATA. Both versions are simulated (public RPC, unsigned, never sent).

| Route | As built | Hop output redirected |
|---|---|---|
| `route_v2`, 0.01 SOL -> 6Vsnb… via Meteora DAMM v2 (run twice) | wallet's ATA credited 10,268,118,068 | **succeeds**: wallet's ATA unchanged (0), other holder credited 10,268,118,068 |
| `shared_accounts_route_v2`, 0.01 SOL -> BONK via 1DEX > TesseraV | wallet's ATA credited | fails, Jupiter 6021 `InvalidOutputTokenAccount` |

So a `route_v2` hop decides where the output goes (and which user account the input comes from, with the user's signature), and checking the route's own user accounts proves nothing. The signer now pins the hop's user side for single `route_v2` hops through reviewed venues (Meteora DBC, Meteora DAMM v2, Orca Whirlpool). It accepts shared-accounts routes only if no hop names the user. Core re-quotes anything else over the reviewed venues.

## 2026-10-03: Jupiter `/build` long-tail fallback dry runs (public RPC, keyless Jupiter, laptop)

Setup: `https://api.mainnet-beta.solana.com`, keyless `https://api.jup.ag/swap/v2/build` (0.5 requests/s), `DRY_RUN=true`, unsigned simulation (`SIMULATE_AS`, read-only wallets that hold SOL or the token), `SLIPPAGE_BPS=1500`. Two tools:
- `bun run trade`: `LANDING_MODE=standard`, CU limit sized by a pre-simulation.
- `packages/core/scripts/jupiter-live-check.ts`: the same build through the shipped signer firewall, fed the lookup tables as they are on chain, in all three landing modes.

Slots ~453,130,650–453,133,400. None of these tokens has a pump curve, canonical PumpSwap pool or LaunchLab pair, so core resolved each to the Jupiter fallback.

| Run (standard mode) | Route | CU used / limit | Size | Accounts | Fill vs quote |
|---|---|---|---|---|---|
| Buy 0.01 SOL of 6Vsnb… (SPL, Meteora DAMM v2), wallet already holds it | `route_v2`, 1 hop | 42,348 / 50,818 | 731 B | 13 static + 6 from 1 table | exact; the ATA was credited exactly the quote |
| Sell 50% of the same | `route_v2` | 34,092 / 40,911 | 699 B | 13 + 6 from 1 table | exact |
| Sell 100% (+ close the token account) | `route_v2` | 34,210 / 41,052 | 706 B | 13 + 6 from 1 table | exact |
| Buy 0.01 SOL of 3XhUN… (Meteora Dynamic Bonding Curve, SPL), fresh ATA | `route_v2` | 56,462 / 67,755 | 916 B | 20 static, no table | exact |
| Sell a holder's balance of the DBC coin | `route_v2` | 50,067 / 60,081 | 891 B | 20 static, no table | simulated OK |
| Buy 0.01 SOL of 4Vn9m… (Token-2022, DAMM v2), fresh ATA | `route_v2` | 48,716 / 58,460 | 856 B | 17 + 3 from 1 table | exact |
| Buy 0.01 SOL of BONK (split Invariant 9% / BisonFi 91%, then TesseraV), re-quoted at `maxAccounts=48` | `shared_accounts_route_v2` | 247,218 / 296,662 | 1,074 B | 20 + 18 from 3 tables | +0.001% (state moved) |
| Sell 0.01% of a BONK holding (TesseraV > BisonFi) | `shared_accounts_route_v2` | 144,623 / 186,802 | 983 B | 2 tables | simulated OK |

Firewall: every one of these, in every landing mode, passed `createSignerPolicy` with Jupiter's quote as the expectation (the 6Vsnb… buy and full sell, the DBC buy and sell, and the BONK buy and sell went through the live check). Turbo is 49 B smaller than standard (one Sender tip instead of two tips). Protected is 16 B smaller (one Jito tip plus the jitodontfront marker).

What these numbers mean:

- Single-hop long-tail routes are small. The DBC route uses no lookup table at all. Multi-hop routes need the tables: the captured two-hop BONK sell is 1,392 B without them and 995 B with them. Keeping the firewall's static keys out of the tables (user side, mints, token programs, tips, every System/Token/ATA account) costs 60–120 B over unrestricted compression.
- One BONK buy quote came back at 1,243 B once our two tips were added. `buildTrade` now checks each route against the largest budget-and-tip layout of any mode. If it doesn't fit, it drops the no-op creation of an ATA that already exists, then re-quotes with `maxAccounts` 48, 32, 24 (Jupiter's documented remedy). Later BONK buys needed 48 or 24, and the quote records which. Each re-quote is another `/build` call; keyless callers hit 429s, which the client retries after `Retry-After`.
- CU varies too much for a static limit: 34–57k for long-tail single hops, 145–250k for multi-hop BONK routes. The CLI sizes the limit with an unsigned simulation at 1.4M CU (limit = simulated × 1.2). The shipped firewall cap is 400k, so a route needing more than ~333k simulated CU would be refused.
- Latency (one run each): `stateLoaded` 570–790 ms (one batch plus the quote mint). `quoted` +300–550 ms: the `/build` call from a laptop, keyless. `built` +255–280 ms, including the CU-sizing simulation. In the browser, state is streamed, but the `/build` round trip and the sizing simulation remain, which is why Jupiter is only the fallback.
- A DAMM v2 route loads about 5.3 MB of account data (the Jupiter and DAMM programs), well inside the 64 MB default.
- Jupiter's `otherAmountThreshold` rounds the minimum up. The firewall reports floor(quoted out × (1 − slippage)), one base unit lower and never above what Jupiter enforces.
- Found on the way: BONK's would-be pump curve PDA holds 1.12 SOL as a System account. Venue resolution read it as a complete curve ("migration pending?"). Venue PDAs now count only when their program owns them.

## 2026-10-03: wallet tracker matcher and copy-trade detection (Bun 1.3.14, Apple M3 laptop)

**Offline benchmark** (`bun run --cwd apps/server tracker-bench`, synthetic flat-string addresses, clean process). The full match path is index lookup, balance / first-buy detection, rows for owners with an open socket, the alert hook and the feed flush.

| Index | Build | Heap per address | Lookups | Full match path |
|---|---|---|---|---|
| 100k addresses, 120k watchers (1,000 users x 100, plus 500 popular wallets x 40 users), 2% of trades tracked | 40-70 ms | ~480 B | 6-11M/s | 4.2-6.6M trades/s |
| 100k addresses, 10 users x 10,000, 5% tracked | ~30 ms | ~365 B | ~11M/s | ~5.7M trades/s |

Matching costs about 0.2 ms per thousand trades, three orders of magnitude inside the 2,000 trades/s target; the feed's real load is JSON frames to online owners, batched every 100 ms (`TRACKER_FLUSH_MS`).

**Live check on public RPC** (`RpcLogsSource`, `wss://api.mainnet-beta.solana.com`, processed, about 150 trades/s decoded): `bun run --cwd apps/server tracker-live` signed in with a throwaway key, tracked the three busiest traders of 12 hot tapes (sampled for 25 s) and copied the busiest, a bot trading about 9 times a second.

| Metric | Value |
|---|---|
| Tracked rows on the `tracked` topic in 180 s | 1,625 (1,618 from the bot, 7 from another wallet) |
| Detection (server receive - event block time, 1 s clock) | p50 1,280 ms, p90 3,760 ms |
| Server receive -> client delivery (100 ms flush) | p50 53 ms, p90 95 ms, max 151 ms |
| Copy decisions | 197 buy signals (189 revoked because the bot sold before any fill, 7 expired, 1 pending), 589 skipped (588 drift guard, 1 curve complete) |

What these numbers mean:

- Matching is not the bottleneck; detection is. On public RPC the median trade reaches the server about 1.3 s after its (floored) block time, so a fast leader's tokens have often moved 15-45% past the leader's fill before a copy could be built. The 10% default drift guard skips those, which is what it is for. A Yellowstone feed should cut detection and make more copies viable.
- Leaders who flip within seconds produce mostly revoked buys (their sell arrives while the copy is pending). Followers of such wallets would need `onlyFirstBuy`, a leader-size minimum, or the browser acting within the 15 s signal TTL.
- Market state reported market caps of 0.1-1 SOL for some live pump tokens (impossible on a SOL-quoted curve); worth a look in the market layer, since copy MC filters read the same summary.
## 2026-10-03: armed orders against real pump.fun and PumpSwap code (mainnet fork)

Setup: `bun run fork:start` + `bun run e2e` (`packages/core/e2e/armed.e2e.ts`). Local Agave 4.3.0 running mainnet's binaries on cloned state; four forks, two coin sets, mainnet slots 453,103,463–453,108,071. One vault-held trading wallet signed everything through `SignerService` with the shipped policy (68 transactions per run, none refused). Ten nonce slots and one operator table. Orders were fired by `evaluateTrigger` on fork state and landed through `SubmitRouter` + `RpcLane`. All 9 cases passed, alongside the 10 trade cases.

| Armed transaction (lowest tip level) | CU used / limit | Size with table (without) | Fee + tip (lamports) |
|---|---|---|---|
| Curve full-exit sell (TP, OCO, ladder fill) | 72,720–77,811 / 115,000 | 928 B (1,204 B) | 16,500 + 10,000 |
| Curve buy (3-variant limit buy, cancelled) | not landed | 964 B (1,240 B) | n/a |
| PumpSwap full-exit sell (SL) | 87,268–97,700 / 135,000 | 910 B (1,155 B) | 18,500 + 10,000 |
| Migration snipe (PumpSwap buy, fresh pool) | 133,754–145,515 / 175,000 | 971 B (1,247 B) | 22,500 + 10,000 |
| Landed failure: slippage (6003) / account closed (3012) | 57,660–59,221 / 13,116 | 928 B | 16,500, tip reverted |
| Cancel | 300 / 2,000 | 282 B | 5,000 |
| Nonce slots (4 per tx) | 1,500 / 16,000 | 1,028 B | 6,600 + 1,447,680 rent per slot (fork rate) |

What these numbers mean:

- One landed attempt per nonce holds with the real programs. A ladder's first attempt landed after the price ran past its min-out: `sell_v2` failed with 6003, the nonce advanced, and it cost 16,500 lamports (base + priority) with the tip reverted. The next nonce filled. A third attempt sent after the fill failed with 3012 (account closed), again base + priority only. Variants on a used nonce are refused at preflight ("Blockhash not found") and, sent blind, dropped without a fee.
- Sizes match the offline matrix to the byte, and both buy shapes overflow 1,232 B without the table. Worst CU headroom is the snipe's 17% (holder-rewards coin), under the 1.3× `DEFAULT_CU_LIMITS` targets.
- Leaders only see new table entries once their extension is finalized. Sent about 12 slots after the extension, the first armed transaction landed 30 slots late (rebroadcasts); after waiting for finalization (about 17 s here), it landed in the next slot. Every other armed transaction landed in the next slot (0.4–0.55 s of local slot timing, not a network figure).
- `migrate` is permissionless (343,804–356,619 CU). It creates a 287-byte canonical pool that trades without `extend_account`, and parks 17.58 SOL of the curve's quote in the pool's boost vault, booked as virtual quote reserves. `estimateMigrationPoolReserves` used to double-count that boost (20% too high an opening price); fixed, the snipe fired at exactly its arming quote.
- The first buy on a fresh pool pays rent for the coin-creator vault's wSOL ATA (2,039,280 lamports at the fork's rate). Snipe reservations should include it.
- Details ("Armed-order findings"): [docs/dev/FORK_TESTING.md](docs/dev/FORK_TESTING.md).

## 2026-10-03: PumpPortal mismatches classified; ingest stall and reconnect storms fixed (public RPC, laptop)

Setup: as in the Phase 2 entry below (`bun apps/server/src/main.ts`, public RPC `logsSubscribe` at processed, PumpPortal free stream, `DRY_RUN=true`, Apple M3 laptop). Run 1: 14 min, before the fixes. Run 2: 16 min, with the eviction fix. Run 3: 15 min, all fixes plus enrichment, one WebSocket client on the three Pulse columns that focused a Final Stretch token after a minute. The reconciler now finalizes a mismatch only after its 30 s window plus a 5 min grace period, so the last ~5.5 min of each run stay unclassified. Every final mismatch was then classified from chain data (`getTransaction` with `maxSupportedTransactionVersion: 1`, `getSignatureStatuses`), and 60 finalized creates that PumpPortal did report (run 2) served as a control sample.

| Seen by | Class | Run 2 | Run 3 | Control (60 matched) |
|---|---|---|---|---|
| us only | create + `CreateFeeSharingConfig` (pump fees program) in the same tx | 43 | 33 | 0 |
| us only | v1-format transaction (SIMD-0385); run 2: 18 `CreateV2` + 1 `MigrateV2` (a 20th, non-SOL, is in the quote row) | 19 | 10 | 0 |
| us only | created through a third-party launcher (`6Vo3245…`, CPI into `CreateV2`) | 13 | 2 | 0 |
| us only | curve quoted in a token other than SOL (USDC, `98kfF7…`, `A7bdiY…` …) | 8 | 9 | 3 (all `XsoCS1…`) |
| us only | plain v0 SOL create, no distinguishing trait | 0 | 1 | n/a |
| PumpPortal only | pump create / migration while our socket was down or degraded | 33 | 60 | n/a |
| PumpPortal only | LetsBonk (LaunchLab) create, venue tag `bonk` | 7 | 1 | n/a |

Totals: run 2 matched 551 (late 0), 83 us-only, 40 PumpPortal-only; run 3 matched 513, 55 and 61.

What these numbers mean:

- Every "us only" event is a successful, finalized transaction at the slot we reported: no forks, no failed transactions. The Phase 2 "42 seen only by us" were PumpPortal coverage gaps: its free stream drops creates that set up fee sharing, v1 transactions, that launcher's CPI creates and most non-SOL quotes. Nothing to fix on our side.
- Every "PumpPortal only" pump event happened while our socket was down or about to drop: run 2 lost 3 sockets (35.7 s down; 29 of 33 events within 3 s of an outage, 4 within 6 s), run 3 lost 2 (93.6 s; 45 of 60 within 3 s, the rest within 30 s, while the endpoint was already delivering notifications 15-20 s late before it dropped the socket). `logsSubscribe` has no replay; Yellowstone resumes from a slot. The LetsBonk launches are LaunchLab pools: core decodes LaunchLab now, but both ingest sources still subscribe to pump and PumpSwap only, and the reconciler matches pump events only.
- v1 transactions (SIMD-0385) were ~3% of pump creates in run 2. `getTransaction` refuses them unless asked for `maxSupportedTransactionVersion: 1`; `packages/core/scripts/fork/accounts.ts` and `packages/core/e2e/harness.ts` still ask for 0. Our decoders read logs or the Yellowstone message, which carries V1 messages in the same fields.

Our bugs, found and fixed:

- **Ingest stalled ~5-10 min into every RPC-logs run.** `BoundedSet` / `LruMap` evicted with `values().next()` / `keys().next()`, which in JavaScriptCore walks past every earlier deletion until the table rehashes. The dedupe set (200k) fills after ~5 min at ~670 adds/s; from then on each add got slower: 200k adds took 0.3 s, then 37.7 s, then 132 s. In run 1, trades stopped at ~610 s, the queue filled to 50,000 and the event loop went silent for minutes. Now O(1) (ring / linked list): the queue peaked at 275 in run 2 and 16 in run 3.
- **Reconnect storms.** A refused WebSocket upgrade reset the backoff (it looked at the last successful connection), so we retried every 250-500 ms and the public RPC kept answering 429: 68 reconnects in run 2. The backoff now grows unless the socket opened and stayed up a minute (run 3: 0.26, 0.6, 1.6, 3.9, 4.9, 9.6, 27 s).
- **Reconciler accounting.** It swept only on `/api/health`, counted a late counterpart as a miss on each side, and re-opened entries for fork re-deliveries. Now: 5 s sweep timer, late matches, repeats, and a record per mismatch (signature, slot, quote mint, mayhem, token program, venue tag, other feed connected).

Run 2 detection latency, after the fixes: p50 1,159 ms, p90 1,555 ms, p99 1,767 ms (Phase 2: 1,050 / 1,455 / 1,615). Run 3's percentiles include the degraded stretch before its first drop (p90 up to ~20 s while our queue stayed at 14), so they are not comparable; my repo-wide typecheck and tests were also running on the laptop around then.

Enrichment, run 3 on public RPC with no Helius key: 261 DexScreener orders checks plus one profiles poll a minute, 67 paid, 19 profile-feed hits, no HTTP 429 (budget: 60 requests in any 60 s window). At the end the Final Stretch list (66) and Migrated list (14) were fully checked (25 and 0 paid); New Pairs are checked only when active or seen in the profiles feed. `getTokenLargestAccounts` is refused by the public endpoint (`x-ratelimit-method-limit: 0`), so the reconciler backed off (1 min doubling to 8 min) and `holdersSource` stayed `trades`; point `ENRICH_RPC_URL` at a provider RPC or set `HELIUS_API_KEY`. Dev history was computed for every token shown (742 computations, 519 creator lookups): 44 of the 100 New Pairs tokens had a creator who had already launched during the run, 8 with a migrated earlier launch. No Helius key: funded-by is off and `insidersPct` stays null by design. On a freshly started server, Final Stretch tokens predate the process, so their holder metrics are null (history not observed) until a restart's replay or their next lifecycle.

## 2026-10-03: Raydium LaunchLab + CPMM dry runs (public RPC, laptop)

Setup: `https://api.mainnet-beta.solana.com`, `LANDING_MODE=standard`, `DRY_RUN=true`, unsigned simulation (`SIMULATE_AS`, read-only wallets that hold SOL / the token). Slots ~453,034,000–453,036,300. Every simulated LaunchLab `TradeEvent` / CPMM `SwapEvent` matched the local quote exactly (`amount_in` and `amount_out`).

| Run | CU used / limit | Size | Fill vs quote |
|---|---|---|---|
| LaunchLab buy 0.01 SOL, StonkFun 9RAPesjv… (Token-2022, 3% transfer fee), base ATA exists | 69,947 | 964 B | exact |
| same, fresh wallet (creates the Token-2022 ATA) | 83,401 / 120,000 | 964 B | exact |
| LaunchLab sell 100% of the StonkFun coin (+ Token-2022 CloseAccount) | 66,606 | 939 B | exact |
| LaunchLab buy 0.01 SOL, BONK.fun 5ojxCYwe… (SPL), base ATA exists / fresh | 66,970 / 74,549 | 932 B | exact |
| LaunchLab sell 100% of the BONK.fun coin (+ CloseAccount) | 62,121 | 907 B | exact |
| CPMM buy 0.02 SOL, StonkFun graduate 9RcvjFss… (Token-2022, 3% fee), ATA exists | 49,969 | 855 B | exact |
| same, 0.01 SOL, fresh wallet | 61,906 / 85,000 | 855 B | exact |
| CPMM sell 50% of the StonkFun graduate | 43,636 | 823 B | exact |
| CPMM buy 0.01 SOL, BONK.fun graduate 2gFxXdy5… (SPL), ATA exists / fresh | 45,472 / 54,551 | 823 B | exact |
| CPMM sell 100% of the BONK.fun graduate (+ CloseAccount) | 40,832 | 798 B | exact |

Latency (one run each): LaunchLab `stateLoaded` 371–458 ms (2 round trips: venue batch + configs), CPMM via a graduated LaunchLab coin 660 ms (3 round trips: venue batch, LaunchLab configs, pool + vaults). `quoted` +2–15 ms, `built` +35–70 ms (priority-fee samples).

Boundary simulations (limit exactly at our quote passes, one unit tighter fails with the program's ExceededSlippage), pinning down semantics the SDK does not settle:

- LaunchLab `buy_exact_in.minimum_amount_out` is compared with what the buyer **receives after the Token-2022 transfer fee** (66,951,189,460 passes, +1 fails 6004).
- LaunchLab `buy_exact_out.amount_out` is the amount received; our `maximum_amount_in` (7,467,853 for 50,000,000,000 tokens) is exact. The SDK's quote prices the transfer fee twice.
- CPMM `swap_base_output` on a transfer-fee coin: our `max_amount_in` (9,657,162 for 100,000,000,000 tokens) is exact (−1 fails 6005).

Default CU limits are now LaunchLab 120k buy / 100k sell, CPMM 85k / 70k (~1.4-1.6x the worst case above, which also absorbs a fork-vs-simulation gap like the +25% seen on PumpSwap; LaunchLab has extra headroom because the program creates a missing fee vault inside the swap). Transactions stay well under 1,232 bytes, with room for a durable-nonce advance.

## 2026-10-03: armed-order transaction sizes and nonce/ALT mechanics

**Sizes** (offline, from the mainnet account fixtures; `bun run packages/core/scripts/armed-sizes.ts`). Every armed variant is a v0 message: `AdvanceNonceAccount`, CU limit, CU price, the trade, then the tip(s). The operator lookup table holds only shared accounts (63 with wSOL: program ids except the token programs, Global/config/fee-config/event-authority/volume-accumulator PDAs, every fee/buyback recipient and its wSOL ATA, the RecentBlockhashes sysvar). The signer firewall requires everything else to be a static key: mints, token programs, System, user token accounts, the pool, transfer destinations, tips, the jitodontfront marker and the nonce account.

| Trade (Token-2022 base) | Jito tip + dontfront: with ALT / without | Helius + Jito tips: with ALT / without |
|---|---|---|
| pump `buy_exact_quote_in_v2` + ATA | 964 / 1,240 | 1,013 / 1,289 |
| pump mayhem buy + ATA | 964 / 1,240 | 1,013 / 1,289 |
| pump `sell_v2` + close (full exit) | 928 / 1,204 | 977 / 1,253 |
| PumpSwap buy (wrap + ATA) | 971 / 1,247 | 1,020 / 1,296 |
| PumpSwap sell + close (full exit) | 910 / 1,155 | 959 / 1,204 |
| PumpSwap cashback buy | 1,004 / 1,280 | 1,053 / 1,329 |
| PumpSwap cashback sell + close | 976 / 1,221 | 1,025 / 1,270 |
| Migration snipe (canonical pool buy) | 971 / 1,247 | 1,020 / 1,296 |

Limit 1,232 bytes. Every shape fits with the table (worst case 1,053 B, 179 B of headroom). Without it, every buy overflows; the pump buy at 1,240 B matches the signer's own measurement. Allowing token programs and mints into the table would save about 93 bytes per buy, but the firewall rightly refuses lookups of identities that decide where funds go.

**Local validator** (Agave 4.3.0 `solana-test-validator`, 8 ticks per slot ≈ 83 ms, `bun run test:validator`, 25 s; 68 s with `ZF_VALIDATOR_SLOW=1`):

- A variant signed before its signing-time blockhash expired (>150 blocks) still landed. Siblings on the same nonce and the cancel were then refused at preflight, and no fee was charged.
- A landed failure cost exactly the base fee plus the priority fee (5,040 lamports at 1,000 µL/CU × 40k CU). The tip transfer reverted and the nonce advanced.
- A cancel (advance plus CU limit) consumed 300 CU and cost 5,000 lamports.
- `AdvanceNonceAccount` works with the RecentBlockhashes sysvar loaded from the table (it appears in `loadedAddresses.readonly`). A nonce account loaded from a table is refused, which confirms SIMD-0242.
- Rent for 80 bytes was 1,447,680 lamports on the local validator (pre-2026 rate) against about 1,056,640 on mainnet. Both are under the firewall's 2,000,000-lamport slot-funding cap, and rent is always read live.
- A table cannot be closed during its cooldown. It closed about 513 slots after deactivation.

## 2026-10-03: mainnet-fork e2e (local Agave 4.3.0, mainnet binaries + cloned state)

Setup: `bun run fork:start` + `bun run e2e`, standard mode, CLI defaults, fresh wallet per run. All 8 trades landed with fills matching the local quote to the lamport. CU across seven forks (limits in parentheses): curve buy with new Token-2022 ATA 104–118k (140k), curve sell 72–86k (100k), PumpSwap buy with wSOL wrap 118–132k (150k), PumpSwap sell 87–99k (130k). Sizes 1,058–1,189 B. Worst-case headroom is only 12% (PumpSwap buy) and 14% (curve sell), less than the 1.3× the CU-limit defaults assume. "Sent → landed" there is local slot timing (0.35–0.6 s), not a network measurement. Findings (fork rent, no mayhem buyback, exact-quote-in event fields): [docs/dev/FORK_TESTING.md](docs/dev/FORK_TESTING.md).

## 2026-10-03: Phase 2 market feed on public RPC (RpcLogsSource, laptop)

Setup: `bun apps/server/src/main.ts` (Bun 1.3.14, Apple M3 laptop, residential network). `wss://api.mainnet-beta.solana.com` `logsSubscribe`, one `mentions` filter each for pump and PumpSwap, `processed` commitment. HTTP reads on the same public endpoint. SQLite WAL in a temp dir. PumpPortal free stream enabled as a cross-check (no API key needed). One WebSocket client subscribed to the three Pulse columns, `chain`, `debug`, and one token's `token`/`trades`/`candles:1s`/`tradectx` topics. 6 min 20 s run, `DRY_RUN=true`.

| Metric | Value |
|---|---|
| Launches (CreateEvent) | 303 (47.8 / min) |
| Migrations | 10 |
| Trades decoded | 129,599, 341 / s (curve + PumpSwap) |
| Decode failures / truncated logs | 0 / 0 |
| WS reconnects / queue drops | 0 / 0 (queue peak 114 of 50,000) |
| Slot lag vs `slotSubscribe` tip | p50 0, p90 1, max 1 slot |
| Trade detection latency (receive - event timestamp) | p50 1,050 ms, p90 1,455 ms, p99 1,615 ms |
| Launch detection latency | p50 1,027 ms, p90 1,405 ms, p99 1,613 ms |
| Delay after the node announced the slot | p50 270 ms, p90 342 ms, p99 560 ms |
| Logs notifications | 461,076: 42% failed txs (skipped), 31% without events |
| Inbound data | 1,002 MB, 2.6 MB/s (about 79 MB per 30 s) |
| HTTP RPC | 904 calls: 31 HTTP 429 + 2 "data allowance" errors |
| PumpPortal reconcile (30 s window) | 267 matched, 42 seen only by us, 7 only by PumpPortal |
| Gateway client | 23.3 MB in 6 min, no sequence gaps on any topic |
| Server | about 9% CPU, 275 MB RSS at 2 min; SQLite flush about 2 ms |

What these numbers mean:

- Event timestamps (the Clock sysvar) have 1 s resolution and are floored, so the true detection latency is the measured value minus 0 to 1,000 ms. The midpoint estimate puts the median at about 0.5 s. The sub-second "delay after slot" row (270 ms median) is the RPC pipeline delay after the node announced the slot, and excludes leader-to-node propagation.
- Public RPC keeps up with the WebSocket stream: lag stays within one slot, there are no drops, and the queue never backs up. But the stream alone uses about 80% of the endpoint's per-IP data allowance (about 100 MB per 30 s), so HTTP reads on the same IP get throttled. In the first minute, before the pool cache warmed up, the `chain` blockhash went 44 s stale and 332 PumpSwap events waited for pool lookups; both recovered within 30 s. For development, point `RPC_URL` at a different provider than `RPC_WS_URL`. Production uses Yellowstone, which carries blockhashes in `blocks_meta`.
- PumpPortal-only events are probably LetsBonk/LaunchLab launches (PumpPortal streams them; we do not decode LaunchLab yet). Events seen only by us were not investigated. (Since classified, see the PumpPortal entry above: PumpPortal coverage gaps, LetsBonk, and events lost while the public RPC socket was down.)
- About 1 s to the debug view meets the Phase 2 bar on public RPC. A Yellowstone feed should beat it; measure that once there is a paid endpoint.

## 2026-10-03: durable nonce failure semantics (local validator, Agave 4.3.0)

A nonce transaction that lands but fails during execution still advances the nonce and pays the 5,000-lamport base fee; replaying it is rejected. Armed orders therefore get one landed attempt per nonce. Full-exit sells can use multi-nonce attempt ladders safely; buys and partial sells cannot. Details: [docs/experiments/nonce-failure](docs/experiments/nonce-failure/README.md).

## 2026-10-03: Phase 1 dry runs (public RPC, laptop, no streamed state)

Setup: `https://api.mainnet-beta.solana.com`, `LANDING_MODE=standard` (Helius SWQoS-only tip 5,000 lamports + Jito tip), `DRY_RUN=true`, unsigned simulation (`SIMULATE_AS`).

| Run | stateLoaded | quoted | built | simulated | CU used | Size | Fill vs quote |
|---|---|---|---|---|---|---|---|
| Curve buy 0.01 SOL, 8iF53SDs… (Token-2022, new ATA) | 354.6 ms | +17.0 ms | +56.0 ms | +122.5 ms | 108,891 / 140,000 | 1,182 B | exact match |

Builder's runs (same day): curve buy 93–107k CU, curve sell 75k, mayhem buy 102k, PumpSwap buy 106–109k, PumpSwap sell 95k, full exit + CloseAccount 98k. All simulated fills matched local quotes exactly.

What these numbers mean:

- `stateLoaded` is one `getMultipleAccounts` over public RPC. In the web app the browser gets this state streamed, so this step should drop to near zero.
- `built` includes fetching priority-fee samples (150 samples). Cache them server-side so they're off the hot path.
- A standard-mode curve buy is 1,182 of 1,232 bytes. Durable-nonce armed orders will need an address lookup table (or v1 transactions) to fit.
- Public RPC returned 0 for prioritization-fee percentiles on curve accounts, hence `PRIORITY_FEE_FLOOR_MICROLAMPORTS` (default 100k µL/CU). With a Helius RPC URL the CLI uses `getPriorityFeeEstimate`.

Not measured yet: sent → landed. That needs the first live 0.001 SOL trade from a dev wallet.
