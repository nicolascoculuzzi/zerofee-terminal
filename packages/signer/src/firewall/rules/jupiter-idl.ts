/**
 * Jupiter v6 instruction layouts the firewall accepts, transcribed from the program's own on-chain
 * Anchor IDL (Jupiter publishes no IDL repo), vendored at packages/core/idl/jupiter.json and pinned in
 * packages/core/idl/JUPITER_SOURCE.json:
 *   IDL account C88XWfp26heEmDkmfSzeXP7Fd7GQJ2j9dDTUsyiZbUTa (owner JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4),
 *   read at slot 453,121,303 on 2026-10-03, sha256 12a0856158b2b6927d683a2ba21566f82e39989aca476e23c02d845fc38cdca8
 * The program authority seed is not in the IDL; it comes from jupiter-cpi (AUTHORITY_SEED = b"authority",
 * ids 0-7): https://github.com/jup-ag/jupiter-cpi/blob/12bc5f67b94a2c3edc74d6e721a19442124a0bad/src/lib.rs
 *
 * Only the two v2 routes Jupiter's `/build` emits are accepted (every captured response used one of
 * them). Their fixed arguments come first and the route plan last:
 *   route_v2                 disc | in_amount u64 | quoted_out_amount u64 | slippage_bps u16 |
 *                            platform_fee_bps u16 | positive_slippage_bps u16 | route_plan Vec<RoutePlanStepV2>
 *   shared_accounts_route_v2 disc | id u8 | (the same)
 *   RoutePlanStepV2          swap: Swap (u8 variant + fields) | bps u16 | input_index u8 | output_index u8
 * The route plan is decoded in full against the embedded copy of the IDL's `Swap` enum below, so the
 * data length is exact and an unknown venue variant (a newer IDL) is refused rather than skipped.
 * test/idl-layout.test.ts and test/constants-crosscheck.test.ts compare every value here with core's
 * vendored IDL and builders.
 */
import { readU32LE, readU64LE } from "../../bytes";

// ---------------------------------------------------------------------------------------------
// Route instructions
// ---------------------------------------------------------------------------------------------

export type JupiterRouteName = "route_v2" | "shared_accounts_route_v2";

/**
 * route_v2, 10 IDL accounts, then the hop accounts:
 *   0 user_transfer_authority (s), 1 user_source_token_account (w), 2 user_destination_token_account (w),
 *   3 source_mint, 4 destination_mint, 5 source_token_program, 6 destination_token_program,
 *   7 destination_token_account (w, optional: the program id means None), 8 event_authority, 9 program
 */
export const JUPITER_ROUTE_V2_LAYOUT = {
  fixedAccounts: 10,
  authority: 0,
  source: 1,
  destination: 2,
  sourceMint: 3,
  destinationMint: 4,
  sourceTokenProgram: 5,
  destinationTokenProgram: 6,
  /** Optional: when set, Jupiter delivers the output here instead of `destination`. Must be None. */
  optionalDestination: 7,
  eventAuthority: 8,
  program: 9,
} as const;

/**
 * shared_accounts_route_v2, 12 IDL accounts, then the hop accounts. Funds move through token accounts
 * of the program authority PDA ["authority", id]:
 *   0 program_authority, 1 user_transfer_authority (s), 2 source_token_account (w),
 *   3 program_source_token_account (w), 4 program_destination_token_account (w),
 *   5 destination_token_account (w), 6 source_mint, 7 destination_mint, 8 source_token_program,
 *   9 destination_token_program, 10 event_authority, 11 program
 */
export const JUPITER_SHARED_ROUTE_V2_LAYOUT = {
  fixedAccounts: 12,
  programAuthority: 0,
  authority: 1,
  source: 2,
  programSource: 3,
  programDestination: 4,
  destination: 5,
  sourceMint: 6,
  destinationMint: 7,
  sourceTokenProgram: 8,
  destinationTokenProgram: 9,
  eventAuthority: 10,
  program: 11,
} as const;

