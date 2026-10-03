/**
 * Pump interface version an armed order was signed against: the IDL snapshot hashes that the
 * daily watcher (scripts/check-pump-idl.ts) keeps in idl/SOURCE.json. When the watcher reports a
 * drift, orders whose venue depends on a changed IDL are flagged for re-arm.
 */
import source from "../../idl/SOURCE.json";
import type { ArmedVenue } from "./model";

export type PumpInterfaceName = "pump" | "pump_amm" | "pump_fees";

const FILES: Record<PumpInterfaceName, string> = { pump: "pump.json", pump_amm: "pump_amm.json", pump_fees: "pump_fees.json" };

/** Builds a version string from IDL file hashes (sha256 hex): `pump:<12>|pump_amm:<12>|pump_fees:<12>`. */
export function formatInterfaceVersion(hashes: Partial<Record<string, string>>): string {
  return (Object.keys(FILES) as PumpInterfaceName[]).map((name) => `${name}:${(hashes[FILES[name]] ?? "unknown").slice(0, 12)}`).join("|");
}

/** Version of the IDLs this build of packages/core was written against. */
export function currentInterfaceVersion(): string {
  return formatInterfaceVersion((source as { files: Record<string, string> }).files);
}

export function parseInterfaceVersion(v: string): Partial<Record<PumpInterfaceName, string>> {
  const out: Partial<Record<PumpInterfaceName, string>> = {};
  for (const part of v.split("|")) {
    const [name, hash] = part.split(":");
    if (name && hash && name in FILES) out[name as PumpInterfaceName] = hash;
  }
  return out;
}

/** IDLs an order on `venue` depends on. */
export function interfacesForVenue(venue: ArmedVenue): PumpInterfaceName[] {
  return venue === "pump" ? ["pump", "pump_fees"] : ["pump_amm", "pump_fees"];
}

/** IDL names whose hash differs between the two versions. */
export function changedInterfaces(signedWith: string, current: string): PumpInterfaceName[] {
  const a = parseInterfaceVersion(signedWith);
  const b = parseInterfaceVersion(current);
  return (Object.keys(FILES) as PumpInterfaceName[]).filter((n) => a[n] !== b[n]);
}
