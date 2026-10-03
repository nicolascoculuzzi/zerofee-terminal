/**
 * MAX_DAILY_SPEND_SOL enforcement for the dev CLI: a tiny JSON ledger (UTC day -> lamports spent on
 * landed buys + fees/tips). Stored under logs/ (gitignored). Dry runs never record spend.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type Ledger = Record<string, string>;

const today = () => new Date().toISOString().slice(0, 10);

function read(path: string): Ledger {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Ledger;
  } catch {
    return {};
  }
}

export function spentToday(path: string): bigint {
  return BigInt(read(path)[today()] ?? "0");
}

export function assertWithinDailyLimit(path: string, additional: bigint, limit: bigint): void {
  const spent = spentToday(path);
  if (spent + additional > limit) {
    throw new Error(`MAX_DAILY_SPEND_SOL exceeded: spent ${spent} + ${additional} > ${limit} lamports today`);
  }
}

export function recordSpend(path: string, lamports: bigint): void {
  const l = read(path);
  l[today()] = (BigInt(l[today()] ?? "0") + lamports).toString();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(l, null, 2));
}