export interface JupiterRouteInstruction {
  readonly name: JupiterRouteName;
  readonly discriminator: readonly number[];
  /** Offset of the u8 program-authority id (shared accounts only). */
  readonly idOffset?: number;
  /** Offsets of the fixed arguments. */
  readonly inAmountOffset: number;
  readonly quotedOutOffset: number;
  readonly slippageOffset: number;
  readonly platformFeeOffset: number;
  readonly positiveSlippageOffset: number;
  /** Where the route plan (u32 length + steps) starts. */
  readonly routePlanOffset: number;
  readonly layout: typeof JUPITER_ROUTE_V2_LAYOUT | typeof JUPITER_SHARED_ROUTE_V2_LAYOUT;
}

export const JUPITER_ROUTE_INSTRUCTIONS: readonly JupiterRouteInstruction[] = [
  {
    name: "route_v2",
    discriminator: [187, 100, 250, 204, 49, 196, 175, 20],
    inAmountOffset: 8,
    quotedOutOffset: 16,
    slippageOffset: 24,
    platformFeeOffset: 26,
    positiveSlippageOffset: 28,
    routePlanOffset: 30,
    layout: JUPITER_ROUTE_V2_LAYOUT,
  },
  {
    name: "shared_accounts_route_v2",
    discriminator: [209, 152, 83, 147, 124, 254, 216, 233],
    idOffset: 8,
    inAmountOffset: 9,
    quotedOutOffset: 17,
    slippageOffset: 25,
    platformFeeOffset: 27,
    positiveSlippageOffset: 29,
    routePlanOffset: 31,
    layout: JUPITER_SHARED_ROUTE_V2_LAYOUT,
  },
];

/**
 * Positions the firewall requires as static account keys: the signer, the user's source and destination
 * token accounts, both mints (they pick the cap and the ATAs) and both token programs (they derive the
 * ATAs and are invoked with the user's signature). The rest is validated by the program itself or is a
 * route hop.
 */
export const JUPITER_STATIC_POSITIONS: Readonly<Record<JupiterRouteName, readonly number[]>> = {
  route_v2: [0, 1, 2, 3, 4, 5, 6],
  shared_accounts_route_v2: [1, 2, 5, 6, 7, 8, 9],
};

/** PDA seeds: the IDL's event authority (D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf on mainnet) and jupiter-cpi's program authority. */
export const JUPITER_SEEDS = { eventAuthority: "__event_authority", programAuthority: "authority" } as const;
/** jupiter-cpi AUTHORITY_COUNT: program authorities exist for ids 0-7. */
export const JUPITER_PROGRAM_AUTHORITY_COUNT = 8;

/** Why the other route instructions are refused by name (the rest are not swaps at all). */
export const JUPITER_REFUSAL_REASONS: Readonly<Record<string, string>> = {
  route: "v1 routes are refused; /build emits route_v2 / shared_accounts_route_v2",
  shared_accounts_route: "v1 routes are refused; /build emits route_v2 / shared_accounts_route_v2",
  exact_out_route: "exact-out routes are refused: /build is exact-in only, and their maximum input is computed on chain",
  shared_accounts_exact_out_route: "exact-out routes are refused: /build is exact-in only, and their maximum input is computed on chain",
  exact_out_route_v2: "exact-out routes are refused: /build is exact-in only, and their maximum input is computed on chain",
  shared_accounts_exact_out_route_v2: "exact-out routes are refused: /build is exact-in only, and their maximum input is computed on chain",
  route_with_token_ledger: "token-ledger routes spend whatever a ledger account recorded, so the input amount cannot be capped",
  shared_accounts_route_with_token_ledger:
    "token-ledger routes spend whatever a ledger account recorded, so the input amount cannot be capped",
};

