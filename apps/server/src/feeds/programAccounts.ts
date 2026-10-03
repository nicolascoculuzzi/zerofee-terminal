/**
 * Program-wide accounts the browser's trade builder needs besides the per-token trade context:
 * pump Global + FeeConfig and PumpSwap GlobalConfig + FeeConfig (fee recipients, fee tiers, buyback
 * config). They change rarely; refreshed every minute and served raw (base64) so the browser decodes
 * them with the same @zerofee/core decoders the CLI uses.
 */
import type { Address } from "@solana/kit";
import { getBase64Decoder } from "@solana/kit";
import { PUMP_AMM_FEE_CONFIG, PUMP_AMM_GLOBAL_CONFIG, PUMP_FEE_CONFIG, PUMP_GLOBAL } from "@zerofee/core";
import type { ProgramAccountsResponse } from "@zerofee/protocol";
import { logger } from "../log";
import type { RpcClient } from "../util/rpc";

const log = logger("program-accounts");
const ADDRESSES: Address[] = [PUMP_GLOBAL, PUMP_FEE_CONFIG, PUMP_AMM_GLOBAL_CONFIG, PUMP_AMM_FEE_CONFIG];

export class ProgramAccountsCache {
  private value: ProgramAccountsResponse | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly rpc: RpcClient,
    private readonly refreshMs = 60_000,
  ) {}

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.refreshMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async refresh(): Promise<void> {
    if (this.rpc.coolingDown()) return;
    try {
      const { slot, accounts } = await this.rpc.getMultipleAccounts(ADDRESSES, "confirmed");
      const b64 = getBase64Decoder();
      const out: ProgramAccountsResponse["accounts"] = {};
      accounts.forEach((a, i) => {
        if (a) out[ADDRESSES[i] as string] = { owner: a.owner, lamports: a.lamports.toString(), data: b64.decode(a.data) };
      });
      this.value = { slot, fetchedAt: Date.now(), accounts: out };
    } catch (e) {
      log.debug(`refresh failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  get(): ProgramAccountsResponse | null {
    return this.value;
  }
}
