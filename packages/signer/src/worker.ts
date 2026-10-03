/**
 * Signer Web Worker: keystore + firewall in their own JS global, reachable only through the typed
 * postMessage RPC in rpc.ts (unlock / lock / list / sign / export, plus vault management).
 *
 * Wiring (the worker bundle must contain only this package and its pinned dependencies):
 *
 *   // signer.worker.ts (separate entry, no app code, no analytics)
 *   import { startSignerWorker, createPumpBondingCurveRule, createPumpSwapRule } from "@zerofee/signer/worker";
 *   startSignerWorker({ policy: POLICY, dailyCaps: DAILY_CAPS });   // POLICY is bundled config, never sent over RPC
 *
 *   // app
 *   const signer = createSignerClient(new Worker(new URL("./signer.worker.ts", import.meta.url), { type: "module" }));
 *   await signer.call("unlock", { password });
 *   const { signedTransaction, summary } = await signer.call("sign", { walletId, transaction });
 *
 * The policy (allowed programs, venue rules, tip accounts, per-trade caps) and the daily caps are
 * fixed when the worker starts; no RPC method can change them. The connected wallet is bound into
 * the vault's authenticated header at creation.
 *
 * Limits of the worker stage: a Worker shares the app's origin, and the password is typed into
 * the app's DOM. Compromised app JavaScript therefore cannot read keys or bypass the firewall, but
 * it can capture the password and call `export`, and it can request firewall-approved transactions
 * within the caps.
 *
 * Planned upgrade: a dedicated signer origin (e.g. https://signer.<canonical-domain>) loaded in a
 * sandboxed iframe with a strict CSP and SRI. The iframe renders its own password, export and
 * confirmation UI, so the app never sees secrets. Bootstrap:
 *   1. The app creates the iframe and a MessageChannel, then posts port2 to the iframe with
 *      `iframe.contentWindow.postMessage({ type: "zerofee-signer/connect" }, SIGNER_ORIGIN, [port2])`.
 *   2. The iframe accepts the port only if `event.origin === APP_ORIGIN` (exact match from its own
 *      bundled config) and `event.source === window.parent`, and ignores every other message.
 *   3. The iframe calls `serveSignerRpc(port2, createSignerHandlers(...))`; the app calls
 *      `createSignerClient(port1)`. The RPC messages are the ones defined here, so the app side is
 *      unchanged; the iframe's own UI then supplies passwords for `unlock` / `export`.
 */
import { type Address, isAddress } from "@solana/kit";
import { AuditLog } from "./audit";
import { SignerError } from "./errors";
import { type DailySpendCaps, type SpendState, SpendTracker } from "./firewall/spend-tracker";
import { IndexedDbStore } from "./indexeddb";
import { type MessageEndpoint, type SignerRpcHandlers, type SignParams, serveSignerRpc } from "./rpc";
import { type SignerPolicy, SignerService, type SignRequest } from "./service";
import type { VersionedStore } from "./store";
import type { StoredVault } from "./vault/format";
import { Vault, type VaultOptions } from "./vault/vault";

// What a worker entry module needs, so it can import from "@zerofee/signer/worker" alone.
export { createPumpBondingCurveRule, createPumpSwapRule } from "./firewall/rules/pump";
export type { DailySpendCaps } from "./firewall/spend-tracker";
export type { FirewallCaps } from "./firewall/types";
export { IndexedDbStore } from "./indexeddb";
export type { SignerPolicy } from "./service";
export { MemoryStore } from "./store";

function str(value: unknown, name: string): string {
  if (typeof value !== "string") throw new SignerError("INVALID_ARGUMENT", `${name} must be a string`);
  return value;
}

function optionalStr(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : str(value, name);
}

function addressList(value: unknown, name: string): Address[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && isAddress(v))) {
    throw new SignerError("INVALID_ARGUMENT", `${name} must be an array of addresses`);
  }
  return value as Address[];
}

function signRequest(params: SignParams): { walletId: string; transaction: Uint8Array; request: SignRequest } {
  const walletId = str(params.walletId, "walletId");
  if (!(params.transaction instanceof Uint8Array)) throw new SignerError("INVALID_ARGUMENT", "transaction must be a Uint8Array");
  const tables = params.addressLookupTables;
  if (tables !== undefined && (typeof tables !== "object" || tables === null || Array.isArray(tables))) {
    throw new SignerError("INVALID_ARGUMENT", "addressLookupTables must be an object of address arrays");
  }
  const addressLookupTables: Record<string, Address[]> = {};
  for (const [table, entries] of Object.entries(tables ?? {})) {
    if (!isAddress(table)) throw new SignerError("INVALID_ARGUMENT", "lookup table keys must be addresses");
    addressLookupTables[table] = addressList(entries, `addressLookupTables[${table}]`);
  }
  return {
    walletId,
    transaction: params.transaction,
    request: { ownedNonceAccounts: addressList(params.ownedNonceAccounts, "ownedNonceAccounts"), addressLookupTables },
  };
}

