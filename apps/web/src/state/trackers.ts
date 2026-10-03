import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { SocialPost, TrackedTrade } from "../protocol";

export interface TrackedWallet {
  address: string;
  name: string;
  emoji: string;
  /** Bell: toast + sound when this wallet trades. */
  alerts: boolean;
  createdAt: number;
}

export interface TrackedHandle {
  handle: string;
  tweets: boolean;
  profile: boolean;
  follows: boolean;
  addedAt: number;
}

export const MAX_TRACKED_WALLETS = 10_000;

export interface TrackersState {
  wallets: TrackedWallet[];
  handles: TrackedHandle[];
  seeded: boolean;
  live: TrackedTrade[];
  posts: SocialPost[];
  unreadTrades: number;
  unreadPosts: number;
  seedDefaults(wallets: TrackedWallet[], handles: TrackedHandle[]): void;
  addWallet(w: Omit<TrackedWallet, "createdAt">): boolean;
  updateWallet(address: string, patch: Partial<TrackedWallet>): void;
  removeWallet(address: string): void;
  importWallets(list: Omit<TrackedWallet, "createdAt">[]): number;
  addHandle(handle: string): boolean;
  updateHandle(handle: string, patch: Partial<TrackedHandle>): void;
  removeHandle(handle: string): void;
  setLive(items: TrackedTrade[]): void;
  pushLive(items: TrackedTrade[]): void;
  setPosts(posts: SocialPost[]): void;
  pushPosts(posts: SocialPost[]): void;
  markRead(kind: "trades" | "posts"): void;
}

export const useTrackers = create<TrackersState>()(
  persist(
    (set, get) => ({
      wallets: [],
      handles: [],
      seeded: false,
      live: [],
      posts: [],
      unreadTrades: 0,
      unreadPosts: 0,
      seedDefaults(wallets, handles) {
        if (get().seeded) return;
        set({ wallets, handles, seeded: true });
      },
      addWallet(w) {
        const s = get();
        if (s.wallets.some((x) => x.address === w.address) || s.wallets.length >= MAX_TRACKED_WALLETS) return false;
        set({ wallets: [{ ...w, createdAt: Date.now() }, ...s.wallets] });
        return true;
      },
      updateWallet(address, patch) {
        set((s) => ({ wallets: s.wallets.map((w) => (w.address === address ? { ...w, ...patch } : w)) }));
      },
      removeWallet(address) {
        set((s) => ({ wallets: s.wallets.filter((w) => w.address !== address) }));
      },
      importWallets(list) {
        const s = get();
        const have = new Set(s.wallets.map((w) => w.address));
        const fresh: TrackedWallet[] = [];
        for (const w of list) {
          if (have.has(w.address)) continue;
          have.add(w.address);
          fresh.push({ ...w, createdAt: Date.now() });
        }
        const room = Math.max(0, MAX_TRACKED_WALLETS - s.wallets.length);
        const added = fresh.slice(0, room);
        set({ wallets: [...added, ...s.wallets] });
        return added.length;
      },
      addHandle(raw) {
        const handle = raw.trim().replace(/^@/, "").toLowerCase();
        if (!/^[a-z0-9_]{1,15}$/.test(handle)) return false;
        if (get().handles.some((h) => h.handle === handle)) return false;
        set((s) => ({ handles: [{ handle, tweets: true, profile: true, follows: false, addedAt: Date.now() }, ...s.handles] }));
        return true;
      },
      updateHandle(handle, patch) {
        set((s) => ({ handles: s.handles.map((h) => (h.handle === handle ? { ...h, ...patch } : h)) }));
      },
      removeHandle(handle) {
        set((s) => ({ handles: s.handles.filter((h) => h.handle !== handle) }));
      },
      setLive(items) {
        set({ live: items.slice(0, 200) });
      },
      pushLive(items) {
        set((s) => ({ live: [...items, ...s.live].slice(0, 200), unreadTrades: s.unreadTrades + items.length }));
      },
      setPosts(posts) {
        set({ posts: posts.slice(0, 120) });
      },
      pushPosts(posts) {
        set((s) => ({ posts: [...posts, ...s.posts].slice(0, 120), unreadPosts: s.unreadPosts + posts.length }));
      },
      markRead(kind) {
        set(kind === "trades" ? { unreadTrades: 0 } : { unreadPosts: 0 });
      },
    }),
    {
      name: "zerofee.trackers",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ wallets: s.wallets, handles: s.handles, seeded: s.seeded }),
    },
  ),
);

/** Lookup map for labelling tracked makers in tables and on charts. */
export function useTrackedMap(): Map<string, TrackedWallet> {
  const wallets = useTrackers((s) => s.wallets);
  return trackedMapCache(wallets);
}

let cacheKey: TrackedWallet[] | null = null;
let cacheVal = new Map<string, TrackedWallet>();
function trackedMapCache(wallets: TrackedWallet[]): Map<string, TrackedWallet> {
  if (wallets !== cacheKey) {
    cacheKey = wallets;
    cacheVal = new Map(wallets.map((w) => [w.address, w]));
  }
  return cacheVal;
}
