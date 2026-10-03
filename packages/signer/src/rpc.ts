/**
 * Typed postMessage RPC between the web app and the isolated signer. The same message shapes work
 * over a dedicated Worker today and over a MessagePort handed out by a signer iframe on its own
 * origin later (see worker.ts), so the app-side client does not change when the signer moves.
 *
 * Everything that arrives at the server side is untrusted and validated before use. Values must be
 * structured-cloneable (Uint8Array, bigint and plain objects are).
 */
import type { AuditEntry } from "./audit";
import { SignerError, type SignerErrorCode } from "./errors";
import type { DailySpendTotals } from "./firewall/spend-tracker";
import type { FirewallResult, TransactionSummary } from "./firewall/types";
import type { LockReason, WalletInfo } from "./vault/vault";

export interface SignerStatus {
  readonly exists: boolean;
  readonly unlocked: boolean;
  readonly walletCount: number;
  /** From the authenticated header when unlocked, otherwise undefined. */
  readonly connectedWallet?: string;
}

export interface SignParams {
  readonly walletId: string;
  /** Wire transaction (legacy or v0) with an empty signature slot. */
  readonly transaction: Uint8Array;
  readonly ownedNonceAccounts?: readonly string[];
  readonly addressLookupTables?: Readonly<Record<string, readonly string[]>>;
}

export interface SignerRpcMethods {
  status: { params: Record<string, never>; result: SignerStatus };
  createVault: { params: { password: string; connectedWallet: string }; result: null };
  unlock: { params: { password: string }; result: WalletInfo[] };
  lock: { params: Record<string, never>; result: null };
  /** Forward user activity (input events) to postpone auto-lock. */
  touch: { params: Record<string, never>; result: null };
  list: { params: Record<string, never>; result: WalletInfo[] };
  addWallet: { params: { label?: string }; result: WalletInfo };
  importWallet: { params: { secret: string; label?: string }; result: WalletInfo };
  renameWallet: { params: { walletId: string; label: string }; result: WalletInfo };
  /** Returns the Phantom-format secret key. Re-asks for the password. */
  export: { params: { walletId: string; password: string }; result: { secretKey: string } };
  changePassword: { params: { oldPassword: string; newPassword: string }; result: null };
  sign: { params: SignParams; result: { signedTransaction: Uint8Array; signature: string; summary: TransactionSummary } };
  /** Dry run of the firewall, no signature. */
  check: { params: SignParams; result: FirewallResult };
  spendToday: { params: Record<string, never>; result: DailySpendTotals };
  auditLog: { params: Record<string, never>; result: AuditEntry[] };
}

export type SignerRpcMethod = keyof SignerRpcMethods;
export type SignerRpcParams<M extends SignerRpcMethod> = SignerRpcMethods[M]["params"];
export type SignerRpcResult<M extends SignerRpcMethod> = SignerRpcMethods[M]["result"];

export const SIGNER_RPC_REQUEST = "zerofee-signer/request";
export const SIGNER_RPC_RESPONSE = "zerofee-signer/response";
export const SIGNER_RPC_EVENT = "zerofee-signer/event";

export const SIGNER_RPC_METHODS: readonly SignerRpcMethod[] = [
  "status",
  "createVault",
  "unlock",
  "lock",
  "touch",
  "list",
  "addWallet",
  "importWallet",
  "renameWallet",
  "export",
  "changePassword",
  "sign",
  "check",
  "spendToday",
  "auditLog",
];

export type SignerRpcRequest = {
  [M in SignerRpcMethod]: { type: typeof SIGNER_RPC_REQUEST; id: number; method: M; params: SignerRpcParams<M> };
}[SignerRpcMethod];

export interface SignerRpcError {
  readonly code: SignerErrorCode;
  readonly message: string;
  readonly violations?: readonly string[];
}

export type SignerRpcResponse =
  | { type: typeof SIGNER_RPC_RESPONSE; id: number; ok: true; result: unknown }
  | { type: typeof SIGNER_RPC_RESPONSE; id: number; ok: false; error: SignerRpcError };

export type SignerRpcEvent = { type: typeof SIGNER_RPC_EVENT; event: "locked"; reason: LockReason };