/** RPC handlers over a vault and service. Shared by the Worker and the future signer iframe. */
export function createSignerHandlers(vault: Vault, service: SignerService, spendTracker: SpendTracker): SignerRpcHandlers {
  return {
    status: async () => {
      const status = await vault.status();
      return { ...status, ...(status.unlocked ? { connectedWallet: vault.connectedWallet } : {}) };
    },
    createVault: async (p) => {
      await vault.createVault(str(p.password, "password"), { connectedWallet: str(p.connectedWallet, "connectedWallet") });
      return null;
    },
    unlock: async (p) => {
      await vault.unlock(str(p.password, "password"));
      return vault.listWallets();
    },
    lock: async () => {
      vault.lock();
      return null;
    },
    touch: async () => {
      vault.touch();
      return null;
    },
    list: async () => vault.listWallets(),
    addWallet: async (p) => vault.addWallet(optionalStr(p.label, "label")),
    importWallet: async (p) => vault.importWallet(str(p.secret, "secret"), optionalStr(p.label, "label")),
    renameWallet: async (p) => vault.renameWallet(str(p.walletId, "walletId"), str(p.label, "label")),
    export: async (p) => ({ secretKey: await vault.exportWallet(str(p.walletId, "walletId"), str(p.password, "password")) }),
    changePassword: async (p) => {
      await vault.changePassword(str(p.oldPassword, "oldPassword"), str(p.newPassword, "newPassword"));
      return null;
    },
    sign: async (p) => {
      const { walletId, transaction, request } = signRequest(p);
      return service.signTransaction(walletId, transaction, request);
    },
    check: async (p) => {
      const { walletId, transaction, request } = signRequest(p);
      return service.checkTransaction(walletId, transaction, request);
    },
    spendToday: async () => spendTracker.totals(),
    auditLog: async () => service.auditLog.list(),
  };
}

export interface SignerWorkerOptions {
  /** Bundled firewall policy. Never accepted over RPC. */
  policy: SignerPolicy | (() => SignerPolicy | Promise<SignerPolicy>);
  /** Bundled daily caps (SPEC: per-user max SOL per day, enforced in the browser). */
  dailyCaps: DailySpendCaps;
  /** Vault options other than storage (KDF params, auto-lock). */
  vault?: Omit<VaultOptions, "storage">;
  /** Defaults to IndexedDB "zerofee-signer" / key "vault". */
  vaultStorage?: VersionedStore<StoredVault>;
  /** Defaults to IndexedDB "zerofee-signer" / key "spend". */
  spendStorage?: VersionedStore<SpendState>;
  /** Defaults to the worker global scope. */
  endpoint?: MessageEndpoint;
  auditCapacity?: number;
}

export interface SignerWorkerHandle {
  readonly vault: Vault;
  readonly service: SignerService;
  readonly spendTracker: SpendTracker;
  stop(): void;
}

/** Starts serving the signer RPC. Call once from the worker's entry module. */
export function startSignerWorker(options: SignerWorkerOptions): SignerWorkerHandle {
  const endpoint = options.endpoint ?? (globalThis as unknown as MessageEndpoint);
  const vault = new Vault({ ...options.vault, storage: options.vaultStorage ?? new IndexedDbStore<StoredVault>({ key: "vault" }) });
  const spendTracker = new SpendTracker({
    storage: options.spendStorage ?? new IndexedDbStore<SpendState>({ key: "spend" }),
    caps: options.dailyCaps,
  });
  const service = new SignerService({ vault, policy: options.policy, spendTracker, auditLog: new AuditLog(options.auditCapacity) });
  const server = serveSignerRpc(endpoint, createSignerHandlers(vault, service, spendTracker));
  const unsubscribe = vault.onLock((reason) => server.emit({ type: "zerofee-signer/event", event: "locked", reason }));
  return {
    vault,
    service,
    spendTracker,
    stop() {
      unsubscribe();
      server.close();
      vault.lock();
    },
  };
}
