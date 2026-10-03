import { fmtSol } from "../lib/format";
import { navigateTo } from "../lib/nav";
import { playTone } from "../lib/sound";
import type { Order, PulseColumnId, TokenSummary, TrackedTrade } from "../protocol";
import { getServices } from "../services";
import { setApprovalRenderer } from "../services/mock/approvalBroker";
import { type PulseBatch, useMarket } from "./market";
import { useOrders } from "./orders";
import { useSettings } from "./settings";
import { subscribeSequenced } from "./subscribe";
import { useToasts } from "./toasts";
import { useTrackers } from "./trackers";
import { useUi } from "./ui";
import { useWallet } from "./wallet";

const COLUMNS: PulseColumnId[] = ["new", "final", "migrated"];

interface ColumnBuffer {
  snapshot: TokenSummary[] | null;
  upsert: Map<string, TokenSummary>;
  remove: Set<string>;
}

const ORDER_LABEL: Record<Order["kind"], string> = {
  limit_buy: "Limit buy",
  limit_sell: "Limit sell",
  take_profit: "Take profit",
  stop_loss: "Stop loss",
  migration_buy: "Migration buy",
  migration_sell: "Migration sell",
  copy_buy: "Copy buy",
  dev_snipe: "Dev snipe",
};

/**
 * Starts every app-wide subscription and returns a stop function. Pulse deltas are buffered
 * and applied in one store write per animation frame, at most `display.pulseHz` times a second.
 */
export function startFeed(): () => void {
  const services = getServices();
  const { data, wallet } = services;
  const stops: (() => void)[] = [];

  // Mock-only: render the simulated wallet-extension popup through the UI store.
  setApprovalRenderer(
    (request) =>
      new Promise<boolean>((resolve) => {
        useUi.getState().setApproval({
          request,
          resolve: (ok) => {
            useUi.getState().setApproval(null);
            resolve(ok);
          },
        });
      }),
  );
  stops.push(() => setApprovalRenderer(null));

  // Connection state.
  useMarket.getState().setConnection(data.getConnectionState());
  stops.push(data.onConnectionState((s) => useMarket.getState().setConnection(s)));

  // Pulse columns, coalesced.
  const buffers: Record<PulseColumnId, ColumnBuffer> = {
    new: { snapshot: null, upsert: new Map(), remove: new Set() },
    final: { snapshot: null, upsert: new Map(), remove: new Set() },
    migrated: { snapshot: null, upsert: new Map(), remove: new Set() },
  };
  let dirty = false;
  for (const column of COLUMNS) {
    stops.push(
      subscribeSequenced(
        `pulse:${column}`,
        (snap) => {
          const b = buffers[column];
          b.snapshot = snap.tokens;
          b.upsert.clear();
          b.remove.clear();
          dirty = true;
        },
        (delta) => {
          const b = buffers[column];
          for (const mint of delta.remove) {
            b.upsert.delete(mint);
            b.remove.add(mint);
          }
          for (const t of delta.upsert) {
            b.remove.delete(t.mint);
            b.upsert.set(t.mint, t);
          }
          dirty = true;
        },
      ),
    );
  }

  let trackedBuffer: TrackedTrade[] = [];
  let lastFlush = 0;
  let raf = 0;
  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    const hz = Math.min(10, Math.max(4, useSettings.getState().display.pulseHz));
    if (now - lastFlush < 1000 / hz) return;
    lastFlush = now;
    if (dirty) {
      dirty = false;
      const batches: PulseBatch[] = COLUMNS.map((column) => {
        const b = buffers[column];
        const batch: PulseBatch = {
          column,
          snapshot: b.snapshot,
          upsert: [...b.upsert.values()],
          remove: [...b.remove],
        };
        b.snapshot = null;
        b.upsert.clear();
        b.remove.clear();
        return batch;
      }).filter((b) => b.snapshot || b.upsert.length || b.remove.length);
      const entered = useMarket.getState().applyPulse(batches);
      const settings = useSettings.getState();
      for (const column of COLUMNS) {
        if (entered[column].length > 0 && settings.columns[column].sound) {
          playTone(column === "new" ? "new" : column === "final" ? "final" : "migrated", settings.display.soundVolume);
        }
      }
    }
    if (trackedBuffer.length > 0) {
      const items = trackedBuffer;
      trackedBuffer = [];
      useTrackers.getState().pushLive(items);
      alertTracked(items);
    }
  };
  raf = requestAnimationFrame(frame);
  stops.push(() => cancelAnimationFrame(raf));

  // Market status (1 Hz).
  stops.push(
    subscribeSequenced(
      "market",
      (m) => useMarket.getState().setMarket(m),
      (m) => useMarket.getState().setMarket(m),
    ),
  );

  // Armed orders.
  stops.push(
    subscribeSequenced(
      "orders",
      (snap) => useOrders.getState().setAll(snap.orders),
      (delta) => {
        const changes = useOrders.getState().apply(delta);
        for (const { order, prev } of changes) notifyOrder(order, prev);
      },
    ),
  );

  // Trackers.
  const trackers = useTrackers.getState();
  trackers.seedDefaults(
    services.defaults.trackedWallets.map((w, i) => ({
      address: w.address,
      name: w.name,
      emoji: w.emoji,
      alerts: i === 0,
      createdAt: Date.now() - (i + 1) * 86_400_000,
    })),
    ["curve_hunter", "migration_alpha", "rugradar_sim"].map((handle, i) => ({
      handle,
      tweets: true,
      profile: i !== 2,
      follows: i === 0,
      addedAt: Date.now() - (i + 2) * 86_400_000,
    })),
  );
  const syncTracked = () => {
    const s = useTrackers.getState();
    void data.setTrackedWallets(s.wallets.map((w) => w.address));
    void data.setTrackedHandles(s.handles.map((h) => h.handle));
  };
  syncTracked();
  let prevWallets = useTrackers.getState().wallets;
  let prevHandles = useTrackers.getState().handles;
  stops.push(
    useTrackers.subscribe((s) => {
      if (s.wallets !== prevWallets || s.handles !== prevHandles) {
        prevWallets = s.wallets;
        prevHandles = s.handles;
        syncTracked();
      }
    }),
  );
  stops.push(
    subscribeSequenced(
      "tracked",
      (snap) => useTrackers.getState().setLive(snap.items),
      (delta) => {
        trackedBuffer = delta.items.concat(trackedBuffer);
      },
    ),
  );
  stops.push(
    subscribeSequenced(
      "social",
      (snap) => useTrackers.getState().setPosts(snap.posts),
      (delta) => useTrackers.getState().pushPosts(delta.posts),
    ),
  );

  // Wallet service state + one wallet topic per trading wallet.
  const walletSubs = new Map<string, () => void>();
  const syncWallets = () => {
    const state = wallet.getState();
    useWallet.getState().setService(state);
    const wanted = new Set(state.tradingWallets.filter((w) => !w.archived).map((w) => w.address));
    for (const [address, stop] of walletSubs) {
      if (!wanted.has(address)) {
        stop();
        walletSubs.delete(address);
      }
    }
    for (const address of wanted) {
      if (walletSubs.has(address)) continue;
      walletSubs.set(
        address,
        subscribeSequenced(
          `wallet:${address}`,
          (status) => useWallet.getState().applySnapshot(address, status),
          (delta) => useWallet.getState().applyDelta(address, delta),
        ),
      );
    }
  };
  syncWallets();
  stops.push(wallet.subscribe(syncWallets));
  stops.push(() => {
    for (const stop of walletSubs.values()) stop();
    walletSubs.clear();
  });

  // Keystore auto-lock follows the setting.
  wallet.setAutoLock(useSettings.getState().autoLockMinutes);
  let prevLock = useSettings.getState().autoLockMinutes;
  stops.push(
    useSettings.subscribe((s) => {
      if (s.autoLockMinutes !== prevLock) {
        prevLock = s.autoLockMinutes;
        wallet.setAutoLock(s.autoLockMinutes);
      }
    }),
  );

  return () => {
    for (const stop of stops.reverse()) stop();
  };
}

