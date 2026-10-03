import { describe, expect, test } from "bun:test";
import { getBase58Decoder, getPublicKeyFromAddress, getTransactionDecoder, type SignatureBytes, verifySignature } from "@solana/kit";
import { getAdvanceNonceAccountInstruction } from "@solana-program/system";
import { bytesEqual } from "../src/bytes";
import { isSignerError, type SignerErrorCode } from "../src/errors";
import { type DailySpendCaps, type SpendState, SpendTracker } from "../src/firewall/spend-tracker";
import * as publicApi from "../src/index";
import { type SignerPolicy, SignerService, type SignRequest } from "../src/service";
import { MemoryStore } from "../src/store";
import { LAMPORTS_PER_SOL, makeContext, randomAddress, type TestActors } from "./helpers/fixtures";
import { curveBuyV2 } from "./helpers/scenarios";
import { buildTransaction, noop, transferSol } from "./helpers/tx";
import { makeVault, PASSWORD } from "./helpers/vault";

const SOL = LAMPORTS_PER_SOL;

async function setup(dailyCaps: DailySpendCaps = { buyLamports: 10n * SOL, feeLamports: SOL }) {
  const { vault } = makeVault();
  const connected = randomAddress();
  await vault.createVault(PASSWORD, { connectedWallet: connected });
  const wallet = await vault.addWallet();
  const actors: TestActors = { signer: wallet.address, connected, attacker: randomAddress(), nonceAccount: randomAddress() };
  const { allowedPrograms, tipAccounts, caps, venueRules } = makeContext(actors);
  const policy: SignerPolicy = { allowedPrograms, tipAccounts, caps, venueRules: venueRules ?? [] };
  const spendTracker = new SpendTracker({ storage: new MemoryStore<SpendState>(), caps: dailyCaps });
  const service = new SignerService({ vault, policy, spendTracker });
  return { vault, service, wallet, actors, spendTracker };
}

async function expectCode(promise: Promise<unknown>, code: SignerErrorCode): Promise<readonly string[]> {
  try {
    await promise;
  } catch (e) {
    if (isSignerError(e, code)) return e.violations ?? [];
    throw new Error(`expected ${code}, got ${String(e)}`);
  }
  throw new Error(`expected ${code}, but it succeeded`);
}