/** Every instruction in idl/jupiter.json (19), keyed by hex discriminator. */
export const JUPITER_INSTRUCTION_NAMES: Readonly<Record<string, string>> = {
  "1a4aec976840b7f9": "close_token",
  "3560e5cad8bbfa18": "shared_accounts_exact_out_route_v2",
  "3ec6d6c1d59f6cd2": "claim",
  "5368c096b4479cc6": "create_idempotent_associated_token_account",
  "74ce1bbfa6130049": "claim_token",
  "927c0e00b5717293": "withdraw_token_account_excess_lamports",
  "93f17b64f484ae76": "create_token_account",
  "96564774a75d0e68": "route_with_token_ledger",
  "9d8ab85215f4f324": "exact_out_route_v2",
  b0d169a89a7d453e: "shared_accounts_exact_out_route",
  bb64facc31c4af14: "route_v2",
  c1209b3341d69c81: "shared_accounts_route",
  cb816785c57d6b56: "close_wsol_token_account",
  d033ef977b2bed5c: "exact_out_route",
  d19853937cfed8e9: "shared_accounts_route_v2",
  e455b9704e4f4d02: "set_token_ledger",
  e517cb977ae3ad2a: "route",
  e6798f50779f6aaa: "shared_accounts_route_with_token_ledger",
  e8f2c5fdf08f8134: "create_token_ledger",
};

// ---------------------------------------------------------------------------------------------
// Route plan decoding (Borsh, against the embedded Swap enum)
// ---------------------------------------------------------------------------------------------

/** The Anchor IDL types the Swap enum uses, with `defined` flattened to the type name. */
export type JupiterType =
  | "bool"
  | "u8"
  | "u16"
  | "u32"
  | "u64"
  | "u128"
  | "bytes"
  | { readonly option: JupiterType }
  | { readonly vec: JupiterType }
  | { readonly array: readonly [JupiterType, number] }
  | { readonly defined: string };

/** [name] for a unit variant, [name, field types] otherwise. */
export type JupiterVariant = readonly [string] | readonly [string, readonly JupiterType[]];

export type JupiterTypeDef =
  | { readonly kind: "enum"; readonly variants: readonly JupiterVariant[] }
  | { readonly kind: "struct"; readonly fields: readonly JupiterType[] };

export interface JupiterRouteStep {
  /** Swap enum variant index and name (e.g. 78 "MeteoraDynamicBondingCurveSwap"). */
  readonly variant: number;
  readonly venue: string;
  readonly bps: number;
  readonly inputIndex: number;
  readonly outputIndex: number;
}

export class JupiterRoutePlanError extends Error {}

const SIZES: Readonly<Record<string, number>> = { u8: 1, u16: 2, u32: 4, u64: 8, u128: 16 };

/** Walks Borsh data; every read is bounds-checked and every tag validated. */
class Cursor {
  constructor(
    private readonly data: Uint8Array,
    public offset: number,
  ) {}

  remaining(): number {
    return this.data.length - this.offset;
  }

  take(n: number, what: string): number {
    if (n < 0 || this.offset + n > this.data.length) throw new JupiterRoutePlanError(`truncated at ${what}`);
    const at = this.offset;
    this.offset += n;
    return at;
  }

  u8(what: string): number {
    return this.data[this.take(1, what)]!;
  }

  u16(what: string): number {
    const at = this.take(2, what);
    return this.data[at]! | (this.data[at + 1]! << 8);
  }

  u32(what: string): number {
    return readU32LE(this.data, this.take(4, what));
  }

  skip(type: JupiterType, what: string, depth = 0): void {
    if (depth > 8) throw new JupiterRoutePlanError(`${what}: types nest too deeply`);
    if (typeof type === "string") {
      if (type === "bool") {
        const b = this.u8(what);
        if (b > 1) throw new JupiterRoutePlanError(`${what}: bool byte ${b}`);
      } else if (type === "bytes") {
        this.take(this.u32(what), what);
      } else {
        this.take(SIZES[type]!, what);
      }
      return;
    }
    if ("option" in type) {
      const tag = this.u8(what);
      if (tag > 1) throw new JupiterRoutePlanError(`${what}: option tag ${tag}`);
      if (tag === 1) this.skip(type.option, what, depth + 1);
      return;
    }
    if ("vec" in type) {
      const n = this.u32(what);
      // Every element type here takes at least one byte, so a length beyond the remaining bytes is malformed.
      if (n > this.remaining()) throw new JupiterRoutePlanError(`${what}: vec length ${n}`);
      for (let i = 0; i < n; i++) this.skip(type.vec, what, depth + 1);
      return;
    }
    if ("array" in type) {
      for (let i = 0; i < type.array[1]; i++) this.skip(type.array[0], what, depth + 1);
      return;
    }
    const def = Object.hasOwn(JUPITER_SWAP_TYPES, type.defined) ? JUPITER_SWAP_TYPES[type.defined] : undefined;
    if (!def) throw new JupiterRoutePlanError(`${what}: unknown type ${type.defined}`);
    if (def.kind === "struct") {
      for (const f of def.fields) this.skip(f, `${what}.${type.defined}`, depth + 1);
      return;
    }
    const v = this.u8(what);
    const variant = def.variants[v];
    if (!variant) throw new JupiterRoutePlanError(`${what}: ${type.defined} variant ${v} does not exist`);
    for (const f of variant[1] ?? []) this.skip(f, `${what}.${variant[0]}`, depth + 1);
  }
}

