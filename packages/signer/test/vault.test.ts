import { describe, expect, test } from "bun:test";
import { createKeyPairFromBytes, getAddressFromPublicKey, getBase58Decoder, getBase58Encoder, isAddress } from "@solana/kit";
import { argon2id } from "hash-wasm";
import { bytesToBase64, toHex } from "../src/bytes";
import { isSignerError, type SignerErrorCode } from "../src/errors";
import { MemoryStore } from "../src/store";
import { parseHeader, type StoredVault, serializeHeader } from "../src/vault/format";
import { DEFAULT_KDF_PARAMS } from "../src/vault/kdf";
import { getSigningKey, Vault } from "../src/vault/vault";
import { randomAddress } from "./helpers/fixtures";
import { FAST_KDF, FrozenTimers, ManualScheduler, makeVault, PASSWORD } from "./helpers/vault";

async function expectCode(promise: Promise<unknown> | (() => unknown), code: SignerErrorCode): Promise<void> {
  try {
    await (typeof promise === "function" ? promise() : promise);
  } catch (e) {
    if (isSignerError(e, code)) return;
    throw new Error(`expected ${code}, got ${String(e)}`);
  }
  throw new Error(`expected ${code}, but it succeeded`);
}

const CONNECTED = randomAddress();

describe("vault: lifecycle", () => {
  test("create, add, lock, unlock, wrong password", async () => {
    const { vault } = makeVault();
    await vault.createVault(PASSWORD, { connectedWallet: CONNECTED });
    expect(vault.isUnlocked).toBe(true);
    expect(vault.connectedWallet).toBe(CONNECTED);
    const w1 = await vault.addWallet("Main");
    const w2 = await vault.addWallet();
    expect(isAddress(w1.address)).toBe(true);
    expect(w1.id).toBe(w1.address);
    expect(w2.label).toBe("Wallet 2");
    expect((await vault.listWallets()).map((w) => w.address)).toEqual([w1.address, w2.address]);

    vault.lock();
    expect(vault.isUnlocked).toBe(false);
    await expectCode(() => vault.connectedWallet, "LOCKED");
    await expectCode(vault.addWallet(), "LOCKED");
    // Public info stays listable while locked (display only).
    expect((await vault.listWallets()).map((w) => w.label)).toEqual(["Main", "Wallet 2"]);

    await expectCode(vault.unlock("wrong password!"), "WRONG_PASSWORD");
    expect(vault.isUnlocked).toBe(false);
    await vault.unlock(PASSWORD);
    expect(vault.isUnlocked).toBe(true);
    expect(getSigningKey(vault, w1.id).address).toBe(w1.address);
  });

  test("never overwrites an existing vault; validates inputs", async () => {
    const { vault } = makeVault();
    await expectCode(vault.unlock(PASSWORD), "NO_VAULT");
    await expectCode(vault.createVault("short", { connectedWallet: CONNECTED }), "WEAK_PASSWORD");
    await expectCode(vault.createVault(PASSWORD, { connectedWallet: "not-an-address" }), "INVALID_ARGUMENT");
    await vault.createVault(PASSWORD, { connectedWallet: CONNECTED });
    await expectCode(vault.createVault(PASSWORD, { connectedWallet: CONNECTED }), "VAULT_EXISTS");
  });

  test("keys are non-extractable CryptoKeys", async () => {
    const { vault } = makeVault();
    await vault.createVault(PASSWORD, { connectedWallet: CONNECTED });
    const w = await vault.addWallet();
    const { privateKey } = getSigningKey(vault, w.id);
    expect(privateKey.extractable).toBe(false);
    expect(privateKey.type).toBe("private");
    await expect(crypto.subtle.exportKey("pkcs8", privateKey)).rejects.toThrow();
    await expect(crypto.subtle.exportKey("jwk", privateKey)).rejects.toThrow();
  });

  test("lock drops all key references, even mid-unlock", async () => {
    const { vault } = makeVault();
    await vault.createVault(PASSWORD, { connectedWallet: CONNECTED });
    const w = await vault.addWallet();
    vault.lock();
    await expectCode(() => getSigningKey(vault, w.id), "LOCKED");
    const unlocking = vault.unlock(PASSWORD);
    vault.lock();
    await expectCode(unlocking, "LOCKED");
    expect(vault.isUnlocked).toBe(false);
  });

  test("at most 25 wallets", async () => {
    const { vault } = makeVault();
    await vault.createVault(PASSWORD, { connectedWallet: CONNECTED });
    for (let i = 0; i < 25; i++) await vault.addWallet();
    await expectCode(vault.addWallet(), "WALLET_LIMIT");
    vault.lock();
    await vault.unlock(PASSWORD);
    expect(await vault.listWallets()).toHaveLength(25);
  });
});

