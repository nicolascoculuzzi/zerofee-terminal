/**
 * Admin kill switch (SPEC "Kill switches"). While halted, POST /api/tx refuses every submission
 * (HTTP 503 "halted") and the state is published on the `chain` topic so every client disables
 * trading. Listeners (onChange) get each transition; the Phase 5 armed-orders engine subscribes here
 * to stop triggering and fire the pre-signed cancels.
 *
 * Every change is a row in the append-only admin audit log, and the latest halt/resume row is the
 * persisted state: a restart comes back halted if it went down halted. Halting is fail-safe: the
 * switch flips in memory first and stays on even if the audit write fails (the caller hears about the
 * failure). Resuming is the opposite: the audit row must be written before trading resumes.
 */
import type { HaltState } from "@zerofee/protocol";
import type { UserStore } from "../db/pg";
import { logger } from "../log";

const log = logger("halt");

export interface AuditMeta {
  actor: string;
  ip: string | null;
  userAgentHash: string | null;
}

export class HaltController {
  private s: HaltState = { halted: false, reason: null, since: null };
  private readonly listeners = new Set<(s: HaltState) => void>();

  constructor(
    private readonly store: UserStore,
    private readonly now: () => number = Date.now,
  ) {}

  get state(): HaltState {
    return { ...this.s };
  }

  isHalted(): boolean {
    return this.s.halted;
  }

  onChange(fn: (s: HaltState) => void): void {
    this.listeners.add(fn);
  }

  private set(next: HaltState): void {
    this.s = next;
    for (const fn of this.listeners) {
      try {
        fn(this.state);
      } catch (e) {
        log.error(`halt listener failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  /** Restores the persisted state (start-up, before serving). */
  async load(): Promise<void> {
    const last = await this.store.audit.lastHaltChange();
    if (last?.action === "halt") {
      const reason = typeof last.detail.reason === "string" ? last.detail.reason : null;
      this.s = { halted: true, reason, since: last.at };
      log.warn(`starting HALTED (since ${new Date(last.at).toISOString()} by ${last.actor}${reason ? `: ${reason}` : ""})`);
    }
  }

  /** Stops all submissions now. Throws only if the audit write failed (the halt stays in effect). */
  async halt(reason: string | null, meta: AuditMeta): Promise<HaltState> {
    const at = this.now();
    const wasHalted = this.s.halted;
    if (!wasHalted || this.s.reason !== reason) this.set({ halted: true, reason, since: wasHalted ? this.s.since : at });
    log.warn(`trading HALTED by ${meta.actor}${reason ? `: ${reason}` : ""}`);
    await this.store.audit.append({ at, ...meta, action: "halt", ok: true, detail: { reason, alreadyHalted: wasHalted } });
    return this.state;
  }

  /** Resumes submissions once the audit row is written. */
  async resume(meta: AuditMeta): Promise<HaltState> {
    const at = this.now();
    const prev = this.state;
    await this.store.audit.append({ at, ...meta, action: "resume", ok: true, detail: { wasHalted: prev.halted, haltedSince: prev.since } });
    if (prev.halted) this.set({ halted: false, reason: null, since: null });
    log.warn(`trading resumed by ${meta.actor}`);
    return this.state;
  }
}
