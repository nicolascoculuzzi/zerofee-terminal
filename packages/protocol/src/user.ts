/**
 * Accounts and per-user settings (REST, JSON). Every endpoint here except the nonce needs the session
 * cookie; mutations also need an allowed `Origin` header (CSRF), which browsers send automatically.
 *
 * Sign-in (SIWS, packages/auth):
 *   1. GET  /api/auth/nonce   -> NonceResponse; pass `input` to `wallet.features["solana:signIn"].signIn(input)`
 *      (or render it with @zerofee/auth createSignInMessage + the address and call signMessage).
 *   2. POST /api/auth/signin  SignInRequest -> MeResponse, sets the `__Host-zf_session` cookie
 *      (HttpOnly, Secure, SameSite=Strict). The raw token never appears in a response body.
 *   3. GET  /api/me           -> MeResponse (401 without a session)
 *   4. POST /api/auth/signout SignOutRequest -> { ok: true }, clears the cookie
 */
import type { ChannelKind } from "./alerts";
import type { LandingPreset } from "./rest";

// ---------------------------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------------------------

/** Wallet Standard `SolanaSignInInput` as JSON (all strings). Pass it to the wallet unchanged. */
export interface SignInInputWire {
  domain: string;
  statement: string;
  uri: string;
  version: string;
  chainId: string;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
}

export interface NonceResponse {
  input: SignInInputWire;
  /** Epoch ms after which the nonce is no longer accepted. */
  expiresAt: number;
}

/** The wallet's `solana:signIn` output (or the signMessage fallback). Byte fields are standard base64. */
export interface SignInRequest {
  account: {
    /** Base58 address. */
    address: string;
    /** 32-byte Ed25519 public key, base64. */
    publicKey: string;
  };
  /** The exact bytes the wallet signed (UTF-8 SIWS text), base64. */
  signedMessage: string;
  /** 64-byte Ed25519 signature, base64. */
  signature: string;
  signatureType?: "ed25519";
}

export interface SessionInfo {
  createdAt: number;
  /** Absolute expiry; sessions are not extended by activity. Sign in again after this. */
  expiresAt: number;
}

export interface MeResponse {
  /** The connected (main) wallet that signed in. */
  wallet: string;
  createdAt: number;
  lastLoginAt: number;
  session: SessionInfo;
}

export interface SignOutRequest {
  /** Revoke every session of this user (all devices), not just this one. */
  all?: boolean;
}

// ---------------------------------------------------------------------------------------------
// limits (enforced by the server; the UI can show them)
// ---------------------------------------------------------------------------------------------

export const USER_LIMITS = {
  tradingWallets: 25,
  watchlist: 1_000,
  blacklistPerKind: 5_000,
  trackedWallets: 10_000,
  alerts: 200,
  notificationChannels: 10,
  pushSubscriptions: 20,
} as const;

// ---------------------------------------------------------------------------------------------
// trading wallets: public keys and labels only. Keys live encrypted in the browser; never send secrets.
// ---------------------------------------------------------------------------------------------

/**
 *   GET    /api/trading-wallets                 -> TradingWallet[]
 *   POST   /api/trading-wallets                 TradingWalletInput -> TradingWallet (upsert by publicKey)
 *   PATCH  /api/trading-wallets/:publicKey      { label } -> TradingWallet
 *   DELETE /api/trading-wallets/:publicKey      -> { ok: true }
 */
export interface TradingWallet {
  publicKey: string;
  label: string;
  createdAt: number;
}

export interface TradingWalletInput {
  publicKey: string;
  label?: string;
}

// ---------------------------------------------------------------------------------------------
// presets P1-P3
// ---------------------------------------------------------------------------------------------

/**
 *   GET /api/presets          -> TradingPreset[] (always 3, defaults filled in)
 *   PUT /api/presets/:slot    TradingPresetInput -> TradingPreset (slot 1-3)
 */