describe("vault: export and import (Phantom format)", () => {
  test("export -> import round trip", async () => {
    const { vault } = makeVault();
    await vault.createVault(PASSWORD, { connectedWallet: CONNECTED });
    const w = await vault.addWallet();
    const secret = await vault.exportWallet(w.id, PASSWORD);
    const bytes = new Uint8Array(getBase58Encoder().encode(secret));
    expect(bytes).toHaveLength(64);
    // Phantom / Solana CLI layout: seed || public key, readable by kit's 64-byte loader.
    const pair = await createKeyPairFromBytes(bytes);
    expect(await getAddressFromPublicKey(pair.publicKey)).toBe(w.address);
    expect((await vault.listWallets())[0]!.exportedAt).toBeNumber();

    const other = makeVault().vault;
    await other.createVault(PASSWORD, { connectedWallet: CONNECTED });
    const imported = await other.importWallet(secret, "Backup");
    expect(imported.address).toBe(w.address);
    expect(imported.source).toBe("imported");
    // 32-byte seed form, base58 and raw.
    const third = makeVault().vault;
    await third.createVault(PASSWORD, { connectedWallet: CONNECTED });
    expect((await third.importWallet(getBase58Decoder().decode(bytes.slice(0, 32)))).address).toBe(w.address);
    await expectCode(third.importWallet(bytes.slice(0, 32)), "DUPLICATE_WALLET");
    bytes.fill(0);
  });

  test("rejects malformed and inconsistent secrets; export needs the password", async () => {
    const { vault } = makeVault();
    await vault.createVault(PASSWORD, { connectedWallet: CONNECTED });
    const a = await vault.addWallet();
    const b = await vault.addWallet();
    const sa = getBase58Encoder().encode(await vault.exportWallet(a.id, PASSWORD));
    const sb = getBase58Encoder().encode(await vault.exportWallet(b.id, PASSWORD));
    const mismatched = getBase58Decoder().decode(Uint8Array.from([...sa.slice(0, 32), ...sb.slice(32)]));
    const fresh = makeVault().vault;
    await fresh.createVault(PASSWORD, { connectedWallet: CONNECTED });
    await expectCode(fresh.importWallet(mismatched), "INVALID_SECRET");
    await expectCode(fresh.importWallet("0OIl"), "INVALID_SECRET");
    await expectCode(fresh.importWallet(getBase58Decoder().decode(new Uint8Array(48).fill(7))), "INVALID_SECRET");
    await expectCode(vault.exportWallet(a.id, "not the password"), "WRONG_PASSWORD");
    await expectCode(vault.exportWallet(randomAddress(), PASSWORD), "WALLET_NOT_FOUND");
  });
});

