/**
 * Helius endpoints used for enrichment (only with HELIUS_API_KEY; the key is never logged):
 *
 *  - DAS `getTokenAccounts` (JSON-RPC on the Helius RPC URL): every token account of a mint, paginated,
 *    10 credits per page. https://www.helius.dev/docs/api-reference/das/gettokenaccounts
 *  - Wallet API `GET /v1/wallet/{wallet}/funded-by`: the wallet's first incoming SOL transfer, 100 credits,
 *    paid plans only (Free answers 403), 404 when none was found.
 *    https://www.helius.dev/docs/api-reference/wallet-api/funded-by
 */

export class HeliusError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HeliusError";
  }
}

export interface FundedBy {
  funder: string;
  funderName: string | null;
  funderType: string | null;
  amountLamports: string | null;
  /** ms */
  fundedAt: number | null;
  slot: number | null;
}

export interface TokenAccountsPage {
  /** Accounts with a positive balance. */
  accounts: { owner: string; amount: bigint }[];
  /** Entries the server returned (before dropping zero / malformed ones): fewer than `limit` = last page. */
  returned: number;
  /** Page size the server applied (it may cap what we asked for). */
  limit: number;
  /** `last_indexed_slot` when the server reports it. */
  slot: number | null;
}

export interface HeliusOptions {
  apiKey: string;
  /** DAS JSON-RPC URL including the key (e.g. https://mainnet.helius-rpc.com/?api-key=...). */
  rpcUrl: string;
  /** Wallet API base (https://api.helius.xyz). */
  apiUrl: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

function toBigint(v: unknown): bigint | null {
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return BigInt(Math.round(v));
  return null;
}

export class HeliusClient {
  private readonly fetchFn: typeof fetch;
  readonly stats = { dasCalls: 0, fundedByCalls: 0, errors: 0, rateLimited: 0, credits: 0 };

  constructor(private readonly opts: HeliusOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      const res = await this.fetchFn(url, { ...init, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000) });
      if (res.status === 429) this.stats.rateLimited++;
      return res;
    } catch (e) {
      this.stats.errors++;
      throw new HeliusError(0, e instanceof Error ? e.message : String(e));
    }
  }

  /** One page (1-based) of a mint's token accounts with a positive balance. */
  async tokenAccountsPage(mint: string, page: number, limit: number): Promise<TokenAccountsPage> {
    this.stats.dasCalls++;
    this.stats.credits += 10;
    const res = await this.send(this.opts.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "zerofee",
        method: "getTokenAccounts",
        params: { mint, page, limit, options: { showZeroBalance: false } },
      }),
    });
    if (!res.ok) {
      this.stats.errors++;
      throw new HeliusError(res.status, `getTokenAccounts: HTTP ${res.status}`);
    }
    const body = (await res.json().catch(() => null)) as {
      result?: { limit?: number; last_indexed_slot?: number; token_accounts?: { owner?: unknown; amount?: unknown }[] };
      error?: { code?: number; message?: string };
    } | null;
    if (!body || body.error || !body.result) {
      this.stats.errors++;
      throw new HeliusError(body?.error?.code ?? 0, `getTokenAccounts: ${body?.error?.message ?? "malformed response"}`);
    }
    const accounts: TokenAccountsPage["accounts"] = [];
    const list = body.result.token_accounts ?? [];
    for (const a of list) {
      const amount = toBigint(a.amount);
      if (typeof a.owner === "string" && amount !== null && amount > 0n) accounts.push({ owner: a.owner, amount });
    }
    return {
      accounts,
      returned: list.length,
      limit: typeof body.result.limit === "number" && body.result.limit > 0 ? body.result.limit : limit,
      slot: typeof body.result.last_indexed_slot === "number" ? body.result.last_indexed_slot : null,
    };
  }

  /** The wallet's first incoming SOL transfer; null when Helius found none (404). Throws HeliusError otherwise. */
  async fundedBy(wallet: string): Promise<FundedBy | null> {
    this.stats.fundedByCalls++;
    this.stats.credits += 100;
    const res = await this.send(`${this.opts.apiUrl}/v1/wallet/${encodeURIComponent(wallet)}/funded-by`, {
      headers: { accept: "application/json", "X-Api-Key": this.opts.apiKey },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      this.stats.errors++;
      throw new HeliusError(res.status, `funded-by: HTTP ${res.status}`);
    }
    const r = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!r || typeof r.funder !== "string") {
      this.stats.errors++;
      throw new HeliusError(res.status, "funded-by: malformed response");
    }
    return {
      funder: r.funder,
      funderName: typeof r.funderName === "string" ? r.funderName : null,
      funderType: typeof r.funderType === "string" ? r.funderType : null,
      amountLamports: typeof r.amountRaw === "string" ? r.amountRaw : null,
      fundedAt: typeof r.timestamp === "number" ? r.timestamp * 1_000 : null,
      slot: typeof r.slot === "number" ? r.slot : null,
    };
  }
}
