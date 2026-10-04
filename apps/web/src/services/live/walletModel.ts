/**
 * `wallet:<address>` (packages/protocol account.ts: lamports, token balances, recent fills) to the UI's
 * WalletStatus (balances, positions, activity).
 *
 * Balances come from the chain (authoritative). Cost basis, realized PnL and entry prices come from the
 * fills the server observed for the wallet (its trade history window plus everything live since): a
 * position whose buys predate that window has an unknown basis, shown as "–", never a guess. Fees per
 * fill are not in the feed, so position fees are unknown too. SOL deposits and withdrawals are not fills
 * and do not appear in the activity list.
 */
import type { WalletTokenBalance, Trade as WireTrade } from "@zerofee/protocol";
import type { ActivityItem, Position, TokenSummary, WalletDelta, WalletStatus } from "../../protocol";
import { uiAmount } from "./adapters";

export interface WalletModelHost {
  /** Live summary of a token (symbol, price, market cap), when the client has one. */
  token(mint: string): TokenSummary | null;
  /** SOL reserved by this wallet's open armed orders, and nonce slots in use / known. */
  reserved(address: string): { sol: number; nonceUsed: number; nonceTotal: number };
}

const FILLS_MAX = 500;

export class WalletModel {
  private lamports = 0n;
  private readonly tokens = new Map<string, WalletTokenBalance>();
  private fills: WireTrade[] = [];
  private ready = false;

  constructor(
    readonly address: string,
    private readonly host: WalletModelHost,
  ) {}

  get loaded(): boolean {
    return this.ready;
  }

  applySnapshot(s: { lamports: string; tokens: WalletTokenBalance[]; fills: WireTrade[] }): WalletStatus {
    this.lamports = BigInt(s.lamports);
    this.tokens.clear();
    for (const t of s.tokens) this.tokens.set(t.mint, t);
    this.fills = [...s.fills].sort((a, b) => b.blockTime - a.blockTime || b.slot - a.slot).slice(0, FILLS_MAX);
    this.ready = true;
    return this.status();
  }

  /** Applies a wire delta; returns the UI delta (changed positions and new activity only). */
  applyDelta(d: { lamports?: string; tokens?: WalletTokenBalance[]; closed?: string[]; fills?: WireTrade[] }): WalletDelta {
    const touched = new Set<string>();
    const out: WalletDelta = {};
    if (d.lamports !== undefined) {
      this.lamports = BigInt(d.lamports);
      out.solBalance = uiAmount(this.lamports, 9);
    }
    for (const t of d.tokens ?? []) {
      this.tokens.set(t.mint, t);
      touched.add(t.mint);
    }
    for (const account of d.closed ?? []) {
      for (const [mint, t] of this.tokens) {
        if (t.account === account) {
          this.tokens.delete(mint);
          touched.add(mint);
        }
      }
    }
    if (d.fills?.length) {
      const seen = new Set(this.fills.map((f) => f.id));
      const fresh = d.fills.filter((f) => !seen.has(f.id)).reverse(); // wire: oldest first
      this.fills = [...fresh, ...this.fills].slice(0, FILLS_MAX);
      for (const f of fresh) touched.add(f.mint);
      if (fresh.length) out.activity = fresh.map((f) => this.activity(f));
    }
    if (touched.size) out.positions = [...touched].map((m) => this.position(m)).filter((p): p is Position => p !== null);
    const r = this.host.reserved(this.address);
    out.reservedSol = r.sol;
    out.nonceSlots = { used: r.nonceUsed, total: r.nonceTotal };
    return out;
  }

  /** Positions re-valued at the latest prices (call when prices moved). */
  revalue(): Position[] {
    return this.mints()
      .map((m) => this.position(m))
      .filter((p): p is Position => p !== null);
  }

  status(): WalletStatus {
    const r = this.host.reserved(this.address);
    return {
      address: this.address,
      solBalance: uiAmount(this.lamports, 9),
      reservedSol: r.sol,
      nonceSlots: { used: r.nonceUsed, total: r.nonceTotal },
      positions: this.revalue().sort((a, b) => (b.lastTradeAt || 0) - (a.lastTradeAt || 0)),
      activity: this.fills.map((f) => this.activity(f)),
    };
  }

