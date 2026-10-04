# Notes: measured latencies and what changed them

Newest first. Record the setup (RPC, region, mode) with every measurement.

## 2026-10-04: trade capture audit, gap repair and history backfill (public RPC, laptop)

Setup: `https://api.mainnet-beta.solana.com` for everything (feed, re-reads, history, verification) from one IP, `DRY_RUN=true`, reads only. Tool: `bun run apps/server/scripts/capture-audit.ts` (`--db` audits a running server's SQLite; `--inprocess` runs the server instrumented; `--backfill-only --mint` backfills and checks whole histories). Truth = `getSignaturesForAddress` on each coin's curve / pool, then `getTransaction` for every successful signature in the window, decoded with the live decoders; a trade is captured when the store holds one of the same signature and side for the coin.

| Run | Code | Window | pump | PumpSwap | LaunchLab | CPMM | All |
|---|---|---|---|---|---|---|---|
| Preview server on :8787 (`--db`, 57 min uptime, 20 reconnects, ingest latency p50 28 s) | before | 10 min, 6 coins | 84/127 (66.1%) | 12/26 (46.2%) | - | - | 96/153 (62.7%) |
| In-process, no outage in the window | before | 4.8 min, 7 coins | 28/28 | 19/19 | 5/5 | 5/5 | 57/57 (100%) |
| In-process, two socket outages in the window (238 and 122 slots) | after | 4.4 min, 7 coins | 66/66 (100%) | 23/38 (60.5%) | (verifier hit the data allowance) | 23/28 (82.1%) | 112/132 (84.8%) |
| In-process on merged main (speed pass: writer thread, ingest p50 ~1.1 s), no outage in the window | after | 4.8 min, 8 coins | 77/77 | 78/78 | 22/22 | 5/5 | 182/182 (100%) |

Where trades were lost (instrumented runs: every notification, every decoded transaction and every socket up / down recorded):

- **Coins first seen mid-life have no history at all.** 4,805 of the preview's 5,998 tokens were first seen mid-life. FLOP (`4ddZ…pump`, 97% bonding) had 2 stored trades while its curve has 439 signatures. This is what the token page showed.
- **Socket outages.** logsSubscribe does not replay, so everything between the last notification and the reconnect is gone. The public socket stalls silently (the old watchdog waited 30 s), refuses upgrades ("Expected 101", TLS handshake failures) with backoff up to 30 s, and drops its backlog on reconnect: the 238-slot gap above is ~95 s of trades for a 2 s disconnect. The old run saw 5 outages (42, 4, 13, 35 s, …) in 12 minutes; the preview had 20 reconnects in 57 minutes. All 20 misses of the after run are classified "not delivered (reconnect gap)".
- **Not observed:** truncated logs (0 of ~800k notifications), decode failures (0), decode-queue drops (0 in-process; the preview's queue peaked at 11,558 of 50,000 with 28 s ingest latency, so it was close). Raydium re-reads are budget-bound: 167-203 logs-only fallbacks per run (429s at 2/s), recorded without a wallet, not lost.

What changed:

- Live: the idle watchdog recycles after 10 s (was 30 s) and checks every second; a logs subscription that stalls while slots keep coming (pump silent 40 slots) is recycled too. Every outage is reported as a gap with its slot range. Truncated / incomplete logs (fewer trade events than pump / PumpSwap trade instructions, or an undecodable event) are re-read with getTransaction at top priority. Notifications the decode queue drops are re-read by signature, or reported as gaps. Everything is counted (`capture` in /api/health, `zerofee_capture_*` in /metrics). Yellowstone reports outages longer than its replay window as gaps.
- History (`src/history`): gaps queue a gap-fill for the active coins (viewed, Final Stretch / Migrated, then the 50 busiest recent ones). Viewed coins are re-checked every 60 s and listed ones every 10 min (one signatures page down to the last signature covered), which also catches drops nothing signals. Coins first seen mid-life, or opened by a user, are backfilled from chain. Idempotent: a trade held by id or by signature + side + amount is never added twice. Candles, windows, the ring, the ATH and (from the creation) the holder book are rebuilt.
- In the after run, the pump coins hit by the two outages were repaired to 100% before verification. The PumpSwap / CPMM ones were not yet: gap-fill on the public RPC runs at ~1 call/s shared with everything else, busy pools need many signature pages, and the background tier is capped at 50 coins. Viewed and listed coins go first; a paid endpoint (`HISTORY_RPC_URL`, `HISTORY_RPS`, `HISTORY_BATCH`) repairs the rest.
- Holder shares: a trade-only book that missed sells only grows (top 10 at 109% on DONALDMAXX). Shares are now scaled to what can be in circulation (curve: tokens sold, plus a mayhem coin's second 1e15; pool: supply minus pool base), never above 100%. An overcounted book on a viewed / listed coin triggers a gap-fill, and the rebuild from the full history makes it exact again.

Whole-history backfill of FLOP (`--backfill-only`, server never saw the coin: discovered from its curve PDA; created 2026-09-26, 97% bonding, 439 curve signatures of which 10 failed):

| Run | Fetched | Stored trades | Chain successful txs | Missing with FLOP trades | Holders / top 10 |
|---|---|---|---|---|---|
| 1 (first code) | 393 in 64 min | 156 | 429 | 199 | 19 / 35.2% (wrong: built on 156 trades) |
| 2 (fixed) | FLOP_RUN2 |

Run 1 found two bugs. (1) The 72 h trade-retention prune (every minute) deleted the backfilled trades of a coin older than 72 h while its backfill ran, because the retention exemption was only written when the job finished. It is now written when the job starts. (2) A getTransaction batch that still failed after the reader's retries (429) was dropped. It is now put back and retried after a 15 s pause. The public RPC gave this run ~0.1-0.2 getTransaction/s: the preview server on the same IP kept a 500-deep Raydium re-read queue.
## 2026-10-04: follow-ups (CSP style-src, one loop-lag monitor, WS_COMPRESSION on)

Setup: Apple M3 laptop, Bun 1.3.14, `DRY_RUN=true`, headless Chromium (Playwright 1.63) at 1440x900.

**CSP `style-src` violation.** Source: TradingView Lightweight Charts inserts a `<style>` element for its attribution logo (`layout.attributionLogo`, kept on for the Apache-2.0 NOTICE). `style-src 'self'` blocked it on every page with a chart (token page: 4 violations, two per policy, meta tag and edge header) and the logo fell into the document flow (`position: static` instead of `absolute` in the chart corner). index.html and its boot skeleton (classes only) were clean; React `style` props, the QR code's included, go through the CSSOM, which CSP does not restrict. Fix: `apps/web/csp.ts` hashes the rule from the installed library and the build puts `'sha256-3pRED1tOXas1FXFoPb9TGCjmYe9XQsmO9OV23khV2nY='` in the meta CSP; the Caddyfile carries the same hash. No 'unsafe-inline'. Guards: the build fails when the final index.html has a style attribute, an unhashed `<style>` or an inline script; `apps/web/src/csp.test.ts` fails when the Caddyfile's style-src stops matching the library (an upgrade) or index.html grows inline styles. `preview:live` now sends the edge's CSP header. Check: production live build under `preview:live` (edge header + meta tag), Pulse, a token page with its chart, Settings, Portfolio, Onboarding and the Fund modal (no wallet, so its empty state): 0 CSP violations on every page (the token page had 4 before), attribution logo `absolute`.

**One event-loop lag monitor.** `src/perf.ts` (20 ms timer) and `src/util/loopLag.ts` (50 ms timer) both ran. Now `perf.loop` is the only `LoopLagMonitor` (20 ms, last 5 min, stall counters) and `/api/perf` (`loop`), `/api/health` (`eventLoopLag`) and `/metrics` (`zerofee_event_loop_lag_seconds`) read it; names unchanged.

**`GET /api/health` twice on load.** The data source polled at construction and again when the socket went live ~100 ms later. The reconnect poll now skips when a poll is in flight or answered in the last 5 s: 2 -> 1 request on load; reconnects after a restart still refresh.

**WS_COMPRESSION, now on by default.** Bun compresses `server.publish()` (deltas) once permessage-deflate is negotiated, but `ws.send()` only when asked, so with `WS_COMPRESSION=true` every snapshot (the largest messages) went out raw; that is why the speed pass saw no difference in first data. Snapshots now pass the flag. A/B: two servers on the same recorded feed (240 s of pump + PumpSwap logs, replayed at 1x, looped), 3 clients each subscribed like the web app (chain, three Pulse columns, one Final Stretch token's trades + token, refocused when quiet), 60 s warm-up then 5 min, wire bytes counted by a TCP proxy, server CPU from `ps`:

| | off | on, snapshots raw (before) | on (after) |
|---|---|---|---|
| Payload per client | 825 KB/min | 825 KB/min | 820 KB/min |
| Wire per client | 827-829 KB/min | 522 KB/min (-37%) | 381 KB/min (-54%) |
| Server CPU (whole process) | 16.7-17.2 s/min | 16.8 s/min | 16.6 s/min |
| Loop lag p50 / p99 | 0.6 / 4.1 ms | 0.6 / 4.1 ms | 0.6 / 4.0 ms |

Connecting: the four first snapshots (three Pulse columns + a trade tape) are 320 KB raw, ~74 KB deflated (estimate with zlib, no context takeover). CPU in isolation (the captured client stream sent to 3 sockets in a loop): ~2 ms/MB raw vs ~12 ms/MB deflated (Bun's shared compressor, no context takeover); `publish()` compresses once per message for every subscriber. At ~0.8 MB per client per minute that is ~8 ms of CPU per client per minute for the snapshot path, invisible next to the process's ~17 s/min. Dedicated (context takeover) compressors were 2.5x the CPU and per-socket memory; not used.

## 2026-10-04: end-to-end speed pass (server hot path, gateway, web load)

Setup: Apple M3 laptop, Bun 1.3.14, residential network, `DRY_RUN=true`. Server runs come from `bun run perf` (apps/server/scripts/perf.ts): the server in a child process, one or three WebSocket clients on `chain` + the three Pulse columns + one active token's `trades`/`token`, breakdown from `GET /api/perf`. "Restored" runs start from a copy of a 1,225-token database a 4-minute run built (91 tokens with holder replay, 4,710 trades). "Before" is commit e417454 (the instrumentation alone on top of fc8145c); "after" is this branch. Web runs come from `bun run perf:web` (apps/web/scripts/perf-load.ts): the production live build served by `preview:live` (brotli, immutable caching), headless Chrome 153 at 1440x900, 5 cold runs, medians, both builds against the same gateway. Another server from the main checkout was streaming the same public endpoint from this IP for most of the session.

### What was slow, and why

- **Startup restore blocked the process.** Token records and the full trade replay ran synchronously before the gateway listened: 435-1,066 ms with 1,225 tokens (more under load), and the first Pulse snapshot after a restart was empty (`pulse:new` 0-3 KB): restored tokens appeared only when they traded again.
- **SQLite writes ran on the event loop.** The 250 ms batch transaction grew with the tables: 22-64 ms of every second, single flushes up to 211-300 ms. It was the largest source of event-loop lag (p99 34-49 ms in 4-minute live runs, climbing as the run went on) and of queue wait behind it.
- **The public RPC's WebSocket stream falls behind by itself.** A new `rpc.streamBehindSlots` stage (HTTP confirmed slot minus the streamed tip) shows backlogs of 18-127 slots (7-50 s) in some windows with our queue empty and the event loop idle. In those windows detection p50 is 5-21 s whatever the server does; in clean windows it is ~1.1 s. This, not the server, explains the 2.6 s / 7.0 s / 23.7 s observation: the backlog comes and goes by the minute (and a second server on the same IP makes it worse).
- **Web: the first screen waited in series.** index.html was blank until the entry ran, then the live data layer (63 KB gzip, including the trade engine) loaded, then the wallet restore had to finish, then the Pulse route chunk loaded, and only then were the Pulse topics subscribed. First-screen JavaScript was 243 KB gzip (entry 126 + live 61 + Pulse 21 + shared chunks), against a 170 KB budget.

### What changed

Server (apps/server):
- `src/perf.ts`: event-loop lag monitor (20 ms timer drift), per-hop latency stages and named work spans; `GET /api/perf`; a one-line summary in the minute log. Deltas carry the publish time (`ts`) so clients can measure gateway -> browser.
- SQLite batches go to a writer thread (`storage/writerWorker.ts`, own WAL connection; one batch in flight, rows keep coalescing meanwhile). Token rows are serialized once per flush instead of on every persist.
- Two-phase restore: records only before listening; the trade replay that rebuilds holder books runs after ingest started, in time-boxed slices (also inside a busy token), and only for trades received before the process started. The Pulse lists are seeded from the restored tokens, so the first snapshot is complete.
- Pulse snapshots are serialized once per list change and shared by every connecting client; `GET /api/pulse` serves all three lists (gzip) for the page's bootstrap.
- Failed transactions (~40% of notifications) are dropped before `JSON.parse`.
- `RPC_MAX_CONCURRENT` budgets reads on `RPC_URL`; `.env.example` documents the endpoint split (the enrichment and Raydium re-reads already have their own clients).
- `scripts/perf-feed.ts` records the logs feed and replays it (looped, relabelled, N times faster) for controlled A/B runs: `bun run perf --replay feed.jsonl.gz --speed 4 --entry <other checkout>/apps/server/src/main.ts`.

Web (apps/web):
- A static boot skeleton in index.html (classes only, CSP-safe) paints with the stylesheet, before any script. The stylesheet goes first in `<head>`; after it, `modulepreload` for the data layer and the Pulse route, `preload` for `GET /api/pulse` and the mono font (vite.config.ts).
- The Pulse topics are subscribed and the REST bootstrap fetched while the data layer initialises; the first render waits at most 100 ms for the wallet restore; a column snapshot is applied on the next frame instead of waiting for the Pulse rate tick.
- Off the first screen: the trade engine (LiveTradeService, packages/core builders), transfers, the SIWS formatter, copy trading and tracked-wallet sync, trade actions and every global overlay load lazily (idle preload). base58 is local (no @solana/kit codecs in the wallet layer).
- react-router replaced by `src/lib/router.tsx` (aliased as `react-router`, same API for what the app uses): 11 KB gzip off the entry. Routes, deep links (`/t/<mint>`, `/portfolio?wallet=`), index redirects (replace), unknown paths, NavLink active state and back/forward were checked in the browser; matching is unit-tested.
- Marks (`zf:boot`, `zf:services`, `zf:wallet`, `zf:ws-open`, `zf:ws-first-snapshot`, `zf:skeleton`, `zf:pulse-data`), gateway -> browser latency, receive -> paint and frame sampling (`zfPerf()` in the console).
- Tools: `preview:live`, `perf:web` (`--throttle`, `--cpu`, `--warm`, `--soak`), `bundle:report` (170 KB gzip budget check).

### Server, live public RPC (4 min, restored database, pump + PumpSwap, clean RPC windows)

| | before | after |
|---|---|---|
| Trade detection (block time -> receive) p50 / p90 / p99 | 1,132 / 1,529 / 1,820 ms | 1,082 / 1,501 / 1,675 ms |
| Launch detection p50 / p90 | 1,091 / 1,521 ms | 991 / 1,461 ms |
| Client trade e2e (block time -> browser socket) p50 / p90 | 1,112 / 1,501 ms | 1,081 / 1,498 ms |
| Client launch e2e p50 / p90 | 1,183 / 1,620 ms | 1,101 / 1,546 ms |
| Receive -> tape publish p50 / p90 | 40 / 75 ms | 41 / 71 ms |
| State change -> Pulse publish p50 / p90 (200 ms flush) | 108 / 189 ms | 108 / 186 ms |
| Gateway publish -> client receive p50 / p99 | 0 / 8 ms | 0 / 5 ms |
| Event-loop lag p99 / max | 34.3 / 493 ms (rising through the run) | 4.0 / 353 ms (max: startup tick) |
| Stalls > 50 ms / > 100 ms | 34 / 5 | 10 / 4 |
| SQLite on the event loop | 63.9 ms per second, max 211 ms | 2.5 ms per second hand-off, max 18 ms |
| Startup: blocking restore, listen after spawn | 435 ms (records + replay), 1,180 ms | 201 ms (records), 788 ms |
| First `pulse:new` snapshot after the restart | 0-3 KB (empty) | 111 KB (full list of 100) |

In windows where the public stream fell behind (`rpc.streamBehindSlots` p50 18-51 slots) both builds measured detection p50 of 5-21 s with an empty queue and loop-lag p99 under 11 ms (after); one "before" run hit it too (p50 12 s at t+61 s). Those runs are left out of the table, not hidden: the stage is printed by every `bun run perf`.

### Server, controlled replay (the same 150 s recording looped at 4x, 3 clients, restored database)

| | before | after |
|---|---|---|
| Receive -> decode (queue) p50 / p90 / p99 | 7 / 57 / 180 ms | 5 / 41 / 98 ms |
| Receive -> tape publish p90 / p99 | 181 / 216 ms | 80 / 166 ms |
| State change -> Pulse publish p99 / max | 264 / 383 ms | 202 / 211 ms |
| Event-loop lag p99 / max | 6.8 / 359 ms | 3.9 / 305 ms |
| Stalls > 50 ms / > 100 ms | 27 / 8 | 2 / 1 |
| Main-thread storage | 22.4 ms per second (max 154 ms) | 1.2 ms per second (max 9.5 ms) |
| Restore before listening | 332 ms | 190 ms (+ background slices, max 68 ms) |

Targets on public RPC (launch and trade p50 <= 1.2 s, p90 <= 2 s, loop-lag p99 < 50 ms) are met in clean windows. What remains is the free endpoint: block time is floored to 1 s, so ~1.1 s measured is ~0.5-0.6 s real, of which ~270 ms is the node's own pipeline after it announces the slot; the rest is propagation to the RPC node and its stream backlog. Expected with Chainstack (or any) Yellowstone gRPC, not measured yet: no stream backlog (the gRPC stream is not shared with HTTP reads), ~50-200 ms from slot to our socket, so measured detection p50 ~0.6-0.8 s (0.1-0.3 s real) and p90 ~1.1 s, plus the same ~40 ms (tape) / ~110 ms (Pulse) gateway cadence.

### Web load (production build, same gateway)

| profile | first paint | FCP | LCP | first Pulse row with data | JS until then (KB) |
|---|---|---|---|---|---|
| none | 40 -> 68 ms | 96 -> 128 ms | 436 -> 464 ms | **414 -> 415 ms** | 265.5 -> 271.9 |
| fast4g | 288 -> 268 ms | 564 -> 492 ms | 952 -> 816 ms | **940 -> 776 ms** | 265.5 -> 222.8 |
| slow4g | 744 -> 636 ms | 2,348 -> 1,976 ms | 4,324 -> 2,308 ms | **4,313 -> 2,266 ms** | 265.5 -> 160.6 |

Medians of 5 cold runs, before -> after; throttling is DevTools emulation (fast4g: 40 ms, 9 Mbit/s; slow4g: Lighthouse's 150 ms, 1.6 Mbit/s). "First Pulse row" is the `zf:pulse-data` mark (the old build has no marks: the first non-empty Pulse card in the DOM, which the new build matches within ~25 ms). On a repeat visit (immutable cache) the first row lands at 399 ms (414 before), with 69 of the requests from cache; the after build transfers ~88 KB then, most of it the fresh `/api/pulse` data. On loopback the work is CPU-bound (~250 ms of main-thread tasks), so nothing moves there; first paint is ~30 ms later because the skeleton HTML is larger, but it is the terminal frame instead of an empty page.

Bundle (bundle:report; first screen = entry, its imports, the data layer and the Pulse route): 243.2 -> 169.1 KB gzip (148.4 KB brotli), budget 170, after merging main's UI polish rounds (which added ~6 KB; the Pulse hover tips and card menu now load right after the first rows to make room). Entry chunk 125.6 -> 96.0 KB, data layer 61.1 -> 16.1 KB (the trade engine is a 26.8 KB lazy chunk now), CSS 13.9 -> 14.9 KB (the UI polish). Lazy: chart 11.1 + 54.7 KB (lightweight-charts), settings 23.8, onboarding 9.9, signer worker 47.2.

Rendering (perf:web --soak 30000, three Pulse columns under the live feed): 60 fps median, frame p99 16.8 ms, no long tasks; with 4x CPU throttling frame p99 33 ms, one 55 ms task in 30 s. Receive -> paint p50 ~105 ms, p90 ~175 ms: the Pulse batch is applied at the user's Pulse rate (4-10 Hz) by design. `WS_COMPRESSION=true` made no measurable difference to first data on slow 4G (the REST bootstrap is already gzip and preloaded), so it stays off. (Later: snapshots were never compressed; fixed and on by default, see the follow-ups above.)

Not done / noticed: on a loopback network the first Pulse row lands at ~0.4 s in both builds (main-thread time: parse and first render, ~250 ms of tasks); the console shows a CSP `style-src` violation from an inline style on some pages (present before this work; the chart attribution `<style>`, fixed in the follow-ups above).

## 2026-10-04: Raydium LaunchLab + CPMM in the live feed (public RPC, laptop)

Setup: `https://api.mainnet-beta.solana.com`, `INGEST_SOURCE=rpc`, `RPC_LOGS_PROGRAMS=pump,pumpswap,launchlab,cpmm`, `RPC_LOGS_TX_FETCH_RPS=2`, `DRY_RUN=true`, server in-process with an anonymous socket on the Pulse topics. Two runs on a Sunday morning UTC (05:42-05:49 and 05:50-05:56). An independent `logsSubscribe` counter on the LaunchLab program ran alongside the second one.

| | Run 1 (7 min) | Run 2 (6 min, final code) |
|---|---|---|
| pump launches | 173 | 135 |
| LaunchLab launches | 3 | 1 (probe: 1 initialize) |
| LaunchLab trades | 81 (2-25/min) | 40 (3-11/min; probe: 43 swap instructions) |
| LaunchLab curves completed / graduations seen | 0 / 0 | 0 / 0 |
| Earlier graduates found through their CPMM pool | 149 | 145 |
| CPMM trades on graduation pools / swaps on other pools ignored | 484 / 583 | 374 / 400 |
| Decode failures | 0 | 0 |
| LaunchLab coins in Pulse (seen on the socket) | new 3, final 4, migrated 0 | new 1, final 2, migrated 0 |
| LaunchLab coins with a trade context | 180 of 183 | 170 of 171 |

- LaunchLab was quiet at that hour: about 0.5 launches and 7-14 trades per minute against pump's 20-25 launches. The "half of all launches" share is not what this window showed. No curve completed, so the graduation path was not exercised live; it is covered by tests on the real `migrate_to_cpswap`.
- Every LaunchLab coin seen on Pulse was StonkFun, and most were quoted in xStocks or other tokens. Those carried null SOL values with known quote-unit prices. No SOL value was ever 0.
- `getTransaction` on the public RPC answered HTTP 429 even at 2/s (60 of about 400 calls in run 2). Re-reads now pause on their own client during the cooldown. In run 2, 87 transactions waited past 20 s and kept their logs-only record. Most trades without a wallet (252 in run 2) are swaps on graduates found after the fact, which are logs-only by design (`wantsRaydiumTx`). Run 1, before that rule, let those swaps take the whole budget.
- Classifying unknown CPMM pools took one batched read of two LaunchLab PDAs per new pool. About 95-120 pools were rejected per run, and later swaps on them cost nothing.

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

Firewall: the 6Vsnb… buy and full sell, the DBC buy and sell, and the BONK buy and sell went through the live check. Each passed `createSignerPolicy` in every landing mode, with Jupiter's quote as the expectation. After the hop rules (entry above), the DBC buy, a BONK buy (a three-hop shared route, 1,145 B, 222,728 CU) and a 6Vsnb… full sell (706 B, 34,224 CU) were re-run and passed again in all three modes. Turbo is 49 B smaller than standard (one Sender tip instead of two tips). Protected is 16 B smaller (one Jito tip plus the jitodontfront marker).

What these numbers mean:

- Single-hop long-tail routes are small. The DBC route uses no lookup table at all. Multi-hop routes need the tables: the captured two-hop BONK sell is 1,392 B without them and 995 B with them. Keeping the firewall's static keys out of the tables (user side, mints, token programs, tips, every System/Token/ATA account) costs 60–120 B over unrestricted compression.
- One BONK buy quote came back at 1,243 B once our two tips were added. `buildTrade` now checks each route against the largest budget-and-tip layout of any mode. If it doesn't fit, it drops the no-op creation of an ATA that already exists, then re-quotes with `maxAccounts` 48, 32, 24 (Jupiter's documented remedy). Later BONK buys needed 48 or 24, and the quote records which. Each re-quote is another `/build` call; keyless callers hit 429s, which the client retries after `Retry-After`.
- CU varies too much for a static limit: 34–57k for long-tail single hops, 145–250k for multi-hop BONK routes. The CLI sizes the limit with an unsigned simulation at 1.4M CU (limit = simulated × 1.2). The shipped firewall cap is 400k, so a route needing more than ~333k simulated CU would be refused.
- Latency (one run each): `stateLoaded` 570–790 ms (one batch plus the quote mint). `quoted` +300–550 ms: the `/build` call from a laptop, keyless. `built` +255–280 ms, including the CU-sizing simulation. In the browser, state is streamed, but the `/build` round trip and the sizing simulation remain, which is why Jupiter is only the fallback.
- A DAMM v2 route loads about 5.3 MB of account data (the Jupiter and DAMM programs), well inside the 64 MB default.
- Jupiter's `otherAmountThreshold` rounds the minimum up. The firewall reports floor(quoted out × (1 − slippage)), one base unit lower and never above what Jupiter enforces.
- Found on the way: BONK's would-be pump curve PDA holds 1.12 SOL as a System account. Venue resolution read it as a complete curve ("migration pending?"). Venue PDAs now count only when their program owns them.

## 2026-10-04: implausible market caps classified against the chain (public RPC, laptop)

Setup: the server as `main.ts` builds it (`createApp`, RPC logs at processed on `api.mainnet-beta.solana.com`, `DRY_RUN=true`, enrichment and PumpPortal off) inside a harness that scanned every token's summary each 15 s and kept every one below a plausible floor (curve: mcSol < 25 SOL; pool: < 1 SOL) or at exactly 0, with the events behind it. Run 1: 10 min on the old code, SOL $120.1-120.3, 157,002 events (27,896 curve trades, 129,106 PumpSwap swaps), 328 creates, 2,425 tokens in memory. Each flagged token was then checked read-only against its bonding curve, mint and pool accounts, and its market cap recomputed with `@zerofee/core`'s `curveMarketCap` on our own reserves and the real mint supply.

| Flagged | Tokens | Cause | Verdict |
|---|---|---|---|
| curve < 25 SOL | 123 (120 SOL-, 3 USDC-quoted) | all mayhem coins; 122 had supply 1e15 against a 2e15 mint | our cap was exactly half of core's on the same reserves |
|   of which, with the 2e15 supply | 77 still < 25 SOL (min 0.01, median 5.6) | the Mayhem agent's trades rewrite the curve's virtual SOL | genuine: core on the chain's curve agrees |
|   | 43 >= 25 SOL | the halved supply alone | bug |
| pool < 1 SOL | 19 | graduated (mostly mayhem) coins in drained canonical pools; `base_supply` 1e15 against ~2e15 mints | genuine low caps, halved again |
| mcSol exactly 0 | 129 | quote mint with no SOL value (xStocks such as SPYx / NVDAx, PUMP, other pump coins): 57 curves, 72 pools | should be null; 1 of them (GMk6j2) is really SOL-quoted |

What these numbers mean:

- **Mayhem coins are the 0.1-1 SOL caps, and most of those caps are real.** `create_v2` of a mayhem coin mints 1e15 to the curve and 1e15 more to the Mayhem program's vault (two MintTo in tx `2FCBGU2a…`), but the CreateEvent, the BondingCurve account and PumpSwap's `base_supply` all say 1e15, and that is what the record kept as its supply. A fresh mayhem curve starts at ~56 SOL with the 2B supply (we showed 28). Then the Mayhem agent (`BwWK17…`, trading through the Mayhem program's CPI into pump `sell` / `buy`) moves the curve's virtual SOL far more than its trade size: MHK's offset over real SOL went 30 -> 20.17 SOL on a 0.019 SOL sell, and was 0.53 SOL six minutes later (cap ~1.2 SOL with 2B). At the check, 101 of 117 flagged mayhem curves had an on-chain cap under 25 SOL, with virtual-minus-real SOL offsets from 0.009 SOL (standard curves: exactly 30 SOL; the token-side offset stayed 279.9M everywhere). The "impossible below ~28 SOL" premise holds for standard SOL curves only. 74 of the run's 328 creates (23%) were mayhem.
- **Our reserves were right.** Every TradeEvent carries post-trade reserves, and core's cap on our recorded reserves equals the chain's wherever no trade intervened (e.g. 0.7398 / 0.7398, 8.1135 / 8.1135, 24.2201 / 24.2201 SOL). The MHK curve account read later matched its last TradeEvent to the unit. A 5 min probe of pump logs (11,892 TradeEvents, 38 mayhem creates) saw no `UpdateMayhemVirtualParamsEvent`, and the agent's transactions carry no `set_mayhem_virtual_params`: the repricing arrives inside the TradeEvent, so a logs feed stays in sync.
- **Hypotheses not borne out:** USDC reserves are read with 6 decimals and converted at SOL/USD (2P1S: core's 5,455.9 USDC / 120.11 = 45.4 SOL, exactly 2x our 22.7: the mayhem halving again). Non-SOL TradeEvents are decoded from the trailing `quote_*` fields (non-SOL CreateEvents carry the quote reserves in both `virtual_sol_reserves` and `virtual_quote_reserves`). Tokens first seen mid-life get correct reserves from their first trade; only their supply was wrong (for mayhem coins the curve account, resolved right after the mint account in the same batch, overwrote the mint's 2e15 with 1e15).
- **Quote mismatch:** GMk6j2 was first priced from a third-party GMk6/PUMP pool and kept PUMP as its quote after its canonical GMk6/wSOL pool took over (one arbitrage tx, `4LYf7b9i…`), so the wSOL vault was read with PUMP's 6 decimals and no SOL value. Trades in any non-primary pool were also valued with the record's quote rather than the pool's.

Fixes: the supply is the mint's (core `curveMintSupply` when only the curve is known; the mint account or a non-mayhem pool's `base_supply` wins), the curve's own 1e15 stays in trade contexts for migration estimates, a token's quote follows the pool that prices it, trades are valued in their own venue's quote, and SOL-denominated values are null (never 0) when the quote has no SOL value: TokenSummary, Trade, tracked rows, copy signals, SQLite (schema v3). Copy MC / liquidity filters skip unknown values (`mc_unknown`, `liquidity_unknown`), alerts neither fire nor re-arm on them, and the protocol header and DESIGN 4.16 tell Pulse filters to do the same. Regression tests replay the real transactions and accounts above (`apps/server/test/marketCap.test.ts`, recorded by `apps/server/scripts/record-market-cap-fixtures.ts`).

Run 2, after the fixes (8 min, same setup, SOL $120.1, 125,289 trade events, 264 creates): 91 curve tokens under 25 SOL, all mayhem, and for 90 of them our mcSol equals core's cap on our reserves with the chain's mint supply to the lamport (the 91st was snapshotted before its mint account, 0.07% burned, had been read). 82 of the 86 SOL-quoted ones were under 25 SOL on chain at the check. The 16 pool tokens under 1 SOL all carried the chain's mint supply. No token showed mcSol 0 (run 1: 129); 136 showed null, none of them quoted in SOL or USDC.

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
- Market state reported market caps of 0.1-1 SOL for some live pump tokens (impossible on a SOL-quoted curve); worth a look in the market layer, since copy MC filters read the same summary. (Since investigated, see the market-cap entry above: mayhem coins, whose caps were halved but are genuinely that low on chain, plus nulls for quotes without a SOL value.)
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
