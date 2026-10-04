import { wsUrl } from "../../runtime";
import type { Services } from "../index";
import type { TradeService } from "../tradeService";
import { LiveDataSource } from "./LiveDataSource";
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

const notYet = (what: string) => () => Promise.reject(new Error(`${what} is not available in this build yet`));

function readOnlyTrade(): TradeService {
  return {
    buy: notYet("Trading"),
    sell: notYet("Trading"),
    placeLimit: notYet("Armed orders"),
    armTpSl: notYet("Armed orders"),
    armMigration: notYet("Armed orders"),
    cancel: notYet("Cancelling"),
    rearm: notYet("Re-arming"),
    panic: notYet("Panic"),
  };
}

/** The live stack: gateway data source, wallet + signer worker, trade engine. */
export async function createLiveServices(): Promise<Services> {
  const data = new LiveDataSource({ socket: { url: wsUrl } });
  const signer = new SignerHost(createSignerWorker);
  const wallet = new LiveWalletService({ data, signer });
  // Restores the session and the keystore's wallet list before the first render (both are local or one
  // REST call); the wallet extension reconnects silently in the background.
  await wallet.init();
  return {
    data,
    trade: readOnlyTrade(),
    wallet,
    simulated: false,
    source: "live",
    features: LIVE_FEATURES,
    defaults: { trackedWallets: [] },
  };
}
