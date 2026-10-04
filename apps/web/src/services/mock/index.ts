import type { Services } from "../index";
import { fakeAddress } from "./addresses";
import { SimEngine } from "./engine";
import { MockDataSource } from "./MockDataSource";
import { MockTradeService } from "./MockTradeService";
import { MockWalletService } from "./MockWalletService";
import { seedFromUrl } from "./rng";

/** The in-browser simulation: a seeded market, a demo wallet pair and simulated fills. No network. */
export function createMockServices(): Services {
  const engine = new SimEngine(seedFromUrl());
  const connected = fakeAddress(engine.rng);
  const wallets = [
    { id: "tw-main", label: "Main", address: fakeAddress(engine.rng), sol: 11.4826 },
    { id: "tw-sniper", label: "Sniper", address: fakeAddress(engine.rng), sol: 2.0391 },
  ];
  engine.seedWorld(wallets.map((w, i) => ({ address: w.address, sol: w.sol, demo: i === 0 })));
  engine.start();
  return {
    data: new MockDataSource(engine),
    trade: new MockTradeService(engine),
    wallet: new MockWalletService(engine, { connected, wallets }),
    simulated: true,
    source: "mock",
    features: MOCK_FEATURES,
    copy: null,
    defaults: { trackedWallets: engine.defaultTracked },
  };
}

const MOCK_FEATURES: Services["features"] = {
  passkey: true,
  holders: true,
  xTracker: true,
  pnlHistory: true,
  otherWallets: true,
  exportNeedsPassword: false,
  otherDestinations: true,
};
