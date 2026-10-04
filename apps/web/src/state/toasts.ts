import { create } from "zustand";

export type ToastKind = "info" | "success" | "error" | "warn";

export interface Toast {
  id: string;
  kind: ToastKind;
  title: string;
  body?: string;
  /** When set, the toast renders the live state of that client trade. */
  tradeId?: string;
  /** ms; null keeps it until dismissed. */
  ttl: number | null;
  createdAt: number;
  action?: { label: string; run: () => void };
}

export interface ToastsState {
  toasts: Toast[];
  push(toast: Omit<Toast, "id" | "createdAt" | "ttl"> & { ttl?: number | null }): string;
  update(id: string, patch: Partial<Toast>): void;
  dismiss(id: string): void;
}

let seq = 0;

export const useToasts = create<ToastsState>()((set) => ({
  toasts: [],
  push(toast) {
    const id = `t${++seq}`;
    const full: Toast = { ttl: 4000, ...toast, id, createdAt: Date.now() };
    set((s) => ({ toasts: [...s.toasts, full].slice(-6) }));
    return id;
  },
  update(id, patch) {
    set((s) => ({
      toasts: s.toasts.map((t) => (t.id === id ? { ...t, ...patch, createdAt: patch.ttl !== undefined ? Date.now() : t.createdAt } : t)),
    }));
  },
  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

export function toast(kind: ToastKind, title: string, body?: string): string {
  return useToasts.getState().push({ kind, title, body });
}