export type PresetSlot = 1 | 2 | 3;

export interface PresetSide {
  /** Max slippage in basis points (1500 = 15%), 1-9900. */
  slippageBps: number;
  /** Priority fee ceiling per transaction in SOL (cu_price x cu_limit); the live estimate is clamped to it. */
  priorityFeeSol: number;
  /** Tip per transaction in SOL (Helius Sender / Jito). */
  tipSol: number;
  landing: LandingPreset;
  /** true: use the live priority-fee estimate (clamped); false: always pay priorityFeeSol. */
  autoFee: boolean;
}

export interface TradingPreset {
  slot: PresetSlot;
  name: string;
  buy: PresetSide;
  sell: PresetSide;
}

export type TradingPresetInput = Omit<TradingPreset, "slot">;

const lean = (landing: LandingPreset, tipSol: number): PresetSide => ({
  slippageBps: 1_500,
  priorityFeeSol: 0.0005,
  tipSol,
  landing,
  autoFee: true,
});

/** Lean defaults (SPEC: terminal default gas is 100-1,000x what calm markets need). */
export const DEFAULT_PRESETS: readonly TradingPreset[] = [
  { slot: 1, name: "P1", buy: lean("reduced", 0.000005), sell: lean("reduced", 0.000005) },
  { slot: 2, name: "P2", buy: lean("secure", 0.00001), sell: lean("secure", 0.00001) },
  { slot: 3, name: "P3", buy: lean("fast", 0.001), sell: lean("fast", 0.001) },
];

// ---------------------------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------------------------

/**
 *   GET   /api/settings   -> UserSettings (defaults merged in)
 *   PATCH /api/settings   UserSettingsPatch -> UserSettings
 */
export type ThemeSetting = "dark" | "light" | "system";
export type TradeMode = "instant" | "direct";
export type ToastPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export interface NotificationPrefs {
  /** Channels for tracked-wallet alerts (each tracked wallet's flags pick the events). */
  walletChannels: ChannelKind[];
  /** Channels for armed-order fills and failures. */
  orderChannels: ChannelKind[];
  /** Low-priority alerts are batched into one message per channel at most this often (seconds, 10-3600). */
  digestSeconds: number;
}

export interface UserSettings {
  theme: ThemeSetting;
  /** instant = browser trading wallet signs; direct = the connected wallet approves each trade. */
  tradeMode: TradeMode;
  /** Keystore auto-lock after this many idle minutes (SPEC default 15). */
  autoLockMinutes: number;
  activePreset: PresetSlot;
  /** Instant Trade buy buttons in SOL (up to 6). */
  quickBuySol: number[];
  /** Instant Trade sell buttons in percent of the position (up to 6). */
  quickSellPct: number[];
  /** Per-user caps (SPEC "Limits"); the browser firewall enforces them, the server re-checks. */
  maxTradeSol: number;
  maxDailySol: number;
  /** action -> key combo, e.g. { "buy1": "Q", "sell100": "Shift+S" } (up to 64 entries). */
  hotkeys: Record<string, string>;
  sounds: boolean;
  toastPosition: ToastPosition;
  notifications: NotificationPrefs;
  /** Free-form display flags (metric colours, mini charts, PnL on rows...), up to 64 keys. */
  display: Record<string, string | number | boolean>;
}

export type UserSettingsPatch = Partial<Omit<UserSettings, "notifications">> & { notifications?: Partial<NotificationPrefs> };

export const DEFAULT_USER_SETTINGS: UserSettings = {
  theme: "dark",
  tradeMode: "instant",
  autoLockMinutes: 15,
  activePreset: 1,
  quickBuySol: [0.05, 0.1, 0.25, 0.5],
  quickSellPct: [25, 50, 75, 100],
  maxTradeSol: 1,
  maxDailySol: 5,
  hotkeys: {},
  sounds: true,
  toastPosition: "bottom-right",
  notifications: { walletChannels: ["push"], orderChannels: ["push", "telegram"], digestSeconds: 60 },
  display: {},
};

