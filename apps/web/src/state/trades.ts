import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { LatencyBreakdown } from "../protocol";
import type { TradeReceipt, TradeSource, TradeStage } from "../services/tradeService";

/** Client-side lifecycle of one buy/sell, for optimistic UI, toasts and the latency readout. */
export interface ClientTrade {
  id: string;
  mint: string;
  symbol: string;
  side: "buy" | "sell";
  /** "0.5 SOL", "25%", "initials"… */
  label: string;
  wallet: string;
  source: TradeSource;
  startedAt: number;
  stage: "clicked" | TradeStage;
  status: "pending" | "confirmed" | "failed";
  receipt: TradeReceipt | null;
  error: string | null;
  /** ms since the click at which each stage completed (toast line 2). */
  stageAt?: Partial<Record<TradeStage, number>>;
  /** Landing preset label for the landed line ("Reduced"). */
  landing?: string;
  /** SOL this buy would spend, for "0.50 SOL not spent" on failure. */
  amountSol?: number;
  /** Re-run the same trade (failed toasts offer Retry). */
  retry?: () => void;
}

/** Local calendar day: the daily cap resets at the trader's midnight. */
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export interface TradesState {
  items: ClientTrade[];
  lastLatency: LatencyBreakdown | null;
  lastLatencyStatus: "confirmed" | "failed" | null;
  /** The last trade was a dry-run simulation (nothing sent). */
  lastLatencySimulated: boolean;
  daily: { day: string; spentSol: number };
  begin(trade: ClientTrade): void;
  progress(id: string, stage: TradeStage, atMs?: number): void;
  finish(id: string, receipt: TradeReceipt): void;
  fail(id: string, error: string): void;
  addSpend(sol: number): void;
  spentToday(): number;
}

export const useTrades = create<TradesState>()(
  persist(
    (set, get) => ({
      items: [],
      lastLatency: null,
      lastLatencyStatus: null,
      lastLatencySimulated: false,
      daily: { day: today(), spentSol: 0 },
      begin(trade) {
        set((s) => ({ items: [trade, ...s.items].slice(0, 60) }));
      },
      progress(id, stage, atMs) {
        set((s) => ({
          items: s.items.map((t) =>
            t.id === id && t.status === "pending"
              ? { ...t, stage, stageAt: atMs === undefined ? t.stageAt : { ...t.stageAt, [stage]: atMs } }
              : t,
          ),
        }));
      },
      finish(id, receipt) {
        set((s) => ({
          items: s.items.map((t) =>
            t.id === id
              ? {
                  ...t,
                  stage: receipt.status === "confirmed" ? "landed" : "failed",
                  status: receipt.status,
                  receipt,
                  error: receipt.error,
                }
              : t,
          ),
          lastLatency: receipt.latency,
          lastLatencyStatus: receipt.status,
          lastLatencySimulated: receipt.simulated === true,
        }));
      },
      fail(id, error) {
        set((s) => ({
          items: s.items.map((t) => (t.id === id ? { ...t, stage: "failed", status: "failed", error } : t)),
        }));
      },
      addSpend(sol) {
        const d = get().daily;
        const day = today();
        set({ daily: { day, spentSol: (d.day === day ? d.spentSol : 0) + sol } });
      },
      spentToday() {
        const d = get().daily;
        return d.day === today() ? d.spentSol : 0;
      },
    }),
    {
      name: "zerofee.trades",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      // Only the daily cap counter survives a reload (SPEC: daily cap tracked in the browser).
      partialize: (s) => ({ daily: s.daily }),
    },
  ),
);
