import type { JupiterTradeOptions } from "@zerofee/core";
import type { PulseBootstrapResponse } from "@zerofee/protocol";
import { apiUrl, wsUrl } from "../../runtime";
import type { CopyService } from "../copyService";
import type { Services } from "../index";
import { LiveDataSource } from "./LiveDataSource";
import { LiveWalletService } from "./LiveWalletService";
import { lazyTradeService, whenIdle } from "./lazyTrade";
import { SignerHost } from "./signerHost";
import { createSignerWorker } from "./signerWorker";

const LIVE_FEATURES: Services["features"] = {
  passkey: false,
  holders: false,
  xTracker: false,
  pnlHistory: false,
  otherWallets: false,
  exportNeedsPassword: true,
  otherDestinations: false,
};

/**
 * Jupiter `/build` straight from the browser (the long-tail fallback). Keyless by default (0.5 requests/s);
 * VITE_JUPITER_API_KEY is sent as `x-api-key` and is visible to anyone who loads the page, so use a key
 * meant for public clients.
 */
function jupiterOptions(): JupiterTradeOptions {
  const apiKey = import.meta.env.VITE_JUPITER_API_KEY;
  return apiKey ? { apiKey } : {};
}

/** How long the first render may wait for the session / keystore restore before rendering without it. */
const WALLET_INIT_WAIT_MS = 300;

/** GET /api/pulse, the request index.html preloads (same URL and credentials mode, so the browser reuses it). */
async function fetchPulseBootstrap(): Promise<PulseBootstrapResponse | null> {
  try {
    const r = await fetch(apiUrl("/api/pulse"));
    return r.ok ? ((await r.json()) as PulseBootstrapResponse) : null;
  } catch {
    return null;
  }
}

/** The live stack: gateway data source, wallet + signer worker, trade engine (loaded when idle). */
export async function createLiveServices(): Promise<Services> {
  const data = new LiveDataSource({ socket: { url: wsUrl } });
  // First data, in parallel with everything below and with the first render: the Pulse topics go out as soon
  // as the socket opens (held for a while so the feed's own subscription finds them warm), and the REST
  // bootstrap fills the lists if it lands before the socket's snapshots.
  for (const column of ["new", "final", "migrated"] as const) {
    const off = data.subscribe(`pulse:${column}`, () => {});
    setTimeout(off, 15_000);
  }
  void fetchPulseBootstrap().then((b) => {
    if (b) data.seedPulse(b);
  });
  const signer = new SignerHost(createSignerWorker);
  const wallet = new LiveWalletService({ data, signer });
  // Restores the session and the keystore's wallet list (local reads and one REST call); the wallet extension
  // reconnects silently in the background. The first render waits for it only briefly: the wallet store
  // updates when it lands, the Pulse lists never wait for it.
  const walletReady = wallet.init();
  const trade = lazyTradeService(() =>
    import("./LiveTradeService").then((m) => new m.LiveTradeService({ data, signer, wallet, jupiter: jupiterOptions() })),
  );
  // Signed-in background work starts once the first screen is up (or at the first copy-task call):
  // tracked wallets live on the server while signed in (the tracked topics are matched there), and copy-trade
  // signals are acted on while this tab is open and the keystore unlocked (the copy topic's snapshot carries
  // any signal that arrived before).
  let engine: Promise<CopyService> | null = null;
  const background = (): Promise<CopyService> =>
    (engine ??= Promise.all([import("./copy"), import("./trackerSync")]).then(([{ CopyEngine }, { TrackerSync }]) => {
      new TrackerSync({
        session: () => wallet.getState().session,
        onSessionChange: (listener) => wallet.subscribe(() => listener()),
        onError: (message) => console.warn(`tracked wallets: ${message}`),
      }).start();
      const copy = new CopyEngine({ data, trade, locked: () => wallet.getState().locked });
      copy.start();
      return copy;
    }));
  const copy: CopyService = {
    create: (input) => background().then((c) => c.create(input)),
    update: (id, patch) => background().then((c) => c.update(id, patch)),
    pause: (id) => background().then((c) => c.pause(id)),
    resume: (id) => background().then((c) => c.resume(id)),
    remove: (id) => background().then((c) => c.remove(id)),
  };
  await Promise.race([walletReady, new Promise((r) => setTimeout(r, WALLET_INIT_WAIT_MS))]);
  walletReady.catch((e: unknown) => console.warn(`wallet restore failed: ${e instanceof Error ? e.message : String(e)}`));
  // The trade engine (packages/core builders) loads once the first screen is up, well before a click needs it.
  whenIdle(() => void trade.preload().catch(() => undefined), 4_000);
  whenIdle(
    () =>
      void background().catch((e: unknown) => console.warn(`copy trading failed to start: ${e instanceof Error ? e.message : String(e)}`)),
    2_000,
  );
  return {
    data,
    trade,
    wallet,
    simulated: false,
    source: "live",
    features: LIVE_FEATURES,
    copy,
    defaults: { trackedWallets: [] },
  };
}
