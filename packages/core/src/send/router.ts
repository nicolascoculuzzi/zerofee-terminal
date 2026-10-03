/**
 * Multi-lane submit router. Identical signed bytes go to every lane at once (the runtime dedupes by
 * signature, so double execution is impossible); `first` resolves on the first successful ack and
 * `all` settles with every lane's ack for telemetry (tx_landing_and_mev.md "Send order").
 *
 * SAFETY: the router refuses to send unless constructed with `dryRun: false` explicitly.
 */
import type { HeliusSenderRegion, JitoRegion } from "../constants";
import type { FeePlan } from "../tx/policy";
import { JitoLane } from "./jito";
import type { Lane, LaneAck } from "./lane";
import { HeliusSenderLane } from "./sender";

export interface LaneConfig {
  heliusRegion: HeliusSenderRegion;
  jitoRegion: JitoRegion;
  heliusApiKey?: string;
  jitoUuid?: string;
  /** Helius `mev-protect=true` ("Reduced" protection). */
  heliusMevProtect?: boolean;
  fetchFn?: typeof fetch;
}

/** Lanes implied by a fee plan, so the tips inside the tx always match where it is sent. */
export function lanesForPlan(plan: Pick<FeePlan, "heliusMode" | "sendToJito" | "jitoBundleOnly">, cfg: LaneConfig): Lane[] {
  const lanes: Lane[] = [];
  if (plan.heliusMode) {
    lanes.push(
      new HeliusSenderLane({
        region: cfg.heliusRegion,
        mode: plan.heliusMode,
        mevProtect: cfg.heliusMevProtect,
        apiKey: cfg.heliusApiKey,
        fetchFn: cfg.fetchFn,
      }),
    );
  }
  if (plan.sendToJito) {
    lanes.push(new JitoLane({ region: cfg.jitoRegion, bundleOnly: plan.jitoBundleOnly, uuid: cfg.jitoUuid, fetchFn: cfg.fetchFn }));
  }
  if (lanes.length === 0) throw new Error("fee plan selects no lanes");
  return lanes;
}

export interface SendResult {
  /** First successful ack, or null if every lane failed. */
  first: Promise<LaneAck | null>;
  /** Every lane's ack. */
  all: Promise<LaneAck[]>;
}

export class SendDisabledError extends Error {
  constructor() {
    super("router is in dry-run mode; construct with { dryRun: false } to send");
  }
}

export class SubmitRouter {
  constructor(private readonly opts: { lanes: Lane[]; dryRun: boolean }) {
    if (opts.lanes.length === 0) throw new Error("router needs at least one lane");
  }

  get lanes(): readonly Lane[] {
    return this.opts.lanes;
  }

  send(wireBase64: string, signal?: AbortSignal): SendResult {
    if (this.opts.dryRun !== false) throw new SendDisabledError();
    const promises = this.opts.lanes.map((l) => l.sendTransaction(wireBase64, signal));
    const first = Promise.any(promises.map((p) => p.then((a) => (a.ok ? a : Promise.reject(a))))).catch(() => null);
    return { first, all: Promise.all(promises) };
  }

  /**
   * Rebroadcasts the same bytes every `intervalMs` until `stop` aborts (call after confirmation or
   * once block height passes lastValidBlockHeight). Jito lanes are skipped by default (1 rps limit).
   */
  async rebroadcast(
    wireBase64: string,
    stop: AbortSignal,
    intervalMs = 800,
    filter: (lane: Lane) => boolean = (l) => !l.name.startsWith("jito"),
  ): Promise<number> {
    if (this.opts.dryRun !== false) throw new SendDisabledError();
    const lanes = this.opts.lanes.filter(filter);
    let rounds = 0;
    while (!stop.aborted && lanes.length) {
      await new Promise((r) => setTimeout(r, intervalMs));
      if (stop.aborted) break;
      await Promise.allSettled(lanes.map((l) => l.sendTransaction(wireBase64, stop)));
      rounds++;
    }
    return rounds;
  }
}