  /** Base units the wallet holds of `mint` (for sells). */
  balanceOf(mint: string): { amount: bigint; decimals: number; account: string } | null {
    const t = this.tokens.get(mint);
    return t ? { amount: BigInt(t.amount), decimals: t.decimals, account: t.account } : null;
  }

  private mints(): string[] {
    const set = new Set<string>();
    for (const [mint, t] of this.tokens) if (BigInt(t.amount) > 0n) set.add(mint);
    for (const f of this.fills) set.add(f.mint);
    return [...set];
  }

  private activity(f: WireTrade): ActivityItem {
    const t = this.host.token(f.mint);
    const rate = f.amountUsd !== null && f.amountSol > 0 ? f.amountUsd / f.amountSol : Number.NaN;
    return {
      id: f.id,
      kind: f.side,
      mint: f.mint,
      symbol: t?.symbol ?? null,
      solAmount: f.amountSol,
      tokenAmount: uiAmount(f.tokenAmount, this.tokens.get(f.mint)?.decimals ?? t?.decimals ?? 6),
      marketCapUsd: Number.isFinite(rate) ? f.mcSol * rate : null,
      ts: f.blockTime,
      signature: f.signature,
    };
  }

  private position(mint: string): Position | null {
    const t = this.host.token(mint);
    const bal = this.tokens.get(mint);
    const decimals = bal?.decimals ?? t?.decimals ?? 6;
    const holding = bal ? uiAmount(bal.amount, decimals) : 0;
    const fills = this.fills.filter((f) => f.mint === mint);
    if (!fills.length && holding <= 0) return null;
    let boughtSol = 0;
    let soldSol = 0;
    let boughtTokens = 0;
    let soldTokens = 0;
    // Weighted-average cost over the observed fills, oldest first.
    let costTokens = 0;
    let costSol = 0;
    let realized = 0;
    for (const f of [...fills].reverse()) {
      const tokens = uiAmount(f.tokenAmount, decimals);
      if (f.side === "buy") {
        boughtSol += f.amountSol;
        boughtTokens += tokens;
        costTokens += tokens;
        costSol += f.amountSol;
      } else {
        soldSol += f.amountSol;
        soldTokens += tokens;
        if (costTokens > 0) {
          const avg = costSol / costTokens;
          const n = Math.min(tokens, costTokens);
          realized += f.amountSol * (n / tokens) - avg * n;
          costSol -= avg * n;
          costTokens -= n;
        }
      }
    }
    // The chain balance is the truth; a basis is only known when the observed buys cover it.
    const basisKnown = boughtTokens > 0 && costTokens + 1e-9 >= holding;
    const avgEntry = boughtTokens > 0 ? boughtSol / boughtTokens : Number.NaN;
    const costBasis = holding <= 0 ? 0 : basisKnown ? (costSol / costTokens) * holding : Number.NaN;
    const price = t?.priceSol ?? Number.NaN;
    const value = holding * price;
    const last = fills[0];
    const first = fills[fills.length - 1];
    return {
      mint,
      symbol: t?.symbol ?? "",
      name: t?.name ?? "",
      imageUri: t?.imageUri ?? null,
      launchpad: t?.launchpad ?? "other",
      boughtSol,
      soldSol,
      boughtTokens,
      soldTokens,
      holdingTokens: holding,
      avgEntryPriceSol: avgEntry,
      avgExitPriceSol: soldTokens > 0 ? soldSol / soldTokens : null,
      costBasisSol: costBasis,
      realizedPnlSol: boughtTokens > 0 ? realized : Number.NaN,
      unrealizedPnlSol: holding <= 0 ? 0 : value - costBasis,
      valueSol: value,
      feesSol: Number.NaN,
      openedAt: first?.blockTime ?? Number.NaN,
      lastTradeAt: last?.blockTime ?? Number.NaN,
      closed: holding <= 0,
    };
  }
}
