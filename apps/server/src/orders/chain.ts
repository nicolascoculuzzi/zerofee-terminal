/**
 * Chain reads the order engine needs (all reads; nothing here sends a transaction): nonce slots, lookup
 * tables and wallet balances (getMultipleAccounts at `confirmed`, so a nonce advanced on a fork that dies
 * is never acted on), which transaction consumed a nonce (getSignatureStatuses, then the nonce account's
 * own history), and transaction simulation for DRY_RUN.
 */
import type { Address } from "@solana/kit";
import {
  decodeLookupTable,
  decodeNonceAccount,
  decodeTokenAccount,
  type LookupTableState,
  NONCE_ACCOUNT_LENGTH,
  type NonceSlotSnapshot,
  SYSTEM_PROGRAM_ID,
} from "@zerofee/core";
import type { RpcAccount, RpcClient } from "../util/rpc";

export interface SignatureStatus {
  slot: number;
  /** null = executed without error. */
  err: unknown;
  confirmationStatus: "processed" | "confirmed" | "finalized" | null;
}

export interface AddressSignature {
  signature: string;
  slot: number;
  err: unknown;
}

export interface Simulation {
  err: unknown;
  logs: string[];
  unitsConsumed: number | null;
  slot: number;
}

export interface ChainReader {
  /** Raw accounts (null = missing) and the context slot of the read. */
  accounts(addresses: readonly string[]): Promise<{ slot: number; accounts: (RpcAccount | null)[] }>;
  signatureStatuses(signatures: readonly string[]): Promise<(SignatureStatus | null)[]>;
  /** Newest first. */
  signaturesForAddress(address: string, limit: number): Promise<AddressSignature[]>;
  simulate(wireBase64: string): Promise<Simulation>;
}

/** ChainReader over the server's JSON-RPC client (shares its rate-limit cooldown). */
export class RpcChainReader implements ChainReader {
  constructor(private readonly rpc: RpcClient) {}

  accounts(addresses: readonly string[]) {
    return this.rpc.getMultipleAccounts(addresses as Address[], "confirmed");
  }

  async signatureStatuses(signatures: readonly string[]): Promise<(SignatureStatus | null)[]> {
    const out: (SignatureStatus | null)[] = [];
    for (let i = 0; i < signatures.length; i += 256) {
      const chunk = signatures.slice(i, i + 256);
      const r = await this.rpc.call<{
        value: ({ slot: number; err: unknown; confirmationStatus?: SignatureStatus["confirmationStatus"] } | null)[];
      }>("getSignatureStatuses", [chunk, { searchTransactionHistory: true }]);
      for (const s of r.value) out.push(s ? { slot: s.slot, err: s.err ?? null, confirmationStatus: s.confirmationStatus ?? null } : null);
    }
    return out;
  }

  async signaturesForAddress(address: string, limit: number): Promise<AddressSignature[]> {
    const r = await this.rpc.call<{ signature: string; slot: number; err: unknown }[]>("getSignaturesForAddress", [
      address,
      { limit, commitment: "confirmed" },
    ]);
    return r.map((x) => ({ signature: x.signature, slot: x.slot, err: x.err ?? null }));
  }

  async simulate(wireBase64: string): Promise<Simulation> {
    // Durable-nonce transactions: never replace the lifetime; sigVerify proves the bytes are what the user signed.
    const r = await this.rpc.simulateTransaction(wireBase64, { sigVerify: true, commitment: "confirmed" });
    return { err: r.value.err, logs: r.value.logs ?? [], unitsConsumed: r.value.unitsConsumed ?? null, slot: r.context.slot };
  }
}

/** A System-owned, initialized 80-byte nonce account, decoded; null otherwise (missing, closed, uninitialized). */
export function nonceSnapshot(acc: RpcAccount | null): NonceSlotSnapshot | null {
  if (!acc || acc.owner !== SYSTEM_PROGRAM_ID || acc.data.length !== NONCE_ACCOUNT_LENGTH) return null;
  try {
    const d = decodeNonceAccount(acc.data);
    return d.initialized ? { account: acc.address, authority: d.authority, value: d.nonce, lamports: acc.lamports } : null;
  } catch {
    return null;
  }
}

export function lookupTableState(acc: RpcAccount | null): LookupTableState | null {
  if (!acc) return null;
  try {
    return decodeLookupTable(acc.data);
  } catch {
    return null;
  }
}

/** Token amount of a token account (0 when it does not exist). */
export function tokenAmount(acc: RpcAccount | null): bigint {
  if (!acc) return 0n;
  try {
    return decodeTokenAccount(acc.data).amount;
  } catch {
    return 0n;
  }
}

/** Confirmed (or finalized) statuses only: a processed-only landing may still be rolled back. */
export function isConfirmed(s: SignatureStatus | null): s is SignatureStatus {
  return !!s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized");
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** True for http(s) URLs on the local machine (tests and the mainnet fork). */
export function isLoopbackUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && LOOPBACK.has(u.hostname);
  } catch {
    return false;
  }
}

/** A fetch that refuses every non-loopback URL: test and fork lanes can never reach a real relay. */
export function loopbackOnlyFetch(inner: typeof fetch = fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!isLoopbackUrl(url)) {
      let host = "an invalid URL";
      try {
        host = new URL(url).host;
      } catch {
        /* keep the placeholder */
      }
      throw new Error(`refusing a non-loopback URL in a local-only lane: ${host}`);
    }
    return inner(input, init);
  }) as typeof fetch;
}
