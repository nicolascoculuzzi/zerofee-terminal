/**
 * Copy trading in the browser (packages/protocol trackers.ts). The server matches leader trades, applies
 * the task's filters, sizing and caps, and pushes a vetted, expiring signal on the `copy` topic. While a
 * tab is open with the keystore unlocked, this engine:
 *   - claims each pending signal once (a Web Lock plus a per-browser marker, so two tabs never both trade);
 *   - drops it when it already expired;
 *   - builds the copy with the instant trade engine: a buy for `sizeSol` whose minimum out never prices the
 *     token above `maxPriceSol` (the server's drift guard), or a sell of the signalled amount, with the
 *     signal's slippage and the task's preset slot, so the signer firewall checks it like any trade;
 *   - reports the outcome (POST /api/copy/signals/:id/result): executed with the signature and amounts
 *     once a real send confirmed, declined when nothing was sent (price moved, dry run), failed otherwise.
 * Locked keystore or no trading wallet: the signal stays pending and the server expires it.
 *
 * Task CRUD goes through REST and lands in the copy store (state/copy.ts), as do topic snapshots and deltas.
 */
import type { CopyDelta, CopySignal, CopySignalResult, CopySnapshot, CopyTask, CopyTaskInput, CopyTaskPatch } from "@zerofee/protocol";
import { uid } from "../../lib/cn";
import { fmtSol } from "../../lib/format";
import { LANDING_INFO } from "../../lib/landing";
import { useCopy } from "../../state/copy";
import { type PresetId, useSettings } from "../../state/settings";
import { useToasts } from "../../state/toasts";
import { useTrades } from "../../state/trades";
import { useWallet } from "../../state/wallet";
import type { CopyService } from "../copyService";
import type { TradeReceipt, TradeService } from "../tradeService";
import { api } from "./api";
import type { LiveDataSource } from "./LiveDataSource";

export interface CopyEngineDeps {
  data: Pick<LiveDataSource, "socket" | "decimalsOf" | "chain">;
  trade: Pick<TradeService, "buy" | "sell">;
  /** The keystore state (instant trades need it unlocked). */
  locked(): boolean;
  rest?: <T>(path: string, o?: { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown }) => Promise<T>;
  now?: () => number;
  /** Cross-tab claim of a signal; default: the Web Locks API, else this tab only. */
  claim?: (id: string, run: () => Promise<void>) => Promise<void>;
}

const DONE_PREFIX = "zerofee.copy.done.";

function done(id: string): boolean {
  try {
    return localStorage.getItem(DONE_PREFIX + id) !== null;
  } catch {
    return false;
  }
}

function markDone(id: string): void {
  try {
    localStorage.setItem(DONE_PREFIX + id, String(Date.now()));
  } catch {
    // private mode: this tab's own set still prevents a repeat here
  }
}

async function webLockClaim(id: string, run: () => Promise<void>): Promise<void> {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  if (!locks) return run();
  await locks.request(`zerofee-copy-${id}`, { ifAvailable: true }, async (lock) => {
    if (lock) await run();
  });
}

/** Short failure reason for the server's records. */
function reasonOf(error: string | null): string {
  if (!error) return "failed";
  if (/price moved/i.test(error)) return "price_moved";
  if (/firewall/i.test(error)) return "firewall";
  if (/slippage|minimum out|exceeds/i.test(error)) return "slippage";
  return error.slice(0, 120);
}

export class CopyEngine implements CopyService {
  private readonly rest: NonNullable<CopyEngineDeps["rest"]>;
  private readonly now: () => number;
  private readonly claim: NonNullable<CopyEngineDeps["claim"]>;
  private readonly handled = new Set<string>();
  private off: (() => void) | null = null;

  constructor(private readonly d: CopyEngineDeps) {
    this.rest = d.rest ?? ((path, o) => api(path, o));
    this.now = d.now ?? Date.now;
    this.claim = d.claim ?? webLockClaim;
  }

  start(): void {
    this.off = this.d.data.socket.subscribe("copy", {
      onMessage: (m) => {
        if (m.type === "snapshot") {
          const s = m.data as CopySnapshot;
          useCopy.getState().applySnapshot(s);
          this.consider(s.signals);
        } else if (m.type === "delta") {
          const d = m.data as CopyDelta;
          useCopy.getState().applyDelta(d);
          this.consider(d.signals ?? []);
        }
      },
      // Signed out: no copy topic; the socket re-subscribes after sign-in and the snapshot brings it back.
      onError: () => useCopy.getState().setAvailable(false),
    });
  }

  stop(): void {
    this.off?.();
    this.off = null;
  }

  // -------------------------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------------------------

  async create(input: CopyTaskInput): Promise<CopyTask> {
    const task = await this.rest<CopyTask>("/api/copy/tasks", { method: "POST", body: input });
    useCopy.getState().upsertTask(task);
    return task;
  }

  async update(id: string, patch: CopyTaskPatch): Promise<CopyTask> {
    const task = await this.rest<CopyTask>(`/api/copy/tasks/${encodeURIComponent(id)}`, { method: "PATCH", body: patch });
    useCopy.getState().upsertTask(task);
    return task;
  }

  async pause(id: string): Promise<CopyTask> {
    const task = await this.rest<CopyTask>(`/api/copy/tasks/${encodeURIComponent(id)}/pause`, { method: "POST", body: {} });
    useCopy.getState().upsertTask(task);
    return task;
  }

