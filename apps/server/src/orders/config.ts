/**
 * Armed-orders engine settings (environment, see .env.example "Armed orders"). Defaults are the
 * conservative ones from @zerofee/core DEFAULT_ARMED_SAFETY_POLICY; DRY_RUN and the landing settings
 * (JITO_REGION, JITO_UUID, ...) are shared with POST /api/tx.
 */
import { isAddress } from "@solana/kit";
import { DEFAULT_ARMED_SAFETY_POLICY, DEFAULT_TRIGGER_POLICY, LAMPORTS_PER_SOL } from "@zerofee/core";

export interface OrdersConfig {
  /** Runs the engine and serves /api/orders (needs the accounts layer). */
  enabled: boolean;
  /** Operator address lookup tables armed transactions may load from (their contents are read from chain). */
  lookupTables: string[];
  /** Non-terminal (armed or submitted) orders per user. */
  maxOpenPerUser: number;
  /** Total armed notional per user (buys: spend; sells: arming quote; OCO groups count once). */
  maxNotionalLamports: bigint;
  /** Spend of one armed buy (further capped by the user's maxTradeSol setting). */
  maxBuyLamports: bigint;
  maxGridDepthBps: number;
  maxTipLamports: bigint;
  maxPriorityFeeLamports: bigint;
  maxAttempts: number;
  maxVariantsPerNonce: number;
  maxBuyVariants: number;
  /** A submitted variant's min-out must sit this far below the live quote. */
  safetyMarginBps: number;
  /** Slots a submitted attempt may take to land before its cancel is fired. */
  missSlots: number;
  /** Slot length used when the slot number is unknown (ms). */
  slotMs: number;
  /** Polling of nonces with an attempt in flight (submitted or cancelling). */
  hotPollMs: number;
  /** Polling of every other armed nonce (foreign advances, closed slots). */
  coldPollMs: number;
  /** Re-evaluation of every open order (time triggers, quiet markets). */
  sweepMs: number;
  /** Staleness checks (creator, migration, recipients, interface version, lookup tables). */
  stalenessMs: number;
  /** Re-send interval of a fired cancel until its nonce advances. */
  cancelRetryMs: number;
  /** Re-send interval of a submitted variant inside its miss window (Jito allows about 1 request/s). */
  resendMs: number;
  /** JSON-RPC endpoint that receives fired cancels (default RPC_URL). A cancel carries no value: any path is fine. */
  cancelRpcUrl: string | null;
  /** Persist trailing-stop high-water marks at most this often per order. */
  statePersistMs: number;
}

type Env = Record<string, string | undefined>;

function int(env: Env, name: string, def: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  const v = raw ? Number(raw) : def;
  if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${name} must be an integer in [${min}, ${max}]`);
  return v;
}

function lamportsBig(env: Env, name: string, def: bigint, max: bigint): bigint {
  const raw = env[name]?.trim();
  if (!raw) return def;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a whole number of lamports`);
  const v = BigInt(raw);
  if (v > max) throw new Error(`${name} must be at most ${max}`);
  return v;
}

/** SOL amount (decimal, up to 9 places) -> lamports. */
function sol(env: Env, name: string, def: bigint, maxSol: number): bigint {
  const raw = env[name]?.trim();
  if (!raw) return def;
  const m = /^(\d+)(?:\.(\d{1,9}))?$/.exec(raw);
  if (!m) throw new Error(`${name} must be a SOL amount like 25 or 0.5`);
  const v = BigInt(m[1] as string) * LAMPORTS_PER_SOL + BigInt((m[2] ?? "").padEnd(9, "0") || "0");
  if (v <= 0n || v > BigInt(maxSol) * LAMPORTS_PER_SOL) throw new Error(`${name} must be in (0, ${maxSol}] SOL`);
  return v;
}

function bool(env: Env, name: string, def: boolean): boolean {
  const v = env[name]?.trim();
  if (!v) return def;
  if (/^(1|true|yes|on)$/i.test(v)) return true;
  if (/^(0|false|no|off)$/i.test(v)) return false;
  throw new Error(`${name} must be true/false`);
}

export function loadOrdersConfig(env: Env = process.env): OrdersConfig {
  const p = DEFAULT_ARMED_SAFETY_POLICY;
  const tables = (env.ARMED_LOOKUP_TABLES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const t of tables) if (!isAddress(t)) throw new Error(`ARMED_LOOKUP_TABLES: ${t} is not an address`);
  const cancelRpcUrl = env.ORDERS_CANCEL_RPC_URL?.trim() || null;
  if (cancelRpcUrl && !/^https?:\/\//.test(cancelRpcUrl)) throw new Error("ORDERS_CANCEL_RPC_URL must be an http(s) URL");
  return {
    enabled: bool(env, "ORDERS_ENABLED", true),
    lookupTables: [...new Set(tables)],
    maxOpenPerUser: int(env, "ORDERS_MAX_OPEN_PER_USER", 50, 1, 10_000),
    maxNotionalLamports: sol(env, "ORDERS_MAX_NOTIONAL_SOL", p.maxArmedNotionalLamports, 1_000_000),
    maxBuyLamports: sol(env, "ORDERS_MAX_BUY_SOL", p.maxBuyLamports, 100_000),
    maxGridDepthBps: int(env, "ORDERS_MAX_GRID_DEPTH_BPS", p.maxGridDepthBps, 1, 9_999),
    maxTipLamports: lamportsBig(env, "ORDERS_MAX_TIP_LAMPORTS", p.maxTipLamports, 1_000_000_000n),
    maxPriorityFeeLamports: lamportsBig(env, "ORDERS_MAX_PRIORITY_FEE_LAMPORTS", p.maxPriorityFeeLamports, 1_000_000_000n),
    maxAttempts: int(env, "ORDERS_MAX_ATTEMPTS", p.maxAttempts, 1, 20),
    maxVariantsPerNonce: int(env, "ORDERS_MAX_VARIANTS_PER_NONCE", p.maxVariantsPerNonce, 1, 256),
    maxBuyVariants: int(env, "ORDERS_MAX_BUY_VARIANTS", p.maxBuyVariants, 1, 64),
    safetyMarginBps: int(env, "ORDERS_SAFETY_MARGIN_BPS", DEFAULT_TRIGGER_POLICY.safetyMarginBps, 0, 5_000),
    missSlots: int(env, "ORDERS_MISS_SLOTS", 8, 1, 150),
    slotMs: int(env, "ORDERS_SLOT_MS", 400, 50, 2_000),
    hotPollMs: int(env, "ORDERS_NONCE_POLL_MS", 400, 100, 60_000),
    coldPollMs: int(env, "ORDERS_NONCE_IDLE_POLL_MS", 5_000, 500, 600_000),
    sweepMs: int(env, "ORDERS_SWEEP_MS", 1_000, 100, 60_000),
    stalenessMs: int(env, "ORDERS_STALENESS_MS", 5_000, 500, 600_000),
    cancelRetryMs: int(env, "ORDERS_CANCEL_RETRY_MS", 2_000, 200, 600_000),
    resendMs: int(env, "ORDERS_RESEND_MS", 1_000, 200, 60_000),
    cancelRpcUrl,
    statePersistMs: int(env, "ORDERS_STATE_PERSIST_MS", 1_000, 0, 600_000),
  };
}