/**
 * Decodes `route_plan` (u32 length + RoutePlanStepV2 entries) starting at `offset`, and requires it to
 * end exactly at the end of the data. Throws JupiterRoutePlanError on anything else.
 */
export function decodeJupiterRoutePlan(data: Uint8Array, offset: number): JupiterRouteStep[] {
  const c = new Cursor(data, offset);
  const n = c.u32("route_plan length");
  if (n === 0) throw new JupiterRoutePlanError("route plan is empty");
  if (n * 5 > c.remaining()) throw new JupiterRoutePlanError(`route plan length ${n} exceeds the data`);
  const steps: JupiterRouteStep[] = [];
  for (let i = 0; i < n; i++) {
    const what = `step ${i}`;
    const variant = c.u8(what);
    const def = JUPITER_SWAP_VARIANTS[variant];
    if (!def) throw new JupiterRoutePlanError(`${what}: Swap variant ${variant} is not in the reviewed IDL (newer Jupiter venue?)`);
    for (const f of def[1] ?? []) c.skip(f, `${what} ${def[0]}`);
    steps.push({ variant, venue: def[0], bps: c.u16(what), inputIndex: c.u8(what), outputIndex: c.u8(what) });
  }
  if (c.remaining() !== 0) throw new JupiterRoutePlanError(`${c.remaining()} trailing bytes after the route plan`);
  return steps;
}

/** Fixed u64 / u16 argument readers for a route instruction (bounds-checked by the caller's length check). */
export function readRouteArgs(def: JupiterRouteInstruction, data: Uint8Array) {
  const u16 = (o: number) => data[o]! | (data[o + 1]! << 8);
  return {
    id: def.idOffset === undefined ? undefined : data[def.idOffset]!,
    inAmount: readU64LE(data, def.inAmountOffset),
    quotedOutAmount: readU64LE(data, def.quotedOutOffset),
    slippageBps: u16(def.slippageOffset),
    platformFeeBps: u16(def.platformFeeOffset),
    positiveSlippageBps: u16(def.positiveSlippageOffset),
  };
}

// ---------------------------------------------------------------------------------------------
// The IDL's Swap enum (191 variants on 2026-10-03) and the types its fields use. Generated from
// packages/core/idl/jupiter.json; test/constants-crosscheck.test.ts fails on any difference.
// ---------------------------------------------------------------------------------------------

