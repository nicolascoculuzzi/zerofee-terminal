# Notes: measured latencies and what changed them

Newest first. Record the setup (RPC, region, mode) with every measurement.

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
