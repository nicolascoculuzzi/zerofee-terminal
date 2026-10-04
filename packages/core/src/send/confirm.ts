/**
 * Confirmation: race a `signatureNotifications` websocket subscription against polling
 * `getSignatureStatuses` (~400 ms), and declare expiry once `getBlockHeight(confirmed)` passes
 * `lastValidBlockHeight` (tx_landing_and_mev.md §7).
 */
import type { Commitment, Rpc, RpcSubscriptions, Signature, SignatureNotificationsApi, SolanaRpcApi } from "@solana/kit";
import { now } from "./lane";

export interface ConfirmResult {
  status: "confirmed" | "failed" | "expired" | "aborted";
  slot?: bigint;
  err?: unknown;
  via?: "ws" | "poll";
  /** performance.now() when the landing was observed. */
  observedAt: number;
}

const COMMITMENT_RANK: Record<Commitment, number> = { processed: 0, confirmed: 1, finalized: 2 };

export async function confirmSignature(args: {
  rpc: Rpc<Pick<SolanaRpcApi, "getSignatureStatuses" | "getBlockHeight">>;
  rpcSubscriptions?: RpcSubscriptions<SignatureNotificationsApi>;
  signature: Signature;
  lastValidBlockHeight: bigint;
  commitment?: Commitment;
  pollIntervalMs?: number;
  abortSignal?: AbortSignal;
}): Promise<ConfirmResult> {
  const commitment = args.commitment ?? "confirmed";
  const pollIntervalMs = args.pollIntervalMs ?? 400;
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  args.abortSignal?.addEventListener("abort", onAbort);

  const ws = args.rpcSubscriptions
    ? (async (): Promise<ConfirmResult | null> => {
        try {
          const notifications = await args
            .rpcSubscriptions!.signatureNotifications(args.signature, { commitment })
            .subscribe({ abortSignal: ac.signal });
          for await (const n of notifications) {
            const err = (n.value as { err: unknown }).err;
            return { status: err ? "failed" : "confirmed", slot: n.context.slot, err: err ?? undefined, via: "ws", observedAt: now() };
          }
        } catch {
          /* fall through to polling */
        }
        return null;
      })()
    : Promise.resolve(null);

  const poll = (async (): Promise<ConfirmResult> => {
    let tick = 0;
    while (!ac.signal.aborted) {
      try {
        const { value } = await args.rpc.getSignatureStatuses([args.signature]).send();
        const s = value[0];
        if (s?.confirmationStatus && COMMITMENT_RANK[s.confirmationStatus] >= COMMITMENT_RANK[commitment]) {
          return { status: s.err ? "failed" : "confirmed", slot: s.slot, err: s.err ?? undefined, via: "poll", observedAt: now() };
        }
        // Block-height expiry check every ~5 polls to save RPC calls.
        if (tick++ % 5 === 0) {
          const height = await args.rpc.getBlockHeight({ commitment: "confirmed" }).send();
          if (height > args.lastValidBlockHeight) return { status: "expired", observedAt: now() };
        }
      } catch {
        /* transient RPC error - keep polling */
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    return { status: "aborted", observedAt: now() };
  })();

  try {
    const winner = await Promise.race([poll, ws.then((r) => r ?? poll)]);
    return winner;
  } finally {
    ac.abort();
    args.abortSignal?.removeEventListener("abort", onAbort);
  }
}
