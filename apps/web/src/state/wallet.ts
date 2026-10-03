import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { Position, WalletDelta, WalletStatus } from "../protocol";
import type { TradeMode } from "../services/tradeService";
import type { TradingWallet, WalletServiceState } from "../services/walletService";

export interface WalletState {
  service: WalletServiceState;
  /** Trading wallet used for trades and shown in the top bar. */
  activeAddress: string | null;
  mode: TradeMode;
  status: Record<string, WalletStatus>;
  setService(state: WalletServiceState): void;
  setActive(address: string): void;
  setMode(mode: TradeMode): void;
  applySnapshot(address: string, status: WalletStatus): void;
  applyDelta(address: string, delta: WalletDelta): void;
}

export const useWallet = create<WalletState>()(
  persist(
    (set, get) => ({
      service: { connected: null, session: null, tradingWallets: [], locked: false, autoLockAt: null },
      activeAddress: null,
      mode: "instant",
      status: {},

      setService(service) {
        const active = get().activeAddress;
        const live = service.tradingWallets.filter((w) => !w.archived);
        const keep = live.some((w) => w.address === active);
        set({ service, activeAddress: keep ? active : (live[0]?.address ?? null) });
      },
      setActive(address) {
        set({ activeAddress: address });
      },
      setMode(mode) {
        set({ mode });
      },
      applySnapshot(address, status) {
        set((s) => ({ status: { ...s.status, [address]: status } }));
      },
      applyDelta(address, delta) {
        const prev = get().status[address];
        if (!prev) return;
        let positions = prev.positions;
        if (delta.positions && delta.positions.length > 0) {
          const byMint = new Map<string, Position>();
          for (const p of prev.positions) byMint.set(p.mint, p);
          for (const p of delta.positions) byMint.set(p.mint, p);
          positions = [...byMint.values()].sort((a, b) => b.lastTradeAt - a.lastTradeAt);
        }
        const activity = delta.activity && delta.activity.length > 0 ? [...delta.activity, ...prev.activity].slice(0, 300) : prev.activity;
        set((s) => ({
          status: {
            ...s.status,
            [address]: {
              ...prev,
              solBalance: delta.solBalance ?? prev.solBalance,
              reservedSol: delta.reservedSol ?? prev.reservedSol,
              nonceSlots: delta.nonceSlots ?? prev.nonceSlots,
              positions,
              activity,
            },
          },
        }));
      },
    }),
    {
      name: "zerofee.wallet",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ activeAddress: s.activeAddress, mode: s.mode }),
    },
  ),
);

export function activeTradingWallet(): TradingWallet | null {
  const s = useWallet.getState();
  return s.service.tradingWallets.find((w) => w.address === s.activeAddress) ?? null;
}

export function useActiveStatus(): WalletStatus | null {
  return useWallet((s) => (s.activeAddress ? (s.status[s.activeAddress] ?? null) : null));
}

export function useActivePosition(mint: string | null | undefined): Position | null {
  return useWallet((s) => {
    if (!mint || !s.activeAddress) return null;
    return s.status[s.activeAddress]?.positions.find((p) => p.mint === mint) ?? null;
  });
}
