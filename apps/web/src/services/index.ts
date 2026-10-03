import type { DataSource } from "./dataSource";
import { fakeAddress } from "./mock/addresses";
import { type DefaultTrackedWallet, SimEngine } from "./mock/engine";
import { MockDataSource } from "./mock/MockDataSource";
import { MockTradeService } from "./mock/MockTradeService";
import { MockWalletService } from "./mock/MockWalletService";
import { seedFromUrl } from "./mock/rng";
import type { TradeService } from "./tradeService";
import type { WalletService } from "./walletService";

export interface Services {
  data: DataSource;
  trade: TradeService;
  wallet: WalletService;
  /** True while everything runs on the in-browser simulation. */
  simulated: boolean;
  /** Mock-only defaults (tracked wallets that exist in the simulated wallet pool). */
  defaults: { trackedWallets: DefaultTrackedWallet[] };
}

let instance: Services | null = null;

/**
 * Service container. Today it always builds the mock stack. When the gateway, trade engine
 * and signer land, construct `WsDataSource`, `CoreTradeService` and `SignerWalletService`
 * here instead (e.g. keyed on `import.meta.env.VITE_GATEWAY_URL`). Nothing else changes.
 */
export function getServices(): Services {
  if (instance) return instance;
  const engine = new SimEngine(seedFromUrl());
  const connected = fakeAddress(engine.rng);
  const wallets = [
    { id: "tw-main", label: "Main", address: fakeAddress(engine.rng), sol: 11.4826 },
    { id: "tw-sniper", label: "Sniper", address: fakeAddress(engine.rng), sol: 2.0391 },
  ];
  engine.seedWorld(wallets.map((w, i) => ({ address: w.address, sol: w.sol, demo: i === 0 })));
  engine.start();
  instance = {
    data: new MockDataSource(engine),
    trade: new MockTradeService(engine),
    wallet: new MockWalletService(engine, { connected, wallets }),
    simulated: true,
    defaults: { trackedWallets: engine.defaultTracked },
  };
  return instance;
}
