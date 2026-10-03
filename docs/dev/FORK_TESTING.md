# Mainnet-fork testing

A local `solana-test-validator` runs **mainnet's exact program binaries** against **cloned mainnet state** for a few live coins. The e2e suite builds each trade the way the CLI does, sends it through the router, and checks the landed transaction against our local quote, to the lamport. No real money moves and nothing is sent to mainnet: mainnet RPC is only read, to clone accounts.

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

`fork:start` takes about 30–45 s. Most of that is finding live coins on the rate-limited public RPC. It prints the env the suite uses and leaves the validator running in the background until `fork:stop`.

| Command | What it does |
|---|---|
| `bun run fork:start` | Picks coins from recent on-chain activity, clones them, starts the validator |
| `bun run fork:start <mint> ...` | Uses these coins instead (active curve or migrated PumpSwap coins) |
| `bun run fork:start --reuse` | Re-forks the previous run's coins with fresh mainnet state |
| `bun run fork:start --no-feature-set` | Keeps the test validator's default features instead of cloning mainnet's |
| `bun run fork:accounts [mint ...]` | Prints the chosen coins and the full clone list as JSON; starts nothing |
| `bun run e2e [-t pattern]` | Runs `packages/core/e2e/*.e2e.ts`, then prints a CU / size / fee / latency table. Extra args go to `bun test` |
| `bun run fork:stop [--keep-ledger]` | Stops the validator and deletes the ledger. `fork.json` is kept for `--reuse` |

| Env | Default | Purpose |
|---|---|---|
| `FORK_DIR` | `<os tmpdir>/zerofee-terminal-fork` | Ledger, logs, `fork.json` manifest, e2e report. Kept outside the repo; `.fork/` is gitignored if you put it inside |
| `FORK_RPC_PORT` | `18899` (websocket +1) | Away from the usual 8899, so other validators can run alongside |
| `FORK_CLONE_URL` | `https://api.mainnet-beta.solana.com` | Read-only mainnet RPC for discovery and cloning. It appears on the validator's command line, so avoid keyed URLs on shared machines |
| `FORK_START_TIMEOUT_MS` | `240000` | Health-check deadline |
| `FORK_RPC_URL`, `FORK_WS_URL` | from `fork.json` | e2e overrides; loopback only |

The e2e files are named `*.e2e.ts`, which `bun test` doesn't pick up, so the default test run and CI stay offline.

## How it works

1. **Coins.** `accounts.ts` reads recent pump trades to find an active Token-2022 (`create_v2`) curve coin, finds a mayhem coin through recent Mayhem-program activity, and picks a canonical wSOL PumpSwap pool, preferring an SPL Token base. A legacy SPL Token curve coin is used only if one shows up along the way, since they're rare after `create_v2`. The public endpoint allows about 5 `getTransaction` calls per 10 s, so discovery stops as soon as each kind is found (about 10 transactions in total).
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

   On 2026-10-03 that was 6 programs, 59 accounts and 24 optional accounts, 20 of which existed. User-side accounts (ATAs, volume accumulators) are created by the trades themselves.
3. **Validator.** It runs with `--reset --bind-address 127.0.0.1 --clone-feature-set` and a fresh ledger in `FORK_DIR`, detached. `--clone-feature-set` matters: by default the test validator turns on every feature, including the 37 that mainnet hasn't activated.
4. **Checks.** Every required clone must exist on the fork. Every program's ELF must be byte-identical to mainnet's: the validator zeroes the deploy slot in the programdata header, so only bytes after the 45-byte header are hashed. The hashes go into `fork.json`.
5. **Rent normalization** (see Findings). Cloned accounts that satisfy mainnet's rent rules but break the fork's are topped up, and each top-up is recorded in `fork.json`. Trade math never reads these lamports.
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

## What it proves and what it doesn't

**It proves:**
- Mainnet's real pump, PumpSwap, pump fees, Token, Token-2022 and ATA binaries accept and execute our transactions against real account state: encoding, account lists including remaining accounts, PDAs, token-program detection, idempotent ATAs, wSOL wrap/unwrap, CloseAccount, compute budget and tip layout.
- Our quotes match execution to the lamport, including the fee tier the real fee program returns (pump calls `GetFeesWithQuoteMint` on every trade) and boost pools' virtual quote reserves.
- Fee routing as the programs actually execute it.
- The router → `RpcLane` → `confirmSignature` → `LatencyTracker` path end to end.
- Compute use under mainnet's feature set, and transaction sizes.

**It doesn't prove:**
- Network latency, landing rate, Sender or Jito acceptance (no relay is involved), or priority-fee competitiveness. The local leader includes everything in the next slot, so "sent → landed" here is about 0.35–0.6 s of local slot timing, not a network figure.
- MEV and sandwich exposure, or behaviour when state moves between quote and execution. The fork is static, so slippage never triggers.
- Rent costs. The fork charges classic rent, so new accounts cost more there than on mainnet (see Findings). The suite reads rent live from the fork.
- Anything outside the clone list, upgrades after the clone, or Clock-dependent logic. The fork starts at slot 0 with wall-clock time; no trade path read the slot in these runs.
- The live Jito tip-account list. The fork uses the documented list.

