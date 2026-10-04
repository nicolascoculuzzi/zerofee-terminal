/**
 * Fakes for the armed-order engine tests, all offline: a programmable chain (nonce accounts, balances,
 * signature statuses), a recording submitter that never touches a network, a market on the real curve
 * math, and a kill switch.
 */
import type { Address } from "@solana/kit";
import {
  type LiveMarketState,
  liveQuoteOut,
  type SignedTx,
  type StalenessObservation,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  WSOL_MINT,
} from "@zerofee/core";
import type { HaltState } from "@zerofee/protocol";
import type { AddressSignature, ChainReader, SignatureStatus, Simulation } from "../src/orders/chain";
import type { SendReport, Submitter } from "../src/orders/lanes";
import type { MarketQuote, OrderMarket, RecipientLists } from "../src/orders/market";
import type { RpcAccount } from "../src/util/rpc";
import { CREATOR, nonceAccountData, nonceValueOf, tokenAccountData } from "./orderFixtures";

/** A programmable ChainReader: every call is recorded; nothing leaves the process. */
export class FakeChain implements ChainReader {
  slot = 1_000;
  readonly nonces = new Map<string, { authority: string; value: string } | null>();
  readonly lamports = new Map<string, bigint>();
  readonly tokens = new Map<string, { mint: string; owner: string; amount: bigint }>();
  readonly raw = new Map<string, RpcAccount | null>();
  readonly statuses = new Map<string, SignatureStatus>();
  readonly history = new Map<string, AddressSignature[]>();
  readonly simulations: string[] = [];
  readonly calls: { method: string; arg: unknown }[] = [];
  failAccounts = false;
  simulation: Simulation = { err: null, logs: ["Program log: ok"], unitsConsumed: 90_000, slot: 1_000 };

  setNonce(account: string, authority: string, value: string): void {
    this.nonces.set(account, { authority, value });
  }

  /** Lands `signature` (confirmed) and advances the nonce it consumed. */
  land(signature: string, o: { nonce?: string; newValue?: string; err?: unknown } = {}): void {
    this.statuses.set(signature, { slot: this.slot, err: o.err ?? null, confirmationStatus: "confirmed" });
    if (o.nonce) {
      const cur = this.nonces.get(o.nonce);
      if (cur) this.nonces.set(o.nonce, { ...cur, value: o.newValue ?? nonceValueOf(`advanced:${signature}`) });
      this.history.set(o.nonce, [{ signature, slot: this.slot, err: o.err ?? null }, ...(this.history.get(o.nonce) ?? [])]);
    }
  }

  async accounts(addresses: readonly string[]): Promise<{ slot: number; accounts: (RpcAccount | null)[] }> {
    this.calls.push({ method: "accounts", arg: [...addresses] });
    if (this.failAccounts) throw new Error("rpc down");
    return {
      slot: this.slot,
      accounts: addresses.map((a) => {
        if (this.raw.has(a)) return this.raw.get(a) ?? null;
        const n = this.nonces.get(a);
        if (n)
          return { address: a as Address, owner: SYSTEM_PROGRAM_ID, lamports: 1_447_680n, data: nonceAccountData(n.authority, n.value) };
        if (n === null) return null;
        const t = this.tokens.get(a);
        if (t)
          return {
            address: a as Address,
            owner: TOKEN_2022_PROGRAM_ID,
            lamports: 2_039_280n,
            data: tokenAccountData(t.mint, t.owner, t.amount),
          };
        const l = this.lamports.get(a);
        if (l !== undefined) return { address: a as Address, owner: SYSTEM_PROGRAM_ID, lamports: l, data: new Uint8Array(0) };
        return null;
      }),
    };
  }

  async signatureStatuses(signatures: readonly string[]): Promise<(SignatureStatus | null)[]> {
    this.calls.push({ method: "signatureStatuses", arg: [...signatures] });
    return signatures.map((s) => this.statuses.get(s) ?? null);
  }

  async signaturesForAddress(address: string, limit: number): Promise<AddressSignature[]> {
    this.calls.push({ method: "signaturesForAddress", arg: address });
    return (this.history.get(address) ?? []).slice(0, limit);
  }

