/**
 * Browser keystore for trading wallets.
 *
 * - Seeds: 32 bytes from crypto.getRandomValues. At rest they exist only inside the AES-256-GCM
 *   ciphertext (key = Argon2id(password, salt), AAD = the serialized header).
 * - Unlock decrypts once, imports each seed as a NON-extractable Ed25519 CryptoKey and wipes the
 *   plaintext. While unlocked we hold those CryptoKeys plus the non-extractable AES key (needed to
 *   re-encrypt when a wallet is added without asking for the password again). lock() drops all of it.
 * - Auto-lock after `autoLockMs` without user activity (touch(); default 15 minutes). Signing does
 *   not count as activity, so an unattended tab locks even if something keeps requesting signatures.
 * - Export re-asks for the password. There is no API that returns a usable key or signs arbitrary
 *   bytes; signing goes through SignerService and the firewall.
 */
import { type Address, getAddressDecoder, isAddress } from "@solana/kit";
import { asBufferSource, randomBytes, zeroize } from "../bytes";
import { SignerError } from "../errors";
import { Mutex } from "../mutex";
import type { StoredRecord, VersionedStore } from "../store";
import {
  AES_GCM_IV_BYTES,
  createHeader,
  decodePayload,
  encodePayload,
  formatSecretKey,
  MAX_WALLETS,
  type PayloadEntry,
  parseHeader,
  parseSecretKey,
  type StoredVault,
  type StoredWalletInfo,
  serializeHeader,
  type VaultHeader,
} from "./format";
import { DEFAULT_KDF_PARAMS, deriveVaultKey, KDF_SALT_BYTES, type KdfParams, validateKdfParams } from "./kdf";
import { derivePublicKey, importSigningKey, keyPairMatches } from "./keys";

export interface WalletInfo {
  /** Stable identifier; equal to the address. */
  readonly id: string;
  readonly address: Address;
  readonly label: string;
  readonly createdAt: number;
  readonly source: "generated" | "imported";
  /** Last time the secret was exported (backup reminder). */
  readonly exportedAt?: number;
}

export interface Scheduler {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemScheduler: Scheduler = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => {
    const handle = globalThis.setTimeout(callback, ms) as unknown;
    // Do not keep Bun/Node processes alive for the lock timer (no-op in browsers).
    (handle as { unref?: () => void } | undefined)?.unref?.();
    return handle;
  },
  clearTimeout: (handle) => globalThis.clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
};

export type LockReason = "auto" | "manual";

export interface VaultOptions {
  storage: VersionedStore<StoredVault>;
  /** KDF parameters for new vaults and password changes. Default m=64 MiB, t=3, p=1. */
  kdfParams?: KdfParams;
  /** Tests only: allow KDF parameters below the OWASP minimum (also when unlocking). */
  allowWeakKdfForTesting?: boolean;
  /** Idle time before auto-lock. Default 15 minutes. */
  autoLockMs?: number;
  /** Default 8 characters (after NFKC normalization). */
  minPasswordLength?: number;
  scheduler?: Scheduler;
}

export interface VaultStatus {
  readonly exists: boolean;
  readonly unlocked: boolean;
  readonly walletCount: number;
}

export const DEFAULT_AUTO_LOCK_MS = 15 * 60 * 1000;
const MAX_PASSWORD_LENGTH = 4096;
const MAX_LABEL_LENGTH = 64;
const WRITE_ATTEMPTS = 3;

interface UnlockedWallet {
  info: WalletInfo;
  readonly privateKey: CryptoKey;
  readonly publicKey: Uint8Array;
}

interface UnlockedState {
  key: CryptoKey;
  headerText: string;
  header: VaultHeader;
  readonly wallets: Map<string, UnlockedWallet>;
  lastActivity: number;
}

/** Signing material handed to SignerService. Non-extractable; never leaves the package API. */
export interface SigningKeyRef {
  readonly address: Address;
  readonly privateKey: CryptoKey;
  readonly publicKey: Uint8Array;
}

