/**
 * Daily spend caps, enforced before signing. Every signed transaction commits its maximum spend
 * (the buy caps from the firewall summary, plus tips and priority fee as a separate budget) to the
 * current UTC day, whether or not it lands: a signed transaction can be submitted at any time.
 *
 * Durable-nonce transactions that share a nonce account and nonce value are mutually exclusive (at
 * most one can execute), so a whole min-out grid counts once, at the largest variant's spend.
 * Re-signing an identical message also counts once (same message => same signature).
 *
 * The device clock defines the day; the server re-checks limits (SPEC "Limits").
 */
import { asBufferSource, toHex } from "../bytes";
import { SignerError } from "../errors";
import { Mutex } from "../mutex";
import type { VersionedStore } from "../store";
import { formatSol } from "./format";
import type { TransactionSummary } from "./types";

export interface DailySpendCaps {
  /** Max sum of SOL-quoted buy commitments per UTC day (lamports). */
  readonly buyLamports: bigint;
  /** Optional max of tips + priority fees per UTC day (lamports). */
  readonly feeLamports?: bigint;
  /** Per non-SOL quote mint. Spending a quote mint without an entry is refused. */
  readonly buyQuote?: Readonly<Record<string, bigint>>;
}

export interface SpendEntry {
  /** Mutual-exclusion group: "nonce:<account>:<value>" or "msg:<sha256 of message>". */
  readonly group: string;
  readonly buyLamports: bigint;
  readonly feeLamports: bigint;
  readonly buyQuote: Readonly<Record<string, bigint>>;
}

export interface SpendState {
  /** UTC day, YYYY-MM-DD. */
  readonly day: string;
  readonly entries: readonly SpendEntry[];
}

export interface DailySpendTotals {
  readonly day: string;
  readonly buyLamports: bigint;
  readonly feeLamports: bigint;
  readonly buyQuote: Readonly<Record<string, bigint>>;
}

export type SpendReservation = { ok: true; totals: DailySpendTotals } | { ok: false; violations: string[]; totals: DailySpendTotals };

/** Above this many entries, plain (non-nonce) entries are folded into one aggregate entry. */
const COMPACT_THRESHOLD = 1000;
const WRITE_ATTEMPTS = 3;

export function utcDay(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function maxRecord(a: Readonly<Record<string, bigint>>, b: Readonly<Record<string, bigint>>): Record<string, bigint> {
  const out: Record<string, bigint> = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = out[k] === undefined || v > out[k] ? v : out[k];
  return out;
}

function addRecord(a: Readonly<Record<string, bigint>>, b: Readonly<Record<string, bigint>>): Record<string, bigint> {
  const out: Record<string, bigint> = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0n) + v;
  return out;
}

/** Sum over groups of the component-wise maximum within each group. */
export function computeTotals(day: string, entries: readonly SpendEntry[]): DailySpendTotals {
  const groups = new Map<string, SpendEntry>();
  for (const e of entries) {
    const prev = groups.get(e.group);
    groups.set(
      e.group,
      prev
        ? {
            group: e.group,
            buyLamports: e.buyLamports > prev.buyLamports ? e.buyLamports : prev.buyLamports,
            feeLamports: e.feeLamports > prev.feeLamports ? e.feeLamports : prev.feeLamports,
            buyQuote: maxRecord(prev.buyQuote, e.buyQuote),
          }
        : e,
    );
  }
  let buyLamports = 0n;
  let feeLamports = 0n;
  let buyQuote: Record<string, bigint> = {};
  for (const g of groups.values()) {
    buyLamports += g.buyLamports;
    feeLamports += g.feeLamports;
    buyQuote = addRecord(buyQuote, g.buyQuote);
  }
  return { day, buyLamports, feeLamports, buyQuote };
}