  async resume(id: string): Promise<CopyTask> {
    const task = await this.rest<CopyTask>(`/api/copy/tasks/${encodeURIComponent(id)}/resume`, { method: "POST", body: {} });
    useCopy.getState().upsertTask(task);
    return task;
  }

  async remove(id: string): Promise<void> {
    await this.rest(`/api/copy/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
    useCopy.getState().removeTask(id);
  }

  // -------------------------------------------------------------------------------------------
  // signals
  // -------------------------------------------------------------------------------------------

  /** Pending signals not handled yet, oldest first. */
  private consider(signals: CopySignal[]): void {
    const pending = signals.filter((s) => s.status === "pending" && !this.handled.has(s.id) && !done(s.id));
    pending.sort((a, b) => a.createdAt - b.createdAt);
    for (const s of pending) void this.handle(s);
  }

  /** Resolves when the signal was acted on (or skipped); exposed for tests. */
  async handle(sig: CopySignal): Promise<void> {
    if (this.handled.has(sig.id)) return;
    if (sig.expiresAt !== null && this.now() >= sig.expiresAt) return; // the server marks it expired
    const wallet = useWallet.getState().activeAddress;
    if (this.d.locked() || !wallet) return; // stays pending until it expires
    if (this.d.data.chain()?.halt.halted) return;
    this.handled.add(sig.id);
    await this.claim(sig.id, async () => {
      if (done(sig.id)) return;
      markDone(sig.id);
      const result = await this.execute(sig, wallet);
      await this.rest(`/api/copy/signals/${encodeURIComponent(sig.id)}/result`, { method: "POST", body: result }).catch(() => undefined);
    });
  }

  private async execute(sig: CopySignal, wallet: string): Promise<CopySignalResult> {
    const s = useSettings.getState();
    const preset = s.presets[`P${sig.preset}` as PresetId] ?? s.presets[s.activePreset];
    const settings = { ...preset[sig.side], slippagePct: sig.slippageBps / 100 };
    const decimals = this.d.data.decimalsOf(sig.mint);
    const clickedAt = this.now();
    const id = uid("copy");
    const label = sig.side === "buy" ? `copy ${fmtSol(sig.sizeSol)} SOL` : `copy ${Math.round((sig.sellFraction ?? 1) * 100)}%`;
    useTrades.getState().begin({
      id,
      mint: sig.mint,
      symbol: sig.symbol,
      side: sig.side,
      label,
      wallet,
      source: "tracker",
      startedAt: clickedAt,
      landing: LANDING_INFO[settings.landing].label,
      ...(sig.side === "buy" && sig.sizeSol !== null ? { amountSol: sig.sizeSol } : {}),
      stage: "clicked",
      status: "pending",
      receipt: null,
      error: null,
      stageAt: {},
    });
    useToasts.getState().push({ kind: "info", title: "", tradeId: id, ttl: null });
    const progress = (p: { stage: Parameters<ReturnType<typeof useTrades.getState>["progress"]>[1]; atMs: number }) =>
      useTrades.getState().progress(id, p.stage, p.atMs);
    let receipt: TradeReceipt;
    try {
      if (sig.side === "buy") {
        if (sig.sizeSol === null || !(sig.sizeSol > 0)) return this.finishDeclined(id, "size_unknown");
        receipt = await this.d.trade.buy(
          {
            clientId: id,
            mint: sig.mint,
            wallet,
            settings,
            mode: "instant",
            source: "tracker",
            clickedAt,
            expectedPriceSol: sig.priceSol,
            solAmount: sig.sizeSol,
            maxPriceSol: sig.maxPriceSol,
          },
          progress,
        );
      } else {
        const tokens = sig.sellTokenAmount !== null ? Number(BigInt(sig.sellTokenAmount)) / 10 ** decimals : null;
        receipt = await this.d.trade.sell(
          {
            clientId: id,
            mint: sig.mint,
            wallet,
            settings,
            mode: "instant",
            source: "tracker",
            clickedAt,
            expectedPriceSol: sig.priceSol,
            ...(tokens !== null && tokens > 0 ? { tokenAmount: tokens } : { pct: Math.min(100, (sig.sellFraction ?? 1) * 100) }),
          },
          progress,
        );
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      useTrades.getState().fail(id, message);
      return { status: "failed", reason: reasonOf(message) };
    }
    useTrades.getState().finish(id, receipt);
    const toast = useToasts.getState().toasts.find((t) => t.tradeId === id);
    if (toast && receipt.status === "confirmed") useToasts.getState().update(toast.id, { ttl: 4000 });
    if (receipt.status === "failed") {
      // Nothing was sent when the engine refused before signing (price moved past the limit) or in a dry run.
      if (receipt.simulated) return { status: "declined", reason: `dry_run_failed: ${reasonOf(receipt.error)}`.slice(0, 120) };
      if (/price moved/i.test(receipt.error ?? "")) return { status: "declined", reason: "price_moved" };
      return { status: "failed", reason: reasonOf(receipt.error) };
    }
    if (receipt.simulated || !receipt.fill || !receipt.signature) return { status: "declined", reason: "dry_run" };
    return {
      status: "executed",
      signature: receipt.signature,
      solAmount: receipt.fill.solAmount,
      tokenAmount: BigInt(Math.round(receipt.fill.tokenAmount * 10 ** decimals)).toString(),
    };
  }

  private finishDeclined(id: string, reason: string): CopySignalResult {
    useTrades.getState().fail(id, reason);
    return { status: "declined", reason };
  }
}