describe("vault: encryption at rest", () => {
  test("only ciphertext and public data are stored; fresh IV per write", async () => {
    const { vault, storage } = makeVault();
    await vault.createVault(PASSWORD, { connectedWallet: CONNECTED });
    const ivs = new Set<string>();
    const record = async () => (await storage.load())!.value;
    ivs.add(toHex((await record()).iv));
    const w = await vault.addWallet();
    ivs.add(toHex((await record()).iv));
    await vault.addWallet();
    ivs.add(toHex((await record()).iv));
    expect(ivs.size).toBe(3);

    const seed = new Uint8Array(getBase58Encoder().encode(await vault.exportWallet(w.id, PASSWORD))).slice(0, 32);
    const stored = await record();
    const dump = JSON.stringify(stored, (_k, v) => (v instanceof Uint8Array ? toHex(v) : v));
    expect(dump.includes(toHex(seed))).toBe(false);
    expect(dump.includes(bytesToBase64(seed))).toBe(false);
    expect(Object.keys(stored).sort()).toEqual(["ciphertext", "header", "iv", "wallets"]);
    expect(stored.ciphertext.length).toBe(1 + 2 * 64 + 16); // version byte + 2 wallets + GCM tag
    const header = parseHeader(stored.header);
    expect(header.kdf).toEqual(FAST_KDF);
    expect(header.salt).toHaveLength(16);
  });

  test("tampering with ciphertext, IV or any header field (AAD) is detected", async () => {
    const { vault, storage } = makeVault();
    await vault.createVault(PASSWORD, { connectedWallet: CONNECTED });
    await vault.addWallet();
    vault.lock();
    const original = (await storage.load())!.value;
    const tamperings: [string, (v: StoredVault) => StoredVault][] = [
      ["ciphertext bit", (v) => ({ ...v, ciphertext: Uint8Array.from(v.ciphertext, (b, i) => (i === 5 ? b ^ 1 : b)) })],
      [
        "GCM tag bit",
        (v) => ({ ...v, ciphertext: Uint8Array.from(v.ciphertext, (b, i) => (i === v.ciphertext.length - 1 ? b ^ 0x80 : b)) }),
      ],
      ["IV", (v) => ({ ...v, iv: Uint8Array.from(v.iv, (b, i) => (i === 0 ? b ^ 1 : b)) })],
      [
        "connected wallet in header",
        (v) => {
          const { header } = parseHeader(v.header);
          return { ...v, header: serializeHeader({ ...header, connectedWallet: randomAddress() }) };
        },
      ],
      [
        "KDF iterations in header",
        (v) => {
          const { header } = parseHeader(v.header);
          return { ...v, header: serializeHeader({ ...header, kdf: { ...header.kdf, t: header.kdf.t + 1 } }) };
        },
      ],
    ];
    for (const [name, tamper] of tamperings) {
      storage.tamper(() => tamper(original));
      try {
        await vault.unlock(PASSWORD);
        throw new Error(`tampered ${name} was accepted`);
      } catch (e) {
        expect({ name, code: isSignerError(e) ? e.code : String(e) }).toEqual({ name, code: "WRONG_PASSWORD" });
      }
      expect(vault.isUnlocked).toBe(false);
    }
    storage.tamper(() => original);
    await vault.unlock(PASSWORD);
  });

  test("absurd KDF parameters in a tampered header are rejected before running Argon2id", async () => {
    const { vault, storage } = makeVault();
    await vault.createVault(PASSWORD, { connectedWallet: CONNECTED });
    vault.lock();
    storage.tamper((v) => {
      const { header } = parseHeader(v.header);
      return { ...v, header: serializeHeader({ ...header, kdf: { ...header.kdf, m: 4 * 1024 * 1024 } }) };
    });
    const started = performance.now();
    await expectCode(vault.unlock(PASSWORD), "INVALID_VAULT");
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("refuses to create or unlock vaults below the OWASP minimum (m>=19456 KiB, t>=2)", async () => {
    expect(() => new Vault({ storage: new MemoryStore(), kdfParams: FAST_KDF })).toThrow(/OWASP/);
    expect(() => new Vault({ storage: new MemoryStore(), kdfParams: { memoryKiB: 19_456, iterations: 1, parallelism: 1 } })).toThrow(
      /OWASP/,
    );
    const { vault, storage } = makeVault();
    await vault.createVault(PASSWORD, { connectedWallet: CONNECTED });
    const production = new Vault({ storage });
    await expectCode(production.unlock(PASSWORD), "WEAK_KDF");
  });

  test("production defaults (Argon2id m=64 MiB, t=3, p=1) work end to end", async () => {
    expect(DEFAULT_KDF_PARAMS).toEqual({ memoryKiB: 65_536, iterations: 3, parallelism: 1 });
    const storage = new MemoryStore<StoredVault>();
    const vault = new Vault({ storage });
    await vault.createVault(PASSWORD, { connectedWallet: CONNECTED });
    const w = await vault.addWallet();
    vault.lock();
    await vault.unlock(PASSWORD);
    expect((await vault.listWallets())[0]!.address).toBe(w.address);
    expect(parseHeader((await storage.load())!.value.header).kdf).toEqual(DEFAULT_KDF_PARAMS);
  });

  test("hash-wasm Argon2id matches the reference implementation's known answer", async () => {
    // phc-winner-argon2 test vector: argon2id, t=2, m=2^16 KiB, p=1, "password" / "somesalt".
    const hash = await argon2id({
      password: "password",
      salt: "somesalt",
      iterations: 2,
      memorySize: 65_536,
      parallelism: 1,
      hashLength: 32,
      outputType: "hex",
    });
    expect(hash).toBe("09316115d5cf24ed5a15a31a3ba326e5cf32edc24702987c02b6566f61913cf7");
  });

  test("passwords are Unicode-normalized (NFC and NFD spellings unlock the same vault)", async () => {
    const { vault } = makeVault();
    const nfc = "pässwörd-crème-brûlée".normalize("NFC");
    await vault.createVault(nfc, { connectedWallet: CONNECTED });
    vault.lock();
    await vault.unlock(nfc.normalize("NFD"));
    expect(vault.isUnlocked).toBe(true);
  });
});

describe("vault: re-keying and metadata", () => {
  test("changePassword re-encrypts with a new salt; old password stops working", async () => {
    const { vault, storage } = makeVault();
    await vault.createVault(PASSWORD, { connectedWallet: CONNECTED });
    const w = await vault.addWallet();
    const saltBefore = parseHeader((await storage.load())!.value.header).salt;
    await expectCode(vault.changePassword("not the password", "a brand new password"), "WRONG_PASSWORD");
    await expectCode(vault.changePassword(PASSWORD, "short"), "WEAK_PASSWORD");
    await vault.changePassword(PASSWORD, "a brand new password");
    expect(toHex(parseHeader((await storage.load())!.value.header).salt)).not.toBe(toHex(saltBefore));
    // Still unlocked and usable after the change.
    expect(getSigningKey(vault, w.id).address).toBe(w.address);
    await vault.addWallet();
    vault.lock();
    await expectCode(vault.unlock(PASSWORD), "WRONG_PASSWORD");
    await vault.unlock("a brand new password");
    expect(await vault.listWallets()).toHaveLength(2);
  });

  test("setConnectedWallet requires the password and is bound into the header", async () => {
    const { vault } = makeVault();
    await vault.createVault(PASSWORD, { connectedWallet: CONNECTED });
    const next = randomAddress();
    await expectCode(vault.setConnectedWallet(next, "not the password"), "WRONG_PASSWORD");
    await vault.setConnectedWallet(next, PASSWORD);
    expect(vault.connectedWallet).toBe(next);
    vault.lock();
    await vault.unlock(PASSWORD);
    expect(vault.connectedWallet).toBe(next);
  });

  test("tampered public metadata is repaired from the decrypted keys at unlock", async () => {
    const { vault, storage } = makeVault();
    await vault.createVault(PASSWORD, { connectedWallet: CONNECTED });
    const w = await vault.addWallet("Main");
    vault.lock();
    const attacker = randomAddress();
    storage.tamper((v) => ({ ...v, wallets: [{ address: attacker, label: "Main", createdAt: 0, source: "generated" }] }));
    expect((await vault.listWallets())[0]!.address).toBe(attacker); // locked: unauthenticated display data
    await vault.unlock(PASSWORD);
    expect((await vault.listWallets()).map((x) => x.address)).toEqual([w.address]);
    expect((await storage.load())!.value.wallets.map((x) => x.address)).toEqual([w.address]);
  });

  test("concurrent writes never lose a wallet (same vault, and two tabs on one store)", async () => {
    const { vault, storage } = makeVault();
    await vault.createVault(PASSWORD, { connectedWallet: CONNECTED });
    await Promise.all([vault.addWallet(), vault.addWallet(), vault.addWallet()]);
    const tab2 = makeVault({ storage }).vault;
    await tab2.unlock(PASSWORD);
    const [x, y] = await Promise.all([vault.addWallet("tab1"), tab2.addWallet("tab2")]);
    vault.lock();
    await vault.unlock(PASSWORD);
    const addresses = (await vault.listWallets()).map((w) => w.address);
    expect(addresses).toHaveLength(5);
    expect(addresses).toContain(x.address);
    expect(addresses).toContain(y.address);
  });

  test("a tab picks up wallets another tab added when it next writes", async () => {
    const { vault, storage } = makeVault();
    await vault.createVault(PASSWORD, { connectedWallet: CONNECTED });
    const tab2 = makeVault({ storage }).vault;
    await tab2.unlock(PASSWORD);
    const fromTab1 = await vault.addWallet("tab1");
    await expect(Promise.resolve().then(() => getSigningKey(tab2, fromTab1.id))).rejects.toThrow("no such wallet");
    await tab2.addWallet("tab2");
    expect(getSigningKey(tab2, fromTab1.id).address).toBe(fromTab1.address);
  });
});

describe("vault: auto-lock", () => {
  test("locks after 15 idle minutes; touch() postpones; onAutoLock fires once", async () => {
    const scheduler = new ManualScheduler();
    const { vault } = makeVault({ scheduler });
    const events: string[] = [];
    vault.onAutoLock(() => events.push("auto"));
    vault.onLock((reason) => events.push(`lock:${reason}`));
    await vault.createVault(PASSWORD, { connectedWallet: CONNECTED });
    scheduler.advance(14 * 60_000);
    expect(vault.isUnlocked).toBe(true);
    vault.touch();
    scheduler.advance(14 * 60_000);
    expect(vault.isUnlocked).toBe(true);
    scheduler.advance(60_000 + 1);
    expect(vault.isUnlocked).toBe(false);
    expect(events).toEqual(["auto", "lock:auto"]);
    vault.lock(); // already locked: no duplicate event
    expect(events).toHaveLength(2);
    expect(scheduler.pending).toBe(0);
  });

  test("idle expiry is enforced on use even if timers are throttled", async () => {
    const scheduler = new FrozenTimers();
    const { vault } = makeVault({ scheduler, autoLockMs: 60_000 });
    await vault.createVault(PASSWORD, { connectedWallet: CONNECTED });
    const w = await vault.addWallet();
    scheduler.time += 60_000;
    await expectCode(() => getSigningKey(vault, w.id), "LOCKED");
    expect(vault.isUnlocked).toBe(false);
  });

  test("manual lock emits a manual event", async () => {
    const { vault } = makeVault();
    const reasons: string[] = [];
    vault.onLock((r) => reasons.push(r));
    await vault.createVault(PASSWORD, { connectedWallet: CONNECTED });
    vault.lock();
    expect(reasons).toEqual(["manual"]);
  });
});