  async simulate(wireBase64: string): Promise<Simulation> {
    this.calls.push({ method: "simulate", arg: wireBase64 });
    this.simulations.push(wireBase64);
    return this.simulation;
  }
}

/** A Submitter that records instead of sending (live-mode tests); `dryRun` mimics the simulator. */
export class RecordingSubmitter implements Submitter {
  readonly variants: string[] = [];
  readonly cancels: SignedTx[] = [];
  accept = true;

  constructor(readonly dryRun = false) {}

  private report(): SendReport {
    return {
      dryRun: this.dryRun,
      ok: this.accept,
      lanes: this.dryRun
        ? []
        : [{ lane: "test-protected", ok: this.accept, error: this.accept ? null : "rejected", ackMs: 1, bundleId: null }],
      simulation: null,
      error: this.accept ? null : "no lane accepted it",
    };
  }

  async sendVariant(wireBase64: string): Promise<SendReport> {
    this.variants.push(wireBase64);
    return this.report();
  }

  async sendCancel(cancel: SignedTx): Promise<SendReport> {
    this.cancels.push(cancel);
    return this.report();
  }
}

// ---------------------------------------------------------------------------------------------
// market
// ---------------------------------------------------------------------------------------------

/** A pump curve market on global fallback rates (no FeeConfig): enough for consistent quotes. */
export function curveMarket(
  o: { vQuote?: bigint; vToken?: bigint; rToken?: bigint; complete?: boolean; creator?: string } = {},
): LiveMarketState {
  return {
    venue: "pump",
    curve: {
      virtualTokenReserves: o.vToken ?? 1_000_000_000_000_000n,
      virtualQuoteReserves: o.vQuote ?? 40_000_000_000n,
      realTokenReserves: o.rToken ?? 700_000_000_000_000n,
      realQuoteReserves: 10_000_000_000n,
      complete: o.complete ?? false,
      creator: (o.creator ?? CREATOR) as Address,
      isMayhemMode: false,
      quoteMint: WSOL_MINT,
      creatorFeeBps: 0n,
    },
    global: { feeBasisPoints: 95n, creatorFeeBasisPoints: 30n, creatorFeeConfigurable: false, buybackBasisPoints: 5_000n },
    feeConfig: null,
    mintSupply: 1_000_000_000_000_000n,
  };
}

/** Quote out of `amount` on `market` (the number the engine compares triggers against). */
export function quoteOf(side: "buy" | "sell", amount: bigint, market: LiveMarketState): bigint {
  const q = liveQuoteOut(side, amount, market);
  if (q === null) throw new Error("not quotable");
  return q;
}

export class FakeMarket implements OrderMarket {
  readonly quotes = new Map<string, MarketQuote>();
  readonly facts = new Map<string, Pick<StalenessObservation, "curve" | "pool">>();
  readonly migratedMints = new Set<string>();
  recipientLists: RecipientLists = {};
  tipFloor: bigint | null = null;
  currentSlot: number | null = 1_000;

  setCurve(mint: string, market: LiveMarketState): void {
    this.quotes.set(mint, { venue: market.venue, market });
  }

  quote(mint: string): MarketQuote | null {
    return this.quotes.get(mint) ?? null;
  }

  coinFacts(mint: string): Pick<StalenessObservation, "curve" | "pool"> {
    return this.facts.get(mint) ?? {};
  }

  recipients(): RecipientLists {
    return this.recipientLists;
  }

  symbol(_mint: string): string | null {
    return "TEST";
  }

  migrated(mint: string): boolean {
    return this.migratedMints.has(mint);
  }

  jitoTipFloorLamports(): bigint | null {
    return this.tipFloor;
  }

  slot(): number | null {
    return this.currentSlot;
  }
}

export class FakeHalt {
  state: HaltState = { halted: false, reason: null, since: null };
  private readonly fns: ((s: HaltState) => void)[] = [];

  isHalted(): boolean {
    return this.state.halted;
  }

  onChange(fn: (s: HaltState) => void): void {
    this.fns.push(fn);
  }

  set(halted: boolean, reason: string | null = null): void {
    this.state = { halted, reason, since: halted ? 1 : null };
    for (const fn of this.fns) fn(this.state);
  }
}