let lastTrackedToast = 0;

function alertTracked(items: TrackedTrade[]): void {
  const { wallets } = useTrackers.getState();
  const byAddress = new Map(wallets.map((w) => [w.address, w]));
  const hits = items.filter((i) => byAddress.get(i.trade.maker)?.alerts);
  if (hits.length === 0) return;
  const settings = useSettings.getState();
  playTone("tracked", settings.display.soundVolume);
  const now = Date.now();
  if (now - lastTrackedToast < 2500) return;
  lastTrackedToast = now;
  const first = hits[0];
  if (!first) return;
  const w = byAddress.get(first.trade.maker);
  useToasts.getState().push({
    kind: "info",
    title: `${w ? `${w.emoji} ${w.name}` : "Tracked wallet"} ${first.trade.side === "buy" ? "bought" : "sold"} ${fmtSol(first.trade.solAmount)} SOL`,
    body: `$${first.token.symbol}${hits.length > 1 ? ` (+${hits.length - 1} more)` : ""}`,
    action: { label: "Open", run: () => navigateTo(`/t/${first.token.mint}`) },
  });
}

function notifyOrder(order: Order, prev: Order | undefined): void {
  if (!prev || prev.status === order.status) return;
  const label = `${ORDER_LABEL[order.kind]} · $${order.symbol}`;
  const push = useToasts.getState().push;
  const volume = useSettings.getState().display.soundVolume;
  if (order.status === "filled") {
    playTone("fill", volume);
    push({
      kind: "success",
      title: `Order filled: ${label}`,
      body: order.fill ? `${order.side === "buy" ? "Bought" : "Sold"} for ${fmtSol(order.fill.solAmount)} SOL` : undefined,
    });
  } else if (order.status === "failed") {
    playTone("fail", volume);
    push({ kind: "error", title: `Order failed: ${label}`, body: order.statusReason ?? undefined, ttl: 8000 });
  } else if (order.status === "stale") {
    push({
      kind: "warn",
      title: `Needs re-arm: ${label}`,
      body: order.statusReason ?? undefined,
      ttl: 10_000,
      action: { label: "Review", run: () => navigateTo("/orders") },
    });
  } else if (order.status === "submitted") {
    push({ kind: "info", title: `Triggered: ${label}`, body: "Submitting the pre-signed transaction…", ttl: 2500 });
  }
}
