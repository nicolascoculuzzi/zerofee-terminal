/**
 * Enrichment settings (DexScreener Dex Paid, holder reconciliation, Helius funding). Every external call is
 * budgeted; the defaults stay inside free / entry plans:
 *
 *  - DexScreener: at most DEXSCREENER_RPM requests in any 60 s window (their documented limit is 60/min).
 *  - Holder reconciliation over RPC: HOLDERS_RPC_PER_MIN calls/min (each check = getTokenLargestAccounts +
 *    getMultipleAccounts = 2 calls). The public mainnet RPC refuses getTokenLargestAccounts outright
 *    (method limit 0); the reconciler then backs off and holder numbers stay trade-based.
 *  - Helius (only with HELIUS_API_KEY): DAS getTokenAccounts pages (10 credits each) and Wallet API
 *    funded-by lookups (100 credits each, paid plans only). Defaults: 10 pages/min + 1 lookup/min =
 *    200 credits/min, about 8.6M credits/month, inside the Developer plan's 10M.
 */
import { DEFAULT_RPC_URL } from "@zerofee/core";

export interface EnrichConfig {
  enabled: boolean;
  /** Helius API key (DAS + Wallet API). Never logged. */
  heliusApiKey: string | null;
  /** HTTP RPC for reconciliation reads; its own client, so its rate limits never stall pool resolution. */
  rpcUrl: string;
  heliusApiUrl: string;
  dexscreener: { enabled: boolean; baseUrl: string; rpm: number; burst: number };
  holders: { enabled: boolean; rpcPerMin: number; focusedEveryMs: number; listedEveryMs: number };
  das: { pagesPerMin: number; pageSize: number; maxPages: number };
  fundedBy: { perMin: number; topHolders: number };
  /** How many "recently active" tokens (by 5 m volume) also get Dex Paid checks. */
  activeTokens: number;
}

type Env = Record<string, string | undefined>;

const get = (env: Env, name: string): string | null => {
  const v = env[name]?.trim();
  return v ? v : null;
};

function num(env: Env, name: string, def: number, min: number, max: number): number {
  const raw = get(env, name);
  const v = raw === null ? def : Number(raw);
  if (!Number.isFinite(v) || v < min || v > max) throw new Error(`${name} must be a number in [${min}, ${max}]`);
  return v;
}

function flag(env: Env, name: string, def: boolean): boolean {
  const v = get(env, name);
  if (v === null) return def;
  if (/^(1|true|yes|on)$/i.test(v)) return true;
  if (/^(0|false|no|off)$/i.test(v)) return false;
  throw new Error(`${name} must be true/false`);
}

export function loadEnrichConfig(env: Env, rpcUrl = DEFAULT_RPC_URL): EnrichConfig {
  const heliusApiKey = get(env, "HELIUS_API_KEY");
  const heliusRpc = get(env, "HELIUS_RPC_URL") ?? "https://mainnet.helius-rpc.com";
  const rpm = num(env, "DEXSCREENER_RPM", 60, 1, 600);
  return {
    enabled: flag(env, "ENRICH_ENABLED", true),
    heliusApiKey,
    rpcUrl: get(env, "ENRICH_RPC_URL") ?? (heliusApiKey ? `${heliusRpc.replace(/\/+$/, "")}/?api-key=${heliusApiKey}` : rpcUrl),
    heliusApiUrl: (get(env, "HELIUS_API_URL") ?? "https://api.helius.xyz").replace(/\/+$/, ""),
    dexscreener: {
      enabled: flag(env, "DEXSCREENER_ENABLED", true),
      baseUrl: (get(env, "DEXSCREENER_URL") ?? "https://api.dexscreener.com").replace(/\/+$/, ""),
      rpm,
      burst: 5,
    },
    holders: {
      enabled: flag(env, "HOLDERS_RECONCILE", true),
      rpcPerMin: num(env, "HOLDERS_RPC_PER_MIN", 30, 1, 100_000),
      focusedEveryMs: num(env, "HOLDERS_FOCUSED_EVERY_S", 30, 5, 86_400) * 1_000,
      listedEveryMs: num(env, "HOLDERS_LISTED_EVERY_S", 300, 30, 86_400) * 1_000,
    },
    das: {
      pagesPerMin: num(env, "HELIUS_DAS_PAGES_PER_MIN", 10, 0, 100_000),
      pageSize: num(env, "HELIUS_DAS_PAGE_SIZE", 1_000, 1, 1_000),
      maxPages: num(env, "HELIUS_DAS_MAX_PAGES", 10, 1, 1_000),
    },
    fundedBy: {
      perMin: num(env, "HELIUS_FUNDED_BY_PER_MIN", 1, 0, 100_000),
      topHolders: num(env, "INSIDER_TOP_HOLDERS", 10, 1, 100),
    },
    activeTokens: num(env, "ENRICH_ACTIVE_TOKENS", 30, 0, 1_000),
  };
}
