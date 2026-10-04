/**
 * Program-wide accounts the venues read on every trade (GET /api/program-accounts): pump.fun Global and
 * FeeConfig, PumpSwap GlobalConfig and FeeConfig. Fee tiers, fee recipients and the creator-fee gate come
 * from these, decoded here with @zerofee/core exactly as the server and the CLI decode them.
 */
import {
  type AmmGlobalConfig,
  decodeAmmGlobalConfig,
  decodeFeeConfig,
  decodePumpGlobal,
  type FeeConfig,
  PUMP_AMM_FEE_CONFIG,
  PUMP_AMM_GLOBAL_CONFIG,
  PUMP_FEE_CONFIG,
  PUMP_GLOBAL,
  type PumpGlobal,
} from "@zerofee/core";
import type { ProgramAccountsResponse } from "@zerofee/protocol";
import { api } from "./api";
import { fromBase64 } from "./bytes";

export interface ProgramConfigs {
  global: PumpGlobal | null;
  pumpFeeConfig: FeeConfig | null;
  ammGlobalConfig: AmmGlobalConfig | null;
  ammFeeConfig: FeeConfig | null;
  /** Server fetch time of the raw accounts (ms). */
  fetchedAt: number;
}

/** Decodes the response; an account that is missing or fails to decode reads as null. */
export function decodeProgramAccounts(res: ProgramAccountsResponse): ProgramConfigs {
  const decode = <T>(address: string, fn: (d: Uint8Array) => T): T | null => {
    const acc = res.accounts[address];
    if (!acc) return null;
    try {
      return fn(fromBase64(acc.data));
    } catch {
      return null;
    }
  };
  return {
    global: decode(PUMP_GLOBAL, decodePumpGlobal),
    pumpFeeConfig: decode(PUMP_FEE_CONFIG, decodeFeeConfig),
    ammGlobalConfig: decode(PUMP_AMM_GLOBAL_CONFIG, decodeAmmGlobalConfig),
    ammFeeConfig: decode(PUMP_AMM_FEE_CONFIG, decodeFeeConfig),
    fetchedAt: res.fetchedAt,
  };
}

/** Loads once, refreshes after `ttlMs`; concurrent callers share one request. */
export class ProgramAccounts {
  private value: ProgramConfigs | null = null;
  private loadedAt = 0;
  private inflight: Promise<ProgramConfigs> | null = null;
  private readonly listeners = new Set<(p: ProgramConfigs) => void>();

  constructor(
    private readonly fetchFn: () => Promise<ProgramAccountsResponse> = () => api<ProgramAccountsResponse>("/api/program-accounts"),
    private readonly ttlMs = 5 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** The last decoded set (null before the first load). */
  current(): ProgramConfigs | null {
    return this.value;
  }

  onChange(fn: (p: ProgramConfigs) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async get(): Promise<ProgramConfigs> {
    if (this.value && this.now() - this.loadedAt < this.ttlMs) return this.value;
    if (!this.inflight) {
      this.inflight = this.fetchFn()
        .then((res) => {
          const v = decodeProgramAccounts(res);
          this.value = v;
          this.loadedAt = this.now();
          for (const l of this.listeners) l(v);
          return v;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    // A failed refresh keeps trading on the previous set (fee tiers change rarely); the first load must succeed.
    if (this.value) return this.inflight.catch(() => this.value as ProgramConfigs);
    return this.inflight;
  }
}
