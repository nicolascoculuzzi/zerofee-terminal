import type { Address, ReadonlyUint8Array } from "@solana/kit";

export interface FirewallCaps {
  /** Max lamports sent to tip accounts in one transaction (sum of all tip transfers). */
  readonly maxTipLamports: bigint;
  /** Max priority fee: ceil(SetComputeUnitPrice x compute unit limit / 1e6) lamports. */
  readonly maxPriorityFeeLamports: bigint;
  /** Max SetComputeUnitLimit. */
  readonly maxComputeUnitLimit: number;
  /** Max SOL (lamports) committed by the buy instructions of one transaction (SOL / wSOL quote). */
  readonly maxBuyLamports: bigint;
  /** Same, per non-SOL quote mint (base units). A quote mint without an entry cannot be bought with. */
  readonly maxBuyQuote: Readonly<Record<string, bigint>>;
}

/** Address lookup table contents by table address. Untrusted input: see decode.ts. */
export type AddressLookupTables = ReadonlyMap<string, readonly string[]> | Readonly<Record<string, readonly string[]>>;

export interface FirewallContext {
  /** The trading wallet that will sign. Must be the fee payer and the only signer. */
  readonly signer: Address;
  /** The user's main wallet: the only unlimited SOL / token destination. */
  readonly connectedWallet: Address;
  /** Durable nonce accounts the signer is the authority of. */
  readonly ownedNonceAccounts: readonly Address[];
  /** Every top-level program must be listed here (and must also have a rule). */
  readonly allowedPrograms: readonly Address[];
  /** Jito / Helius Sender tip accounts. */
  readonly tipAccounts: readonly Address[];
  readonly caps: FirewallCaps;
  /** Contents of every lookup table the transaction references. A missing table is a refusal. */
  readonly addressLookupTables?: AddressLookupTables;
  /** Rules for venue programs (pump.fun, PumpSwap, ...). */
  readonly venueRules?: readonly VenueRule[];
}

/** One account slot of an instruction, with its role in the message. */
export interface AccountRef {
  readonly address: Address;
  /** Index in the transaction's full account list (static keys, then ALT writable, then ALT readonly). */
  readonly index: number;
  readonly isSigner: boolean;
  readonly isWritable: boolean;
  /** False when the address came from an address lookup table (its identity is then only as good as the ALT data we were given). */
  readonly isStatic: boolean;
}

export interface DecodedInstruction {
  /** Position in the transaction. */
  readonly index: number;
  readonly programAddress: Address;
  readonly accounts: readonly AccountRef[];
  readonly data: ReadonlyUint8Array;
}

export interface DecodedTransaction {
  readonly version: "legacy" | 0;
  readonly messageBytes: ReadonlyUint8Array;
  readonly feePayer: Address;
  readonly accounts: readonly AccountRef[];
  readonly instructions: readonly DecodedInstruction[];
  /** Recent blockhash, or the nonce value for durable-nonce transactions. */
  readonly lifetimeToken: string;
  readonly lookupTableAddresses: readonly Address[];
}

/** Helpers available to every rule. */
export interface RuleEnv {
  readonly ctx: FirewallContext;
  readonly tx: DecodedTransaction;
  /** Associated token address (cached per check). */
  ata(owner: Address, mint: Address, tokenProgram: Address): Promise<Address>;
}

export interface TradeAction {
  readonly kind: "trade";
  readonly venue: string;
  readonly instruction: string;
  readonly side: "buy" | "sell";
  readonly baseMint: Address;
  /** wSOL for SOL-quoted trades. */
  readonly quoteMint: Address;
  /** Buys: the capped amount argument (max quote spent, fees included). */
  readonly maxQuoteIn?: bigint;
  /** Buys: tokens out (exact or minimum). Sells: tokens in. */
  readonly baseAmount: bigint;
  readonly baseAmountIs: "exact_out" | "min_out" | "exact_in";
  /** Sells: minimum quote received. */
  readonly minQuoteOut?: bigint;
}

export type SummaryAction =
  | TradeAction
  | { readonly kind: "tip"; readonly to: Address; readonly lamports: bigint }
  | {
      readonly kind: "sol_transfer";
      readonly to: Address;
      readonly lamports: bigint;
      readonly destination: "connected_wallet" | "own_wsol_account";
    }
  | {
      readonly kind: "token_transfer";
      readonly mint: Address;
      readonly amount: bigint;
      readonly decimals: number;
      readonly to: Address;
      readonly destination: "own_token_account" | "connected_wallet_token_account";
    }
  | { readonly kind: "close_account"; readonly account: Address; readonly destination: Address }
  | { readonly kind: "sync_native"; readonly account: Address }
  | { readonly kind: "revoke"; readonly account: Address }
  | { readonly kind: "create_ata"; readonly ata: Address; readonly owner: Address; readonly mint: Address; readonly idempotent: boolean }
  | { readonly kind: "nonce_advance"; readonly nonceAccount: Address }
  | { readonly kind: "nonce_withdraw"; readonly nonceAccount: Address; readonly to: Address; readonly lamports: bigint }
  | { readonly kind: "nonce_create"; readonly nonceAccount: Address; readonly lamports: bigint };

export type VenueCheck = { ok: true; action: TradeAction } | { ok: false; violations: string[] };

/**
 * Pluggable rule for one venue program. It must refuse every instruction it does not explicitly
 * understand, verify that funds can only flow to and from the signer's own accounts, and report the
 * buy amount; per-trade caps are applied centrally from the reported TradeAction.
 */
export interface VenueRule {
  readonly programId: Address;
  readonly name: string;
  check(ix: DecodedInstruction, env: RuleEnv): VenueCheck | Promise<VenueCheck>;
}

export interface TransactionSummary {
  /** Plain-language description, one sentence per line. */
  readonly text: string;
  readonly lines: readonly string[];
  readonly actions: readonly SummaryAction[];
  readonly version: "legacy" | 0;
  readonly feePayer: Address;
  readonly computeUnitLimit?: number;
  readonly computeUnitPriceMicroLamports?: bigint;
  readonly priorityFeeLamports: bigint;
  readonly tipLamports: bigint;
  /** Sum of the SOL-quoted buy caps (max_sol_cost, spendable_sol_in, max_quote_amount_in, ...). */
  readonly maxBuyLamports: bigint;
  /** Sum of buy caps per non-SOL quote mint. */
  readonly maxBuyQuote: Readonly<Record<string, bigint>>;
  /** Upper bound on SOL paid to third parties: buys + tips + priority fee (excludes refundable rent and moves between own accounts). */
  readonly maxSolOutLamports: bigint;
  /** Present when the first instruction advances a durable nonce: the transaction never expires on its own. */
  readonly durableNonce?: { readonly nonceAccount: Address; readonly nonceValue: string };
}

export type FirewallResult = { ok: true; summary: TransactionSummary } | { ok: false; violations: string[] };

/** What a built-in rule returns for one instruction. */
export interface RuleOutcome {
  readonly violations: string[];
  readonly actions: SummaryAction[];
}