let readSigningKey: (vault: Vault, walletId: string) => SigningKeyRef;
let readVaultEpoch: (vault: Vault) => number;

const addressDecoder = getAddressDecoder();
const utf8 = (text: string) => new TextEncoder().encode(text);

/** Metadata comes from unauthenticated storage: coerce it to sane shapes before it reaches any UI. */
function toWalletInfo(stored: StoredWalletInfo, address: Address): WalletInfo {
  const label = typeof stored.label === "string" ? stored.label.slice(0, MAX_LABEL_LENGTH) : "Wallet";
  return {
    id: address,
    address,
    label,
    createdAt: Number.isFinite(stored.createdAt) ? stored.createdAt : 0,
    source: stored.source === "imported" ? "imported" : "generated",
    ...(Number.isFinite(stored.exportedAt) ? { exportedAt: stored.exportedAt as number } : {}),
  };
}

function cleanLabel(label: string | undefined, fallback: string): string {
  if (label === undefined) return fallback;
  if (typeof label !== "string") throw new SignerError("INVALID_ARGUMENT", "label must be a string");
  const trimmed = label.trim();
  if (!trimmed) return fallback;
  if (trimmed.length > MAX_LABEL_LENGTH) throw new SignerError("INVALID_ARGUMENT", `label is longer than ${MAX_LABEL_LENGTH} characters`);
  return trimmed;
}

export class Vault {
  static {
    readSigningKey = (vault, walletId) => vault.#signingKey(walletId);
    readVaultEpoch = (vault) => vault.#epoch;
  }

  readonly #storage: VersionedStore<StoredVault>;
  readonly #kdfParams: KdfParams;
  readonly #allowWeak: boolean;
  readonly #autoLockMs: number;
  readonly #minPasswordLength: number;
  readonly #scheduler: Scheduler;
  readonly #mutex = new Mutex();
  readonly #lockListeners = new Set<(reason: LockReason) => void>();
  #state: UnlockedState | undefined;
  /** Incremented by every lock; async operations started before a lock must not resurrect state. */
  #epoch = 0;
  #timer: unknown;

