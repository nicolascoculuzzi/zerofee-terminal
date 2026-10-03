/**
 * Environment configuration for the developer CLI. Bun auto-loads `.env` from the working
 * directory (run `bun run trade ...` from the repo root). Never print secret values.
 */
import { type Address, address } from "@solana/kit";
import {
  DEFAULT_RPC_URL,
  HELIUS_SENDER_ENDPOINTS,
  type HeliusSenderRegion,
  JITO_BLOCK_ENGINES,
  type JitoRegion,
  type LandingMode,
  parseUiAmount,
  type SpeedPreset,
} from "@zerofee/core";

export interface CliConfig {
  rpcUrl: string;
  rpcWsUrl: string;
  dryRun: boolean;
  /** Read-only fee payer for unsigned simulation (DRY_RUN only). */
  simulateAs?: Address;
  maxBuyLamports: bigint;
  maxDailySpendLamports: bigint;
  slippageBps: number;
  landingMode: LandingMode;
  speedPreset: SpeedPreset;
  maxPriorityFeeLamports: bigint;
  maxTipLamports: bigint;
  heliusSwqosTipLamports: bigint;
  senderRegion: HeliusSenderRegion;
  jitoRegion: JitoRegion;
  heliusSenderApiKey?: string;
  jitoUuid?: string;
  heliusMevProtect: boolean;
  cuLimitOverride?: number;
  minCuPriceMicroLamports: bigint;
  ledgerPath: string;
  hasWalletKey: boolean;
}

function bool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  if (/^(1|true|yes)$/i.test(v)) return true;
  if (/^(0|false|no)$/i.test(v)) return false;
  throw new Error(`${name} must be true/false`);
}

function sol(name: string, def: string): bigint {
  const v = process.env[name]?.trim() || def;
  try {
    return parseUiAmount(v, 9);
  } catch {
    throw new Error(`${name} must be a SOL amount like 0.05`);
  }
}

function int(name: string, def: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  const v = raw ? Number(raw) : def;
  if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${name} must be an integer in [${min}, ${max}]`);
  return v;
}

function oneOf<T extends string>(name: string, def: T, allowed: readonly T[]): T {
  const v = (process.env[name]?.trim() || def) as T;
  if (!allowed.includes(v)) throw new Error(`${name} must be one of ${allowed.join(", ")}`);
  return v;
}

export function loadConfig(): CliConfig {
  const rpcUrl = process.env.RPC_URL?.trim() || DEFAULT_RPC_URL;
  const rpcWsUrl = process.env.RPC_WS_URL?.trim() || rpcUrl.replace(/^http/, "ws");
  // DRY_RUN is true unless explicitly set to false.
  const dryRun = bool("DRY_RUN", true);
  const simulateAsRaw = process.env.SIMULATE_AS?.trim();
  const cfg: CliConfig = {
    rpcUrl,
    rpcWsUrl,
    dryRun,
    simulateAs: simulateAsRaw ? address(simulateAsRaw) : undefined,
    maxBuyLamports: sol("MAX_BUY_SOL", "0.05"),
    maxDailySpendLamports: sol("MAX_DAILY_SPEND_SOL", "0.5"),
    slippageBps: int("SLIPPAGE_BPS", 1500, 0, 5000),
    landingMode: oneOf<LandingMode>("LANDING_MODE", "standard", ["standard", "turbo", "protected"]),
    speedPreset: oneOf<SpeedPreset>("SPEED_PRESET", "fast", ["eco", "fast", "turbo"]),
    maxPriorityFeeLamports: sol("MAX_PRIORITY_FEE_SOL", "0.0005"),
    maxTipLamports: sol("MAX_TIP_SOL", "0.0005"),
    heliusSwqosTipLamports: sol("HELIUS_SWQOS_TIP_SOL", "0.000005"),
    senderRegion: oneOf("SENDER_REGION", "fra", Object.keys(HELIUS_SENDER_ENDPOINTS) as HeliusSenderRegion[]),
    jitoRegion: oneOf("JITO_REGION", "frankfurt", Object.keys(JITO_BLOCK_ENGINES) as JitoRegion[]),
    heliusSenderApiKey: process.env.HELIUS_SENDER_API_KEY?.trim() || undefined,
    jitoUuid: process.env.JITO_UUID?.trim() || undefined,
    heliusMevProtect: bool("HELIUS_MEV_PROTECT", false),
    cuLimitOverride: process.env.CU_LIMIT?.trim() ? int("CU_LIMIT", 200_000, 10_000, 1_400_000) : undefined,
    minCuPriceMicroLamports: BigInt(int("PRIORITY_FEE_FLOOR_MICROLAMPORTS", 100_000, 0, 100_000_000)),
    ledgerPath: process.env.SPEND_LEDGER_PATH?.trim() || "logs/daily-spend.json",
    hasWalletKey: Boolean(process.env.WALLET_PRIVATE_KEY?.trim()),
  };
  if (!cfg.dryRun && cfg.simulateAs) throw new Error("SIMULATE_AS is only allowed with DRY_RUN=true");
  if (cfg.maxBuyLamports > cfg.maxDailySpendLamports) throw new Error("MAX_BUY_SOL cannot exceed MAX_DAILY_SPEND_SOL");
  return cfg;
}

/** Redacts api-key style query params before printing a URL. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) if (/key|token|auth|uuid/i.test(k)) u.searchParams.set(k, "***");
    return u.toString();
  } catch {
    return "<invalid url>";
  }
}
