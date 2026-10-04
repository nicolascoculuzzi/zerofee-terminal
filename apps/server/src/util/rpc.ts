/**
 * Thin JSON-RPC-over-HTTP client for the server's off-hot-path reads (pool / mint resolution, blockhash
 * polling, fee sampling, dry-run simulation).
 *
 * The public mainnet RPC enforces per-IP limits (HTTP 429) and a data allowance (~100 MB per 30 s,
 * answered with "You have used your data allowance") that a full pump + PumpSwap logs stream nearly
 * exhausts on its own. Both trigger a shared cooldown so callers degrade instead of hammering.
 */
import { type Address, getBase64Encoder } from "@solana/kit";

export interface RpcAccount {
  address: Address;
  owner: Address;
  lamports: bigint;
  data: Uint8Array;
}

export class RpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | null,
    message: string,
  ) {
    super(`${method}: ${message}`);
    this.name = "RpcError";
  }
}

export interface RpcClientOptions {
  url: string;
  fetchFn?: typeof fetch;
  maxConcurrent?: number;
  timeoutMs?: number;
  /** Cooldown after a 429 / data-allowance response. */
  cooldownMs?: number;
}

export interface RpcStats {
  calls: number;
  errors: number;
  rateLimited: number;
  dataAllowance: number;
  coolingDownUntil: number;
  lastError: string | null;
}

const b64 = getBase64Encoder();

export class RpcClient {
  private readonly fetchFn: typeof fetch;
  private inFlight = 0;
  private readonly waiters: (() => void)[] = [];
  private nextId = 1;
  readonly stats: RpcStats = { calls: 0, errors: 0, rateLimited: 0, dataAllowance: 0, coolingDownUntil: 0, lastError: null };

  constructor(private readonly opts: RpcClientOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  get url(): string {
    return this.opts.url;
  }

  /** True while a rate-limit / data-allowance cooldown is active. */
  coolingDown(now = Date.now()): boolean {
    return now < this.stats.coolingDownUntil;
  }

  private async acquire(): Promise<void> {
    if (this.inFlight < (this.opts.maxConcurrent ?? 4)) {
      this.inFlight++;
      return;
    }
    await new Promise<void>((r) => this.waiters.push(r));
    this.inFlight++;
  }

  private release(): void {
    this.inFlight--;
    this.waiters.shift()?.();
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    if (this.coolingDown())
      throw new RpcError(method, 429, `cooling down after rate limit (${this.stats.coolingDownUntil - Date.now()} ms left)`);
    await this.acquire();
    this.stats.calls++;
    try {
      const res = await this.fetchFn(this.opts.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      });
      if (res.status === 429) {
        this.stats.rateLimited++;
        this.cooldown(this.opts.cooldownMs ?? 5_000);
        throw new RpcError(method, 429, "HTTP 429");
      }
      const text = await res.text();
      let body: { result?: T; error?: { code: number; message: string } };
      try {
        body = JSON.parse(text);
      } catch {
        throw new RpcError(method, res.status, `HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      if (body.error) {
        if (/data allowance/i.test(body.error.message)) {
          this.stats.dataAllowance++;
          this.cooldown(this.opts.cooldownMs ?? 30_000);
        }
        throw new RpcError(method, body.error.code, body.error.message);
      }
      if (!res.ok) throw new RpcError(method, res.status, `HTTP ${res.status}`);
      return body.result as T;
    } catch (e) {
      this.stats.errors++;
      this.stats.lastError = e instanceof Error ? e.message : String(e);
      throw e instanceof RpcError ? e : new RpcError(method, null, this.stats.lastError);
    } finally {
      this.release();
    }
  }

  private cooldown(ms: number): void {
    this.stats.coolingDownUntil = Math.max(this.stats.coolingDownUntil, Date.now() + ms);
  }

  /** getMultipleAccounts (base64), chunked by 100; missing accounts are null. */
  async getMultipleAccounts(
    addresses: readonly Address[],
    commitment = "confirmed",
  ): Promise<{ slot: number; accounts: (RpcAccount | null)[] }> {
    const accounts: (RpcAccount | null)[] = [];
    let slot = 0;
    for (let i = 0; i < addresses.length; i += 100) {
      const chunk = addresses.slice(i, i + 100);
      const r = await this.call<{
        context: { slot: number };
        value: ({ owner: string; lamports: number; data: [string, string] } | null)[];
      }>("getMultipleAccounts", [chunk, { encoding: "base64", commitment }]);
      slot = Math.max(slot, r.context.slot);
      r.value.forEach((a, j) => {
        accounts.push(
          a
            ? {
                address: chunk[j] as Address,
                owner: a.owner as Address,
                lamports: BigInt(a.lamports),
                data: new Uint8Array(b64.encode(a.data[0])),
              }
            : null,
        );
      });
    }
    return { slot, accounts };
  }

  /** getTokenAccountsByOwner (jsonParsed) for one token program: the owner's token accounts with amounts and decimals. */
  async getTokenAccountsByOwner(
    owner: string,
    programId: string,
    commitment = "confirmed",
  ): Promise<{ slot: number; accounts: { account: string; mint: string; amount: string; decimals: number; tokenProgram: string }[] }> {
    const r = await this.call<{
      context: { slot: number };
      value: {
        pubkey: string;
        account: { owner: string; data: { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string; decimals?: number } } } } };
      }[];
    }>("getTokenAccountsByOwner", [owner, { programId }, { encoding: "jsonParsed", commitment }]);
    const accounts = [];
    for (const v of r.value) {
      const info = v.account.data.parsed?.info;
      const amount = info?.tokenAmount?.amount;
      const decimals = info?.tokenAmount?.decimals;
      if (!info?.mint || typeof amount !== "string" || typeof decimals !== "number") continue;
      accounts.push({ account: v.pubkey, mint: info.mint, amount, decimals, tokenProgram: v.account.owner });
    }
    return { slot: r.context.slot, accounts };
  }

  getLatestBlockhash(commitment = "confirmed") {
    return this.call<{ context: { slot: number }; value: { blockhash: string; lastValidBlockHeight: number } }>("getLatestBlockhash", [
      { commitment },
    ]);
  }

  getRecentPrioritizationFees(accounts: readonly string[]) {
    return this.call<{ slot: number; prioritizationFee: number }[]>("getRecentPrioritizationFees", [accounts]);
  }

  simulateTransaction(wireBase64: string, config: Record<string, unknown>) {
    return this.call<{
      context: { slot: number };
      value: { err: unknown; logs: string[] | null; unitsConsumed?: number };
    }>("simulateTransaction", [wireBase64, { encoding: "base64", ...config }]);
  }
}
