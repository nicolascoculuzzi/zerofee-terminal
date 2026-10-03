/**
 * POST /api/tx: the browser built and signed the transaction locally; the server only lands it.
 *
 *   DRY_RUN=true (default): simulateTransaction and return the result. NOTHING is sent.
 *   DRY_RUN=false:          hand the bytes to the @zerofee/core SubmitRouter with the preset's lanes
 *                           (reduced = Helius Sender SWQoS + mev-protect, secure = Jito bundleOnly,
 *                           fast = Sender Max). Requires an authenticated (non-anonymous) session unless
 *                           ALLOW_ANONYMOUS_TX=true.
 * The transaction must already carry the preset's tips; the server never adds or changes instructions.
 */
import { getBase58Decoder, getBase64Encoder } from "@solana/kit";
import { HeliusSenderLane, type HeliusSenderRegion, JitoLane, type JitoRegion, type Lane, SubmitRouter } from "@zerofee/core";
import type { ApiErrorBody, LandingPreset, TxSubmitRequest, TxSubmitResponse } from "@zerofee/protocol";
import type { RpcClient } from "../util/rpc";
import type { Session } from "./auth";

/** v1 transactions can be up to 4,096 bytes (SIMD-0385). */
const MAX_TX_BYTES = 4_096;
const PRESETS: readonly LandingPreset[] = ["reduced", "secure", "fast"];

export interface TxHandlerOptions {
  rpc: Pick<RpcClient, "simulateTransaction">;
  dryRun: boolean;
  allowAnonymous: boolean;
  landing: { heliusRegion: HeliusSenderRegion; jitoRegion: JitoRegion; heliusApiKey?: string; jitoUuid?: string };
  fetchFn?: typeof fetch;
}

export interface TxResult {
  status: number;
  body: TxSubmitResponse | ApiErrorBody;
}

const b64 = getBase64Encoder();
const b58 = getBase58Decoder();

/** Reads the compact-u16 signature count and the first (fee payer) signature. */
export function firstSignature(bytes: Uint8Array): { signature: string; signed: boolean } | null {
  let count = 0;
  let shift = 0;
  let i = 0;
  for (; i < 3; i++) {
    const b = bytes[i];
    if (b === undefined) return null;
    count |= (b & 0x7f) << shift;
    shift += 7;
    if ((b & 0x80) === 0) break;
  }
  const start = i + 1;
  if (count < 1 || bytes.length < start + 64) return null;
  const sig = bytes.subarray(start, start + 64);
  return { signature: b58.decode(sig), signed: sig.some((x) => x !== 0) };
}

export function lanesForPreset(preset: LandingPreset, o: TxHandlerOptions["landing"], fetchFn?: typeof fetch): Lane[] {
  switch (preset) {
    case "reduced":
      return [new HeliusSenderLane({ region: o.heliusRegion, mode: "swqos", mevProtect: true, apiKey: o.heliusApiKey, fetchFn })];
    case "secure":
      return [new JitoLane({ region: o.jitoRegion, bundleOnly: true, uuid: o.jitoUuid, fetchFn })];
    case "fast":
      return [new HeliusSenderLane({ region: o.heliusRegion, mode: "max", apiKey: o.heliusApiKey, fetchFn })];
  }
}

export class TxHandler {
  readonly stats = { requests: 0, simulated: 0, sent: 0, rejected: 0 };

  constructor(private readonly opts: TxHandlerOptions) {}

  async handle(body: unknown, session: Session | null): Promise<TxResult> {
    this.stats.requests++;
    const receivedAt = Date.now();
    const bad = (status: number, error: string, code: ApiErrorBody["code"] = "bad_request"): TxResult => {
      this.stats.rejected++;
      return { status, body: { error, code } };
    };
    const req = body as Partial<TxSubmitRequest> | null;
    if (!req || typeof req !== "object" || typeof req.tx !== "string") return bad(400, "body must be { tx: base64, preset }");
    const preset = (req.preset ?? "reduced") as LandingPreset;
    if (!PRESETS.includes(preset)) return bad(400, `preset must be one of ${PRESETS.join(", ")}`);
    if (req.tx.length > Math.ceil((MAX_TX_BYTES * 4) / 3) + 4) return bad(413, "transaction too large");
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(b64.encode(req.tx));
    } catch {
      return bad(400, "tx is not valid base64");
    }
    if (bytes.length > MAX_TX_BYTES) return bad(413, "transaction too large");
    const sig = firstSignature(bytes);
    if (!sig) return bad(400, "not a transaction");

    if (this.opts.dryRun) {
      // Unsigned transactions are simulated without signature checks (developer convenience).
      const sim = await this.opts.rpc
        .simulateTransaction(
          req.tx,
          sig.signed
            ? { sigVerify: true, commitment: "processed" }
            : { sigVerify: false, replaceRecentBlockhash: true, commitment: "processed" },
        )
        .catch((e: Error) => e);
      if (sim instanceof Error) return bad(502, `simulation failed: ${sim.message}`, "unavailable");
      this.stats.simulated++;
      return {
        status: 200,
        body: {
          signature: sig.signature,
          dryRun: true,
          preset,
          lanes: [],
          simulation: {
            err: sim.value.err,
            logs: sim.value.logs ?? [],
            unitsConsumed: sim.value.unitsConsumed ?? null,
            slot: sim.context.slot,
          },
          receivedAt,
        },
      };
    }

    if (!session || (session.anonymous && !this.opts.allowAnonymous)) return bad(401, "sign in to send transactions", "unauthorized");
    if (!sig.signed) return bad(400, "transaction is not signed");
    const router = new SubmitRouter({ lanes: lanesForPreset(preset, this.opts.landing, this.opts.fetchFn), dryRun: false });
    const acks = await router.send(req.tx).all;
    this.stats.sent++;
    return {
      status: 200,
      body: {
        signature: sig.signature,
        dryRun: false,
        preset,
        lanes: acks.map((a) => ({ lane: a.lane, ok: a.ok, error: a.error ?? null, ackMs: Math.round(a.ackAt - a.sentAt) })),
        simulation: null,
        receivedAt,
      },
    };
  }
}
