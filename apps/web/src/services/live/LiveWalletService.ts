/**
 * Identity and keys against the real stack:
 *  - the connected wallet through Wallet Standard (walletStandard.ts), signing in with SIWS against
 *    /api/auth/* (packages/auth builds the exact message; the server sets the HttpOnly session cookie,
 *    so the socket reconnects to pick it up);
 *  - trading wallets in packages/signer's vault inside a Web Worker (signerHost.ts): create, unlock,
 *    lock, auto-lock, export with the passphrase, up to 25 wallets. Keys never reach this thread; the
 *    worker's RPC returns addresses, signatures and the exported key only when the user asks for it;
 *  - funding from and withdrawing to the connected wallet (transfers.ts), submitted to POST /api/tx.
 *
 * Trading wallets are registered with the server (public keys only) so it serves their wallet topic and
 * accepts their armed orders. Backup confirmations and archived wallets are UI state kept in this browser.
 */

import { createSignInMessageText } from "@zerofee/auth";
import type { MeResponse, NonceResponse, TradingWallet as ServerTradingWallet, SignInRequest } from "@zerofee/protocol";
import { isSignerError, type WalletInfo } from "@zerofee/signer";
import { IS_LIVE } from "../../runtime";
import { useSettings } from "../../state/settings";
import type {
  ApprovalRequest,
  ConnectedWallet,
  ProviderInfo,
  SiwsSession,
  TradingWallet,
  TransferReceipt,
  UnlockMethod,
  WalletBalances,
  WalletProvider,
  WalletService,
  WalletServiceState,
} from "../walletService";
import { ApiError, api } from "./api";
import { firstSignature, toBase58, toBase64 } from "./bytes";
import type { LiveDataSource } from "./LiveDataSource";
import { signerConfigFromSettings } from "./signerConfig";
import type { SignerHost } from "./signerHost";
import { buildSolTransfer, simulationError, submitSigned, TransferError } from "./transfers";
import { ConnectedSession, connectWallet, type DetectedWallet, detectWallets, onWalletsChanged, PROVIDERS } from "./walletStandard";

const PROVIDER_NAME: Record<WalletProvider, string> = { phantom: "Phantom", solflare: "Solflare", backpack: "Backpack" };
const LOCAL_KEY = "zerofee.live.wallets";
const TOUCH_EVERY_MS = 10_000;

interface LocalWalletState {
  backedUp: Record<string, number>;
  archived: string[];
}

function loadLocal(): LocalWalletState {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    const v = raw ? (JSON.parse(raw) as Partial<LocalWalletState>) : {};
    return { backedUp: v.backedUp ?? {}, archived: v.archived ?? [] };
  } catch {
    return { backedUp: {}, archived: [] };
  }
}

function saveLocal(v: LocalWalletState): void {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(v));
  } catch {
    // private mode: the confirmation lasts for this session only
  }
}

/** Signer and wallet errors in plain words. */
export function walletErrorMessage(e: unknown): string {
  if (isSignerError(e)) {
    switch (e.code) {
      case "WRONG_PASSWORD":
        return "Wrong passphrase";
      case "LOCKED":
        return "The keystore is locked. Unlock it and try again.";
      case "FIREWALL_REFUSED":
        return `Refused by the signer firewall: ${e.violations?.[0] ?? e.message}`;
      case "DAILY_CAP_EXCEEDED":
        return `Refused by the signer: ${e.violations?.[0] ?? "daily cap reached"}`;
      case "WEAK_PASSWORD":
        return e.message;
      default:
        return e.message;
    }
  }
  if (e instanceof Error && /reject|denied|cancel/i.test(e.message)) return "Rejected in the wallet";
  return e instanceof Error ? e.message : String(e);
}

export interface LiveWalletDeps {
  data: LiveDataSource;
  signer: SignerHost;
}

export class LiveWalletService implements WalletService {
  private state: WalletServiceState = { connected: null, session: null, tradingWallets: [], locked: true, autoLockAt: null };
  private readonly listeners = new Set<(s: WalletServiceState) => void>();
  private conn: ConnectedSession | null = null;
  private offConn: (() => void) | null = null;
  private vaultWallets: WalletInfo[] = [];
  private local = loadLocal();
  private lastTouch = 0;
  private autoLockMinutes = 15;
  private pendingSignIn: { input: NonceResponse["input"]; expiresAt: number; text: string } | null = null;
  private offWalletWatch: (() => void) | null = null;
  /** wallet:<connected> while signed in: the connected wallet's SOL for the funding forms. */
  private connectedTopic: { address: string; off: () => void } | null = null;

