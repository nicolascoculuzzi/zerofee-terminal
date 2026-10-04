/**
 * Daily spend caps, enforced before signing. Every signed transaction commits its maximum spend to
 * the current UTC day, whether or not it lands (a signed transaction can be submitted any time):
 *   - buys: the buy caps from the firewall summary (SOL, and per non-SOL quote mint);
 *   - fees: tips + priority fee + network base fee, as a separate, mandatory budget. It applies to
 *     every transaction, sells included, so set it generously enough that exits are never starved.
 *
 * Re-signing an identical message counts once: same message => same signature => the runtime can
 * execute it at most once.
 *
 * Durable-nonce variants are NOT grouped, even when they share a nonce account and lifetime token.
 * Offline, the signer cannot tell a durable nonce value from a recent blockhash; a transaction that
 * starts with AdvanceNonceAccount but carries a recent blockhash runs as an ordinary transaction,
 * so several such "variants" can all land in successive slots. Counting each one in full is the
 * only sound choice; armed buy grids therefore consume the daily cap per variant.
 *
 * Storage is not trusted to only grow: the tracker keeps an in-memory high-water mark of today's
 * entries and merges it with whatever storage returns, so deleting or rewriting the stored record
 * cannot lower today's total while this tracker instance lives. Code on the same origin that can
 * also restart the signer (a compromised app in the Worker stage) can still reset it; daily caps are
 * only fully reliable once the signer runs on its own origin. The device clock defines the day; the
 * server re-checks limits (SPEC "Limits").
 */
import { asBufferSource, randomBytes, toHex } from "../bytes";
import { SignerError } from "../errors";
import { Mutex } from "../mutex";
import type { VersionedStore } from "../store";
import { formatSol } from "./format";
import type { TransactionSummary } from "./types";

export interface DailySpendCaps {
  /** Max sum of SOL-quoted buy commitments per UTC day (lamports). */
  readonly buyLamports: bigint;
  /** Max tips + priority fees + base fees per UTC day (lamports). Gates sells too. */
  readonly feeLamports: bigint;
  /** Per non-SOL quote mint. Spending a quote mint without an entry is refused. */
  readonly buyQuote?: Readonly<Record<string, bigint>>;
}

