/**
 * The live wallet's signer path end to end, in process: SignerHost drives packages/signer's worker
 * handlers over a real MessageChannel (structured cloning, like the Web Worker), with the shipped
 * createSignerPolicy and the config the worker would decode from its name. Withdrawals built by
 * transfers.ts must pass the firewall to the bound connected wallet and nowhere else.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { SpendState, StoredVault } from "@zerofee/signer";
import { createSignerPolicy, isSignerError, MemoryStore, type MessageEndpoint, startSignerWorker } from "@zerofee/signer";
import { firstSignature } from "./bytes";
import { wireChain } from "./fixtures";
import { decodeSignerConfig, encodeSignerConfig, signerConfigFromSettings } from "./signerConfig";
import { SignerHost, type WorkerLike } from "./signerHost";
import { buildSolTransfer, recentBlockhash, TransferError } from "./transfers";

setDefaultTimeout(30_000);

const FAST_KDF = { memoryKiB: 64, iterations: 1, parallelism: 1 };
const PASSWORD = "correct horse battery staple";
const CONNECTED = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const STRANGER = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

/** An in-process "worker": the same handlers the real worker entry starts, over a MessageChannel. */
function inProcessFactory(stores: { vault: MemoryStore<StoredVault>; spend: MemoryStore<SpendState> }) {
  const started: string[] = [];
  const factory = (name: string): WorkerLike => {
    started.push(name);
    const cfg = decodeSignerConfig(name);
    if (!cfg) throw new Error("bad config");
    const ch = new MessageChannel();
    ch.port1.start();
    ch.port2.start();
    const handle = startSignerWorker({
      policy: createSignerPolicy({ caps: { maxBuyLamports: BigInt(cfg.maxBuyLamports) } }),
      dailyCaps: { buyLamports: BigInt(cfg.dailyBuyLamports), feeLamports: BigInt(cfg.dailyFeeLamports) },
      vault: { kdfParams: FAST_KDF, allowWeakKdfForTesting: true, autoLockMs: cfg.autoLockMs },
      vaultStorage: stores.vault,
      spendStorage: stores.spend,
      endpoint: ch.port2 as unknown as MessageEndpoint,
    });
    const port = ch.port1 as unknown as MessageEndpoint;
    const terminate = () => {
      handle.stop();
      ch.port1.close();
      ch.port2.close();
    };
    stops.push(terminate);
    return Object.assign(Object.create(null), {
      postMessage: (m: unknown) => port.postMessage(m),
      addEventListener: (t: "message", l: (e: MessageEvent) => void) => port.addEventListener(t, l),
      removeEventListener: (t: "message", l: (e: MessageEvent) => void) => port.removeEventListener(t, l),
      terminate,
    }) as WorkerLike;
  };
  return { factory, started };
}

describe("signer config", () => {
  test("settings become caps and auto-lock; the encoding round-trips and rejects junk", () => {
    const cfg = signerConfigFromSettings({ perTradeSol: 0.5, dailySol: 3, autoLockMinutes: 15 });
    expect(cfg).toMatchObject({ maxBuyLamports: "500000000", dailyBuyLamports: "3000000000", autoLockMs: 900_000 });
    expect(decodeSignerConfig(encodeSignerConfig(cfg))).toEqual(cfg);
    expect(decodeSignerConfig("something-else")).toBeNull();
    expect(decodeSignerConfig('zerofee-signer:{"maxBuyLamports":"-1"}')).toBeNull();
    expect(signerConfigFromSettings({ perTradeSol: 1, dailySol: 1, autoLockMinutes: 0 }).autoLockMs).toBe(24 * 3_600_000);
  });
});

describe("live signer path", () => {
  test("vault in the worker, withdrawal to the bound connected wallet signs; anywhere else is refused", async () => {
    const stores = { vault: new MemoryStore<StoredVault>(), spend: new MemoryStore<SpendState>() };
    const { factory, started } = inProcessFactory(stores);
    const host = new SignerHost(factory);
    const locks: string[] = [];
    host.onLocked((r) => locks.push(r));
    expect(host.configure(signerConfigFromSettings({ perTradeSol: 1, dailySol: 5, autoLockMinutes: 15 }))).toBe(false);
    expect(host.configure(signerConfigFromSettings({ perTradeSol: 1, dailySol: 5, autoLockMinutes: 15 }))).toBe(false); // same config: no restart

    expect(await host.rpc.call("status", {})).toEqual({ exists: false, unlocked: false, walletCount: 0 });
    await host.rpc.call("createVault", { password: PASSWORD, connectedWallet: CONNECTED });
    const wallet = await host.rpc.call("addWallet", { label: "Main" });
    const chain = wireChain();

    const withdraw = buildSolTransfer({ from: wallet.address, to: CONNECTED, lamports: 250_000_000n, chain });
    const { signedTransaction, signature, summary } = await host.rpc.call("sign", { walletId: wallet.address, transaction: withdraw });
    expect(firstSignature(signedTransaction)).toBe(signature);
    expect(summary.tipLamports).toBe(5_000n); // the Helius Sender tip the Reduced preset needs
    expect(summary.actions.some((a) => a.kind === "sol_transfer" && a.destination === "connected_wallet")).toBe(true);

    const stolen = buildSolTransfer({ from: wallet.address, to: STRANGER, lamports: 1n, chain });
    const refused = await host.rpc.call("sign", { walletId: wallet.address, transaction: stolen }).catch((e: unknown) => e);
    expect(isSignerError(refused, "FIREWALL_REFUSED")).toBe(true);

    // New settings restart the worker: keys are gone from memory, the vault reads as locked.
    expect(host.configure(signerConfigFromSettings({ perTradeSol: 0.25, dailySol: 5, autoLockMinutes: 15 }))).toBe(true);
    expect(started).toHaveLength(2);
    expect(locks).toContain("restart");
    expect(await host.rpc.call("status", {})).toMatchObject({ exists: true, unlocked: false, walletCount: 1 });
    expect((await host.rpc.call("list", {})).map((w) => w.address)).toEqual([wallet.address]);
    const wrong = await host.rpc.call("unlock", { password: "not it" }).catch((e: unknown) => e);
    expect(isSignerError(wrong, "WRONG_PASSWORD")).toBe(true);
    await host.rpc.call("unlock", { password: PASSWORD });
    const exported = await host.rpc.call("export", { walletId: wallet.address, password: PASSWORD });
    expect(exported.secretKey.length).toBeGreaterThan(80);
    host.stop();
  });

  test("a transfer needs a blockhash and an amount", () => {
    expect(() => recentBlockhash(null)).toThrow(TransferError);
    expect(() => buildSolTransfer({ from: CONNECTED, to: STRANGER, lamports: 0n, chain: wireChain() })).toThrow(TransferError);
  });
});