  constructor(options: VaultOptions) {
    this.#storage = options.storage;
    this.#kdfParams = options.kdfParams ?? DEFAULT_KDF_PARAMS;
    this.#allowWeak = options.allowWeakKdfForTesting === true;
    this.#autoLockMs = options.autoLockMs ?? DEFAULT_AUTO_LOCK_MS;
    this.#minPasswordLength = options.minPasswordLength ?? 8;
    this.#scheduler = options.scheduler ?? systemScheduler;
    if (!Number.isFinite(this.#autoLockMs) || this.#autoLockMs <= 0)
      throw new SignerError("INVALID_ARGUMENT", "autoLockMs must be positive");
    validateKdfParams(this.#kdfParams, { allowWeak: this.#allowWeak });
  }

  // ---------------------------------------------------------------- state

  get isUnlocked(): boolean {
    return this.#state !== undefined && !this.#idleExpired(this.#state);
  }

  /** The connected (main) wallet bound into the authenticated header. Requires unlock. */
  get connectedWallet(): Address {
    return this.#requireUnlocked().header.connectedWallet;
  }

  async status(): Promise<VaultStatus> {
    const loaded = await this.#storage.load();
    return {
      exists: loaded !== undefined,
      unlocked: this.isUnlocked,
      walletCount: this.#state ? this.#state.wallets.size : (loaded?.value.wallets.length ?? 0),
    };
  }

  /**
   * Wallets with public info only. Unlocked: derived from the decrypted keys (authoritative).
   * Locked: read from storage metadata, which is not authenticated; use for display only.
   */
  async listWallets(): Promise<WalletInfo[]> {
    if (this.isUnlocked && this.#state) return [...this.#state.wallets.values()].map((w) => w.info);
    const loaded = await this.#storage.load();
    return (loaded?.value.wallets ?? []).filter((w) => isAddress(w.address)).map((w) => toWalletInfo(w, w.address as Address));
  }

  /** Records user activity (forwarded from the UI), postponing auto-lock. */
  touch(): void {
    const state = this.#state;
    if (state && !this.#idleExpired(state)) state.lastActivity = this.#scheduler.now();
  }

  onLock(listener: (reason: LockReason) => void): () => void {
    this.#lockListeners.add(listener);
    return () => this.#lockListeners.delete(listener);
  }

  onAutoLock(listener: () => void): () => void {
    return this.onLock((reason) => {
      if (reason === "auto") listener();
    });
  }

  /** Drops every key reference immediately. */
  lock(): void {
    this.#lock("manual");
  }

  // ---------------------------------------------------------------- lifecycle

  /** Creates an empty vault bound to `connectedWallet` and leaves it unlocked. Never overwrites. */
  createVault(password: string, options: { connectedWallet: string }): Promise<void> {
    const epoch = this.#epoch;
    return this.#mutex.run(async () => {
      this.#assertPassword(password);
      const connectedWallet = options?.connectedWallet;
      if (typeof connectedWallet !== "string" || !isAddress(connectedWallet)) {
        throw new SignerError("INVALID_ARGUMENT", "connectedWallet must be a base58 address");
      }
      if (await this.#storage.load()) throw new SignerError("VAULT_EXISTS", "a vault already exists");
      const salt = randomBytes(KDF_SALT_BYTES);
      const header = createHeader(this.#kdfParams, salt, connectedWallet);
      const headerText = serializeHeader(header);
      const key = await deriveVaultKey(password, salt, this.#kdfParams);
      const plain = encodePayload([]);
      const { iv, ciphertext } = await this.#encrypt(key, plain, headerText);
      const revision = await this.#storage.save({ header: headerText, iv, ciphertext, wallets: [] }, undefined);
      if (revision === undefined) throw new SignerError("VAULT_EXISTS", "a vault already exists");
      if (epoch === this.#epoch) this.#setState({ key, headerText, header, wallets: new Map(), lastActivity: this.#scheduler.now() });
    });
  }

  unlock(password: string): Promise<void> {
    // Captured at call time: a lock() issued while this unlock waits or runs cancels it.
    const epoch = this.#epoch;
    return this.#mutex.run(async () => {
      if (typeof password !== "string") throw new SignerError("INVALID_ARGUMENT", "password must be a string");
      const loaded = await this.#load();
      const { header, kdf, salt } = parseHeader(loaded.value.header);
      validateKdfParams(kdf, { allowWeak: this.#allowWeak });
      const key = await deriveVaultKey(password, salt, kdf);
      const plain = await this.#decrypt(key, loaded.value);
      try {
        const wallets = await this.#importWallets(decodePayload(plain), loaded.value.wallets);
        if (epoch !== this.#epoch) throw new SignerError("LOCKED", "vault was locked while unlocking");
        this.#setState({ key, headerText: loaded.value.header, header, wallets, lastActivity: this.#scheduler.now() });
        await this.#repairMetadata(loaded, wallets);
      } finally {
        plain.fill(0);
      }
    });
  }

  // ---------------------------------------------------------------- wallets

  addWallet(label?: string): Promise<WalletInfo> {
    return this.#mutex.run(async () => {
      this.#requireUnlocked();
      const seed = randomBytes(32);
      try {
        const publicKey = await derivePublicKey(seed);
        const address = addressDecoder.decode(publicKey);
        return await this.#rewrite((entries, wallets) => {
          if (entries.length >= MAX_WALLETS) throw new SignerError("WALLET_LIMIT", `at most ${MAX_WALLETS} wallets`);
          const info: StoredWalletInfo = {
            address,
            label: cleanLabel(label, `Wallet ${entries.length + 1}`),
            createdAt: this.#scheduler.now(),
            source: "generated",
          };
          return {
            entries: [...entries, { seed, publicKey }],
            wallets: [...wallets.filter((w) => w.address !== address), info],
            result: toWalletInfo(info, address),
          };
        });
      } finally {
        seed.fill(0);
      }
    });
  }

  /** Imports a Phantom-style base58 64-byte secret key or a 32-byte seed (base58 or bytes). */
  importWallet(secret: string | Uint8Array, label?: string): Promise<WalletInfo> {
    return this.#mutex.run(async () => {
      this.#requireUnlocked();
      const parsed = parseSecretKey(secret);
      let publicKey: Uint8Array | undefined;
      try {
        if (parsed.publicKey) {
          const probe = await importSigningKey(parsed.seed);
          if (!(await keyPairMatches(probe, parsed.publicKey))) {
            throw new SignerError("INVALID_SECRET", "the public-key half of this secret key does not match its seed");
          }
          publicKey = parsed.publicKey;
        } else {
          publicKey = await derivePublicKey(parsed.seed);
        }
        const address = addressDecoder.decode(publicKey);
        const pk = publicKey;
        return await this.#rewrite((entries, wallets) => {
          if (entries.some((e) => addressDecoder.decode(e.publicKey) === address)) {
            throw new SignerError("DUPLICATE_WALLET", "this wallet is already in the vault");
          }
          if (entries.length >= MAX_WALLETS) throw new SignerError("WALLET_LIMIT", `at most ${MAX_WALLETS} wallets`);
          const info: StoredWalletInfo = {
            address,
            label: cleanLabel(label, `Imported ${entries.length + 1}`),
            createdAt: this.#scheduler.now(),
            source: "imported",
          };
          return {
            entries: [...entries, { seed: parsed.seed, publicKey: pk }],
            wallets: [...wallets.filter((w) => w.address !== address), info],
            result: toWalletInfo(info, address),
          };
        });
      } finally {
        zeroize(parsed.seed, parsed.publicKey);
      }
    });
  }

