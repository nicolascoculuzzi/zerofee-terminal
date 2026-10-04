# Notes: measured latencies and what changed them

Newest first. Record the setup (RPC, region, mode) with every measurement.

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
- Every "PumpPortal only" pump event happened while our socket was down or about to drop: run 2 lost 3 sockets (35.7 s down; 29 of 33 events within 3 s of an outage, 4 within 6 s), run 3 lost 2 (93.6 s; 45 of 60 within 3 s, the rest within 30 s, while the endpoint was already delivering notifications 15-20 s late before it dropped the socket). `logsSubscribe` has no replay; Yellowstone resumes from a slot. The LetsBonk launches need a LaunchLab decoder (Phase 7).
- v1 transactions (SIMD-0385) were ~3% of pump creates in run 2. `getTransaction` refuses them unless asked for `maxSupportedTransactionVersion: 1`; `packages/core/scripts/fork/accounts.ts` and `packages/core/e2e/harness.ts` still ask for 0. Our decoders read logs or the Yellowstone message, which carries V1 messages in the same fields.

Our bugs, found and fixed:

- **Ingest stalled ~5-10 min into every RPC-logs run.** `BoundedSet` / `LruMap` evicted with `values().next()` / `keys().next()`, which in JavaScriptCore walks past every earlier deletion until the table rehashes. The dedupe set (200k) fills after ~5 min at ~670 adds/s; from then on each add got slower: 200k adds took 0.3 s, then 37.7 s, then 132 s. In run 1, trades stopped at ~610 s, the queue filled to 50,000 and the event loop went silent for minutes. Now O(1) (ring / linked list): the queue peaked at 275 in run 2 and 16 in run 3.
- **Reconnect storms.** A refused WebSocket upgrade reset the backoff (it looked at the last successful connection), so we retried every 250-500 ms and the public RPC kept answering 429: 68 reconnects in run 2. The backoff now grows unless the socket opened and stayed up a minute (run 3: 0.26, 0.6, 1.6, 3.9, 4.9, 9.6, 27 s).
- **Reconciler accounting.** It swept only on `/api/health`, counted a late counterpart as a miss on each side, and re-opened entries for fork re-deliveries. Now: 5 s sweep timer, late matches, repeats, and a record per mismatch (signature, slot, quote mint, mayhem, token program, venue tag, other feed connected).

Run 2 detection latency, after the fixes: p50 1,159 ms, p90 1,555 ms, p99 1,767 ms (Phase 2: 1,050 / 1,455 / 1,615). Run 3's percentiles include the degraded stretch before its first drop (p90 up to ~20 s while our queue stayed at 14), so they are not comparable; my repo-wide typecheck and tests were also running on the laptop around then.

Enrichment, run 3 on public RPC with no Helius key: 261 DexScreener orders checks plus one profiles poll a minute, 67 paid, 19 profile-feed hits, no HTTP 429 (budget: 60 requests in any 60 s window). At the end the Final Stretch list (66) and Migrated list (14) were fully checked (25 and 0 paid); New Pairs are checked only when active or seen in the profiles feed. `getTokenLargestAccounts` is refused by the public endpoint (`x-ratelimit-method-limit: 0`), so the reconciler backed off (1 min doubling to 8 min) and `holdersSource` stayed `trades`; point `ENRICH_RPC_URL` at a provider RPC or set `HELIUS_API_KEY`. Dev history was computed for every token shown (742 computations, 519 creator lookups): 44 of the 100 New Pairs tokens had a creator who had already launched during the run, 8 with a migrated earlier launch. No Helius key: funded-by is off and `insidersPct` stays null by design. On a freshly started server, Final Stretch tokens predate the process, so their holder metrics are null (history not observed) until a restart's replay or their next lifecycle.

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
