import type { Address } from "@solana/kit";
import { WSOL_MINT } from "./programs";

const LAMPORTS_PER_SOL = 1_000_000_000n;

/** 1234567n -> "1,234,567" */
export function formatInteger(value: bigint): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString();
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }
  return negative ? `-${out}` : out;
}

/** 500000000n -> "0.5 SOL", 5000n -> "0.000005 SOL" */
export function formatSol(lamports: bigint): string {
  const whole = lamports / LAMPORTS_PER_SOL;
  const fraction = (lamports % LAMPORTS_PER_SOL).toString().padStart(9, "0").replace(/0+$/, "");
  return `${formatInteger(whole)}${fraction ? `.${fraction}` : ""} SOL`;
}

/** "So11...1112" style short form for summaries (checks always use full addresses). */
export function shortAddress(address: Address | string): string {
  return address.length <= 12 ? address : `${address.slice(0, 4)}…${address.slice(-4)}`;
}

export function formatQuote(amount: bigint, quoteMint: Address): string {
  return quoteMint === WSOL_MINT ? formatSol(amount) : `${formatInteger(amount)} base units of ${shortAddress(quoteMint)}`;
}
