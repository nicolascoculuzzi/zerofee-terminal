/** Wallet Standard providers offered at login. */
export type WalletProvider = "phantom" | "solflare" | "backpack";

export interface ConnectedWallet {
  provider: WalletProvider;
  address: string;
}

/** Sign-In With Solana session (SPEC "Sessions"). */
export interface SiwsSession {
  address: string;
  domain: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  /** The exact message the user signed. */
  message: string;
  /** Base58 signature from the connected wallet. */
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
  connectedSol: number;
  /** SOL per trading-wallet address. */
  trading: Record<string, number>;
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

  connect(provider: WalletProvider): Promise<ConnectedWallet>;
  disconnect(): Promise<void>;
  /** Builds the SIWS message (domain, server nonce, issued-at, expiry) and asks the wallet to sign. */
  signIn(): Promise<SiwsSession>;

  /** Generates and encrypts a trading key in the browser; returns the backup phrase once. */
  createTradingWallet(options: {
    label: string;
    method: UnlockMethod;
    password?: string;
  }): Promise<{ wallet: TradingWallet; backupPhrase: string[] }>;
  confirmBackup(walletId: string): Promise<void>;
  /**
   * The trading key in base58 (the format Phantom imports), for backup and export. Needs an
   * unlocked keystore. The live signer shows it in its own isolated window; the mock returns a
   * simulated key that controls nothing.
   */
  exportKey(walletId: string): Promise<string>;
  /** Hides a trading wallet from the app. Refused while it holds SOL or live armed orders. */
  archiveTradingWallet(walletId: string): Promise<void>;
  /** Re-encrypts the keystore under a passkey or a new passphrase (inside the signer). Needs it unlocked. */
  changeUnlockMethod(method: UnlockMethod, password?: string): Promise<void>;
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
  fundFromConnected(tradingAddress: string, sol: number): Promise<{ signature: string }>;
  /** One-click withdraw back to the connected wallet (other destinations need a delay). */
  withdrawToConnected(tradingAddress: string, sol: number): Promise<{ signature: string }>;

  /** Direct mode: ask the connected wallet to approve and sign one transaction. */
  approveWithConnected(request: ApprovalRequest): Promise<boolean>;
}
