/**
 * The worker RPC over a real MessageChannel: the same transport a signer iframe would hand out,
 * and structured cloning exactly like a Worker.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { getPublicKeyFromAddress, getTransactionDecoder, type SignatureBytes, verifySignature } from "@solana/kit";
import { isSignerError } from "../src/errors";
import type { SpendState } from "../src/firewall/spend-tracker";
import { createSignerClient, type MessageEndpoint, SIGNER_RPC_REQUEST, type SignerClient, type SignerRpcEvent } from "../src/rpc";
import { MemoryStore } from "../src/store";
import type { StoredVault } from "../src/vault/format";
import { type SignerWorkerHandle, startSignerWorker } from "../src/worker";
import { LAMPORTS_PER_SOL, makeContext, randomAddress, type TestActors } from "./helpers/fixtures";
import { curveBuyV2, curveSellV2 } from "./helpers/scenarios";
import { buildTransaction, transferSol } from "./helpers/tx";
import { FAST_KDF, PASSWORD } from "./helpers/vault";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function start(): { client: SignerClient; handle: SignerWorkerHandle; app: MessagePort; connected: string } {
  const channel = new MessageChannel();
  channel.port1.start();
  channel.port2.start();
  const policyActors: TestActors = {
    signer: randomAddress(),
    connected: randomAddress(),
    attacker: randomAddress(),
    nonceAccount: randomAddress(),
  };
  const { allowedPrograms, tipAccounts, caps, venueRules } = makeContext(policyActors);
  const handle = startSignerWorker({
    policy: { allowedPrograms, tipAccounts, caps, venueRules: venueRules ?? [] },
    dailyCaps: { buyLamports: 5n * LAMPORTS_PER_SOL, feeLamports: LAMPORTS_PER_SOL },
    vault: { kdfParams: FAST_KDF, allowWeakKdfForTesting: true },
    vaultStorage: new MemoryStore<StoredVault>(),
    spendStorage: new MemoryStore<SpendState>(),
    endpoint: channel.port2 as unknown as MessageEndpoint,
  });
  const client = createSignerClient(channel.port1 as unknown as MessageEndpoint, { timeoutMs: 2_000 });
  cleanups.push(() => {
    client.close();
    handle.stop();
    channel.port1.close();
    channel.port2.close();
  });
  return { client, handle, app: channel.port1, connected: policyActors.connected };
}

describe("signer RPC", () => {
  test("create, add, sign, refuse, export, lock, unlock", async () => {
    const { client } = start();
    const events: SignerRpcEvent[] = [];
    client.onEvent((e) => events.push(e));
    const connected = randomAddress();

    expect(await client.call("status", {})).toEqual({ exists: false, unlocked: false, walletCount: 0 });
    await client.call("createVault", { password: PASSWORD, connectedWallet: connected });
    const wallet = await client.call("addWallet", { label: "Main" });
    expect((await client.call("status", {})).connectedWallet).toBe(connected);
    expect((await client.call("list", {})).map((w) => w.label)).toEqual(["Main"]);

    const actors: TestActors = { signer: wallet.address, connected, attacker: randomAddress(), nonceAccount: randomAddress() };
    const transaction = buildTransaction({ feePayer: wallet.address, instructions: await curveBuyV2(actors) });
    const signed = await client.call("sign", { walletId: wallet.id, transaction });
    expect(signed.signedTransaction).toBeInstanceOf(Uint8Array);
    expect(signed.summary.maxBuyLamports).toBe(LAMPORTS_PER_SOL / 2n); // bigint survives structured clone
    const decoded = getTransactionDecoder().decode(signed.signedTransaction);
    const key = await getPublicKeyFromAddress(wallet.address);
    expect(await verifySignature(key, decoded.signatures[wallet.address] as SignatureBytes, decoded.messageBytes)).toBe(true);

    const drain = buildTransaction({
      feePayer: wallet.address,
      instructions: [transferSol(wallet.address, actors.attacker, LAMPORTS_PER_SOL)],
    });
    const refusal = await client.call("sign", { walletId: wallet.id, transaction: drain }).catch((e: unknown) => e);
    expect(isSignerError(refusal, "FIREWALL_REFUSED")).toBe(true);
    expect(isSignerError(refusal) && refusal.violations?.join()).toContain("not a tip account");
    const dryRun = await client.call("check", { walletId: wallet.id, transaction: drain });
    expect(dryRun.ok).toBe(false);

    const { secretKey } = await client.call("export", { walletId: wallet.id, password: PASSWORD });
    expect(secretKey.length).toBeGreaterThan(80);
    expect((await client.call("auditLog", {})).map((e) => e.status)).toEqual(["signed", "refused"]);
    expect((await client.call("spendToday", {})).buyLamports).toBe(LAMPORTS_PER_SOL / 2n);

    await client.call("lock", {});
    const locked = await client.call("sign", { walletId: wallet.id, transaction }).catch((e: unknown) => e);
    expect(isSignerError(locked, "LOCKED")).toBe(true);
    expect(events).toEqual([{ type: "zerofee-signer/event", event: "locked", reason: "manual" }]);

    const unlocked = await client.call("unlock", { password: PASSWORD });
    expect(unlocked.map((w) => w.address)).toEqual([wallet.address]);
  });

  test("malformed and unknown messages are ignored; bad params are rejected with codes", async () => {
    const { client, app } = start();
    app.postMessage("garbage");
    app.postMessage({ type: SIGNER_RPC_REQUEST, id: "1", method: "status", params: {} });
    app.postMessage({ type: SIGNER_RPC_REQUEST, id: 2, method: "setPolicy", params: {} });
    app.postMessage({ type: SIGNER_RPC_REQUEST, id: 3, method: "status", params: [] });
    expect((await client.call("status", {})).exists).toBe(false);

    const unknown = client.call("setPolicy" as "status", {});
    const shortClient = createSignerClient(app as unknown as MessageEndpoint, { timeoutMs: 100 });
    cleanups.push(() => shortClient.close());
    const timedOut = await shortClient.call("setPolicy" as "status", {}).catch((e: unknown) => e);
    expect(isSignerError(timedOut, "INTERNAL")).toBe(true);
    void unknown.catch(() => undefined);

    const badCreate = await client
      .call("createVault", { password: 42 as unknown as string, connectedWallet: "x" })
      .catch((e: unknown) => e);
    expect(isSignerError(badCreate, "INVALID_ARGUMENT")).toBe(true);
    await client.call("createVault", { password: PASSWORD, connectedWallet: randomAddress() });
    const wallet = await client.call("addWallet", {});
    const badSign = await client
      .call("sign", { walletId: wallet.id, transaction: "AQID" as unknown as Uint8Array })
      .catch((e: unknown) => e);
    expect(isSignerError(badSign, "INVALID_ARGUMENT")).toBe(true);
    const badTables = await client
      .call("sign", { walletId: wallet.id, transaction: new Uint8Array(10), addressLookupTables: { nope: ["x"] } })
      .catch((e: unknown) => e);
    expect(isSignerError(badTables, "INVALID_ARGUMENT")).toBe(true);
  });

  test("trade expectations cross the boundary with bigints intact and are validated", async () => {
    const { client } = start();
    const connected = randomAddress();
    await client.call("createVault", { password: PASSWORD, connectedWallet: connected });
    const wallet = await client.call("addWallet", {});
    const actors: TestActors = { signer: wallet.address, connected, attacker: randomAddress(), nonceAccount: randomAddress() };
    const transaction = buildTransaction({ feePayer: wallet.address, instructions: await curveSellV2(actors) });
    const quote = (expectedOut: bigint) => [{ instruction: 2, expectedOut, slippageBps: 1500 }];

    const signed = await client.call("sign", { walletId: wallet.id, transaction, expectations: quote(470_000_000n) });
    expect(signed.summary.text).toContain("Checked against your own quote");
    const refused = await client
      .call("sign", { walletId: wallet.id, transaction, expectations: quote(600_000_000n) })
      .catch((e: unknown) => e);
    expect(isSignerError(refused, "FIREWALL_REFUSED") && refused.violations?.join()).toContain("below your quote");
    expect((await client.call("check", { walletId: wallet.id, transaction, expectations: quote(600_000_000n) })).ok).toBe(false);

    for (const expectations of [
      { instruction: 2 },
      [{ instruction: 2, expectedOut: 470_000_000, slippageBps: 1500 }],
      [{ instruction: 2, expectedOut: 470_000_000n, slippageBps: "15%" }],
      [{ instruction: "2", expectedOut: 470_000_000n, slippageBps: 1500 }],
      [null],
    ]) {
      const bad = await client
        .call("sign", { walletId: wallet.id, transaction, expectations: expectations as never })
        .catch((e: unknown) => e);
      expect({ expectations, code: isSignerError(bad) ? bad.code : String(bad) }).toEqual({ expectations, code: "INVALID_ARGUMENT" });
    }
  });

  test("internal errors do not leak details across the boundary", async () => {
    const { client, handle } = start();
    (handle.vault as unknown as { status: () => Promise<never> }).status = async () => {
      throw new Error("secret internal detail");
    };
    const error = await client.call("status", {}).catch((e: unknown) => e);
    expect(isSignerError(error, "INTERNAL")).toBe(true);
    expect((error as Error).message).not.toContain("secret internal detail");
  });
});
