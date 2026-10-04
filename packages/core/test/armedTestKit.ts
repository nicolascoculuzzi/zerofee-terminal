/** Shared fixtures for the armed-order tests: a throwaway trading wallet, nonce slots, venue contexts, the operator table. */
import {
  type Address,
  type AddressesByLookupTableAddress,
  generateKeyPairSigner,
  getBase58Decoder,
  type KeyPairSigner,
  type Nonce,
} from "@solana/kit";
import {
  type AmmTradeContext,
  armedStaticAccounts,
  bondingCurvePda,
  type DurableNonceRef,
  decodeAmmGlobalConfig,
  decodeBondingCurve,
  decodeMint,
  decodePool,
  decodePumpGlobal,
  deriveLookupTableAddress,
  jitoTipLevels,
  nonceSlotAddress,
  PUMP_AMM_GLOBAL_CONFIG,
  PUMP_GLOBAL,
  type PumpTradeContext,
  type TipLevel,
} from "../src";
import { CURVE_MINT, fixture, POOL } from "./fixtures";

/** Ephemeral, never-funded wallet (WebCrypto key, as the browser vault holds it). */
export async function armedWallet(): Promise<KeyPairSigner> {
  return generateKeyPairSigner();
}

export function randomNonceValue(): Nonce {
  return getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(32))) as Nonce;
}

/** Slot refs 0..count-1 of `wallet` with fresh nonce values. */
export async function nonceRefs(wallet: Address, count: number, from = 0): Promise<DurableNonceRef[]> {
  return Promise.all(
    Array.from({ length: count }, async (_v, i) => ({
      account: (await nonceSlotAddress(wallet, from + i)).address,
      authority: wallet,
      value: randomNonceValue(),
    })),
  );
}

export const pumpGlobal = () => decodePumpGlobal(fixture(PUMP_GLOBAL).data);
export const ammGlobalConfig = () => decodeAmmGlobalConfig(fixture(PUMP_AMM_GLOBAL_CONFIG).data);

/** Live fixture curve (Token-2022 coin 8iF53SDs…) traded by `user`. */
export async function curveContext(user: Address): Promise<PumpTradeContext> {
  const curve = decodeBondingCurve(fixture(await bondingCurvePda(CURVE_MINT)).data);
  const m = fixture(CURVE_MINT);
  return { mint: CURVE_MINT, baseTokenProgram: decodeMint(m.data, m.owner).tokenProgram, user, curve, global: pumpGlobal() };
}

/** Live fixture canonical boost pool 5RxfsBsy… traded by `user`. */
export function poolContext(user: Address): AmmTradeContext {
  const pool = decodePool(fixture(POOL).data);
  const m = fixture(pool.baseMint);
  return { poolAddress: POOL, pool, user, baseTokenProgram: decodeMint(m.data, m.owner).tokenProgram, globalConfig: ammGlobalConfig() };
}

/** The operator lookup table (dummy address; compression only needs its contents). */
export async function operatorTables(): Promise<AddressesByLookupTableAddress> {
  const contents = await armedStaticAccounts({ pumpGlobal: pumpGlobal(), ammGlobalConfig: ammGlobalConfig() });
  const { address } = await deriveLookupTableAddress("Hy5oibb1cYdmjyPJ2fiypDtKYvp1uZTuPkmFzVy7TL8c" as Address, 300_000_000n);
  return { [address]: contents };
}

/** Two Jito bundle-only tip levels (armed default). */
export const TIP_LEVELS: TipLevel[] = jitoTipLevels([
  { tipLamports: 10_000n, cuPriceMicroLamports: 100_000n },
  { tipLamports: 50_000n, cuPriceMicroLamports: 200_000n },
]);
