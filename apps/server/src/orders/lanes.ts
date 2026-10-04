/**
 * Where armed transactions go.
 *
 *  - Variants: ONLY the protected lane, Jito `bundleOnly=true` (revert-protected, never leaves the block
 *    engine as a plain transaction) with the jitodontfront marker the variants carry. A variant that
 *    leaked to a public path would stay landable until its nonce advances (SPEC "Armed orders").
 *  - Cancels: they only advance a nonce and carry no value, so any path that reaches a leader is fine: a
 *    plain JSON-RPC sendTransaction, plus Jito / Helius Sender when the cancel pays their tip.
 *
 * DRY_RUN=true never constructs a sending lane: the DryRunSubmitter simulates instead.
 */
import {
  HELIUS_SENDER_SWQOS_MIN_TIP_LAMPORTS,
  HELIUS_SENDER_TIP_ACCOUNTS,
  HeliusSenderLane,
  type HeliusSenderRegion,
  inspectArmedTransaction,
  JITO_MIN_TIP_LAMPORTS,
  JITO_TIP_ACCOUNTS_FALLBACK,
  JitoLane,
  type JitoRegion,
  type Lane,
  RpcLane,
  type SignedTx,
  SubmitRouter,
  SYSTEM_PROGRAM_ID,
} from "@zerofee/core";
import type { ChainReader, Simulation } from "./chain";

export interface LaneReport {
  lane: string;
  ok: boolean;
  error: string | null;
  ackMs: number;
  bundleId: string | null;
}

export interface SendReport {
  dryRun: boolean;
  /** At least one lane accepted it (live), or the simulation ran (dry run). */
  ok: boolean;
  lanes: LaneReport[];
  simulation: Simulation | null;
  error: string | null;
}

export interface Submitter {
  readonly dryRun: boolean;
  /** An armed variant: protected lane only. */
  sendVariant(wireBase64: string): Promise<SendReport>;
  /** A pre-signed cancel. */
  sendCancel(cancel: SignedTx): Promise<SendReport>;
}

/** DRY_RUN: simulate, never send. */
export class DryRunSubmitter implements Submitter {
  readonly dryRun = true;

  constructor(private readonly chain: Pick<ChainReader, "simulate">) {}

  private async simulate(wire: string): Promise<SendReport> {
    try {
      const simulation = await this.chain.simulate(wire);
      return { dryRun: true, ok: true, lanes: [], simulation, error: null };
    } catch (e) {
      return {
        dryRun: true,
        ok: false,
        lanes: [],
        simulation: null,
        error: `simulation failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  sendVariant(wireBase64: string): Promise<SendReport> {
    return this.simulate(wireBase64);
  }

  sendCancel(cancel: SignedTx): Promise<SendReport> {
    return this.simulate(cancel.wireBase64);
  }
}

/** Lamports a transaction tips to the Jito and Helius Sender tip accounts (top-level System transfers). */
export function tipsOf(wireBase64: string): { jito: bigint; helius: bigint } {
  const out = { jito: 0n, helius: 0n };
  let insp: ReturnType<typeof inspectArmedTransaction>;
  try {
    insp = inspectArmedTransaction(wireBase64);
  } catch {
    return out;
  }
  for (const ix of insp.instructions) {
    const d = ix.data;
    if (ix.program !== SYSTEM_PROGRAM_ID || d.length !== 12 || d[0] !== 2 || d[1] !== 0 || d[2] !== 0 || d[3] !== 0) continue;
    const lamports = new DataView(d.buffer, d.byteOffset).getBigUint64(4, true);
    const to = ix.accounts[1];
    if (to && JITO_TIP_ACCOUNTS_FALLBACK.includes(to)) out.jito += lamports;
    else if (to && HELIUS_SENDER_TIP_ACCOUNTS.includes(to)) out.helius += lamports;
  }
  return out;
}

export interface LiveLaneOptions {
  jitoRegion: JitoRegion;
  jitoUuid?: string;
  heliusRegion: HeliusSenderRegion;
  heliusApiKey?: string;
  /** JSON-RPC endpoint for cancels. */
  cancelRpcUrl: string;
  fetchFn?: typeof fetch;
}

export interface LaneSet {
  variant: Lane[];
  cancel(tx: SignedTx): Lane[];
}

/** Production lanes. */
export function liveLanes(o: LiveLaneOptions): LaneSet {
  const protectedLane = new JitoLane({ region: o.jitoRegion, bundleOnly: true, uuid: o.jitoUuid, fetchFn: o.fetchFn });
  const rpc = new RpcLane({ url: o.cancelRpcUrl, name: "cancel-rpc", fetchFn: o.fetchFn });
  return {
    variant: [protectedLane],
    cancel(tx) {
      const tips = tipsOf(tx.wireBase64);
      const lanes: Lane[] = [rpc];
      if (tips.jito >= JITO_MIN_TIP_LAMPORTS) lanes.push(new JitoLane({ region: o.jitoRegion, uuid: o.jitoUuid, fetchFn: o.fetchFn }));
      if (tips.helius >= HELIUS_SENDER_SWQOS_MIN_TIP_LAMPORTS) {
        lanes.push(new HeliusSenderLane({ region: o.heliusRegion, mode: "swqos", apiKey: o.heliusApiKey, fetchFn: o.fetchFn }));
      }
      return lanes;
    },
  };
}

/** Sends through real lanes (DRY_RUN=false only). */
export class LiveSubmitter implements Submitter {
  readonly dryRun = false;

  constructor(private readonly lanes: LaneSet) {
    if (lanes.variant.length === 0) throw new Error("live submitter needs a variant lane");
  }

  private async send(lanes: Lane[], wire: string): Promise<SendReport> {
    try {
      const acks = await new SubmitRouter({ lanes, dryRun: false }).send(wire).all;
      const reports = acks.map((a) => ({
        lane: a.lane,
        ok: a.ok,
        error: a.error ?? null,
        ackMs: Math.round(a.ackAt - a.sentAt),
        bundleId: a.bundleId ?? null,
      }));
      return {
        dryRun: false,
        ok: reports.some((r) => r.ok),
        lanes: reports,
        simulation: null,
        error: reports.some((r) => r.ok) ? null : "no lane accepted it",
      };
    } catch (e) {
      return { dryRun: false, ok: false, lanes: [], simulation: null, error: e instanceof Error ? e.message : String(e) };
    }
  }

  sendVariant(wireBase64: string): Promise<SendReport> {
    return this.send(this.lanes.variant, wireBase64);
  }

  sendCancel(cancel: SignedTx): Promise<SendReport> {
    return this.send(this.lanes.cancel(cancel), cancel.wireBase64);
  }
}
