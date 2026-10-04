/**
 * The connected (main) wallet through Wallet Standard (@wallet-standard/app, pinned): Phantom, Solflare and
 * Backpack register themselves; we only use their public features. The wallet's own popup is the approval
 * for everything it signs (sign-in, funding, direct-mode trades).
 *
 * Feature shapes follow @solana/wallet-standard-features; they are declared locally (types only) to keep
 * the dependency list to the registry itself.
 */
import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { KNOWN_WALLETS, type KnownWallet, type WalletProvider } from "../walletService";

export const SOLANA_MAINNET = "solana:mainnet";

interface ConnectFeature {
  connect(input?: { silent?: boolean }): Promise<{ accounts: readonly WalletAccount[] }>;
}
interface DisconnectFeature {
  disconnect(): Promise<void>;
}
interface EventsFeature {
  on(event: "change", listener: (props: { accounts?: readonly WalletAccount[] }) => void): () => void;
}
export interface SignInInput {
  domain?: string;
  address?: string;
  statement?: string;
  uri?: string;
  version?: string;
  chainId?: string;
  nonce?: string;
  issuedAt?: string;
  expirationTime?: string;
}
export interface SignInOutput {
  account: WalletAccount;
  signedMessage: Uint8Array;
  signature: Uint8Array;
  signatureType?: "ed25519";
}
interface SignInFeature {
  signIn(...inputs: SignInInput[]): Promise<readonly SignInOutput[]>;
}
interface SignMessageFeature {
  signMessage(
    ...inputs: { account: WalletAccount; message: Uint8Array }[]
  ): Promise<readonly { signedMessage: Uint8Array; signature: Uint8Array }[]>;
}
interface SignTransactionFeature {
  signTransaction(
    ...inputs: { account: WalletAccount; transaction: Uint8Array; chain?: string }[]
  ): Promise<readonly { signedTransaction: Uint8Array }[]>;
}

const F = {
  connect: "standard:connect",
  disconnect: "standard:disconnect",
  events: "standard:events",
  signIn: "solana:signIn",
  signMessage: "solana:signMessage",
  signTransaction: "solana:signTransaction",
} as const;

export const PROVIDERS: readonly KnownWallet[] = KNOWN_WALLETS;

/** Registered names of the known wallets ("Coinbase Wallet", "OKX Wallet", "Trust"). */
const KNOWN_MATCH: readonly [KnownWallet, RegExp][] = [
  ["phantom", /phantom/i],
  ["solflare", /solflare/i],
  ["backpack", /backpack/i],
  ["coinbase", /coinbase/i],
  ["okx", /\bokx\b/i],
  ["trust", /\btrust\b/i],
];

/** The provider id for a registered wallet: a known wallet by name, otherwise "std:" plus its name. */
export function providerOf(name: string): WalletProvider {
  return KNOWN_MATCH.find(([, re]) => re.test(name))?.[0] ?? `std:${name}`;
}

/**
 * A wallet we can sign in with: it lists a Solana chain, connects, signs Solana transactions and has a way
 * to sign the SIWS message (solana:signIn or solana:signMessage). The sign-in flow is the same for all.
 */
export function usable(w: Pick<Wallet, "chains" | "features">): boolean {
  const f = w.features as Record<string, unknown>;
  const solana = w.chains.some((c) => c.startsWith("solana:"));
  return solana && !!f[F.connect] && !!f[F.signTransaction] && (!!f[F.signIn] || !!f[F.signMessage]);
}

export interface DetectedWallet {
  provider: WalletProvider;
  name: string;
  /** Data URI the wallet supplies for its logo. */
  icon: string;
  wallet: Wallet;
}

/** Usable wallets among `wallets`, one per provider (first registration wins), in registration order. */
export function detectFrom(wallets: readonly Wallet[]): DetectedWallet[] {
  const out = new Map<WalletProvider, DetectedWallet>();
  for (const w of wallets) {
    if (!usable(w)) continue;
    const provider = providerOf(w.name);
    if (out.has(provider)) continue;
    out.set(provider, { provider, name: w.name, icon: w.icon, wallet: w });
  }
  return [...out.values()];
}

/** Installed wallets we can sign in with. */
export function detectWallets(): DetectedWallet[] {
  return detectFrom(getWallets().get());
}

/** Fires when a wallet extension registers or unregisters (they can load after the page). */
export function onWalletsChanged(listener: () => void): () => void {
  const api = getWallets();
  const offA = api.on("register", listener);
  const offB = api.on("unregister", listener);
  return () => {
    offA();
    offB();
  };
}

/** A connected wallet account and the operations the app needs from it. */
export class ConnectedSession {
  constructor(
    readonly provider: WalletProvider,
    readonly wallet: Wallet,
    readonly account: WalletAccount,
  ) {}

  get address(): string {
    return this.account.address;
  }

  /** Watches account switches and disconnects in the extension. */
  onChange(listener: (account: WalletAccount | null) => void): () => void {
    const events = (this.wallet.features as Record<string, unknown>)[F.events] as EventsFeature | undefined;
    if (!events) return () => {};
    return events.on("change", ({ accounts }) => {
      if (!accounts) return;
      listener(accounts[0] ?? null);
    });
  }

  /** SIWS: the wallet's own `solana:signIn` with the server's input, else signMessage over the exact text. */
  async signIn(input: SignInInput, messageText: string): Promise<SignInOutput> {
    const f = this.wallet.features as Record<string, unknown>;
    const signIn = f[F.signIn] as SignInFeature | undefined;
    if (signIn) {
      const [out] = await signIn.signIn({ ...input, address: this.address });
      if (!out) throw new Error("The wallet returned no signature");
      return out;
    }
    const signMessage = f[F.signMessage] as SignMessageFeature | undefined;
    if (!signMessage) throw new Error("This wallet can't sign messages");
    const message = new TextEncoder().encode(messageText);
    const [out] = await signMessage.signMessage({ account: this.account, message });
    if (!out) throw new Error("The wallet returned no signature");
    return { account: this.account, signedMessage: out.signedMessage, signature: out.signature, signatureType: "ed25519" };
  }

  /** Asks the wallet to sign one wire transaction (its popup is the approval). Never sends it. */
  async signTransaction(transaction: Uint8Array): Promise<Uint8Array> {
    const f = (this.wallet.features as Record<string, unknown>)[F.signTransaction] as SignTransactionFeature | undefined;
    if (!f) throw new Error("This wallet can't sign transactions");
    const [out] = await f.signTransaction({ account: this.account, transaction, chain: SOLANA_MAINNET });
    if (!out) throw new Error("The wallet returned no signed transaction");
    return out.signedTransaction;
  }

  async disconnect(): Promise<void> {
    const f = (this.wallet.features as Record<string, unknown>)[F.disconnect] as DisconnectFeature | undefined;
    await f?.disconnect().catch(() => undefined);
  }
}

/** Connects `detected` (silently: only if the site is already authorized; otherwise the wallet asks). */
export async function connectWallet(detected: DetectedWallet, opts: { silent?: boolean } = {}): Promise<ConnectedSession | null> {
  const connect = (detected.wallet.features as Record<string, unknown>)[F.connect] as ConnectFeature;
  const { accounts } = await connect.connect(opts.silent ? { silent: true } : undefined);
  const account = accounts.find((a) => a.chains.includes(SOLANA_MAINNET)) ?? accounts[0];
  if (!account) {
    if (opts.silent) return null;
    throw new Error(`${detected.name} returned no account`);
  }
  return new ConnectedSession(detected.provider, detected.wallet, account);
}
