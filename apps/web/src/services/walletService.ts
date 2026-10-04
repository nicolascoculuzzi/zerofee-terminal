/** Wallet Standard providers offered at login. */
export type WalletProvider = "phantom" | "solflare" | "backpack";

export interface ConnectedWallet {
  provider: WalletProvider;
  address: string;
  /** The wallet's own name ("Phantom"), as it registered through Wallet Standard. */
  name: string;
  /** The wallet's official logo, a data: URI from Wallet Standard; null when it has none (the simulation). */
  icon: string | null;
}

/** A wallet the connect step can offer (installed ones first). */
export interface ProviderInfo {
  provider: WalletProvider;
  name: string;
  /** The wallet's own logo (data URI) when it registered one; null draws a letter square. */
  icon: string | null;
  /** The extension is installed and registered through Wallet Standard. */
  installed: boolean;
}

/** Sign-In With Solana session (SPEC "Sessions"). */
export interface SiwsSession {
  address: string;
  domain: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  /** The exact message the user signed ("" for a session restored from the cookie). */
  message: string;
  /** Base58 signature from the connected wallet ("" for a restored session). */
  signature: string;
}

export type UnlockMethod = "password" | "passkey";

export interface TradingWallet {
  id: string;
  label: string;
  address: string;
  unlockMethod: UnlockMethod;
  createdAt: number;
  /** Null until the user confirms the backup screen. */
  backedUpAt: number | null;
  archived: boolean;
}

export interface WalletBalances {
  /** Null while unknown (the live wallet feed has not reported it). */
  connectedSol: number | null;
  /** SOL per trading-wallet address. */
  trading: Record<string, number>;
}

/** Result of a funding or withdrawal transfer. */
export interface TransferReceipt {
  signature: string;
  /** The server only simulated it (DRY_RUN): nothing moved on-chain. */
  simulated?: boolean;
}

export interface WalletServiceState {
  connected: ConnectedWallet | null;
  session: SiwsSession | null;
  tradingWallets: TradingWallet[];
  locked: boolean;
  /** When the keystore auto-locks (ms), null while locked. */
  autoLockAt: number | null;
}

/** What the connected wallet is asked to approve in direct mode (rendered by its own popup). */
export interface ApprovalRequest {
  title: string;
  lines: { label: string; value: string }[];
}

/**
 * Identity + keys. Production: Wallet Standard for the connected wallet, and the isolated
 * signer (own origin/worker) for the trading keystore: WebCrypto keygen, Argon2id or
 * passkey (WebAuthn PRF) encryption, auto-lock. Keys never leave the signer and are never
 * sent to the server.
 */
export interface WalletService {
  getState(): WalletServiceState;
  subscribe(listener: (state: WalletServiceState) => void): () => void;

  /** Wallets the connect step offers, installed or not. */
  providers(): ProviderInfo[];
  connect(provider: WalletProvider): Promise<ConnectedWallet>;
  disconnect(): Promise<void>;
  /**
   * The exact SIWS message the next `signIn()` will ask the wallet to sign, when the service can know it
   * ahead (the live server issues the nonce); undefined = show a preview.
   */
  previewSignIn?(): Promise<string>;
  /** Builds the SIWS message (domain, server nonce, issued-at, expiry) and asks the wallet to sign. */
  signIn(): Promise<SiwsSession>;

  /** Generates and encrypts a trading key in the browser; returns the backup phrase once (empty when the key itself is the backup). */
  createTradingWallet(options: {
    label: string;
    method: UnlockMethod;
    password?: string;
  }): Promise<{ wallet: TradingWallet; backupPhrase: string[] }>;
  confirmBackup(walletId: string): Promise<void>;
  /**
   * The trading key in base58 (the format Phantom imports), for backup and export. Needs an
   * unlocked keystore; the live signer re-asks for the passphrase (`password`). The mock returns
   * a simulated key that controls nothing.
   */
  exportKey(walletId: string, password?: string): Promise<string>;
  /** Hides a trading wallet from the app. Refused while it holds SOL or live armed orders. */
  archiveTradingWallet(walletId: string): Promise<void>;
  /**
   * Re-encrypts the keystore under a passkey or a new passphrase (inside the signer). Needs it
   * unlocked; the live signer also needs the current passphrase.
   */
  changeUnlockMethod(method: UnlockMethod, password?: string, currentPassword?: string): Promise<void>;
  /** Closes durable-nonce accounts no armed order holds and returns their rent to each trading wallet. */
  reclaimRent(): Promise<{ closed: number; sol: number }>;

  unlock(password: string): Promise<void>;
  unlockWithPasskey(): Promise<void>;
  lock(): void;
  /** Resets the idle timer; the keystore locks after `minutes` without activity (0 = never). */
  setAutoLock(minutes: number): void;
  touch(): void;

  balances(): Promise<WalletBalances>;

  /** One connected-wallet popup moving SOL into a trading wallet. */
  fundFromConnected(tradingAddress: string, sol: number): Promise<TransferReceipt>;
  /** One-click withdraw back to the connected wallet (other destinations need a delay). */
  withdrawToConnected(tradingAddress: string, sol: number): Promise<TransferReceipt>;

  /** Direct mode: ask the connected wallet to approve and sign one transaction. */
  approveWithConnected(request: ApprovalRequest): Promise<boolean>;
}