function compact(entries: readonly SpendEntry[]): SpendEntry[] {
  if (entries.length <= COMPACT_THRESHOLD) return [...entries];
  const kept = entries.filter((e) => e.group.startsWith("nonce:"));
  const folded = computeTotals(
    "",
    entries.filter((e) => !e.group.startsWith("nonce:")),
  );
  return [...kept, { group: "aggregate", buyLamports: folded.buyLamports, feeLamports: folded.feeLamports, buyQuote: folded.buyQuote }];
}

export interface SpendTrackerOptions {
  storage: VersionedStore<SpendState>;
  caps: DailySpendCaps;
  now?: () => number;
}

export class SpendTracker {
  readonly #storage: VersionedStore<SpendState>;
  readonly #caps: DailySpendCaps;
  readonly #now: () => number;
  readonly #mutex = new Mutex();

  constructor(options: SpendTrackerOptions) {
    this.#storage = options.storage;
    this.#caps = options.caps;
    this.#now = options.now ?? Date.now;
    if (typeof this.#caps.buyLamports !== "bigint" || this.#caps.buyLamports < 0n)
      throw new SignerError("INVALID_ARGUMENT", "caps.buyLamports must be a bigint");
  }

  async totals(): Promise<DailySpendTotals> {
    const day = utcDay(this.#now());
    const loaded = await this.#storage.load();
    return computeTotals(day, loaded?.value.day === day ? loaded.value.entries : []);
  }

  /** Checks the transaction against today's caps and records it if it fits. Atomic with respect to other reservations. */
  reserve(summary: TransactionSummary, messageBytes: Uint8Array): Promise<SpendReservation> {
    return this.#mutex.run(async () => {
      const group = summary.durableNonce
        ? `nonce:${summary.durableNonce.nonceAccount}:${summary.durableNonce.nonceValue}`
        : `msg:${toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", asBufferSource(messageBytes))))}`;
      const entry: SpendEntry = {
        group,
        buyLamports: summary.maxBuyLamports,
        feeLamports: summary.tipLamports + summary.priorityFeeLamports,
        buyQuote: { ...summary.maxBuyQuote },
      };
      for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
        const day = utcDay(this.#now());
        const loaded = await this.#storage.load();
        const current = loaded?.value.day === day ? loaded.value.entries : [];
        const before = computeTotals(day, current);
        const after = computeTotals(day, [...current, entry]);
        const violations = this.#violations(before, after);
        if (violations.length) return { ok: false, violations, totals: before };
        const saved = await this.#storage.save({ day, entries: compact([...current, entry]) }, loaded?.revision);
        if (saved !== undefined) return { ok: true, totals: after };
      }
      throw new SignerError("STORAGE_CONFLICT", "spend tracker storage kept changing; try again");
    });
  }

  #violations(before: DailySpendTotals, after: DailySpendTotals): string[] {
    const v: string[] = [];
    const caps = this.#caps;
    // Only transactions that add spend are checked, so sells (exits) are never blocked by a buy cap.
    if (after.buyLamports > before.buyLamports && after.buyLamports > caps.buyLamports) {
      v.push(
        `daily buy cap: ${formatSol(before.buyLamports)} committed today, this transaction would bring it to ${formatSol(after.buyLamports)} (cap ${formatSol(caps.buyLamports)})`,
      );
    }
    // The optional fee budget applies to every transaction that adds tips/priority fees, sells included.
    if (caps.feeLamports !== undefined && after.feeLamports > before.feeLamports && after.feeLamports > caps.feeLamports) {
      v.push(`daily tip and priority fee cap: would reach ${formatSol(after.feeLamports)} (cap ${formatSol(caps.feeLamports)})`);
    }
    for (const [mint, total] of Object.entries(after.buyQuote)) {
      if (total === (before.buyQuote[mint] ?? 0n)) continue;
      const cap = caps.buyQuote?.[mint];
      if (cap === undefined) v.push(`no daily cap is configured for quote mint ${mint}`);
      else if (total > cap) v.push(`daily cap for quote mint ${mint}: would reach ${total} (cap ${cap})`);
    }
    return v;
  }
}
