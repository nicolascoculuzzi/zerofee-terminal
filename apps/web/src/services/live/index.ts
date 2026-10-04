import type { JupiterTradeOptions } from "@zerofee/core";
import { wsUrl } from "../../runtime";
import type { Services } from "../index";
import { LiveDataSource } from "./LiveDataSource";
import { LiveTradeService } from "./LiveTradeService";
import { LiveWalletService } from "./LiveWalletService";
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

/** The live stack: gateway data source, wallet + signer worker, trade engine. */
export async function createLiveServices(): Promise<Services> {
  const data = new LiveDataSource({ socket: { url: wsUrl } });
  const signer = new SignerHost(createSignerWorker);
  const wallet = new LiveWalletService({ data, signer });
  // Restores the session and the keystore's wallet list before the first render (both are local or one
  // REST call); the wallet extension reconnects silently in the background.
  await wallet.init();
  const trade = new LiveTradeService({ data, signer, wallet, jupiter: jupiterOptions() });
  return {
    data,
    trade,
    wallet,
    simulated: false,
    source: "live",
    features: LIVE_FEATURES,
    defaults: { trackedWallets: [] },
  };
}