export interface SpendEntry {
  /** "msg:<sha256 of message bytes>" (identical messages count once) or "aggregate:<id>" (compacted history). */
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

/** Above this many entries, all but the most recent KEEP_RECENT are folded into one aggregate entry. */
const COMPACT_THRESHOLD = 1000;
const KEEP_RECENT = 200;
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

function maxEntry(a: SpendEntry, b: SpendEntry): SpendEntry {
  return {
    group: a.group,
    buyLamports: a.buyLamports > b.buyLamports ? a.buyLamports : b.buyLamports,
    feeLamports: a.feeLamports > b.feeLamports ? a.feeLamports : b.feeLamports,
    buyQuote: maxRecord(a.buyQuote, b.buyQuote),
  };
}

/** Union by group key (same key: component-wise maximum). Never loses an entry from either side. */
export function mergeEntries(a: readonly SpendEntry[], b: readonly SpendEntry[]): SpendEntry[] {
  const groups = new Map<string, SpendEntry>();
  for (const e of [...a, ...b]) {
    const prev = groups.get(e.group);
    groups.set(e.group, prev ? maxEntry(prev, e) : e);
  }
  return [...groups.values()];
}

/** Sum over groups of the component-wise maximum within each group. */
export function computeTotals(day: string, entries: readonly SpendEntry[]): DailySpendTotals {
  let buyLamports = 0n;
  let feeLamports = 0n;
  let buyQuote: Record<string, bigint> = {};
  for (const g of mergeEntries(entries, [])) {
    buyLamports += g.buyLamports;
    feeLamports += g.feeLamports;
    buyQuote = addRecord(buyQuote, g.buyQuote);
  }
  return { day, buyLamports, feeLamports, buyQuote };
}

/**
 * Bounds stored history. Folding only ever over-counts: a folded message re-signed later counts
 * again, and aggregates get unique keys so two different aggregates are both counted.
 */
function compact(entries: readonly SpendEntry[]): SpendEntry[] {
  if (entries.length <= COMPACT_THRESHOLD) return [...entries];
  const old = entries.slice(0, entries.length - KEEP_RECENT);
  const folded = computeTotals("", old);
  const aggregate: SpendEntry = {
    group: `aggregate:${toHex(randomBytes(8))}`,
    buyLamports: folded.buyLamports,
    feeLamports: folded.feeLamports,
    buyQuote: folded.buyQuote,
  };
  return [aggregate, ...entries.slice(entries.length - KEEP_RECENT)];
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
  /** High-water mark: everything this instance has committed or seen today. Storage cannot lower it. */
  #memory: SpendState | undefined;

  constructor(options: SpendTrackerOptions) {
    this.#storage = options.storage;
    this.#caps = options.caps;
    this.#now = options.now ?? Date.now;
    for (const key of ["buyLamports", "feeLamports"] as const) {
      const value = this.#caps[key];
      if (typeof value !== "bigint" || value < 0n) throw new SignerError("INVALID_ARGUMENT", `caps.${key} must be a non-negative bigint`);
    }
  }

  async totals(): Promise<DailySpendTotals> {
    const day = utcDay(this.#now());
    return computeTotals(day, await this.#today(day));
  }

  /** Checks the transaction against today's caps and records it if it fits. Atomic with respect to other reservations. */
  reserve(summary: TransactionSummary, messageBytes: Uint8Array): Promise<SpendReservation> {
    return this.#mutex.run(async () => {
      const group = `msg:${toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", asBufferSource(messageBytes))))}`;
      const entry: SpendEntry = {
        group,
        buyLamports: summary.maxBuyLamports,
        feeLamports: summary.tipLamports + summary.priorityFeeLamports + summary.networkFeeLamports,
        buyQuote: { ...summary.maxBuyQuote },
      };
      for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
        const day = utcDay(this.#now());
        const loaded = await this.#storage.load();
        const stored = loaded?.value.day === day ? loaded.value.entries : [];
        const remembered = this.#memory?.day === day ? this.#memory.entries : [];
        const current = mergeEntries(stored, remembered);
        this.#memory = { day, entries: current };
        const before = computeTotals(day, current);
        const after = computeTotals(day, [...current, entry]);
        const violations = this.#violations(before, after);
        if (violations.length) return { ok: false, violations, totals: before };
        const next = compact([...current, entry]);
        if ((await this.#storage.save({ day, entries: next }, loaded?.revision)) !== undefined) {
          this.#memory = { day, entries: next };
          return { ok: true, totals: after };
        }
      }
      throw new SignerError("STORAGE_CONFLICT", "spend tracker storage kept changing; try again");
    });
  }

  async #today(day: string): Promise<SpendEntry[]> {
    const loaded = await this.#storage.load();
    const stored = loaded?.value.day === day ? loaded.value.entries : [];
    return mergeEntries(stored, this.#memory?.day === day ? this.#memory.entries : []);
  }

  #violations(before: DailySpendTotals, after: DailySpendTotals): string[] {
    const v: string[] = [];
    const caps = this.#caps;
    // Only transactions that add buy spend are checked, so sells (exits) are never blocked by a buy cap.
    if (after.buyLamports > before.buyLamports && after.buyLamports > caps.buyLamports) {
      v.push(
        `daily buy cap: ${formatSol(before.buyLamports)} committed today, this transaction would bring it to ${formatSol(after.buyLamports)} (cap ${formatSol(caps.buyLamports)})`,
      );
    }
    if (after.feeLamports > before.feeLamports && after.feeLamports > caps.feeLamports) {
      v.push(
        `daily fee budget (tips, priority and base fees): would reach ${formatSol(after.feeLamports)} (cap ${formatSol(caps.feeLamports)})`,
      );
    }
    for (const [mint, total] of Object.entries(after.buyQuote)) {
      if (total === (before.buyQuote[mint] ?? 0n)) continue;
      const cap = caps.buyQuote && Object.hasOwn(caps.buyQuote, mint) ? caps.buyQuote[mint] : undefined;
      if (cap === undefined) v.push(`no daily cap is configured for quote mint ${mint}`);
      else if (total > cap) v.push(`daily cap for quote mint ${mint}: would reach ${total} (cap ${cap})`);
    }
    return v;
  }
}
