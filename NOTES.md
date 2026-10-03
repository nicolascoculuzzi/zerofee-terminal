# Notes: measured latencies and what changed them

Newest first. Record the setup (RPC, region, mode) with every measurement.

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
- PumpPortal-only events are probably LetsBonk/LaunchLab launches (PumpPortal streams them; we do not decode LaunchLab yet). Events seen only by us were not investigated.
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
