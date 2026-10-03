# zerofee-terminal

An Axiom-style Solana memecoin trading terminal with **zero platform fees**. You keep your keys.

- **Log in with your wallet.** Sign one message with Phantom, Solflare or Backpack. No email or password.
- **Trade instantly.** A trading wallet is created and encrypted in your browser, and it signs trades with no popup. Your keys never touch our servers.
- **All the terminal features:** a three-column live token feed with filters, one-click and hotkey trading, limit/TP/SL and migration orders that keep running with the tab closed, wallet and X trackers, copy trading, PnL.
- **MEV protection on by default,** sent through routes where it actually applies.

**What you still pay:** what the chain charges. That's venue fees (pump.fun takes 1.25% per side on the bonding curve; no terminal can remove it), network fees and tips (usually tiny), and refundable rent. Other terminals add 0.75–1% on every buy and sell on top of that.

## Status

Early build. Phase 1, the trade engine, works in dry-run: pump.fun bonding-curve and PumpSwap buys and sells, built locally and simulated against mainnet, with fills matching our quotes exactly. The wallet layer, web UI and live data feed are next. See [SPEC.md](SPEC.md) for the full plan, feature checklist and phases.

## Quick start (developers)

Requires [Bun](https://bun.sh) 1.3+.

```bash
bun install
```

```bash
bun test
```

```bash
cp .env.example .env
```

Dry-run a trade. This builds and simulates against mainnet and **never sends** while `DRY_RUN=true`, which is the default. `SIMULATE_AS` lets you simulate as any address that holds SOL, with no key needed:

```bash
SIMULATE_AS=<address-with-SOL> bun run trade buy <mint> 0.01
```

```bash
SIMULATE_AS=<address-holding-the-token> bun run trade sell <mint> 50
```

**Sending real trades:** put a throwaway dev wallet's key in `.env` (`WALLET_PRIVATE_KEY`), keep only what you'd lose on it, and set `DRY_RUN=false`. `MAX_BUY_SOL` and `MAX_DAILY_SPEND_SOL` are hard caps. Latency measurements go in [NOTES.md](NOTES.md).

## Docs

- [SPEC.md](SPEC.md): architecture, security rules, stack, feature checklist, phases
- [Research report](docs/reports/Solana%20trading%20terminal%20teardown.md): how Axiom and its competitors work, pump.fun internals, transaction landing and MEV, data feeds, token analytics, costs
- [Raw research notes](docs/research_notes/): every claim with its source

## Safety

- The operator never holds user keys.
- Every transaction your browser signs goes through a signer firewall first.
- Keep only what you're willing to lose in the trading wallet.
- Never paste a private key into chat, support DMs or a site that isn't the canonical domain.
