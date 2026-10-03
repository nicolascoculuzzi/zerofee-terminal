import { MemoryStore } from "../../src/store";
import type { StoredVault } from "../../src/vault/format";
import type { KdfParams } from "../../src/vault/kdf";
import { type Scheduler, Vault, type VaultOptions } from "../../src/vault/vault";

/** Far below the OWASP floor: tests only (allowWeakKdfForTesting). */
export const FAST_KDF: KdfParams = { memoryKiB: 64, iterations: 1, parallelism: 1 };
export const PASSWORD = "correct horse battery staple";

export function makeVault(options: Partial<VaultOptions> = {}): { vault: Vault; storage: MemoryStore<StoredVault> } {
  const storage = (options.storage as MemoryStore<StoredVault> | undefined) ?? new MemoryStore<StoredVault>();
  const vault = new Vault({ kdfParams: FAST_KDF, allowWeakKdfForTesting: true, ...options, storage });
  return { vault, storage };
}

/** Deterministic clock and timers. */
export class ManualScheduler implements Scheduler {
  time = 1_000_000;
  #next = 1;
  readonly #timers = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.#next++;
    this.#timers.set(id, { at: this.time + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  get pending(): number {
    return this.#timers.size;
  }

  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      const due = [...this.#timers.entries()].filter(([, t]) => t.at <= target).sort((x, y) => x[1].at - y[1].at)[0];
      if (!due) break;
      this.#timers.delete(due[0]);
      this.time = due[1].at;
      due[1].fn();
    }
    this.time = target;
  }
}

/** A scheduler whose timers never fire (models a throttled background tab). */
export class FrozenTimers extends ManualScheduler {
  override setTimeout(): unknown {
    return 0;
  }
}
