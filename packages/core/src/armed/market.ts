/**
 * The trigger engine's market view (LiveMarketState) from the state loadTokenState returns, so the browser
 * arms with exactly the inputs the server's trigger engine quotes with. Jupiter fallback states are refused
 * (ArmingError): armed orders exist for pump.fun, PumpSwap, Raydium LaunchLab and Raydium CPMM only.
 */
import { cpmmFeeRates } from "../raydium/cpmm/math";
import { launchLabTradeParams } from "../raydium/launchlab/math";
import type { TokenState } from "../state";
import { ArmingError } from "./builders";
import type { LiveMarketState } from "./trigger";

export function liveMarketFromState(s: TokenState): LiveMarketState {
  switch (s.venue) {
    case "pump":
      return { venue: "pump", curve: s.curve, global: s.global, feeConfig: s.feeConfig, mintSupply: s.mintInfo.supply };
    case "pumpswap":
      return {
        venue: "pumpswap",
        pool: s.pool,
        reserves: s.reserves,
        isCanonical: s.isCanonical,
        baseMintSupply: s.mintInfo.supply,
        feeConfig: s.feeConfig,
        globalConfig: s.globalConfig,
      };
    case "launchlab":
      return {
        venue: "launchlab",
        pool: s.pool,
        // share_fee_rate 0: what armed variants sign.
        params: launchLabTradeParams({ globalConfig: s.globalConfig, platformConfig: s.platformConfig }),
        transferFees: {
          base: s.mintInfo.extensions.transferFeeConfig,
          quote: s.quoteMintInfo.extensions.transferFeeConfig,
          epoch: s.clock.epoch,
        },
        mintSupply: s.mintInfo.supply,
      };
    case "cpmm":
      return {
        venue: "cpmm",
        pool: s.pool,
        vault0Amount: s.vault0Amount,
        vault1Amount: s.vault1Amount,
        rates: cpmmFeeRates(s.ammConfig, s.pool),
        baseMint: s.mint,
        transferFees: {
          base: s.mintInfo.extensions.transferFeeConfig,
          quote: s.quoteMintInfo.extensions.transferFeeConfig,
          epoch: s.clock.epoch,
        },
        unixTimestamp: s.clock.unixTimestamp,
        baseMintSupply: s.mintInfo.supply,
      };
    case "jupiter":
      // A /build route is a live quote with its own accounts and lookup tables: it cannot be pre-signed.
      throw new ArmingError(`armed orders do not support Jupiter routes (${s.mint} has no pump.fun, PumpSwap or Raydium venue)`);
    default:
      throw new ArmingError(`armed orders do not support venue ${(s as { venue: string }).venue}`);
  }
}
