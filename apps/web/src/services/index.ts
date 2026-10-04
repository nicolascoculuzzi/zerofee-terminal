import type { DataSourceKind } from "../runtime";
import type { DataSource } from "./dataSource";
import type { TradeService } from "./tradeService";
import type { WalletService } from "./walletService";

/** A tracked wallet the simulation seeds the wallet tracker with (mock only; empty in live mode). */
export interface DefaultTrackedWallet {
  address: string;
  name: string;
  emoji: string;
}

/**
 * What the running backend can do. The UI shows a plain "not available" state for anything off,
 * never placeholder numbers (live mode follows what the server publishes today).
 */
export interface ServiceFeatures {
  /** Passkey (WebAuthn PRF) unlock. The live signer is passphrase-only for now. */
  passkey: boolean;
  /** Holder and top-trader lists on the token page. */
  holders: boolean;
  /** X tracker posts (the `social` feed). */
  xTracker: boolean;
  /** Daily PnL history for the Portfolio chart. */
  pnlHistory: boolean;
  /** Portfolio "search other wallets". */
  otherWallets: boolean;
  /** Key export re-asks for the keystore passphrase (the live signer does; the mock doesn't). */
  exportNeedsPassword: boolean;
}

export interface Services {
  data: DataSource;
  trade: TradeService;
  wallet: WalletService;
  /** True while everything runs on the in-browser simulation. */
  simulated: boolean;
  source: DataSourceKind;
  features: ServiceFeatures;
  /** Mock-only defaults (tracked wallets that exist in the simulated wallet pool). */
  defaults: { trackedWallets: DefaultTrackedWallet[] };
}

/** Kept on globalThis so hot module reloads in dev reuse the running services instead of forking a second set. */
const holder = globalThis as { __zerofeeServices?: Services };

/**
 * Builds the service container once, before the first render (main.tsx). VITE_DATA_SOURCE picks the
 * implementation at build time; each lives in its own chunk, so a live build never ships the simulation
 * and the design preview never loads the trade engine.
 */
export async function initServices(): Promise<Services> {
  if (holder.__zerofeeServices) return holder.__zerofeeServices;
  // Compared on the inlined literal itself (vite.config.ts `define`), not through a variable, so the
  // bundler can see which branch is dead and leave its chunk out.
  const instance =
    import.meta.env.VITE_DATA_SOURCE === "live"
      ? await import("./live").then((m) => m.createLiveServices())
      : await import("./mock").then((m) => m.createMockServices());
  holder.__zerofeeServices = instance;
  return instance;
}

/** The service container. Only valid after `initServices()` resolved (main.tsx renders after it). */
export function getServices(): Services {
  const s = holder.__zerofeeServices;
  if (!s) throw new Error("services are not initialised yet (initServices)");
  return s;
}
