/**
 * Venue interface version an armed order was signed against: the IDL snapshot hashes that the daily
 * watcher (scripts/check-pump-idl.ts) keeps in idl/SOURCE.json (pump.fun) and idl/RAYDIUM_SOURCE.json
 * (Raydium). When the watcher reports a drift, orders whose venue depends on a changed IDL are flagged for
 * re-arm.
 */
import raydiumSource from "../../idl/RAYDIUM_SOURCE.json";
import source from "../../idl/SOURCE.json";
import type { ArmedVenue } from "./model";

export type PumpInterfaceName = "pump" | "pump_amm" | "pump_fees";
export type RaydiumInterfaceName = "raydium_launchpad" | "raydium_cp_swap";
export type VenueInterfaceName = PumpInterfaceName | RaydiumInterfaceName;

const FILES: Record<VenueInterfaceName, string> = {
  pump: "pump.json",
  pump_amm: "pump_amm.json",
  pump_fees: "pump_fees.json",
  raydium_launchpad: "raydium_launchpad.json",
  raydium_cp_swap: "raydium_cp_swap.json",
};

/**
 * Builds a version string from IDL file hashes (sha256 hex):
 * `pump:<12>|pump_amm:<12>|pump_fees:<12>|raydium_launchpad:<12>|raydium_cp_swap:<12>`.
 */
export function formatInterfaceVersion(hashes: Partial<Record<string, string>>): string {
  return (Object.keys(FILES) as VenueInterfaceName[]).map((name) => `${name}:${(hashes[FILES[name]] ?? "unknown").slice(0, 12)}`).join("|");
}

/** IDL file -> sha256 of the snapshots this build of packages/core was written against. */
export function currentInterfaceHashes(): Record<string, string> {
  const raydium = (raydiumSource as { idl: { files: Record<string, { sha256: string }> } }).idl.files;
  return {
    ...(source as { files: Record<string, string> }).files,
    ...Object.fromEntries(Object.entries(raydium).map(([file, f]) => [file, f.sha256])),
  };
}

/** Version of the IDLs this build of packages/core was written against. */
export function currentInterfaceVersion(): string {
  return formatInterfaceVersion(currentInterfaceHashes());
}

export function parseInterfaceVersion(v: string): Partial<Record<VenueInterfaceName, string>> {
  const out: Partial<Record<VenueInterfaceName, string>> = {};
  for (const part of v.split("|")) {
    const [name, hash] = part.split(":");
    if (name && hash && name in FILES) out[name as VenueInterfaceName] = hash;
  }
  return out;
}

/** IDLs an order on `venue` depends on. */
export function interfacesForVenue(venue: ArmedVenue): VenueInterfaceName[] {
  switch (venue) {
    case "pump":
      return ["pump", "pump_fees"];
    case "pumpswap":
      return ["pump_amm", "pump_fees"];
    case "launchlab":
      return ["raydium_launchpad"];
    case "cpmm":
      return ["raydium_cp_swap"];
  }
}

/** IDL names whose hash differs between the two versions. */
export function changedInterfaces(signedWith: string, current: string): VenueInterfaceName[] {
  const a = parseInterfaceVersion(signedWith);
  const b = parseInterfaceVersion(current);
  return (Object.keys(FILES) as VenueInterfaceName[]).filter((n) => a[n] !== b[n]);
}