  constructor(private readonly d: LiveWalletDeps) {}

  /** Starts the signer, restores the session and the vault's wallet list, reconnects the wallet silently. */
  async init(): Promise<void> {
    const s = useSettings.getState();
    this.autoLockMinutes = s.autoLockMinutes;
    this.d.signer.configure(signerConfigFromSettings({ ...s.caps, autoLockMinutes: s.autoLockMinutes }));
    this.d.signer.onLocked(() => {
      this.set({ locked: true, autoLockAt: null });
      void this.refreshVault();
    });
    // New caps or auto-lock restart the worker (and lock the keystore): the policy is fixed per worker.
    useSettings.subscribe((next, prev) => {
      if (next.caps === prev.caps && next.autoLockMinutes === prev.autoLockMinutes) return;
      this.d.signer.configure(signerConfigFromSettings({ ...next.caps, autoLockMinutes: next.autoLockMinutes }));
    });
    this.d.data.socket.onSessionEnded(() => this.set({ session: null }));
    await Promise.all([this.refreshVault(), this.restoreSession()]);
    this.watchForWallet();
  }

  // -------------------------------------------------------------------------------------------
  // state
  // -------------------------------------------------------------------------------------------

  getState(): WalletServiceState {
    return this.state;
  }

  /** The connected wallet (direct-mode trades sign through its popup); null while none is connected. */
  connectedSession(): ConnectedSession | null {
    return this.conn;
  }