/** Worker global scope, Worker, or MessagePort. */
export interface MessageEndpoint {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

export type SignerRpcHandlers = { [M in SignerRpcMethod]: (params: SignerRpcParams<M>) => Promise<SignerRpcResult<M>> };

function isRequest(data: unknown): data is SignerRpcRequest {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    d.type === SIGNER_RPC_REQUEST &&
    Number.isSafeInteger(d.id) &&
    typeof d.method === "string" &&
    (SIGNER_RPC_METHODS as readonly string[]).includes(d.method) &&
    (d.params === undefined || (typeof d.params === "object" && d.params !== null && !Array.isArray(d.params)))
  );
}

function toRpcError(e: unknown): SignerRpcError {
  if (e instanceof SignerError) {
    return { code: e.code, message: e.message, ...(e.violations ? { violations: [...e.violations] } : {}) };
  }
  // Do not leak internals (stack traces, library messages) across the boundary.
  return { code: "INTERNAL", message: "internal signer error" };
}

/**
 * Serves `handlers` on `endpoint`. Malformed messages are ignored (no reply: the sender is not
 * speaking this protocol). Returns `emit` for events and `close` to stop listening.
 */
export function serveSignerRpc(
  endpoint: MessageEndpoint,
  handlers: SignerRpcHandlers,
): { emit(event: SignerRpcEvent): void; close(): void } {
  const listener = (event: MessageEvent) => {
    const data: unknown = event.data;
    if (!isRequest(data)) return;
    const handler = handlers[data.method] as (params: unknown) => Promise<unknown>;
    Promise.resolve()
      .then(() => handler(data.params ?? {}))
      .then(
        (result) => endpoint.postMessage({ type: SIGNER_RPC_RESPONSE, id: data.id, ok: true, result } satisfies SignerRpcResponse),
        (e: unknown) =>
          endpoint.postMessage({ type: SIGNER_RPC_RESPONSE, id: data.id, ok: false, error: toRpcError(e) } satisfies SignerRpcResponse),
      );
  };
  endpoint.addEventListener("message", listener);
  return {
    emit: (event) => endpoint.postMessage(event),
    close: () => endpoint.removeEventListener("message", listener),
  };
}

export interface SignerClient {
  call<M extends SignerRpcMethod>(method: M, params: SignerRpcParams<M>): Promise<SignerRpcResult<M>>;
  onEvent(listener: (event: SignerRpcEvent) => void): () => void;
  close(): void;
}

/** App-side client. Rejects with SignerError carrying the signer's code and violations. */
export function createSignerClient(endpoint: MessageEndpoint, options: { timeoutMs?: number } = {}): SignerClient {
  const timeoutMs = options.timeoutMs ?? 60_000;
  let nextId = 1;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const eventListeners = new Set<(event: SignerRpcEvent) => void>();

  const listener = (event: MessageEvent) => {
    const data = event.data as { type?: unknown; id?: unknown } | null;
    if (!data || typeof data !== "object") return;
    if (data.type === SIGNER_RPC_EVENT) {
      for (const l of eventListeners) l(data as unknown as SignerRpcEvent);
      return;
    }
    if (data.type !== SIGNER_RPC_RESPONSE || typeof data.id !== "number") return;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    clearTimeout(entry.timer);
    const response = data as unknown as SignerRpcResponse;
    if (response.ok) entry.resolve(response.result);
    else
      entry.reject(
        new SignerError(
          response.error.code,
          response.error.message,
          response.error.violations ? { violations: response.error.violations } : {},
        ),
      );
  };
  endpoint.addEventListener("message", listener);

  return {
    call(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new SignerError("INTERNAL", `signer did not answer ${method} within ${timeoutMs} ms`));
        }, timeoutMs);
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
        endpoint.postMessage({ type: SIGNER_RPC_REQUEST, id, method, params } as SignerRpcRequest);
      });
    },
    onEvent(l) {
      eventListeners.add(l);
      return () => eventListeners.delete(l);
    },
    close() {
      endpoint.removeEventListener("message", listener);
      for (const [, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(new SignerError("INTERNAL", "signer client closed"));
      }
      pending.clear();
    },
  };
}
