# Experiment: does a failed durable-nonce transaction advance the nonce?

**Result (2026-10-03, local `solana-test-validator` 4.3.0, Agave):** yes.

| Case | Outcome |
|---|---|
| A: nonce tx lands, 2nd instruction fails (transfer > balance) | `InstructionError [1, Custom 1]`; fee 5,000 lamports charged; **nonce advanced** |
| B: replay the same signed tx | Rejected, no extra fee |
| C: control, successful nonce tx | Landed; nonce advanced |

Consequence for armed orders: one landed attempt per nonce. See SPEC.md → Armed orders.

## Rerun

Use a throwaway folder outside the repo. Keypairs are generated in memory; only local or devnet SOL is used.

```bash
bun add @solana/kit@^8.4.0 @solana-program/system
```

```bash
solana-test-validator --reset --quiet --ledger ./ledger
```

```bash
RPC_URL=http://127.0.0.1:8899 WS_URL=ws://127.0.0.1:8900 bun run test.ts
```

The public devnet faucet works too (omit the env vars), but it is often rate-limited.
