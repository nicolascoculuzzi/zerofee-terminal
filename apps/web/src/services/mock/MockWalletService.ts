import type {
  ApprovalRequest,
  ConnectedWallet,
  SiwsSession,
  TradingWallet,
  UnlockMethod,
  WalletBalances,
  WalletProvider,
  WalletService,
  WalletServiceState,
} from "../walletService";
import { fakeAddress, fakeSignature, randomBase58 } from "./addresses";
import { requestApproval } from "./approvalBroker";
import type { SimEngine } from "./engine";
import { mockBackupPhrase } from "./names";

export interface DemoWalletSeed {
  id: string;
  label: string;
  address: string;
  sol: number;
}

/**
 * Mock identity + keystore. Starts in a signed-in demo state (connected wallet + two
 * unlocked trading wallets) so the terminal is explorable; onboarding walks the real flow.
 * Demo wallets accept any non-empty password. Nothing here is a real key.
 */
export class MockWalletService implements WalletService {
  private state: WalletServiceState;
  private readonly listeners = new Set<(state: WalletServiceState) => void>();
  private readonly passwords = new Map<string, string>();
  private connectedSol = 42.37;
  private autoLockMinutes = 15;
  private lockTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly engine: SimEngine,
    demo: { connected: string; wallets: DemoWalletSeed[] },
  ) {
    const now = Date.now();
    this.state = {
      connected: { provider: "phantom", address: demo.connected },
      session: this.buildSession(demo.connected, now - 3 * 60_000, "demo"),
      tradingWallets: demo.wallets.map((w) => ({
        id: w.id,
        label: w.label,
        address: w.address,
        unlockMethod: "password" as const,
        createdAt: now - 31 * 86_400_000,
        backedUpAt: now - 31 * 86_400_000,
        archived: false,
      })),
      locked: false,
      autoLockAt: now + this.autoLockMinutes * 60_000,
    };
    this.armLockTimer();
  }

  getState(): WalletServiceState {
    return this.state;
  }

  subscribe(listener: (state: WalletServiceState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(patch: Partial<WalletServiceState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  private buildSession(address: string, issuedAt: number, nonce?: string): SiwsSession {
    const domain = typeof window === "undefined" ? "zerofee.local" : window.location.host;
    const n = nonce ?? randomBase58(this.engine.rng, 16);
    const expiresAt = issuedAt + 8 * 3_600_000;
    const message = [
      `${domain} wants you to sign in with your Solana account:`,
      address,
      "",
      "Sign in to zerofee. This request will not trigger a transaction or cost any fees.",
      "",
      `URI: ${typeof window === "undefined" ? "https://zerofee.local" : window.location.origin}`,
      "Version: 1",
      "Chain ID: mainnet",
      `Nonce: ${n}`,
      `Issued At: ${new Date(issuedAt).toISOString()}`,
      `Expiration Time: ${new Date(expiresAt).toISOString()}`,
    ].join("\n");
    return { address, domain, nonce: n, issuedAt, expiresAt, message, signature: fakeSignature(this.engine.rng) };
  }

  async connect(provider: WalletProvider): Promise<ConnectedWallet> {
    await wait(650);
    const connected = { provider, address: fakeAddress(this.engine.rng) };
    this.connectedSol = 25 + Math.round(this.engine.rng.next() * 4000) / 100;
    this.set({ connected, session: null });
    return connected;
  }

  async disconnect(): Promise<void> {
    this.set({ connected: null, session: null });
  }

  async signIn(): Promise<SiwsSession> {
    const connected = this.state.connected;
    if (!connected) throw new Error("Connect a wallet first");
    const approved = await requestApproval({
      title: "Sign message",
      lines: [
        { label: "Request", value: "Sign-In With Solana" },
        { label: "Domain", value: typeof window === "undefined" ? "zerofee.local" : window.location.host },
        { label: "Cost", value: "Free, no transaction" },
      ],
    });
    if (!approved) throw new Error("Signature request rejected in the wallet");
    const session = this.buildSession(connected.address, Date.now());
    this.set({ session });
    return session;
  }

  async createTradingWallet(options: {
    label: string;
    method: UnlockMethod;
    password?: string;
  }): Promise<{ wallet: TradingWallet; backupPhrase: string[] }> {
    if (options.method === "password" && (!options.password || options.password.length < 8)) {
      throw new Error("Password must be at least 8 characters");
    }
    await wait(options.method === "passkey" ? 900 : 1100);
    const wallet: TradingWallet = {
      id: `tw-${Date.now().toString(36)}`,
      label: options.label || "Trading",
      address: fakeAddress(this.engine.rng),
      unlockMethod: options.method,
      createdAt: Date.now(),
      backedUpAt: null,
      archived: false,
    };
    if (options.password) this.passwords.set(wallet.id, options.password);
    this.engine.ensureUserWallet(wallet.address, 0);
    this.set({
      tradingWallets: [...this.state.tradingWallets, wallet],
      locked: false,
      autoLockAt: Date.now() + this.autoLockMinutes * 60_000,
    });
    this.armLockTimer();
    return { wallet, backupPhrase: mockBackupPhrase(this.engine.rng) };
  }

  async confirmBackup(walletId: string): Promise<void> {
    this.set({
      tradingWallets: this.state.tradingWallets.map((w) => (w.id === walletId ? { ...w, backedUpAt: Date.now() } : w)),
    });
  }

  async unlock(password: string): Promise<void> {
    await wait(350);
    if (!password) throw new Error("Enter your password");
    const known = [...this.passwords.values()];
    if (known.length > 0 && !known.includes(password)) throw new Error("Wrong password");
    this.set({ locked: false, autoLockAt: this.autoLockMinutes > 0 ? Date.now() + this.autoLockMinutes * 60_000 : null });
    this.armLockTimer();
  }

  async unlockWithPasskey(): Promise<void> {
    await wait(700);
    this.set({ locked: false, autoLockAt: this.autoLockMinutes > 0 ? Date.now() + this.autoLockMinutes * 60_000 : null });
    this.armLockTimer();
  }

  lock(): void {
    if (this.lockTimer) clearTimeout(this.lockTimer);
    this.lockTimer = null;
    this.set({ locked: true, autoLockAt: null });
  }

  setAutoLock(minutes: number): void {
    this.autoLockMinutes = minutes;
    if (!this.state.locked) this.touch();
  }

  touch(): void {
    if (this.state.locked) return;
    const autoLockAt = this.autoLockMinutes > 0 ? Date.now() + this.autoLockMinutes * 60_000 : null;
    if (autoLockAt !== null && this.state.autoLockAt !== null && autoLockAt - this.state.autoLockAt < 5000) return;
    this.set({ autoLockAt });
    this.armLockTimer();
  }

  private armLockTimer(): void {
    if (this.lockTimer) clearTimeout(this.lockTimer);
    this.lockTimer = null;
    const at = this.state.autoLockAt;
    if (at === null) return;
    this.lockTimer = setTimeout(() => this.lock(), Math.max(1000, at - Date.now()));
  }

  async balances(): Promise<WalletBalances> {
    const trading: Record<string, number> = {};
    for (const w of this.state.tradingWallets) trading[w.address] = this.engine.userSol(w.address);
    return { connectedSol: this.state.connected ? this.connectedSol : 0, trading };
  }

  async fundFromConnected(tradingAddress: string, sol: number): Promise<{ signature: string }> {
    if (!this.state.connected) throw new Error("Connect a wallet first");
    if (sol <= 0) throw new Error("Enter an amount");
    if (sol > this.connectedSol - 0.001) throw new Error("Not enough SOL in the connected wallet");
    const approved = await requestApproval({
      title: "Approve transfer",
      lines: [
        { label: "Send", value: `${sol} SOL` },
        { label: "To", value: `${tradingAddress.slice(0, 4)}…${tradingAddress.slice(-4)} (your trading wallet)` },
        { label: "Network fee", value: "0.000005 SOL" },
      ],
    });
    if (!approved) throw new Error("Transfer rejected in the wallet");
    await wait(500);
    const signature = fakeSignature(this.engine.rng);
    this.connectedSol -= sol + 0.000005;
    this.engine.transferUser(tradingAddress, sol, signature);
    return { signature };
  }

  async withdrawToConnected(tradingAddress: string, sol: number): Promise<{ signature: string }> {
    if (!this.state.connected) throw new Error("Connect a wallet first");
    if (this.state.locked) throw new Error("Unlock the trading wallet to withdraw");
    if (sol <= 0) throw new Error("Enter an amount");
    await wait(600);
    const signature = fakeSignature(this.engine.rng);
    if (!this.engine.transferUser(tradingAddress, -sol, signature)) throw new Error("Insufficient balance");
    this.connectedSol += sol - 0.000005;
    return { signature };
  }

  approveWithConnected(request: ApprovalRequest): Promise<boolean> {
    return requestApproval(request);
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
