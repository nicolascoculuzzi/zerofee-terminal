/**
 * Armed-order fixtures, all offline: synthetic (unsigned) orders with valid shapes and fake bytes, and
 * encoders for the accounts the engine reads (System nonce accounts, token accounts).
 */
import { type Address, getAddressEncoder, getBase58Decoder, getBase58Encoder } from "@solana/kit";
import {
  type ArmedAttempt,
  type ArmedOrder,
  type ArmedTrigger,
  type ArmedVariant,
  currentInterfaceVersion,
  JITO_TIP_ACCOUNTS_FALLBACK,
  NONCE_ACCOUNT_LENGTH,
  TOKEN_2022_PROGRAM_ID,
  WSOL_MINT,
} from "@zerofee/core";
import { addr } from "./helpers";

const b58 = getBase58Decoder();

/** Deterministic base58 of `n` pseudo-random bytes derived from `tag`. */
export function tagBytes(tag: string, n: number): Uint8Array {
  let h = 2166136261;
  for (const c of tag) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    h = (Math.imul(h, 1103515245) + 12345) >>> 0;
    out[i] = h >>> 24;
  }
  return out;
}

export const sigOf = (tag: string): string => b58.decode(tagBytes(`sig:${tag}`, 64));
export const nonceValueOf = (tag: string): string => b58.decode(tagBytes(`nonce-value:${tag}`, 32));

export const CREATOR = addr("creator") as Address;
export const FEE = addr("fee-recipient") as Address;
export const BUYBACK = addr("buyback-recipient") as Address;
export const TABLE = addr("operator-table") as Address;

export interface SynthArgs {
  id?: string;
  wallet?: string;
  mint?: string;
  side?: "buy" | "sell";
  kind?: ArmedOrder["kind"];
  attempts?: number;
  /** Nonce account tag per attempt (default `${id}-n<i>`): orders sharing a tag share the nonce. */
  nonceTags?: string[];
  /** Nonce value tag per attempt (default the nonce tag). */
  valueTags?: string[];
  minOuts?: bigint[];
  tipLevels?: number[];
  venues?: ArmedVariant["venue"][];
  trigger?: ArmedTrigger;
  fullExit?: boolean;
  ocoGroup?: string;
  amount?: bigint;
  armingQuoteOut?: bigint;
  creator?: string;
  reservationLamports?: bigint;
}

/** A synthetic (unsigned) armed order: valid shapes, fake bytes. */
export function synthOrder(a: SynthArgs = {}): ArmedOrder {
  const id = a.id ?? crypto.randomUUID();
  const wallet = (a.wallet ?? addr("wallet")) as Address;
  const mint = (a.mint ?? addr("mint")) as Address;
  const side = a.side ?? "sell";
  const minOuts = a.minOuts ?? [1_000n, 900n, 800n];
  const tips = a.tipLevels ?? [0, 1];
  const venues = a.venues ?? ["pump"];
  const attempts: ArmedAttempt[] = Array.from({ length: a.attempts ?? 1 }, (_v, index) => {
    const nonceTag = a.nonceTags?.[index] ?? `${id}-n${index}`;
    const valueTag = a.valueTags?.[index] ?? nonceTag;
    const variants: ArmedVariant[] = [];
    for (const venue of venues) {
      for (const [mi, minOut] of minOuts.entries()) {
        for (const tipLevel of tips) {
          variants.push({
            id: `${id}/${index}/${venue}/${mi}/${tipLevel}`,
            venue,
            minOut,
            tipLevel,
            tipLamports: 10_000n * BigInt(tipLevel + 1),
            priorityFeeLamports: 15_000n,
            tx: { wireBase64: "AQID", signature: sigOf(`${id}/${index}/${venue}/${mi}/${tipLevel}`), size: 900 },
          });
        }
      }
    }
    return {
      index,
      nonce: {
        account: addr(`nonce:${nonceTag}`) as Address,
        authority: wallet,
        value: nonceValueOf(valueTag),
        // OCO orders carry the same cancel bytes for a shared nonce generation.
        cancel: { wireBase64: "BAUG", signature: sigOf(`cancel:${nonceTag}:${valueTag}`), size: 200 },
      },
      variants,
      status: "live",
    };
  });
  const amount = a.amount ?? 1_000_000n;
  return {
    id,
    wallet,
    kind: a.kind ?? (side === "buy" ? "limit-buy" : "stop-loss"),
    side,
    mint,
    amount,
    fullExit: a.fullExit ?? side === "sell",
    trigger: a.trigger ?? { type: "quote-at-most", threshold: 1_100n },
    attempts,
    ...(a.ocoGroup ? { ocoGroup: a.ocoGroup } : {}),
    armingQuoteOut: a.armingQuoteOut ?? 1_200n,
    armedAtMs: 1,
    frozen: {
      mint,
      baseTokenProgram: TOKEN_2022_PROGRAM_ID,
      quoteMint: WSOL_MINT,
      venues: venues.map((venue) => ({
        venue,
        creator: (a.creator ?? CREATOR) as Address,
        market: addr(`market:${venue}:${mint}`) as Address,
        feeRecipient: FEE,
        buybackFeeRecipient: BUYBACK,
      })),
      tipAccounts: [JITO_TIP_ACCOUNTS_FALLBACK[0] as Address],
      lookupTables: [TABLE],
      interfaceVersion: currentInterfaceVersion(),
    },
    reservation: { lamports: a.reservationLamports ?? 50_000n, mint, tokens: side === "sell" ? amount : 0n },
    capCost: { buyLamports: side === "buy" ? amount : 0n, buyQuote: {}, feeLamports: 0n },
    status: "armed",
  };
}

export function variantOf(o: ArmedOrder, attempt: number, minOutIndex: number, tip = 0, venue = "pump"): ArmedVariant {
  const v = o.attempts[attempt]?.variants.find((x) => x.id === `${o.id}/${attempt}/${venue}/${minOutIndex}/${tip}`);
  if (!v) throw new Error(`no variant ${attempt}/${venue}/${minOutIndex}/${tip}`);
  return v;
}

// ---------------------------------------------------------------------------------------------
// accounts
// ---------------------------------------------------------------------------------------------

const addressEncoder = getAddressEncoder();
const b58e = getBase58Encoder();

/** An initialized System nonce account (Versions::Current) holding `value` with `authority`. */
export function nonceAccountData(authority: string, value: string): Uint8Array {
  const d = new Uint8Array(NONCE_ACCOUNT_LENGTH);
  const v = new DataView(d.buffer);
  v.setUint32(0, 1, true); // version: current
  v.setUint32(4, 1, true); // state: initialized
  d.set(addressEncoder.encode(authority as Address), 8);
  d.set(b58e.encode(value), 40);
  v.setBigUint64(72, 5_000n, true);
  return d;
}

export function tokenAccountData(mint: string, owner: string, amount: bigint): Uint8Array {
  const d = new Uint8Array(165);
  d.set(addressEncoder.encode(mint as Address), 0);
  d.set(addressEncoder.encode(owner as Address), 32);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  return d;
}
