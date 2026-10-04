import { wsUrl } from "../../runtime";
import type { Services } from "../index";
import type { TradeService } from "../tradeService";
import type { WalletService, WalletServiceState } from "../walletService";
import { LiveDataSource } from "./LiveDataSource";

const LIVE_FEATURES: Services["features"] = {
  passkey: false,
  holders: false,
  xTracker: false,
  pnlHistory: false,
  otherWallets: false,
  exportNeedsPassword: true,
};

const notYet = (what: string) => () => Promise.reject(new Error(`${what} is not available in this build yet`));

/** Read-only wallet service until the wallet layer is wired (no connected wallet, no trading wallets). */
function readOnlyWallet(): WalletService {
  const state: WalletServiceState = { connected: null, session: null, tradingWallets: [], locked: true, autoLockAt: null };
  return {
    getState: () => state,
    subscribe: () => () => {},
    connect: notYet("Connecting a wallet"),
    disconnect: async () => {},
    signIn: notYet("Sign-in"),
    createTradingWallet: notYet("Creating a trading wallet"),
    confirmBackup: notYet("Backup"),
    exportKey: notYet("Key export"),
    archiveTradingWallet: notYet("Archiving"),
    changeUnlockMethod: notYet("Changing the unlock method"),
    reclaimRent: notYet("Reclaiming rent"),
    unlock: notYet("Unlocking"),
    unlockWithPasskey: notYet("Passkey unlock"),
    lock: () => {},
    setAutoLock: () => {},
    touch: () => {},
    balances: async () => ({ connectedSol: Number.NaN, trading: {} }),
    fundFromConnected: notYet("Funding"),
    withdrawToConnected: notYet("Withdrawing"),
    approveWithConnected: async () => false,
  };
}

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
  return {
    data,
    trade: readOnlyTrade(),
    wallet: readOnlyWallet(),
    simulated: false,
    source: "live",
    features: LIVE_FEATURES,
    defaults: { trackedWallets: [] },
  };
}