describe("SignerService", () => {
  test("firewall-approved transaction is signed by the trading wallet", async () => {
    const { service, wallet, actors } = await setup();
    const unsigned = buildTransaction({ feePayer: wallet.address, instructions: await curveBuyV2(actors) });
    const result = await service.signTransaction(wallet.id, unsigned);

    const decoded = getTransactionDecoder().decode(result.signedTransaction);
    const signature = decoded.signatures[wallet.address];
    expect(signature).toBeTruthy();
    expect(bytesEqual(decoded.messageBytes, unsigned.subarray(65))).toBe(true); // message untouched
    const key = await getPublicKeyFromAddress(wallet.address);
    expect(await verifySignature(key, signature as SignatureBytes, decoded.messageBytes)).toBe(true);
    expect(result.signature).toBe(getBase58Decoder().decode(signature!));
    expect(result.signedTransaction.length).toBe(unsigned.length);
    expect(result.summary.maxBuyLamports).toBe(SOL / 2n);

    const audit = service.auditLog.list();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ walletId: wallet.id, status: "signed", signature: result.signature });
    expect(audit[0]!.summary).toContain("Buy on pump.fun bonding curve");
  });

  test("refused transactions are not signed, not reserved, and are audited", async () => {
    const { service, wallet, actors, spendTracker } = await setup();
    const drain = buildTransaction({ feePayer: wallet.address, instructions: [transferSol(wallet.address, actors.attacker, 5n * SOL)] });
    const violations = await expectCode(service.signTransaction(wallet.id, drain), "FIREWALL_REFUSED");
    expect(violations.join()).toContain("not a tip account");
    expect((await spendTracker.totals()).buyLamports).toBe(0n);
    expect(service.auditLog.list()[0]).toMatchObject({ status: "refused" });
    expect(service.auditLog.list()[0]!.signature).toBeUndefined();
  });

  test("the connected wallet comes from the vault, never from the caller", async () => {
    const { service, wallet, actors } = await setup();
    await service.signTransaction(
      wallet.id,
      buildTransaction({ feePayer: wallet.address, instructions: [transferSol(wallet.address, actors.connected, SOL)] }),
    );
    const forged = { connectedWallet: actors.attacker, tipAccounts: [actors.attacker] } as unknown as SignRequest;
    const toAttacker = buildTransaction({ feePayer: wallet.address, instructions: [transferSol(wallet.address, actors.attacker, SOL)] });
    await expectCode(service.signTransaction(wallet.id, toAttacker, forged), "FIREWALL_REFUSED");
  });

  test("daily cap is enforced across signatures", async () => {
    const { service, wallet, actors } = await setup({ buyLamports: SOL, feeLamports: SOL });
    await service.signTransaction(
      wallet.id,
      buildTransaction({ feePayer: wallet.address, instructions: await curveBuyV2(actors, (SOL * 6n) / 10n) }),
    );
    const violations = await expectCode(
      service.signTransaction(
        wallet.id,
        buildTransaction({ feePayer: wallet.address, instructions: await curveBuyV2(actors, (SOL * 6n) / 10n) }),
      ),
      "DAILY_CAP_EXCEEDED",
    );
    expect(violations.join()).toContain("daily buy cap");
  });

  test("locked vault and unknown wallet are refused", async () => {
    const { service, vault, wallet, actors } = await setup();
    const tx = buildTransaction({ feePayer: wallet.address, instructions: await curveBuyV2(actors) });
    await expectCode(service.signTransaction(randomAddress(), tx), "WALLET_NOT_FOUND");
    vault.lock();
    await expectCode(service.signTransaction(wallet.id, tx), "LOCKED");
  });

  test("a wallet cannot sign a transaction built for another wallet", async () => {
    const { service, vault, wallet, actors } = await setup();
    const second = await vault.addWallet();
    const tx = buildTransaction({ feePayer: wallet.address, instructions: await curveBuyV2(actors) });
    const violations = await expectCode(service.signTransaction(second.id, tx), "FIREWALL_REFUSED");
    expect(violations.join()).toContain("fee payer");
  });

  test("dry-run check neither signs nor reserves", async () => {
    const { service, wallet, actors, spendTracker } = await setup();
    const result = await service.checkTransaction(
      wallet.id,
      buildTransaction({ feePayer: wallet.address, instructions: await curveBuyV2(actors) }),
    );
    expect(result.ok).toBe(true);
    expect((await spendTracker.totals()).buyLamports).toBe(0n);
    expect(service.auditLog.list()).toHaveLength(0);
  });

  test("durable nonce accounts supplied by the caller are honoured only with the signer as authority", async () => {
    const { service, wallet, actors } = await setup();
    const cancel = buildTransaction({
      feePayer: wallet.address,
      instructions: [getAdvanceNonceAccountInstruction({ nonceAccount: actors.nonceAccount, nonceAuthority: noop(wallet.address) })],
    });
    await expectCode(service.signTransaction(wallet.id, cancel), "FIREWALL_REFUSED");
    const signed = await service.signTransaction(wallet.id, cancel, { ownedNonceAccounts: [actors.nonceAccount] });
    expect(signed.signature).toBeString();
  });

  test("the package API has no way to sign arbitrary bytes with a trading wallet", () => {
    const exported = Object.keys(publicApi);
    for (const name of ["getSigningKey", "getVaultEpoch", "signMessage", "signBytes", "inspectTransaction"])
      expect(exported).not.toContain(name);
    expect("signMessage" in SignerService.prototype).toBe(false);
  });
});