// ---------------------------------------------------------------------------------------------
// watchlist and blacklists
// ---------------------------------------------------------------------------------------------

/**
 *   GET    /api/watchlist          -> WatchlistEntry[] (newest first)
 *   PUT    /api/watchlist/:mint    -> WatchlistEntry (idempotent)
 *   DELETE /api/watchlist/:mint    -> { ok: true }
 */
export interface WatchlistEntry {
  mint: string;
  addedAt: number;
}

/**
 *   GET    /api/blacklists                  -> BlacklistsResponse
 *   PUT    /api/blacklists/:kind/:value     { note? } -> BlacklistEntry (idempotent)
 *   DELETE /api/blacklists/:kind/:value     -> { ok: true }
 * token/dev/funder values are base58 addresses; x values are X handles (stored lowercase, without "@").
 */
export type BlacklistKind = "token" | "dev" | "funder" | "x";
export const BLACKLIST_KINDS: readonly BlacklistKind[] = ["token", "dev", "funder", "x"];

export interface BlacklistEntry {
  kind: BlacklistKind;
  value: string;
  note: string;
  addedAt: number;
}

export type BlacklistsResponse = Record<BlacklistKind, BlacklistEntry[]>;

// ---------------------------------------------------------------------------------------------
// wallet tracker
// ---------------------------------------------------------------------------------------------

/**
 *   GET    /api/tracked-wallets                      -> TrackedWallet[]
 *   POST   /api/tracked-wallets                      TrackedWalletInput -> TrackedWallet (upsert by address)
 *   PATCH  /api/tracked-wallets/:address             TrackedWalletPatch -> TrackedWallet
 *   DELETE /api/tracked-wallets/:address             -> { ok: true }
 *   POST   /api/tracked-wallets/import               TrackedWalletImportRequest -> TrackedWalletImportResult
 *   GET    /api/tracked-wallets/export?format=gmgn   -> JSON array in that format (gmgn | bullx | axiom)
 *
 * Import auto-detects: JSON arrays from GMGN ({ address, name, emoji }), BullX ({ name, address, emoji,
 * tags }) and Axiom ({ trackedWalletAddress, name, emoji, alertsOn }), arrays of address strings, and
 * plain text with one wallet per line ("<address> [emoji] [name]", commas or tabs also work).
 */
export interface TrackedWalletAlerts {
  buy: boolean;
  sell: boolean;
  /** The wallet launched a token (dev-wallet tracking). */
  create: boolean;
  /** Ignore trades smaller than this (SOL). */
  minSol: number;
}

export interface TrackedWallet {
  address: string;
  label: string;
  emoji: string;
  tags: string[];
  alerts: TrackedWalletAlerts;
  createdAt: number;
  updatedAt: number;
}

export interface TrackedWalletInput {
  address: string;
  label?: string;
  emoji?: string;
  tags?: string[];
  alerts?: Partial<TrackedWalletAlerts>;
}

export type TrackedWalletPatch = Omit<TrackedWalletInput, "address">;

export type WalletListFormat = "gmgn" | "bullx" | "axiom";

export interface TrackedWalletImportRequest {
  /** File contents (JSON or plain text) or an already-parsed JSON array. */
  data: string | unknown[];
  /** merge (default): add new wallets and update labels of existing ones; replace: the list becomes exactly the import. */
  mode?: "merge" | "replace";
}

export interface TrackedWalletImportResult {
  /** "gmgn" | "bullx" | "axiom" | "addresses" | "text" */
  detected: string;
  added: number;
  updated: number;
  /** Duplicates within the import and invalid entries. */
  skipped: number;
  /** Wallets removed by mode=replace. */
  removed: number;
  /** First 20 problems (1-based entry or line number). */
  errors: { entry: number; error: string }[];
}