export const JUPITER_SWAP_VARIANTS: readonly JupiterVariant[] = [
  ["Saber"], // 0
  ["SaberAddDecimalsDeposit"], // 1
  ["SaberAddDecimalsWithdraw"], // 2
  ["TokenSwap"], // 3
  ["Sencha"], // 4
  ["Step"], // 5
  ["Cropper"], // 6
  ["Raydium"], // 7
  ["Crema", ["bool"]], // 8
  ["Lifinity"], // 9
  ["Mercurial"], // 10
  ["Cykura"], // 11
  ["Serum", [{ defined: "Side" }]], // 12
  ["MarinadeDeposit"], // 13
  ["MarinadeUnstake"], // 14
  ["Aldrin", [{ defined: "Side" }]], // 15
  ["AldrinV2", [{ defined: "Side" }]], // 16
  ["Whirlpool", ["bool"]], // 17
  ["Invariant", ["bool"]], // 18
  ["Meteora"], // 19
  ["GooseFX"], // 20
  ["DeltaFi", ["bool"]], // 21
  ["Balansol"], // 22
  ["MarcoPolo", ["bool"]], // 23
  ["Dradex", [{ defined: "Side" }]], // 24
  ["LifinityV2"], // 25
  ["RaydiumClmm"], // 26
  ["Openbook", [{ defined: "Side" }]], // 27
  ["Phoenix", [{ defined: "Side" }]], // 28
  ["Symmetry", ["u64", "u64"]], // 29
  ["TokenSwapV2"], // 30
  ["HeliumTreasuryManagementRedeemV0"], // 31
  ["StakeDexStakeWrappedSol"], // 32
  ["StakeDexSwapViaStake", ["u32"]], // 33
  ["GooseFXV2"], // 34
  ["Perps"], // 35
  ["PerpsAddLiquidity"], // 36
  ["PerpsRemoveLiquidity"], // 37
  ["MeteoraDlmm"], // 38
  ["OpenBookV2", [{ defined: "Side" }]], // 39
  ["RaydiumClmmV2"], // 40
  ["StakeDexPrefundWithdrawStakeAndDepositStake", ["u32"]], // 41
  ["Clone", ["u8", "bool", "bool"]], // 42
  ["SanctumS", ["u8", "u8", "u32", "u32"]], // 43
  ["SanctumSAddLiquidity", ["u8", "u32"]], // 44
  ["SanctumSRemoveLiquidity", ["u8", "u32"]], // 45
  ["RaydiumCP"], // 46
  ["WhirlpoolSwapV2", ["bool", { option: { defined: "RemainingAccountsInfo" } }]], // 47
  ["OneIntro"], // 48
  ["PumpWrappedBuy"], // 49
  ["PumpWrappedSell"], // 50
  ["PerpsV2"], // 51
  ["PerpsV2AddLiquidity"], // 52
  ["PerpsV2RemoveLiquidity"], // 53
  ["MoonshotWrappedBuy"], // 54
  ["MoonshotWrappedSell"], // 55
  ["StabbleStableSwap"], // 56
  ["StabbleWeightedSwap"], // 57
  ["Obric", ["bool"]], // 58
  ["FoxBuyFromEstimatedCost"], // 59
  ["FoxClaimPartial", ["bool"]], // 60
  ["SolFi", ["bool"]], // 61
  ["SolayerDelegateNoInit"], // 62
  ["SolayerUndelegateNoInit"], // 63
  ["TokenMill", [{ defined: "Side" }]], // 64
  ["DaosFunBuy"], // 65
  ["DaosFunSell"], // 66
  ["ZeroFi"], // 67
  ["StakeDexWithdrawWrappedSol"], // 68
  ["VirtualsBuy"], // 69
  ["VirtualsSell"], // 70
  ["Perena", ["u8", "u8"]], // 71
  ["PumpSwapBuy"], // 72
  ["PumpSwapSell"], // 73
  ["Gamma"], // 74
  ["MeteoraDlmmSwapV2", [{ defined: "RemainingAccountsInfo" }]], // 75
  ["Woofi"], // 76
  ["MeteoraDammV2"], // 77
  ["MeteoraDynamicBondingCurveSwap"], // 78
  ["StabbleStableSwapV2"], // 79
  ["StabbleWeightedSwapV2"], // 80
  ["RaydiumLaunchlabBuy", ["u64"]], // 81
  ["RaydiumLaunchlabSell", ["u64"]], // 82
  ["BoopdotfunWrappedBuy"], // 83
  ["BoopdotfunWrappedSell"], // 84
  ["Plasma", [{ defined: "Side" }]], // 85
  ["GoonFi", ["bool", "u8"]], // 86
  ["HumidiFi", ["u64", "bool"]], // 87
  ["MeteoraDynamicBondingCurveSwapWithRemainingAccounts"], // 88
  ["TesseraV", [{ defined: "Side" }]], // 89
  ["PumpWrappedBuyV2"], // 90
  ["PumpWrappedSellV2"], // 91
  ["PumpSwapBuyV2"], // 92
  ["PumpSwapSellV2"], // 93
  ["Heaven", ["bool"]], // 94
  ["SolFiV2", ["bool"]], // 95
  ["Aquifer"], // 96
  ["PumpWrappedBuyV3"], // 97
  ["PumpWrappedSellV3"], // 98
  ["PumpSwapBuyV3"], // 99
  ["PumpSwapSellV3"], // 100
  ["JupiterLendDeposit"], // 101
  ["JupiterLendRedeem"], // 102
  ["DefiTuna", ["bool", { option: { defined: "RemainingAccountsInfo" } }]], // 103
  ["AlphaQ", ["bool"]], // 104
  ["RaydiumV2"], // 105
  ["SarosDlmm", ["bool"]], // 106
  ["Futarchy", [{ defined: "Side" }]], // 107
  ["MeteoraDammV2WithRemainingAccounts"], // 108
  ["Obsidian"], // 109
  ["WhaleStreet", [{ defined: "Side" }]], // 110
  ["DynamicV1", [{ vec: { defined: "CandidateSwap" } }, { option: "u8" }]], // 111
  ["PumpWrappedBuyV4"], // 112
  ["PumpWrappedSellV4"], // 113
  ["CarrotIssue"], // 114
  ["CarrotRedeem"], // 115
  ["Manifest", [{ defined: "Side" }]], // 116
  ["BisonFi", ["bool"]], // 117
  ["HumidiFiV2", ["u64", "bool"]], // 118
  ["PerenaStar", ["bool"]], // 119
  ["JupiterRfqV2", [{ defined: "Side" }, "bytes"]], // 120
  ["GoonFiV2", ["bool"]], // 121
  ["Scorch", ["u128"]], // 122
  ["VaultLiquidUnstake", [{ array: ["u64", 5] }, "u64"]], // 123
  ["XOrca"], // 124
  ["Quantum", [{ defined: "Side" }]], // 125
  ["WhaleStreetV2", [{ defined: "Side" }, "u64", "u64"]], // 126
  ["Riptide", ["bool"]], // 127
  ["RunnerRodeo"], // 128
  ["TaurusFi", ["bool"]], // 129
  ["Omnipair"], // 130
  ["MSwap"], // 131
  ["Hylo", [{ defined: "HyloSwapType" }]], // 132
  ["VoltrDeposit"], // 133
  ["VoltrWithdraw"], // 134
  ["SanctumSV2", ["u8", "u8", "u32", "u32"]], // 135
  ["LemmingsFi", ["bool"]], // 136
  ["ScaleVmmBuy"], // 137
  ["ScaleVmmSell"], // 138
  ["ScaleAmmBuy"], // 139
  ["ScaleAmmSell"], // 140
  ["BisonFiV2", ["bool"]], // 141
  ["Trends"], // 142
  ["HumaDeposit"], // 143
  ["HumaInstantWithdraw"], // 144
  ["Kipseli", ["bool"]], // 145
  ["DynamicV2", [{ vec: { defined: "CandidateSwapWithBps" } }, "u8", "u8"]], // 146
  ["PumpSwapBuyV3WithCashbackClaim"], // 147
  ["PumpSwapSellV3WithCashbackClaim"], // 148
  ["PumpWrappedBuyV4WithCashbackClaim"], // 149
  ["PumpWrappedSellV4WithCashbackClaim"], // 150
  ["GoonFiV3", ["bool"]], // 151
  ["PumpWrappedBuyV5", ["bool"]], // 152
  ["PumpWrappedSellV5", ["bool"]], // 153
  ["ZeroFiSwapV2"], // 154
  ["BisonFiPredict", [{ defined: "BisonFiPredictSide" }, "bool"]], // 155
  ["ByrealDynamicV3"], // 156
  ["Flux", ["u64", "bool"]], // 157
  ["VaultLiquidSellLst"], // 158
  ["VaultLiquidBuyLst", ["u64"]], // 159
  ["KipseliV2", ["bool"]], // 160
  ["Deriverse", [{ defined: "Side" }, "u32"]], // 161
  ["Hadron", ["bool"]], // 162
  ["BinaryFi"], // 163
  ["Metric", ["bool"]], // 164
  ["JupiterLendDexSwap", ["bool"]], // 165
  ["Gatorswap", ["bool"]], // 166
  ["Flint", ["bool", "bool"]], // 167
  ["Denali", ["bool"]], // 168
  ["PerenaStarV2Deposit"], // 169
  ["PerenaStarV2WithdrawFromExternal", ["u8"]], // 170
  ["SanctumSols", [{ defined: "SanctumSolsSwapType" }]], // 171
  ["HyloV2", [{ defined: "HyloSwapType" }]], // 172
  ["SanctumPamm"], // 173
  ["Archer", [{ defined: "Side" }]], // 174
  ["TrenchWrappedBuy"], // 175
  ["TrenchWrappedSell"], // 176
  ["BisonFiMarketBacked", ["bool"]], // 177
  ["TesseraVV2", [{ defined: "Side" }]], // 178
  ["Stableswap"], // 179
  ["BinaryFiV2"], // 180
  ["KipseliV3", ["bool"]], // 181
  ["PerenaStarV2TrancheDeposit", [{ defined: "PerenaTrancheKind" }]], // 182
  ["PerenaStarV2TrancheWithdrawFromExternal", [{ defined: "PerenaTrancheKind" }, { option: "u8" }]], // 183
  ["Quay", ["bool"]], // 184
  ["HumidiFiRouter", ["u64", { array: ["u8", 32] }, { array: ["u8", 16] }, "bool"]], // 185
  ["HumidiFiRouterV2", ["u64", "u64", { array: ["u8", 32] }, { array: ["u8", 16] }, "bool"]], // 186
  ["PumpWrappedBuyV6", ["bool", "bool"]], // 187
  ["HyloRouter"], // 188
  ["Memefun", ["bool"]], // 189
  ["HumidiFiRouterV3", ["u64", "u64", "u64", "u64", { array: ["u8", 32] }, { array: ["u8", 16] }, "bool"]], // 190
];