  subscribe(listener: (state: WalletServiceState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(patch: Partial<WalletServiceState>): void {
    this.state = { ...this.state, ...patch };
    const own = [...this.state.tradingWallets.map((w) => w.address), ...(this.state.connected ? [this.state.connected.address] : [])];
    this.d.data.setOwnWallets(own);
    this.syncConnectedTopic();
    for (const l of this.listeners) l(this.state);
  }

  /** Keeps wallet:<connected> subscribed while that wallet holds the session (the server allows only then). */
  private syncConnectedTopic(): void {
    const want = this.state.connected && this.state.session?.address === this.state.connected.address ? this.state.connected.address : null;
    if (this.connectedTopic?.address === want) return;
    this.connectedTopic?.off();
    this.connectedTopic = want ? { address: want, off: this.d.data.subscribe(`wallet:${want}`, () => {}) } : null;
  }

  private tradingWallets(): TradingWallet[] {
    return this.vaultWallets.map((w) => ({
      id: w.id,
      label: w.label,
      address: w.address,
      unlockMethod: "password" as const,
      createdAt: w.createdAt,
      backedUpAt: this.local.backedUp[w.id] ?? null,
      archived: this.local.archived.includes(w.id),
    }));
  }

  private async refreshVault(): Promise<void> {
    try {
      // A worker that failed to start never answers: give up after a few seconds instead of blocking.
      const status = await Promise.race([
        this.d.signer.rpc.call("status", {}),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("signer did not start")), 8_000)),
      ]);
      this.vaultWallets = status.exists ? await this.d.signer.rpc.call("list", {}) : [];
      this.set({
        tradingWallets: this.tradingWallets(),
        locked: !status.unlocked,
        autoLockAt: status.unlocked ? (this.state.autoLockAt ?? this.nextAutoLock()) : null,
      });
    } catch {
      // The worker failed to start (IndexedDB unavailable, unsupported browser): no trading wallets.
      this.set({ tradingWallets: [], locked: true, autoLockAt: null });
    }
  }

  private nextAutoLock(): number | null {
    return this.autoLockMinutes > 0 ? Date.now() + this.autoLockMinutes * 60_000 : null;
  }

  // -------------------------------------------------------------------------------------------
  // connected wallet + SIWS
  // -------------------------------------------------------------------------------------------

  /** Supported wallets, installed ones first, each with the name and logo its extension registered. */
  providers(): ProviderInfo[] {
    const found = new Map(detectWallets().map((w) => [w.provider, w]));
    const all = PROVIDERS.map((provider) => {
      const w = found.get(provider);
      return { provider, name: w?.name ?? PROVIDER_NAME[provider], icon: w?.icon ?? null, installed: !!w };
    });
    return [...all.filter((p) => p.installed), ...all.filter((p) => !p.installed)];
  }

  private connectedOf(conn: ConnectedSession, address: string): ConnectedWallet {
    return { provider: conn.provider, address, name: conn.wallet.name, icon: conn.wallet.icon ?? null };
  }

  private adopt(conn: ConnectedSession): ConnectedWallet {
    this.offConn?.();
    this.conn = conn;
    this.offConn = conn.onChange((account) => {
      if (!account) {
        this.conn = null;
        this.set({ connected: null });
        return;
      }
      if (account.address === this.state.connected?.address) return;
      this.conn = new ConnectedSession(conn.provider, conn.wallet, account);
      // Another account in the extension: it has to sign in on its own.
      const session = this.state.session?.address === account.address ? this.state.session : null;
      this.set({ connected: this.connectedOf(conn, account.address), session });
    });
    const connected = this.connectedOf(conn, conn.address);
    const session = this.state.session?.address === conn.address ? this.state.session : null;
    this.set({ connected, session });
    return connected;
  }

  async connect(provider: WalletProvider): Promise<ConnectedWallet> {
    const detected = detectWallets().find((w) => w.provider === provider);
    if (!detected) throw new Error(`${PROVIDER_NAME[provider]} isn't installed in this browser`);
    try {
      const conn = await connectWallet(detected);
      if (!conn) throw new Error(`${detected.name} returned no account`);
      return this.adopt(conn);
    } catch (e) {
      throw new Error(walletErrorMessage(e));
    }
  }

  async disconnect(): Promise<void> {
    this.offConn?.();
    this.offConn = null;
    const conn = this.conn;
    this.conn = null;
    await this.signOut();
    await conn?.disconnect();
    this.set({ connected: null, session: null });
  }

  private async signOut(): Promise<void> {
    if (!this.state.session) return;
    await api("/api/auth/signout", { method: "POST", body: {} }).catch(() => undefined);
    this.d.data.socket.reconnect();
  }

  /** Fetches a nonce and renders the exact message the wallet will sign. */
  async previewSignIn(): Promise<string> {
    const connected = this.state.connected;
    if (!connected) throw new Error("Connect a wallet first");
    const n = await api<NonceResponse>("/api/auth/nonce");
    const text = createSignInMessageText({ ...n.input, address: connected.address });
    this.pendingSignIn = { input: n.input, expiresAt: n.expiresAt, text };
    return text;
  }

  async signIn(): Promise<SiwsSession> {
    const conn = this.conn;
    if (!conn) throw new Error("Connect a wallet first");
    if (!this.pendingSignIn || this.pendingSignIn.expiresAt - Date.now() < 30_000) await this.previewSignIn();
    const pending = this.pendingSignIn;
    if (!pending) throw new Error("Could not get a sign-in nonce");
    this.pendingSignIn = null;
    let out: Awaited<ReturnType<ConnectedSession["signIn"]>>;
    try {
      out = await conn.signIn(pending.input, pending.text);
    } catch (e) {
      throw new Error(walletErrorMessage(e));
    }
    const body: SignInRequest = {
      account: { address: out.account.address, publicKey: toBase64(new Uint8Array(out.account.publicKey)) },
      signedMessage: toBase64(out.signedMessage),
      signature: toBase64(out.signature),
      signatureType: "ed25519",
    };
    const me = await api<MeResponse>("/api/auth/signin", { method: "POST", body });
    const session: SiwsSession = {
      address: me.wallet,
      domain: pending.input.domain,
      nonce: pending.input.nonce,
      issuedAt: Date.parse(pending.input.issuedAt),
      expiresAt: me.session.expiresAt,
      message: new TextDecoder().decode(out.signedMessage),
      signature: toBase58(out.signature),
    };
    this.set({ session });
    // The session cookie is read at the WebSocket upgrade: reconnect for the user topics.
    this.d.data.socket.reconnect();
    void this.registerWallets();
    return session;
  }

  /** A session cookie from an earlier visit (GET /api/me). */
  private async restoreSession(): Promise<void> {
    try {
      const me = await api<MeResponse>("/api/me");
      this.set({
        session: {
          address: me.wallet,
          domain: window.location.host,
          nonce: "",
          issuedAt: me.session.createdAt,
          expiresAt: me.session.expiresAt,
          message: "",
          signature: "",
        },
      });
      void this.registerWallets();
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) return;
    }
  }

  /** Wallet extensions register after the page loads: try a silent reconnect as they appear. */
  private watchForWallet(): void {
    const attempt = async (w: DetectedWallet) => {
      if (this.conn) return;
      try {
        const conn = await connectWallet(w, { silent: true });
        if (!conn || this.conn) return;
        // Prefer the account that holds the session; otherwise remember whichever authorized us.
        if (this.state.session && conn.address !== this.state.session.address) return;
        this.adopt(conn);
      } catch {
        // not authorized for this site yet: the user connects from onboarding
      }
    };
    const scan = () => {
      for (const w of detectWallets()) void attempt(w);
    };
    scan();
    this.offWalletWatch = onWalletsChanged(scan);
    setTimeout(() => {
      this.offWalletWatch?.();
      this.offWalletWatch = null;
    }, 15_000);
  }

  /** Public keys of the vault's wallets, upserted on the server (it serves their topics and orders). */
  private async registerWallets(): Promise<void> {
    if (!this.state.session || !this.vaultWallets.length) return;
    let known: ServerTradingWallet[] = [];
    try {
      known = await api<ServerTradingWallet[]>("/api/trading-wallets");
    } catch {
      return;
    }
    const have = new Set(known.map((w) => w.publicKey));
    for (const w of this.vaultWallets) {
      if (have.has(w.address)) continue;
      await api("/api/trading-wallets", { method: "POST", body: { publicKey: w.address, label: w.label } }).catch(() => undefined);
    }
    // The wallet topics answered "forbidden" for unregistered wallets: resubscribe with the new rights.
    this.d.data.socket.reconnect();
  }

  // -------------------------------------------------------------------------------------------
  // keystore
  // -------------------------------------------------------------------------------------------

  async createTradingWallet(options: { label: string; method: UnlockMethod; password?: string }) {
    if (options.method !== "password") throw new Error("Passkey unlock isn't available yet. Use a passphrase.");
    const password = options.password ?? "";
    const rpc = this.d.signer.rpc;
    try {
      const status = await rpc.call("status", {});
      if (!status.exists) {
        const connected = this.state.connected;
        if (!connected) throw new Error("Connect your wallet first: withdrawals can only go back to it.");
        await rpc.call("createVault", { password, connectedWallet: connected.address });
      } else if (!status.unlocked) {
        await rpc.call("unlock", { password });
      }
      const info = await rpc.call("addWallet", { label: options.label });
      await this.refreshVault();
      this.set({ locked: false, autoLockAt: this.nextAutoLock() });
      void this.registerWallets();
      const wallet = this.tradingWallets().find((w) => w.id === info.id);
      if (!wallet) throw new Error("The new wallet did not appear in the keystore");
      return { wallet, backupPhrase: [] as string[] };
    } catch (e) {
      throw new Error(walletErrorMessage(e));
    }
  }

  async confirmBackup(walletId: string): Promise<void> {
    this.local = { ...this.local, backedUp: { ...this.local.backedUp, [walletId]: Date.now() } };
    saveLocal(this.local);
    this.set({ tradingWallets: this.tradingWallets() });
  }

  async exportKey(walletId: string, password?: string): Promise<string> {
    if (!password) throw new Error("Enter your keystore passphrase to show the key");
    try {
      const { secretKey } = await this.d.signer.rpc.call("export", { walletId, password });
      this.touch();
      return secretKey;
    } catch (e) {
      throw new Error(walletErrorMessage(e));
    }
  }

  async archiveTradingWallet(walletId: string): Promise<void> {
    const wallet = this.state.tradingWallets.find((w) => w.id === walletId && !w.archived);
    if (!wallet) throw new Error("Unknown trading wallet");
    const status = this.d.data.wallet(wallet.address)?.status();
    if (status && status.solBalance > 0.001) throw new Error("Withdraw its SOL first.");
    const open = [...this.d.data.orders().values()].filter((o) => o.wallet === wallet.address && o.open).length;
    if (open > 0) throw new Error(`Cancel its ${open} armed order${open === 1 ? "" : "s"} first.`);
    this.local = { ...this.local, archived: [...this.local.archived, walletId] };
    saveLocal(this.local);
    this.set({ tradingWallets: this.tradingWallets() });
  }

  async changeUnlockMethod(method: UnlockMethod, password?: string, currentPassword?: string): Promise<void> {
    if (method !== "password") throw new Error("Passkey unlock isn't available yet.");
    if (!password) throw new Error("Enter a new passphrase");
    if (!currentPassword) throw new Error("Enter your current passphrase");
    try {
      await this.d.signer.rpc.call("changePassword", { oldPassword: currentPassword, newPassword: password });
    } catch (e) {
      throw new Error(walletErrorMessage(e));
    }
  }

  async reclaimRent(): Promise<{ closed: number; sol: number }> {
    throw new Error("Rent reclaim needs the nonce-slot manager, which is not wired yet.");
  }

  async unlock(password: string): Promise<void> {
    try {
      this.vaultWallets = await this.d.signer.rpc.call("unlock", { password });
    } catch (e) {
      throw new Error(walletErrorMessage(e));
    }
    this.set({ tradingWallets: this.tradingWallets(), locked: false, autoLockAt: this.nextAutoLock() });
    void this.registerWallets();
  }

  async unlockWithPasskey(): Promise<void> {
    throw new Error("Passkey unlock isn't available yet. Use your passphrase.");
  }

  lock(): void {
    void this.d.signer.rpc.call("lock", {}).catch(() => undefined);
    this.set({ locked: true, autoLockAt: null });
  }

  /** The vault's own timer enforces auto-lock (settings restart the worker); this keeps the countdown shown. */
  setAutoLock(minutes: number): void {
    this.autoLockMinutes = minutes;
    if (!this.state.locked) this.set({ autoLockAt: this.nextAutoLock() });
  }

  touch(): void {
    if (this.state.locked) return;
    const now = Date.now();
    if (now - this.lastTouch < TOUCH_EVERY_MS) return;
    this.lastTouch = now;
    void this.d.signer.rpc.call("touch", {}).catch(() => undefined);
    this.set({ autoLockAt: this.nextAutoLock() });
  }

  // -------------------------------------------------------------------------------------------
  // balances and transfers
  // -------------------------------------------------------------------------------------------

  async balances(): Promise<WalletBalances> {
    const trading: Record<string, number> = {};
    for (const w of this.state.tradingWallets) {
      const s = this.d.data.wallet(w.address)?.status();
      if (s) trading[w.address] = s.solBalance;
    }
    const connected = this.state.connected ? this.d.data.wallet(this.state.connected.address)?.status() : undefined;
    return { connectedSol: connected?.solBalance ?? null, trading };
  }

  async fundFromConnected(tradingAddress: string, sol: number): Promise<TransferReceipt> {
    const conn = this.conn;
    if (!conn) throw new Error("Connect your wallet first");
    try {
      const unsigned = buildSolTransfer({
        from: conn.address,
        to: tradingAddress,
        lamports: solToLamports(sol),
        chain: this.d.data.chain(),
      });
      const signed = await conn.signTransaction(unsigned);
      return await this.submit(signed);
    } catch (e) {
      throw new Error(e instanceof TransferError ? e.message : walletErrorMessage(e));
    }
  }

  async withdrawToConnected(tradingAddress: string, sol: number): Promise<TransferReceipt> {
    const to = this.state.connected?.address;
    if (!to) throw new Error("Connect your wallet first");
    if (this.state.locked) throw new Error("Unlock the trading wallet to withdraw");
    try {
      const unsigned = buildSolTransfer({ from: tradingAddress, to, lamports: solToLamports(sol), chain: this.d.data.chain() });
      // The firewall allows SOL only to the connected wallet bound into the vault (and reviewed tips).
      const { signedTransaction } = await this.d.signer.rpc.call("sign", { walletId: tradingAddress, transaction: unsigned });
      this.touch();
      return await this.submit(signedTransaction);
    } catch (e) {
      throw new Error(e instanceof TransferError ? e.message : walletErrorMessage(e));
    }
  }

  private async submit(signed: Uint8Array): Promise<TransferReceipt> {
    const res = await submitSigned(signed, "reduced");
    if (res.dryRun) {
      if (res.simulation?.err) throw new Error(`Simulation failed: ${simulationError(res.simulation.err, res.simulation.logs)}`);
      return { signature: res.signature || (firstSignature(signed) ?? ""), simulated: true };
    }
    return { signature: res.signature };
  }

  /** Live direct mode: the wallet's own popup is the approval, shown when the trade is signed. */
  async approveWithConnected(_request: ApprovalRequest): Promise<boolean> {
    return IS_LIVE;
  }
}

function solToLamports(sol: number): bigint {
  if (!(sol > 0) || !Number.isFinite(sol)) throw new TransferError("Enter an amount");
  return BigInt(Math.round(sol * 1e9));
}
