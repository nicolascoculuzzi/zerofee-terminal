/**
 * @zerofee/signer public API: keystore (Vault), signer firewall (checkTransaction, venue rules,
 * SpendTracker), SignerService, and the worker / iframe RPC. Deliberately absent: any function that
 * returns key material or signs arbitrary bytes with a trading wallet.
 */
export { type AuditEntry, AuditLog } from "./audit";
export { isSignerError, SignerError, type SignerErrorCode } from "./errors";
export { findAssociatedTokenAddress } from "./firewall/ata";
export { type DecodeResult, decodeTransaction } from "./firewall/decode";
export { checkTransaction } from "./firewall/firewall";
export {
  ASSOCIATED_TOKEN_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
  JITO_DONT_FRONT_PREFIX,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  WSOL_MINT,
} from "./firewall/programs";
export {
  createIdlVenueRule,
  createPumpBondingCurveRule,
  createPumpSwapRule,
  findCanonicalPumpPool,
  type IdlVenueRuleOptions,
  type PumpSwapRuleOptions,
} from "./firewall/rules/pump";
export { PUMP_AMM_INSTRUCTIONS, PUMP_CURVE_INSTRUCTIONS, type VenueInstruction, type VenueLayout } from "./firewall/rules/pump-idl";
export {
  computeTotals,
  type DailySpendCaps,
  type DailySpendTotals,
  type SpendEntry,
  type SpendReservation,
  type SpendState,
  SpendTracker,
  type SpendTrackerOptions,
  utcDay,
} from "./firewall/spend-tracker";
export type {
  AccountRef,
  AddressLookupTables,
  DecodedInstruction,
  DecodedTransaction,
  FirewallCaps,
  FirewallContext,
  FirewallResult,
  RuleEnv,
  SummaryAction,
  TradeAction,
  TransactionSummary,
  VenueCheck,
  VenueRule,
} from "./firewall/types";
export { IndexedDbStore, type IndexedDbStoreOptions } from "./indexeddb";
export {
  createSignerClient,
  type MessageEndpoint,
  SIGNER_RPC_EVENT,
  SIGNER_RPC_METHODS,
  SIGNER_RPC_REQUEST,
  SIGNER_RPC_RESPONSE,
  type SignerClient,
  type SignerRpcError,
  type SignerRpcEvent,
  type SignerRpcHandlers,
  type SignerRpcMethod,
  type SignerRpcMethods,
  type SignerRpcRequest,
  type SignerRpcResponse,
  type SignerStatus,
  type SignParams,
  serveSignerRpc,
} from "./rpc";
export { type SignerPolicy, SignerService, type SignerServiceOptions, type SignRequest, type SignResult } from "./service";
export { MemoryStore, type StoredRecord, type VersionedStore } from "./store";
export { MAX_WALLETS, type StoredVault, type StoredWalletInfo } from "./vault/format";
export { DEFAULT_KDF_PARAMS, type KdfParams, MAX_KDF_PARAMS, MIN_KDF_PARAMS } from "./vault/kdf";
export {
  DEFAULT_AUTO_LOCK_MS,
  type LockReason,
  type Scheduler,
  systemScheduler,
  Vault,
  type VaultOptions,
  type VaultStatus,
  type WalletInfo,
} from "./vault/vault";
export { createSignerHandlers, type SignerWorkerHandle, type SignerWorkerOptions, startSignerWorker } from "./worker";
