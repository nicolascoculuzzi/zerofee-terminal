import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/**
 * Alert delivery preferences (DESIGN.md 5.5 "Alerts"). Kept in this feature until alerts get a
 * server-side home (SPEC: Postgres holds alerts); the in-app toasts don't read these yet.
 */
export type AlertChannel = "push" | "telegram" | "discord";
export type AlertEvent = "orderFilled" | "orderFailed" | "orderCancelled" | "trackedTrade" | "priceAlert" | "migration" | "connection";

export interface AlertPrefsState {
  channels: Record<AlertChannel, { connectedAt: number | null }>;
  events: Record<AlertEvent, boolean>;
  setChannel(channel: AlertChannel, connected: boolean): void;
  setEvent(event: AlertEvent, on: boolean): void;
}

export const useAlertPrefs = create<AlertPrefsState>()(
  persist(
    (set) => ({
      channels: { push: { connectedAt: null }, telegram: { connectedAt: null }, discord: { connectedAt: null } },
      events: {
        orderFilled: true,
        orderFailed: true,
        orderCancelled: false,
        trackedTrade: true,
        priceAlert: true,
        migration: true,
        connection: false,
      },
      setChannel: (channel, connected) =>
        set((s) => ({ channels: { ...s.channels, [channel]: { connectedAt: connected ? Date.now() : null } } })),
      setEvent: (event, on) => set((s) => ({ events: { ...s.events, [event]: on } })),
    }),
    {
      name: "zerofee.alerts",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ channels: s.channels, events: s.events }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<AlertPrefsState>;
        return {
          ...current,
          channels: { ...current.channels, ...(p.channels ?? {}) },
          events: { ...current.events, ...(p.events ?? {}) },
        };
      },
    },
  ),
);