export const JUPITER_SWAP_TYPES: Readonly<Record<string, JupiterTypeDef>> = {
  BisonFiPredictSide: { kind: "enum", variants: [["Yes"], ["No"]] },
  CandidateSwap: {
    kind: "enum",
    variants: [
      ["HumidiFi", ["u64", "bool"]],
      ["TesseraV", [{ defined: "Side" }]],
      ["HumidiFiV2", ["u64", "bool"]],
      ["RaydiumV2"],
      ["RaydiumClmm"],
      ["Whirlpool", ["bool"]],
      ["ZeroFi"],
      ["BisonFiV2", ["bool"]],
      ["GoonFiV2", ["bool"]],
      ["GoonFiV3", ["bool"]],
      ["WhirlpoolV2", ["bool", { option: { defined: "RemainingAccountsInfo" } }]],
      ["ZeroFiSwapV2"],
      ["BisonFiMarketBacked", ["bool"]],
      ["RaydiumClmmV2"],
      ["TesseraVV2", [{ defined: "Side" }]],
      ["HumidiFiRouter", ["u64", { array: ["u8", 32] }, { array: ["u8", 16] }, "bool"]],
      ["HumidiFiRouterV2", ["u64", "u64", { array: ["u8", 32] }, { array: ["u8", 16] }, "bool"]],
      ["HumidiFiRouterV3", ["u64", "u64", "u64", "u64", { array: ["u8", 32] }, { array: ["u8", 16] }, "bool"]],
    ],
  },
  CandidateSwapWithBps: { kind: "struct", fields: [{ defined: "CandidateSwap" }, "u32"] },
  HyloSwapType: {
    kind: "enum",
    variants: [
      ["MintStable"],
      ["RedeemStable"],
      ["MintLever"],
      ["RedeemLever"],
      ["SwapStableToLever"],
      ["SwapLeverToStable"],
      ["StabilityPoolDeposit"],
      ["StabilityPoolWithdraw"],
    ],
  },
  PerenaTrancheKind: { kind: "enum", variants: [["Junior"], ["Senior"]] },
  RemainingAccountsInfo: { kind: "struct", fields: [{ vec: { defined: "RemainingAccountsSlice" } }] },
  RemainingAccountsSlice: { kind: "struct", fields: ["u8", "u8"] },
  SanctumSolsSwapType: { kind: "enum", variants: [["Mint"], ["Claim"], ["ClaimHolding"]] },
  Side: { kind: "enum", variants: [["Bid"], ["Ask"]] },
};
