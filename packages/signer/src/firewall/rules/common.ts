import { JITO_DONT_FRONT_PREFIX } from "../programs";
import type { AccountRef, DecodedInstruction } from "../types";

export function where(ix: DecodedInstruction, name: string): string {
  return `#${ix.index} ${name}`;
}

/**
 * Splits off trailing `jitodontfront…` accounts. Extra accounts are tolerated only at the end of an
 * instruction's account list, and only when read-only, non-signer and static (an ALT entry is only
 * as trustworthy as the ALT data we were handed). The remaining "core" list must then match the
 * instruction's exact layout, so any other extra account fails the count check.
 */
export function splitTrailingDontFront(ix: DecodedInstruction, label: string): { core: readonly AccountRef[]; violations: string[] } {
  const core = [...ix.accounts];
  const violations: string[] = [];
  while (core.length > 0) {
    const last = core[core.length - 1]!;
    if (!last.address.startsWith(JITO_DONT_FRONT_PREFIX)) break;
    if (last.isSigner || last.isWritable || !last.isStatic) {
      violations.push(`${label}: extra account ${last.address} must be read-only, non-signer and not loaded from a lookup table`);
    }
    core.pop();
  }
  return { core, violations };
}

export function countMismatch(label: string, expected: readonly number[], actual: number): string {
  return `${label}: expected ${expected.join(" or ")} accounts (plus optional trailing jitodontfront markers), got ${actual}`;
}
