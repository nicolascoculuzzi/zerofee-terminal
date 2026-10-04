# Mainnet-fork testing

A local `solana-test-validator` runs **mainnet's exact program binaries** against **cloned mainnet state** for a few live coins. The trade suites build each trade the way the CLI does, send it through the router, and check the landed transaction against our local quote, to the lamport. The armed suite pre-signs durable-nonce orders through the signer firewall, lets core's trigger engine fire them on fork state, and checks the fills, failures, nonces and status-machine effects the same way. No real money moves and nothing is sent to mainnet: mainnet RPC is only read, to clone accounts.

## Run it

You need [Bun](https://bun.sh) and an Agave `solana-test-validator` (tested with 4.3.0). The default path is `~/.local/share/solana/install/active_release/bin/solana-test-validator`; set `SOLANA_TEST_VALIDATOR` to override it.

```bash
bun install
```

```bash
bun run fork:start
```

```bash
bun run e2e
```

```bash
bun run fork:stop
```

`fork:start` takes about 30–70 s. Most of that is finding live coins on the rate-limited public RPC (which also returns the odd transient error, such as an HTTP 413; just run it again). It prints the env the suite uses and leaves the validator running in the background until `fork:stop`.

| Command | What it does |
|---|---|
| `bun run fork:start` | Picks coins from recent on-chain activity, clones them, starts the validator |
| `bun run fork:start <mint> ...` | Uses these coins instead (active curve or migrated PumpSwap coins). A required kind you leave out (Token-2022 curve coin, PumpSwap pool) is still discovered |
| `bun run fork:start --reuse` | Re-forks the previous run's coins with fresh mainnet state |
| `bun run fork:start --no-feature-set` | Keeps the test validator's default features instead of cloning mainnet's |
| `bun run fork:start --allow-missing` | Starts even when no Token-2022 curve coin or PumpSwap pool was found; the e2e cases that need it are skipped, with the reason in the test name |
| `bun run fork:accounts [mint ...]` | Prints the chosen coins and the full clone list as JSON; starts nothing |
| `bun run e2e [-t pattern]` | Runs `packages/core/e2e/*.e2e.ts` (armed orders and trades), then prints a CU / size / fee / latency table with each transaction's result. Extra args go to `bun test` |
| `bun run fork:stop [--keep-ledger]` | Stops the validator and deletes the ledger. `fork.json` is kept for `--reuse` |

| Env | Default | Purpose |
|---|---|---|
| `FORK_DIR` | `<os tmpdir>/zerofee-terminal-fork` | Ledger, logs, `fork.json` manifest, e2e report. Kept outside the repo; `.fork/` is gitignored if you put it inside |
| `FORK_RPC_PORT` | `18899` (websocket +1) | Away from the usual 8899, so other validators can run alongside |
| `FORK_CLONE_URL` | `https://api.mainnet-beta.solana.com` | Read-only mainnet RPC for discovery and cloning. It appears on the validator's command line, so avoid keyed URLs on shared machines |
| `FORK_START_TIMEOUT_MS` | `240000` | Health-check deadline |
| `FORK_DISCOVERY_TIMEOUT_MS` | `180000` | Time budget for finding coins from recent activity |
| `FORK_RPC_URL`, `FORK_WS_URL` | from `fork.json` | e2e overrides; loopback only |

The e2e files are named `*.e2e.ts`, which `bun test` doesn't pick up, so the default test run and CI stay offline.

The armed suite's migration case buys out the `migration` coin's curve and migrates it, which can't be undone on the fork. A second `bun run e2e` on the same fork skips that case and says why; to run it again, re-fork: `bun run fork:stop && bun run fork:start --reuse`. Everything else can run any number of times. Set `FORK_DIR` and `FORK_RPC_PORT` per checkout when several worktrees run forks at once.

## How it works

1. **Coins.** `accounts.ts` reads recent pump trades to find an active Token-2022 (`create_v2`) curve coin, plus a second one as the `migration` coin, which only the armed suite uses because it completes and migrates it. It finds a mayhem coin through recent Mayhem-program activity. It also picks a canonical wSOL PumpSwap pool: it prefers an SPL Token base for 6 transactions, then takes any eligible pool, up to 15. A legacy SPL Token curve coin is used only if one shows up along the way, since they're rare after `create_v2`. The public endpoint allows about 5 `getTransaction` calls per 10 s, so discovery stops as soon as each kind is found and logs why it rejected coins and pools. It reads `getSignaturesForAddress` pages (100 signatures each, up to 4 for pump), spreads its picks across slots (at most 3 per slot, newest first) so one busy slot cannot use up the budget, and fetches the transactions in JSON-RPC batches of 5 with `maxSupportedTransactionVersion: 1`: v1 transactions are live on mainnet, and asking for version 0 made every one of them an error. Rate-limited calls are retried with backoff (honoring `Retry-After`). A required kind (the Token-2022 curve coin, the PumpSwap pool) gets up to 3 rounds of up to 40 (pump) or 15 (PumpSwap) transactions, 5 s and 10 s apart, each reading newer activity, all within `FORK_DISCOVERY_TIMEOUT_MS`. If one is still missing, `fork:start` fails fast and says how to pass mints (or `--allow-missing` starts anyway). Explicit mints and `--reuse` give the second Token-2022 curve coin the `migration` kind.
2. **Clone list.** Every account the trades touch is resolved with `packages/core`'s own PDA and state helpers, from live mainnet state:

   | Group | Accounts | Flag |
   |---|---|---|
   | Programs | pump, PumpSwap, pump fees, SPL Token, Token-2022 (all upgradeable on mainnet) | `--clone-upgradeable-program` |
   | Programs | ATA (BPFLoader2) | `--clone` |
   | Globals | pump Global, FeeConfig, GlobalVolumeAccumulator; PumpSwap GlobalConfig, FeeConfig, GlobalVolumeAccumulator; wSOL mint | `--clone` |
   | Fee recipients | every account the builders may pick at random. Curve: the live Global's 8 normal, 8 buyback and (for mayhem) 8 reserved recipients, which are credited in SOL | `--clone` |
   | Fee recipients | PumpSwap: protocol and buyback recipients from the live GlobalConfig and their quote ATAs, which get credited (and created at the payer's expense if missing) | `--maybe-clone` |
   | Tip accounts | 8 Jito + 10 Helius Sender. A small tip into a missing account fails the rent check | `--clone` |
   | Curve coin | mint, bonding curve, curve token account | `--clone` |
   | Curve coin | creator vault (from the live `bonding_curve.creator`), sharing config | `--maybe-clone` |
   | Pool coin | mint, pool, both vaults | `--clone` |
   | Pool coin | coin-creator vault authority (from the live `pool.coin_creator`) and its quote ATA, `pool-v2` | `--maybe-clone` |
   | Migration coin | as a curve coin, plus what `migrate` and the first trade on the new pool touch: the Global's `withdraw_authority`, the coin-creator vault authority the pool inherits from the curve and its wSOL ATA, `pool-v2`, the PumpSwap protocol and buyback recipients and their wSOL ATAs | `--maybe-clone` |

   On 2026-10-03 that was 6 programs, 59 accounts and 24 optional accounts, 20 of which existed (62 and 30 with a migration coin, 23–24 of them present). User-side accounts (ATAs, volume accumulators) are created by the trades themselves, and `migrate` creates the pool's.
3. **Validator.** It runs with `--reset --bind-address 127.0.0.1 --clone-feature-set` and a fresh ledger in `FORK_DIR`, detached. `--clone-feature-set` matters: by default the test validator turns on every feature, including the 37 that mainnet hasn't activated.
4. **Checks.** Every required clone must exist on the fork. Every program's ELF must be byte-identical to mainnet's: the validator zeroes the deploy slot in the programdata header, so only bytes after the 45-byte header are hashed. The hashes go into `fork.json`.
5. **Rent normalization** (see Findings). Every account owned by the pump, PumpSwap or fees program gets exactly `rent_fork(len) − rent_mainnet(len)` added, with mainnet rent read live. Any other account below the fork's rent-exempt minimum is lifted to it. Each top-up is recorded in `fork.json`. Trade math never reads these lamports.
6. **e2e.** `harness.ts` mirrors `apps/cli/src/index.ts` with the `.env.example` defaults (15% slippage, standard landing mode, fast preset, 100k µL/CU floor):
   - It builds and signs the trade with `loadTokenState`, `buildTrade`, `planFees`, `assembleTransaction` and `signAssembled`.
   - It simulates with `sigVerify`, then sends through `SubmitRouter({ dryRun: false })` with one `RpcLane`.
   - It confirms with `confirmSignature` (websocket plus polling) and records a `LatencyTracker` through "landed".

   Three things differ from the CLI, all because the fork is local. The lane's fetch refuses any non-loopback URL, and no Helius or Jito lane is ever built, although the standard-mode tip transfers stay inside the transaction. Tip accounts and the tip floor use the CLI's own fallbacks (the documented tip accounts, lane-minimum tips). The signer is a fresh in-memory WebCrypto keypair per suite, funded by the local faucet; no key is written anywhere.

## What each case asserts

The expected values come from `packages/core`'s quote math over the pre-trade state the transaction was built from. The actual values come from the landed transaction's meta (pre/post lamports and token balances) and the program's own trade event. Nothing else trades on the fork, so every check is exact.

| Case | Checks |
|---|---|
| Curve buy 0.01 SOL, `buy_exact_quote_in_v2`, new Token-2022 ATA | Discriminator; TradeEvent tokens, quote, fees; user and curve token deltas; fee recipient = protocol − buyback, buyback, creator vault deltas; curve SOL = net quote; user SOL = −(total + fee + tips + rent of the new ATA and volume accumulator); post-trade reserves; the ATA is owned by Token-2022 |
| Curve `sell_v2` 50% | The same, for a sell: curve pays the gross quote, user gets the net, nothing is closed |
| Curve full exit + CloseAccount | Sells 100%; the last instruction is a Token-2022 CloseAccount; the ATA is gone; its rent comes back to the user |
| PumpSwap buy 0.01 SOL with wSOL wrap | Instruction order (create wSOL ATA, fund, SyncNative, ..., unwrap); BuyEvent; pool vaults (the LP fee stays in the pool); protocol, buyback and creator quote ATAs; the temporary wSOL account nets to zero; user SOL to the lamport |
| PumpSwap sell 50% | SellEvent, vault and fee-ATA deltas, unwrap to native SOL |
| PumpSwap full exit + close | Base ATA closed and its rent refunded |
| Mayhem buy and exit | 2B supply, reserved fee recipient, then the same exact checks |
| Legacy SPL Token curve coin | Buy and full exit; skipped when the fork has no such coin |

Every trade also checks the fee (5,000 base plus the planned priority fee), that one Helius tip and one Jito tip landed in pre-existing (cloned) tip accounts for exactly the planned amounts, and the latency record through "landed": every stage, the `rpc-127.0.0.1` lane ack, the landed slot and the slot delta. Each new account must hold exactly the fork's rent-exempt minimum, and no account outside the expected set may be created or closed. That second check also catches gaps in the clone list.

## Armed orders (`armed.e2e.ts`)

Three kinds of actor, as on mainnet (`armedKit.ts`):

- **The trading wallet** lives in a real `@zerofee/signer` `Vault` (in memory, test KDF parameters) and signs only through `SignerService` with the shipped `createSignerPolicy()` and a `SpendTracker`. The armed builders sign their batches through an adapter over the same service, so every variant and cancel passes the firewall and is reserved against the daily caps before the vault key signs it. Right before anything is sent, `checkTransaction` runs again on the exact wire bytes, and an armed transaction must advance one of the wallet's own slots.
- **The operator** (a faucet-funded keypair) creates and extends the lookup table. The firewall never sees its transactions, because the trading wallet doesn't sign them.
- **Market wallets** (faucet-funded keypairs) are other traders. They move prices, buy out a curve, and call the permissionless `migrate`. Price moves are sized with core's venue math so a trade hits a target quote exactly, and they never complete a curve by accident.

Orders fire the way the server engine will run them: `evaluateTrigger` with `liveQuoteOut` from `loadTokenState` on the fork; then the pre-submit checks (`hasReservedBalance`, and `detectStaleness` against the observed curve or pool, fee-recipient lists, nonces, table and balance); then `submitted`; then the variant goes through `SubmitRouter` + `RpcLane`; and the landing is applied as `nonce-consumed`. At arming, each order must pass `assertArmable` with the table contents and survive its JSON codec, and the signer's daily totals must move by exactly the order's `capCost`.

| Case | Checks |
|---|---|
| 1. Operator lookup table | Contents = `armedStaticAccounts` of the live Global and GlobalConfig (63 addresses), shareable; create + 3 extends land; decoded contents, authority and status match; the operator pays the table's rent. The suite waits until the last extension is finalized (see Findings) |
| 2. Nonce slots | 10 slots, 4 per tx, `CreateAccountWithSeed` + `InitializeNonceAccount` with the trading wallet the only signer; the firewall summary reports each `nonce_create` at the live rent, under the 0.002 SOL cap; the slots derive from the wallet alone; the wallet paid exactly fees + rent |
| 3. Take-profit, curve | Full exit, 3 min-outs x 2 tips on one nonce. It holds below the target. A market buy lifts the quote past target + margin, and the engine picks the tightest min-out at the lowest tip. The fill equals the engine's live quote to the lamport and clears the signed min-out. TradeEvent; ATA closed and refunded; fee = base + priority; one Jito tip landed; only table addresses were loaded (RecentBlockhashes among them, the nonce account static); the nonce advanced; the order is `filled`. A sibling variant and the cancel are then dead |
| 4. OCO | TP + SL (ladder of 2) share a nonce, so `exclusiveGroups` reserves the position once. The TP fills. The SL on the shared nonce is refused at preflight and dropped when sent blind. `signaturesOnNonce` resolves the consumer; the SL becomes `cancelled` with a `fire-cancel` effect for its second nonce. Running that effect lands the cancel and kills the SL's second-nonce variants |
| 5. Full-exit SL ladder, 3 nonces | A market dump fires the stop; a second dump before landing puts the chosen min-out out of reach. Attempt 1 lands and fails (`sell_v2` 6003): fee = base + priority, tip reverted, tokens kept, nonce consumed, order back to `armed`. Attempt 2 fills exactly; its `fire-cancel` effect targets nonce 3. Attempt 3 is sent anyway, lands and fails harmlessly (3012, account already closed), and its cancel is then dead |
| 6. Cancel | A 3-variant curve limit buy (each variant counts in full against the daily buy cap). `cancel-requested` yields one `fire-cancel`; the cancel lands for 5,000 lamports and 300 CU; all three variants are refused; the attempt is `burned` |
| 7. Stop-loss, PumpSwap | Full exit on the canonical pool, 4 min-outs x 2 tips. A market sale fires it. Exact SellEvent fill above min-out, vault deltas, wSOL unwrapped in the same tx, ATA closed, the nonce advanced, `filled` |
| 8. Migration snipe | Armed against the not-yet-existing canonical pool; the engine holds (`no-quote`) before the buy-out and before `migrate`. A market wallet buys out the curve and calls `migrate`. The CompletePumpAmmMigrationEvent becomes a market event; the engine fires on the new pool's live quote; the BuyEvent fill is exact and above min-out; the buyer pays rent for exactly the accounts that did not exist. Opening reserves equal `estimateMigrationPoolReserves` (base, and real + virtual quote); the snipe fires at exactly its arming quote. Skipped (with a note) when its coin was already migrated on this fork |
| 9. Sizes | Every variant and cancel signed in the run fits in 1,232 bytes. Variants load the operator table with the nonce account static; the size without the table is reported too. The signer's audit log shows every signature, none refused |

## What it proves and what it doesn't

**It proves:**
- Mainnet's real pump, PumpSwap, pump fees, Token, Token-2022 and ATA binaries accept and execute our transactions against real account state: encoding, account lists including remaining accounts, PDAs, token-program detection, idempotent ATAs, wSOL wrap/unwrap, CloseAccount, compute budget and tip layout.
- Our quotes match execution to the lamport, including the fee tier the real fee program returns (pump calls `GetFeesWithQuoteMint` on every trade) and boost pools' virtual quote reserves.
- Fee routing as the programs actually execute it.
- The router → `RpcLane` → `confirmSignature` → `LatencyTracker` path end to end.
- Compute use under mainnet's feature set, and transaction sizes.
- Armed orders as built by `packages/core/src/armed` and signed by the shipped signer policy. Durable-nonce v0 transactions that load the operator table execute against the real programs; one landed attempt per nonce holds, landed failures included; cancels, OCO burns, ladders, the full-exit close guard and the migration snipe behave as the status machine assumes; the trigger engine's quotes equal the fills.

**It doesn't prove:**
- Network latency, landing rate, Sender or Jito acceptance (no relay is involved), or priority-fee competitiveness. The local leader includes everything in the next slot, so "sent → landed" here is about 0.35–0.6 s of local slot timing, not a network figure.
- MEV and sandwich exposure. The fork is static, so slippage only triggers when a suite moves the price itself (the armed ladder does, on purpose).
- That Jito accepts durable-nonce bundles with the `jitodontfront` marker, armed landing rates, or the engine's submit-missed window against real relays. Trailing-stop, DCA and dev-sell triggers, mayhem and cashback armed variants, USDC-quoted coins and two-venue orders are only covered offline.
- Rent costs. The fork charges classic rent, so new accounts cost more there than on mainnet (see Findings): a nonce slot costs 1,447,680 lamports there against about 1,056,640 on mainnet. The suites read rent live from the fork.
- The shipped vault's KDF cost. The armed suite's vault uses test parameters; only the signing path is the real one.
- Anything outside the clone list, upgrades after the clone, or Clock-dependent logic. The fork starts at slot 0 with wall-clock time; no trade path read the slot in these runs.
- The live Jito tip-account list. The fork uses the documented list.

## Findings (2026-10-03, Agave 4.3.0, mainnet slots 453,021,560–453,030,065)

1. **The fork's rent rate is not mainnet's.** Even with `--clone-feature-set`, the test validator's genesis keeps the classic rent rate: 6,960 lamports/byte including the 128-byte overhead (a 0-byte account needs 890,880). Mainnet now charges 5,080 (650,240). Two problems follow, and `fork:start` fixes both:
   - **Rent-paying accounts.** Jito tip accounts are swept down to about the mainnet minimum (690,880 for 8 bytes). On the fork that is "rent-paying" (minimum 946,560), and the runtime rejects any transaction that credits such an account without lifting it to the minimum. In one run, 6 of 8 Jito tip accounts were below the line, so most standard-mode trades would have failed with `InsufficientFundsForRent`.
   - **Program lamport accounting.** pump treats lamports above `rent(len)` as program state. A bonding curve holds rent plus its real SOL, plus tracked extras: a fee-sharing curve held 40.6M lamports beyond both. pump charges the trader whenever the rent cushion falls short. On an un-normalized fork the first buy paid an extra 524,520 lamports ((151 + 128) bytes × the 1,880-lamport rate difference) into the curve, a cost that doesn't exist on mainnet. Topping curves up to `rent + real_quote_reserves` was not enough for the fee-sharing curve. Adding the exact rent difference to every program-owned account (which preserves `lamports − rent`) fixed every coin.
2. **Mayhem coins have no buyback carve-out.** The reserved fee recipient gets the whole protocol fee (93,828 of 93,828 on a 0.01 SOL buy), and the buyback recipient is passed, writable, and gets nothing. The program's own TradeEvent agrees: `buyback_fee_basis_points = 0`, `buyback_fee = 0`. Normal coins split 50/50 (46,914 / 46,914). The research notes say the buyback recipient applies to "all coins". `curveFeeRates` now returns `buybackBps: 0` for mayhem curves; the value is informational and doesn't affect instruction building.
3. **PumpSwap `buy_exact_quote_in` events swap two field meanings.** `quote_amount_in` is the total paid including fees (10,000,000) and `user_quote_amount_in` is the pre-fee quote (9,900,989). For `buy`, the notes record the reverse. `quote_amount_in_with_lp_fee` (9,920,791) and every fee field match our quote. The decoder (`events/types.ts`) documents both meanings.
4. **`ix_name` hides the v2 instructions.** The curve TradeEvent reports `buy_exact_quote_in` and `sell` for `buy_exact_quote_in_v2` and `sell_v2`, so an indexer can't tell v2 from legacy by name.
5. **Coin variants trade unchanged.** The creator fee always lands in the creator vault derived from the live `bonding_curve.creator`. On a holder-rewards coin (`2ssUBRVx…`) that is the holder-rewards PDA, and the event labels the fee `holder_rewards` (30 bps). On a fee-sharing coin (`HtzBLBrV…`) it is the sharing-config PDA.
6. **Smaller confirmations.** Some mayhem curves are 141 bytes, and the program doesn't resize them on trade. The user volume accumulator is 137 bytes and Token-2022 ATAs are 170 bytes, both created at the payer's expense. The PumpSwap buyback split is a floor (2,475 of a 4,951 protocol fee), as the notes say. Fee tiers came from the live FeeConfig through the fee program: 95/30 bps on curves, and 20/5/75 and 20/5/85 bps (LP/protocol/creator) on two pools in different market-cap bands.

### Compute and size (seven forks, six coin sets, fresh wallet each run)

| Case | CU used | CU limit | Size |
|---|---|---|---|
| Curve buy 0.01 SOL, new Token-2022 ATA + volume accumulator | 104,421–116,495 (118,300 on the un-normalized fork) | 140,000 | 1,182 B |
| Curve sell 50% | 72,094–82,662 | 100,000 | 1,139 B |
| Curve full exit + close | 73,807–85,738 | 100,000 | 1,146 B |
| Mayhem buy 0.01 SOL | 104,286–112,841 | 140,000 | 1,182 B |
| Mayhem full exit + close | 73,415–80,615 | 100,000 | 1,146 B |
| PumpSwap buy 0.01 SOL, wSOL wrap, new ATA + volume accumulator | 118,382–131,803 | 150,000 | 1,189 B (1,157 B with an SPL Token base) |
| PumpSwap sell 50% | 87,454–96,408 | 130,000 | 1,090 B (1,058 B) |
| PumpSwap full exit + close | 87,679–99,156 | 130,000 | 1,097 B (1,065 B) |

PumpSwap rows cover both Token-2022-base pools and an SPL Token-base pool (`XLBLxbY1…`, a migrated legacy coin). The SPL-base transactions are 32 bytes smaller because they don't reference the Token-2022 program. CU varies by up to about 13k between identical trades, mostly from PDA bump searches with each new wallet. The worst cases leave 12% headroom on the PumpSwap buy and 14% on a curve sell, less than the "about 1.3× worst case" the `DEFAULT_CU_LIMITS` comment assumes. The largest transaction is 1,189 of 1,232 bytes. Fees were 5,000 base plus 100k µL/CU × CU limit (14,000 / 10,000 / 15,000 / 13,000 lamports), plus 5,000 + 1,000 lamports of tips. Those limits predate the raise to 155k / 115k / 175k / 135k CU; later runs pay 20,500 / 16,500 / 22,500 / 18,500 lamports.

## Armed-order findings (2026-10-03, four forks, two coin sets, mainnet slots 453,103,463–453,108,071)

1. **One landed attempt per nonce holds with the real programs.** A `sell_v2` variant that landed after the price moved past its min-out failed with 6003 (TooLittleSolReceived) and still advanced its nonce. It cost exactly 5,000 + its priority fee (16,500 lamports); its Jito tip reverted with the trade, and the tokens stayed. The ladder's next nonce then filled. The local-validator experiment in `docs/experiments/nonce-failure` shows the same with a stand-in program.
2. **The full-exit close guard works.** A ladder attempt sent after another attempt filled landed and failed at `sell_v2` with 3012 (AccountNotInitialized, since the fill closed the token account). It used 13,116 CU and cost base + priority fee only.
3. **Dead transactions never land and never cost anything.** Once a nonce has moved on, every other transaction signed against it (siblings, OCO partner, cancel) gets `-32002: Transaction simulation failed: Blockhash not found` from the RPC's preflight. Sent without preflight, as the production lanes do, it is dropped: no status, no fee.
4. **Wait for the lookup table's extension to be finalized.** The first armed transaction, sent about 12 slots after the table's last extension (simulation clean, RPC ack ok), only landed 30 slots later through the router's rebroadcasts. Every later one landed in the next slot. After waiting for the extension to be finalized (about 17 s on the fork), the first one landed in the next slot too. That is consistent with the leader resolving tables against a rooted bank when it takes transactions in. The operator should arm against new entries only after their extension is finalized.
   The server engine's run adds the mechanism: the leader's scheduler drops such a transaction outright at parsing and sanitization (`banking_stage_scheduler_slot_counts num_dropped_on_parsing_and_sanitization=1` for every send and re-send), so it is not delayed but lost until the extension is rooted. With the engine's miss window (`ORDERS_MISS_SLOTS`, 8 by default) the cancel then fires and burns the nonce. The engine therefore reads operator tables at `finalized` commitment, and intake verifies orders only against rooted contents.
5. **`migrate` is permissionless and works on the fork** (343,804–356,619 CU, paid by any wallet: 5,000 lamports plus one account's rent). It creates the canonical pool at 287 bytes, below `POOL_ACCOUNT_NEW_SIZE` (300), and buys on that pool execute without `extend_account`, so `migrationPoolContext` rightly leaves it out. In the first run it credited 6,536,641 lamports of the 15,000,001-lamport migration fee to the Global's `withdraw_authority`, so the fork now clones that account.
6. **The boost doesn't move the opening price.** `migrate` parked 17.58 SOL of the curve's quote in the pool's boost vault (the wSOL ATA of PumpSwap PDA `["boost_vault", pool]`) and booked the same amount as virtual quote reserves: 67.41 SOL real + 17.58 SOL virtual. `CompletePumpAmmMigrationEvent.sol_amount` is the sum. `estimateMigrationPoolReserves` used to add the boost on top and overstated the opening price by about 20%. Fixed, it now matches the opening pool's base and effective quote to the unit, on a normal coin and on a holder-rewards coin, and the snipe fired at exactly the quote it was armed with.
7. **The first buy on a fresh pool creates the coin-creator vault's wSOL ATA**, at the buyer's expense (2,039,280 lamports at the fork's rent), and credits the creator fee into it in the same transaction. Callers of `armMigrationSnipe` should reserve rent (`extraReserveLamports`) for that account, the user's base ATA and, on a wallet's first PumpSwap trade, its volume accumulator.
8. **Sizes match the offline matrix to the byte.** With the table: curve sell + close 928 B, curve buy 964 B, PumpSwap sell + close 910 B, migration snipe 971 B, cancel 282 B. Without it: 1,204 / 1,240 / 1,155 / 1,247 B, so both buy shapes overflow 1,232 B.
9. **The signer accepts everything the armed library builds.** Each run, 68 trading-wallet transactions (slot creation, positions, 52 variants, 9 cancels) were signed through `SignerService` with the shipped policy, and none was refused. Every order's `capCost` equalled the change in the `SpendTracker`'s daily totals: fees for all orders, plus 3 × the spend for the 3-variant limit buy and for the snipe. The OCO pair's shared cancel was counted once by both.

| Armed transaction | CU used | CU limit | Size | Fee (lamports) | Tip |
|---|---|---|---|---|---|
| Curve full-exit sell (TP, OCO, ladder fill) | 72,720–77,811 | 115,000 | 928 B | 16,500 | 10,000 Jito |
| Curve sell landed and failed (6003, slippage) | 57,660–59,221 | 115,000 | 928 B | 16,500 | reverted |
| Curve sell after the account was closed (3012) | 13,116 | 115,000 | 928 B | 16,500 | reverted |
| PumpSwap full-exit sell (SL) | 87,268–97,700 | 135,000 | 910 B | 18,500 | 10,000 Jito |
| Migration snipe (PumpSwap buy, fresh pool) | 133,754–145,515 | 175,000 | 971 B | 22,500 | 10,000 Jito |
| Cancel (advance nonce + CU limit) | 300 | 2,000 | 282 B | 5,000 | none |
| Nonce slots, 4 per tx | 375 per slot | 4,000 per slot | 1,028 B | 6,600 + 1,447,680 rent per slot | none |
| Operator: create table / extend +25 / extend +13 | 10,661 / 13,278–13,281 / 9,755 | 20,000 | 292 / 1,092 / 708 B | 5,000 each + 15,312,000 rent (63 addresses) | none |
| Market: buy out a curve (exact tokens) / `migrate` | 110,353–114,314 / 343,804–356,619 | 200,000 / 1,000,000 | 1,072 / 1,046 B | 5,000 | none |

Fees are 5,000 base plus 100k µL/CU × the static CU limit, at the lowest of two tip levels (the trigger policy's default). The headroom on the snipe was only 17% in the worst run (holder-rewards coin), less than the 1.3× that `DEFAULT_CU_LIMITS` assumes. On mainnet, the slot rent is about 1,056,640 lamports and the 63-address table about 11.2M. After the table wait, every armed transaction landed in the next slot (0.4–0.55 s, local slot timing).

## The server's armed-orders engine (`apps/server/e2e/armed.e2e.ts`)

`bun run fork:start`, then `bun run e2e:orders` (same `FORK_DIR`). The whole server runs against the fork: RPC-logs ingest into `MarketState`, program accounts, the PGlite accounts layer and the order engine with `DRY_RUN=false`. Its protected lane is an `RpcLane` to the fork through a loopback-only fetch, since Jito does not exist there. The browser side signs in with SIWS, registers the trading wallet and POSTs orders armed with `@zerofee/core`.

| Case | Checks |
|---|---|
| Take-profit fires | Intake accepts a full-exit take-profit (signatures, live nonce value and the finalized operator table checked against the fork). Another wallet pumps the price; the engine sees the trade on the logs stream, quotes the order, submits the chosen variant, sees the nonce advance and resolves `filled` from the signature status. The token account is closed and the wallet received at least the variant's min-out net of fees |
| Missed attempt | The protected lane accepts and drops every variant of an order whose trigger already holds. After `ORDERS_MISS_SLOTS` the engine fires the pre-signed cancel, which lands; the order is `failed-consumed`, the tokens never moved and the nonce advanced |
| Panic | `POST /api/orders/panic` fires a parked order's cancel; it lands and the order closes as `cancelled` |

## Safety

- The mainnet RPC client refuses every method that isn't a read (`getAccountInfo`, `getMinimumBalanceForRentExemption`, `getMultipleAccounts`, `getSignaturesForAddress`, `getTransaction`, `getSlot`, `getVersion`).
- Every e2e send goes through `SubmitRouter` with `dryRun: false`, which is set explicitly and only against the fork. The single `RpcLane` uses a fetch that throws on any non-loopback URL, and the harness refuses non-loopback `FORK_RPC_URL` / `FORK_WS_URL`. The armed suite's preflight check uses a second loopback-only `RpcLane`.
- Keys exist only in memory: the trading wallet's in an in-memory vault, the operator's and market wallets' as WebCrypto keypairs. All of them are funded by the fork's faucet. The ledger lives in the OS temp dir.
- `fork:stop` signals the process only after confirming the pid really is a `solana-test-validator`. It deletes files only inside a directory `fork:start` created (marker file), never a home, temp or working-directory root.