## Findings (2026-10-03, Agave 4.3.0, mainnet slots 453,021,560–453,026,107)

1. **The fork's rent rate is not mainnet's.** Even with `--clone-feature-set`, the test validator's genesis keeps the classic rent rate: 6,960 lamports/byte including the 128-byte overhead (a 0-byte account needs 890,880). Mainnet now charges 5,080 (650,240). Two problems follow, and `fork:start` fixes both:
   - **Rent-paying accounts.** Jito tip accounts are swept down to about the mainnet minimum (690,880 for 8 bytes). On the fork that is "rent-paying" (minimum 946,560), and the runtime rejects any transaction that credits such an account without lifting it to the minimum. In one run, 6 of 8 Jito tip accounts were below the line, so most standard-mode trades would have failed with `InsufficientFundsForRent`.
   - **Bonding-curve cushion.** pump keeps every bonding curve at exactly `rent(len) + real_quote_reserves` lamports (true on mainnet for both 141- and 151-byte curves) and charges the trader any shortfall. On an un-normalized fork the first buy paid an extra 524,520 lamports ((151 + 128) bytes × the 1,880-lamport rate difference) into the curve, a cost that doesn't exist on mainnet. The fix is to top every curve up to the fork's `rent(len) + real_quote_reserves`.
2. **Mayhem coins have no buyback carve-out.** The reserved fee recipient gets the whole protocol fee (93,828 of 93,828 on a 0.01 SOL buy). The buyback recipient is passed, writable, and gets nothing. Normal coins split 50/50 (46,914 / 46,914). The research notes say the buyback recipient applies to "all coins". `curveFeeRates` now returns `buybackBps: 0` for mayhem curves; the value is informational and doesn't affect instruction building.
3. **PumpSwap `buy_exact_quote_in` events swap two field meanings.** `quote_amount_in` is the total paid including fees (10,000,000) and `user_quote_amount_in` is the pre-fee quote (9,900,989). For `buy`, the notes record the reverse. `quote_amount_in_with_lp_fee` (9,920,791) and every fee field match our quote. The decoder documents both meanings.
4. **Smaller confirmations.** Some mayhem curves are 141 bytes, and the program doesn't resize them on trade. The user volume accumulator is 137 bytes and Token-2022 ATAs are 170 bytes, both created at the payer's expense. The PumpSwap buyback split is a floor (2,475 of a 4,951 protocol fee), as the notes say. Fee tiers came from the live FeeConfig through the fee program: 95/30 bps on the curve, and 20/5/75 bps on a pool in the 4,420–9,820 SOL band.

5. **Holder-rewards coins trade unchanged.** The creator fee lands in the creator vault derived from the live creator (the holder-rewards PDA). Verified on `2ssUBRVx…` as the curve coin of a fourth fork.

### Compute and size (four forks, three coin sets, fresh wallet each run)

| Case | CU used | CU limit | Size |
|---|---|---|---|
| Curve buy 0.01 SOL, new Token-2022 ATA + volume accumulator | 104,421–116,495 (118,300 on the un-normalized fork) | 140,000 | 1,182 B |
| Curve sell 50% | 72,094–82,562 | 100,000 | 1,139 B |
| Curve full exit + close | 73,807–85,738 | 100,000 | 1,146 B |
| Mayhem buy 0.01 SOL | 104,286–112,841 | 140,000 | 1,182 B |
| Mayhem full exit + close | 73,415–79,440 | 100,000 | 1,146 B |
| PumpSwap buy 0.01 SOL, wSOL wrap, new ATA + volume accumulator | 118,382–131,803 | 150,000 | 1,189 B |
| PumpSwap sell 50% | 90,146–96,408 | 130,000 | 1,090 B |
| PumpSwap full exit + close | 88,775–99,156 | 130,000 | 1,097 B |

CU varies by up to about 13k between identical trades, mostly from PDA bump searches with each new wallet. The worst cases leave 12% headroom on the PumpSwap buy and 14% on a curve sell, less than the "about 1.3× worst case" the `DEFAULT_CU_LIMITS` comment assumes. The largest transaction is 1,189 of 1,232 bytes. Fees were 5,000 base plus 100k µL/CU × CU limit (14,000 / 10,000 / 15,000 / 13,000 lamports), plus 5,000 + 1,000 lamports of tips.

## Safety

- The mainnet RPC client refuses every method that isn't a read (`getAccountInfo`, `getMultipleAccounts`, `getSignaturesForAddress`, `getTransaction`, `getSlot`, `getVersion`).
- Every e2e send goes through `SubmitRouter` with `dryRun: false`, which is set explicitly and only against the fork. The single `RpcLane` uses a fetch that throws on any non-loopback URL, and the harness refuses non-loopback `FORK_RPC_URL` / `FORK_WS_URL`.
- Keys exist only in memory. The ledger lives in the OS temp dir.
- `fork:stop` signals the process only after confirming the pid really is a `solana-test-validator`. It deletes files only inside a directory `fork:start` created (marker file), never a home, temp or working-directory root.