  /** Returns the Phantom-compatible base58 64-byte secret key. Requires unlock and the password again. */
  exportWallet(walletId: string, password: string): Promise<string> {
    return this.#mutex.run(async () => {
      const state = this.#requireUnlocked();
      if (!state.wallets.has(walletId)) throw new SignerError("WALLET_NOT_FOUND", "no such wallet");
      const loaded = await this.#load();
      if (loaded.value.header !== state.headerText) this.#staleAndLock();
      const { kdf, salt } = parseHeader(loaded.value.header);
      const key = await deriveVaultKey(password, salt, kdf);
      const plain = await this.#decrypt(key, loaded.value);
      try {
        const entry = decodePayload(plain).find((e) => addressDecoder.decode(e.publicKey) === walletId);
        if (!entry) throw new SignerError("WALLET_NOT_FOUND", "no such wallet");
        const secret = formatSecretKey(entry.seed, entry.publicKey);
        const exportedAt = this.#scheduler.now();
        await this.#saveMetadata(
          loaded,
          loaded.value.wallets.map((w) => (w.address === walletId ? { ...w, exportedAt } : w)),
        ).catch(() => undefined);
        return secret;
      } finally {
        plain.fill(0);
      }
    });
  }

  renameWallet(walletId: string, label: string): Promise<WalletInfo> {
    return this.#mutex.run(async () => {
      const state = this.#requireUnlocked();
      const wallet = state.wallets.get(walletId);
      if (!wallet) throw new SignerError("WALLET_NOT_FOUND", "no such wallet");
      const clean = cleanLabel(label, wallet.info.label);
      for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
        const loaded = await this.#load();
        const wallets = loaded.value.wallets.map((w) => (w.address === walletId ? { ...w, label: clean } : w));
        if ((await this.#storage.save({ ...loaded.value, wallets }, loaded.revision)) !== undefined) {
          wallet.info = { ...wallet.info, label: clean };
          return wallet.info;
        }
      }
      throw new SignerError("STORAGE_CONFLICT", "vault storage kept changing; try again");
    });
  }

  // ---------------------------------------------------------------- re-keying

  changePassword(oldPassword: string, newPassword: string): Promise<void> {
    return this.#mutex.run(async () => {
      this.#assertPassword(newPassword);
      await this.#rekey(oldPassword, (header) => ({
        password: newPassword,
        params: this.#kdfParams,
        connectedWallet: header.connectedWallet,
      }));
    });
  }

  /** Re-binds the vault to a new connected wallet (the firewall's withdrawal destination). Requires the password. */
  setConnectedWallet(connectedWallet: string, password: string): Promise<void> {
    return this.#mutex.run(async () => {
      if (typeof connectedWallet !== "string" || !isAddress(connectedWallet)) {
        throw new SignerError("INVALID_ARGUMENT", "connectedWallet must be a base58 address");
      }
      await this.#rekey(password, () => ({ password, params: this.#kdfParams, connectedWallet }));
    });
  }

  // ---------------------------------------------------------------- internals

  #signingKey(walletId: string): SigningKeyRef {
    const state = this.#requireUnlocked();
    const wallet = state.wallets.get(walletId);
    if (!wallet) throw new SignerError("WALLET_NOT_FOUND", "no such wallet");
    return { address: wallet.info.address, privateKey: wallet.privateKey, publicKey: wallet.publicKey };
  }

  #assertPassword(password: string): void {
    if (typeof password !== "string") throw new SignerError("INVALID_ARGUMENT", "password must be a string");
    const length = [...password.normalize("NFKC")].length;
    if (length < this.#minPasswordLength)
      throw new SignerError("WEAK_PASSWORD", `password must be at least ${this.#minPasswordLength} characters`);
    if (length > MAX_PASSWORD_LENGTH) throw new SignerError("WEAK_PASSWORD", "password is too long");
  }

  #idleExpired(state: UnlockedState): boolean {
    return this.#scheduler.now() - state.lastActivity >= this.#autoLockMs;
  }

  #requireUnlocked(): UnlockedState {
    const state = this.#state;
    if (!state) throw new SignerError("LOCKED", "vault is locked");
    if (this.#idleExpired(state)) {
      this.#lock("auto");
      throw new SignerError("LOCKED", "vault auto-locked after inactivity");
    }
    return state;
  }

  #setState(state: UnlockedState): void {
    this.#state = state;
    this.#armTimer(this.#autoLockMs);
  }

  #armTimer(delayMs: number): void {
    if (this.#timer !== undefined) this.#scheduler.clearTimeout(this.#timer);
    this.#timer = this.#scheduler.setTimeout(() => {
      this.#timer = undefined;
      const state = this.#state;
      if (!state) return;
      const idle = this.#scheduler.now() - state.lastActivity;
      if (idle >= this.#autoLockMs) this.#lock("auto");
      else this.#armTimer(this.#autoLockMs - idle);
    }, delayMs);
  }

  #lock(reason: LockReason): void {
    this.#epoch++;
    if (this.#timer !== undefined) {
      this.#scheduler.clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    const wasUnlocked = this.#state !== undefined;
    this.#state = undefined;
    if (!wasUnlocked) return;
    for (const listener of this.#lockListeners) {
      try {
        listener(reason);
      } catch {
        // A faulty listener must not prevent locking.
      }
    }
  }

  /** Storage was re-keyed elsewhere (another tab): our keys may be stale, so lock and ask again. */
  #staleAndLock(): never {
    this.#lock("manual");
    throw new SignerError("LOCKED", "the vault changed in another tab; unlock again");
  }

  async #load(): Promise<StoredRecord<StoredVault>> {
    const loaded = await this.#storage.load();
    if (!loaded) throw new SignerError("NO_VAULT", "no vault has been created");
    return loaded;
  }

  async #encrypt(key: CryptoKey, plain: Uint8Array, headerText: string): Promise<{ iv: Uint8Array; ciphertext: Uint8Array }> {
    const iv = randomBytes(AES_GCM_IV_BYTES);
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: utf8(headerText), tagLength: 128 },
      key,
      asBufferSource(plain),
    );
    return { iv, ciphertext: new Uint8Array(ciphertext) };
  }

  async #decrypt(key: CryptoKey, record: StoredVault): Promise<Uint8Array> {
    if (!(record.iv instanceof Uint8Array) || record.iv.length !== AES_GCM_IV_BYTES || !(record.ciphertext instanceof Uint8Array)) {
      throw new SignerError("INVALID_VAULT", "vault record is malformed");
    }
    try {
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: asBufferSource(record.iv), additionalData: utf8(record.header), tagLength: 128 },
        key,
        asBufferSource(record.ciphertext),
      );
      return new Uint8Array(plain);
    } catch {
      throw new SignerError("WRONG_PASSWORD", "wrong password, or the vault data was modified");
    }
  }

  async #importWallets(entries: readonly PayloadEntry[], metadata: readonly StoredWalletInfo[]): Promise<Map<string, UnlockedWallet>> {
    const wallets = new Map<string, UnlockedWallet>();
    for (const [i, entry] of entries.entries()) {
      const privateKey = await importSigningKey(entry.seed);
      if (!(await keyPairMatches(privateKey, entry.publicKey))) throw new SignerError("INVALID_VAULT", "vault key pair mismatch");
      const address = addressDecoder.decode(entry.publicKey);
      if (wallets.has(address)) throw new SignerError("INVALID_VAULT", "duplicate wallet in vault");
      const meta = metadata.find((m) => m.address === address) ?? {
        address,
        label: `Wallet ${i + 1}`,
        createdAt: 0,
        source: "generated" as const,
      };
      wallets.set(address, { info: toWalletInfo(meta, address), privateKey, publicKey: new Uint8Array(entry.publicKey) });
    }
    return wallets;
  }

  /** Rewrites the public metadata if it disagrees with the decrypted keys (it is not authenticated). */
  async #repairMetadata(loaded: StoredRecord<StoredVault>, wallets: Map<string, UnlockedWallet>): Promise<void> {
    const expected: StoredWalletInfo[] = [...wallets.values()].map(({ info }) => ({
      address: info.address,
      label: info.label,
      createdAt: info.createdAt,
      source: info.source,
      ...(info.exportedAt !== undefined ? { exportedAt: info.exportedAt } : {}),
    }));
    if (JSON.stringify(expected) !== JSON.stringify(loaded.value.wallets))
      await this.#saveMetadata(loaded, expected).catch(() => undefined);
  }

  /** Best-effort metadata-only write (same ciphertext and IV); a concurrent change wins. */
  async #saveMetadata(loaded: StoredRecord<StoredVault>, wallets: readonly StoredWalletInfo[]): Promise<void> {
    const revision = await this.#storage.save({ ...loaded.value, wallets }, loaded.revision);
    const state = this.#state;
    if (revision === undefined || !state) return;
    for (const meta of wallets) {
      const w = state.wallets.get(meta.address);
      if (w) w.info = toWalletInfo(meta, w.info.address);
    }
  }

  /**
   * Decrypts the stored payload with the in-memory key, lets `mutate` produce new entries, then
   * re-encrypts with a fresh IV and compare-and-swaps the record. Retries on concurrent writes.
   */
  async #rewrite<T>(
    mutate: (entries: PayloadEntry[], wallets: StoredWalletInfo[]) => { entries: PayloadEntry[]; wallets: StoredWalletInfo[]; result: T },
  ): Promise<T> {
    const state = this.#requireUnlocked();
    const epoch = this.#epoch;
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
      const loaded = await this.#load();
      if (loaded.value.header !== state.headerText) this.#staleAndLock();
      const plain = await this.#decrypt(state.key, loaded.value);
      let next: Uint8Array | undefined;
      try {
        const out = mutate(decodePayload(plain), [...loaded.value.wallets]);
        next = encodePayload(out.entries);
        const { iv, ciphertext } = await this.#encrypt(state.key, next, state.headerText);
        const revision = await this.#storage.save({ header: state.headerText, iv, ciphertext, wallets: out.wallets }, loaded.revision);
        if (revision === undefined) continue;
        if (epoch === this.#epoch && this.#state === state) await this.#syncWallets(state, out.entries, out.wallets);
        return out.result;
      } finally {
        plain.fill(0);
        next?.fill(0);
      }
    }
    throw new SignerError("STORAGE_CONFLICT", "vault storage kept changing; try again");
  }

  /** Imports keys for entries written by this or another tab that we do not hold yet. */
  async #syncWallets(state: UnlockedState, entries: readonly PayloadEntry[], metadata: readonly StoredWalletInfo[]): Promise<void> {
    for (const entry of entries) {
      const address = addressDecoder.decode(entry.publicKey);
      const meta = metadata.find((m) => m.address === address);
      const existing = state.wallets.get(address);
      if (existing) {
        if (meta) existing.info = toWalletInfo(meta, address);
        continue;
      }
      const privateKey = await importSigningKey(entry.seed);
      state.wallets.set(address, {
        info: toWalletInfo(meta ?? { address, label: `Wallet ${state.wallets.size + 1}`, createdAt: 0, source: "generated" }, address),
        privateKey,
        publicKey: new Uint8Array(entry.publicKey),
      });
    }
  }

  /** Verifies `password` against storage, then re-encrypts under a new header (salt/params/connected wallet). */
  async #rekey(
    password: string,
    next: (header: VaultHeader) => { password: string; params: KdfParams; connectedWallet: Address },
  ): Promise<void> {
    if (typeof password !== "string") throw new SignerError("INVALID_ARGUMENT", "password must be a string");
    const epoch = this.#epoch;
    const loaded = await this.#load();
    const { header, kdf, salt } = parseHeader(loaded.value.header);
    validateKdfParams(kdf, { allowWeak: this.#allowWeak });
    const oldKey = await deriveVaultKey(password, salt, kdf);
    const plain = await this.#decrypt(oldKey, loaded.value);
    try {
      const target = next(header);
      validateKdfParams(target.params, { allowWeak: this.#allowWeak });
      const newSalt = randomBytes(KDF_SALT_BYTES);
      const newHeader = createHeader(target.params, newSalt, target.connectedWallet);
      const headerText = serializeHeader(newHeader);
      const key = await deriveVaultKey(target.password, newSalt, target.params);
      const { iv, ciphertext } = await this.#encrypt(key, plain, headerText);
      const revision = await this.#storage.save({ header: headerText, iv, ciphertext, wallets: loaded.value.wallets }, loaded.revision);
      if (revision === undefined) throw new SignerError("STORAGE_CONFLICT", "vault storage changed concurrently; try again");
      const state = this.#state;
      if (state && epoch === this.#epoch) {
        state.key = key;
        state.headerText = headerText;
        state.header = newHeader;
        state.lastActivity = this.#scheduler.now();
      }
    } finally {
      plain.fill(0);
    }
  }
}

/** @internal SignerService's access to signing keys. Deliberately not re-exported from the package index. */
export function getSigningKey(vault: Vault, walletId: string): SigningKeyRef {
  return readSigningKey(vault, walletId);
}

/** @internal Lock epoch, so SignerService can detect a lock that happened while it was awaiting. */
export function getVaultEpoch(vault: Vault): number {
  return readVaultEpoch(vault);
}
