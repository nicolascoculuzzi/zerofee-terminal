/**
 * SignerService: the only way to get a trading-wallet signature.
 *
 *   firewall (checkTransaction) -> daily spend reservation -> sign message bytes with the
 *   non-extractable key -> self-verify -> audit log -> signed wire transaction
 *
 * Trust split: the security-relevant context (program allowlist, venue rules, tip accounts, caps)
 * comes from the SignerPolicy the host bundles into the signer, and the connected wallet comes from
 * the vault's authenticated header. Callers (the web app, possibly compromised) only supply data
 * the firewall can safely treat as untrusted: the transaction, the nonce accounts it claims the
 * wallet owns (authority must still be the signer, enforced on-chain), and ALT contents (anything
 * fund-sensitive must be a static key).
 *
 * There is deliberately no signMessage / sign-arbitrary-bytes API for trading wallets.
 */
import { type Address, getBase58Decoder, signBytes } from "@solana/kit";
import { AuditLog } from "./audit";
import { asBufferSource, concatBytes } from "./bytes";
import { SignerError } from "./errors";
import { inspectTransaction } from "./firewall/firewall";
import type { SpendTracker } from "./firewall/spend-tracker";
import type { AddressLookupTables, FirewallCaps, FirewallContext, FirewallResult, TransactionSummary, VenueRule } from "./firewall/types";
import { Mutex } from "./mutex";
import { importVerifyKey } from "./vault/keys";
import { getSigningKey, getVaultEpoch, type Vault } from "./vault/vault";

export interface SignerPolicy {
  readonly allowedPrograms: readonly Address[];
  readonly tipAccounts: readonly Address[];
  readonly caps: FirewallCaps;
  readonly venueRules: readonly VenueRule[];
}

/** Per-request data from the caller. Untrusted by design. */
export interface SignRequest {
  readonly ownedNonceAccounts?: readonly Address[];
  readonly addressLookupTables?: AddressLookupTables;
}

export interface SignResult {
  readonly signedTransaction: Uint8Array;
  /** Base58 signature (= transaction id). */
  readonly signature: string;
  readonly summary: TransactionSummary;
}

export interface SignerServiceOptions {
  vault: Vault;
  /** Bundled with the signer, never received from callers. A function lets the host refresh tip accounts. */
  policy: SignerPolicy | (() => SignerPolicy | Promise<SignerPolicy>);
  spendTracker?: SpendTracker;
  auditLog?: AuditLog;
  now?: () => number;
}

export class SignerService {
  readonly #vault: Vault;
  readonly #policy: SignerServiceOptions["policy"];
  readonly #spend: SpendTracker | undefined;
  readonly #now: () => number;
  /** One signature at a time, so the spend reservation and the signature are effectively atomic. */
  readonly #mutex = new Mutex();
  readonly auditLog: AuditLog;

  constructor(options: SignerServiceOptions) {
    this.#vault = options.vault;
    this.#policy = options.policy;
    this.#spend = options.spendTracker;
    this.#now = options.now ?? Date.now;
    this.auditLog = options.auditLog ?? new AuditLog();
  }

  /** Dry run: what would the firewall say? Requires the vault unlocked (for the signer and connected wallet). */
  async checkTransaction(walletId: string, txBytes: Uint8Array, request: SignRequest = {}): Promise<FirewallResult> {
    const ctx = await this.#context(walletId, request);
    const result = await inspectTransaction(txBytes, ctx);
    return result.ok ? { ok: true, summary: result.summary } : { ok: false, violations: result.violations };
  }

  signTransaction(walletId: string, txBytes: Uint8Array, request: SignRequest = {}): Promise<SignResult> {
    return this.#mutex.run(async () => {
      const epoch = getVaultEpoch(this.#vault);
      const ctx = await this.#context(walletId, request);
      const inspected = await inspectTransaction(txBytes, ctx);
      if (!inspected.ok) {
        this.auditLog.append({ at: this.#now(), walletId, status: "refused", violations: inspected.violations });
        throw new SignerError("FIREWALL_REFUSED", `transaction refused by the signer firewall: ${inspected.violations[0] ?? ""}`, {
          violations: inspected.violations,
        });
      }
      const { summary, tx } = inspected;
      const messageBytes = new Uint8Array(tx.messageBytes);

      if (this.#spend) {
        const reservation = await this.#spend.reserve(summary, messageBytes);
        if (!reservation.ok) {
          this.auditLog.append({ at: this.#now(), walletId, status: "refused", summary: summary.text, violations: reservation.violations });
          throw new SignerError("DAILY_CAP_EXCEEDED", reservation.violations[0] ?? "daily cap exceeded", {
            violations: reservation.violations,
          });
        }
      }

      // Re-read the key after the awaits: a lock in the meantime must win.
      if (getVaultEpoch(this.#vault) !== epoch) throw new SignerError("LOCKED", "vault was locked before signing");
      const key = getSigningKey(this.#vault, walletId);
      if (key.address !== ctx.signer) throw new SignerError("INTERNAL", "signing key changed during the request");
      const signature = await signBytes(key.privateKey, messageBytes);
      const verified = await crypto.subtle.verify("Ed25519", await importVerifyKey(key.publicKey), asBufferSource(signature), messageBytes);
      if (!verified) throw new SignerError("INTERNAL", "self-verification of the signature failed");

      // The firewall guarantees exactly one required signature: wire format is [shortvec 1][signature][message].
      const signedTransaction = concatBytes(Uint8Array.of(1), signature, messageBytes);
      const signatureText = getBase58Decoder().decode(signature);
      this.auditLog.append({ at: this.#now(), walletId, status: "signed", signature: signatureText, summary: summary.text });
      return { signedTransaction, signature: signatureText, summary };
    });
  }

  async #context(walletId: string, request: SignRequest): Promise<FirewallContext> {
    if (typeof walletId !== "string") throw new SignerError("INVALID_ARGUMENT", "walletId must be a string");
    const key = getSigningKey(this.#vault, walletId); // throws LOCKED / WALLET_NOT_FOUND
    const connectedWallet = this.#vault.connectedWallet;
    const policy = typeof this.#policy === "function" ? await this.#policy() : this.#policy;
    return {
      signer: key.address,
      connectedWallet,
      ownedNonceAccounts: request.ownedNonceAccounts ?? [],
      allowedPrograms: policy.allowedPrograms,
      tipAccounts: policy.tipAccounts,
      caps: policy.caps,
      venueRules: policy.venueRules,
      ...(request.addressLookupTables !== undefined ? { addressLookupTables: request.addressLookupTables } : {}),
    };
  }
}
