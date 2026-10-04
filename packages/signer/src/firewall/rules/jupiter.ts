/**
 * Venue rule for Jupiter v6 routes (the long-tail fallback: Swap API V2 `/build`). The program ID is
 * injected (the shipped policy passes the signer's embedded JUPITER_PROGRAM, see policy.ts); layouts and
 * the route-plan decoder come from the program's own IDL (jupiter-idl.ts).
 *
 * What a route instruction carries, and what the rule proves about each part:
 *   - who signs: user_transfer_authority is the trading wallet (static, signing);
 *   - where the funds come from: the source token account is the trading wallet's own ATA for the
 *     source mint under the source token program (all three static keys);
 *   - where the output lands: the destination token account is the trading wallet's own ATA for the
 *     destination mint under the destination token program (static), and route_v2's optional
 *     destination_token_account override is None (the program id). Shared-accounts routes also pass
 *     through the program authority PDA ["authority", id] and its ATAs, which are checked against
 *     their derivations;
 *   - how much goes in: in_amount, exact (both v2 routes are exact-in). When the input is wSOL or a
 *     quote mint with a cap, the trade is a buy and in_amount is reported for the central per-trade and
 *     daily caps; when the output is, it is a sell. Two non-quote mints, or two quote mints, are refused;
 *   - how little may come out: Jupiter fails the route unless the output reaches
 *     quoted_out_amount x (10,000 - slippage_bps) / 10,000. The rule reports floor() of that as the
 *     trade's minimum (never above what Jupiter enforces) for the central non-zero floor and the
 *     caller's own quote (expectations), and refuses quoted_out_amount 0 or slippage_bps >= 10,000;
 *   - fees: platform_fee_bps and positive_slippage_bps must both be 0. Either one makes Jupiter pay part
 *     of the output (or of anything above the quote) to a fee account (the first hop account), and
 *     Jupiter charges no fee of its own on /build routes;
 *   - the route plan decodes completely against the reviewed IDL (exact length; a Swap variant the
 *     reviewed IDL does not know is refused), and every other Jupiter instruction is refused by name:
 *     v1 routes, exact-out routes (maximum input computed on chain), token-ledger routes (input amount
 *     not in the instruction), and the admin / account instructions.
 *
 * What it cannot prove, and why that is acceptable: the hops. Each RoutePlanStepV2 names a venue (the
 * Swap variant) and the hop accounts follow the fixed ones, mostly loaded from Jupiter's lookup tables,
 * whose contents are caller-supplied. Which pools a hop touches and what they hold are only known when
 * the transaction executes, so no offline check can price a hop or prove that a pool is honest. The
 * rule therefore does not try; it relies on two things Jupiter enforces on chain over the whole route:
 *   1. the output is credited to the destination token account checked above (the trading wallet's
 *      own ATA, a static key the runtime resolves exactly as the firewall saw it), and
 *   2. the route fails unless that output reaches the minimum, which the firewall bounds from below
 *      (non-zero, and with expectations within the user's slippage of the quote they were shown).
 * A malicious or broken route can then only fail (costing the network fee) or fill at or above the
 * minimum into the user's own account; and the user's spend is in_amount from their own source
 * account, which is capped. This leans on the Jupiter program itself: that it invokes only the AMM
 * each Swap variant names (IncorrectSwapProgramId), sizes every hop from in_amount, and checks the
 * minimum on the destination account. Hop accounts may include the trading wallet itself (some venues
 * take the user as an authority), so the program also decides which hops see the user's signature.
 * Residual risk, as with every venue: the minimum is only as good as the quote it is checked against;
 * Jupiter's quote comes from Jupiter's API, so a compromised API (or app) can quote a bad price and a
 * matching minimum. Expectations catch a minimum that does not match the quote the user was shown, not
 * a dishonest quote.
 */
import type { Address } from "@solana/kit";
import { startsWith, toHex } from "../../bytes";
import { TOKEN_PROGRAMS } from "../programs";
import type { DecodedInstruction, RuleEnv, TradeAction, VenueCheck, VenueRule } from "../types";
import { where } from "./common";
import {
  decodeJupiterRoutePlan,
  JUPITER_INSTRUCTION_NAMES,
  JUPITER_PROGRAM_AUTHORITY_COUNT,
  JUPITER_REFUSAL_REASONS,
  JUPITER_ROUTE_INSTRUCTIONS,
  JUPITER_ROUTE_V2_LAYOUT,
  JUPITER_SEEDS,
  JUPITER_SHARED_ROUTE_V2_LAYOUT,
  JupiterRoutePlanError,
  readRouteArgs,
} from "./jupiter-idl";
import { type Check, checkFixed, checkUserTokenAccount, findPda, isQuoteAsset, staticMint, swapDirection, utf8 } from "./venue-checks";

/** Event-CPI authority ["__event_authority"] (mainnet D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf). */
export const findJupiterEventAuthority = (programId: Address) => findPda(programId, [utf8(JUPITER_SEEDS.eventAuthority)]);
/** Shared-accounts program authority ["authority", id]. */
export const findJupiterProgramAuthority = (programId: Address, id: number) =>
  findPda(programId, [utf8(JUPITER_SEEDS.programAuthority), Uint8Array.of(id)]);

export interface JupiterRuleOptions {
  /** JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 on mainnet. */
  readonly programId: Address;
}

const ROUTES = JUPITER_ROUTE_INSTRUCTIONS.map((def) => ({ def, bytes: Uint8Array.from(def.discriminator) }));
const ALLOWED = JUPITER_ROUTE_INSTRUCTIONS.map((d) => d.name).join(", ");

/** route_v2 / shared_accounts_route_v2 between the trading wallet's own ATAs, fee-free, exact-in. */
export function createJupiterRule(options: JupiterRuleOptions): VenueRule {
  const { programId } = options;
  const name = "Jupiter";
  let eventAuthority: Promise<Address> | undefined;

  return {
    programId,
    name,
    async check(ix: DecodedInstruction, env: RuleEnv): Promise<VenueCheck> {
      const base = where(ix, name);
      if (ix.programAddress !== programId) return { ok: false, violations: [`${base}: rule applied to the wrong program`] };
      if (ix.data.length < 8) return { ok: false, violations: [`${base}: instruction data too short`] };
      const def = ROUTES.find((r) => startsWith(ix.data, r.bytes))?.def;
      if (!def) {
        const hex = toHex(ix.data.subarray(0, 8));
        const ixName = JUPITER_INSTRUCTION_NAMES[hex];
        const reason = (ixName && JUPITER_REFUSAL_REASONS[ixName]) ?? `only ${ALLOWED} are allowed`;
        return { ok: false, violations: [`${base}: instruction "${ixName ?? `unknown ${hex}`}" is refused (${reason})`] };
      }
      const label = `${base} ${def.name}`;
      const data = new Uint8Array(ix.data);
      if (data.length < def.routePlanOffset + 4) return { ok: false, violations: [`${label}: instruction data too short`] };

      // Arguments: fees, slippage, amounts, and the route plan.
      const violations: string[] = [];
      const args = readRouteArgs(def, data);
      let route: string[] = [];
      try {
        route = decodeJupiterRoutePlan(data, def.routePlanOffset).map((s) => s.venue);
      } catch (e) {
        if (!(e instanceof JupiterRoutePlanError)) throw e;
        violations.push(`${label}: route plan does not decode against the reviewed Jupiter IDL (${e.message})`);
      }
      if (args.platformFeeBps !== 0) {
        violations.push(
          `${label}: platform_fee_bps must be 0, got ${args.platformFeeBps} (a platform fee pays part of the output to a fee account)`,
        );
      }
      if (args.positiveSlippageBps !== 0) {
        violations.push(
          `${label}: positive_slippage_bps must be 0, got ${args.positiveSlippageBps} (it pays part of any output above the quote to a fee account)`,
        );
      }
      if (args.slippageBps >= 10_000) violations.push(`${label}: slippage_bps ${args.slippageBps} leaves no minimum output`);
      if (args.quotedOutAmount === 0n) violations.push(`${label}: quoted_out_amount is 0, so the minimum output is 0`);
      if (args.inAmount === 0n) violations.push(`${label}: in_amount is 0`);

      // Accounts.
      const L = def.layout;
      const accounts = ix.accounts;
      if (accounts.length <= L.fixedAccounts) {
        return {
          ok: false,
          violations: [
            ...violations,
            `${label}: expected ${L.fixedAccounts} accounts plus the route's hop accounts, got ${accounts.length}`,
          ],
        };
      }
      const c: Check = { label, core: accounts, env, violations };
      const { signer, caps } = env.ctx;
      const authority = accounts[L.authority]!;
      if (authority.address !== signer || !authority.isSigner || !authority.isStatic) {
        violations.push(`${label}: user_transfer_authority must be the trading wallet, not ${authority.address}`);
      }
      const sourceMint = staticMint(c, L.sourceMint, "source mint");
      const destinationMint = staticMint(c, L.destinationMint, "destination mint");
      if (sourceMint === destinationMint) violations.push(`${label}: source and destination mints are the same`);
      await checkUserTokenAccount(c, L.source, sourceMint, L.sourceTokenProgram);
      await checkUserTokenAccount(c, L.destination, destinationMint, L.destinationTokenProgram);
      eventAuthority ??= findJupiterEventAuthority(programId);
      checkFixed(c, L.program, programId, "the Jupiter program (event CPI)");
      const ea = await eventAuthority;
      if (accounts[L.eventAuthority]!.address !== ea) {
        violations.push(
          `${label}: position ${L.eventAuthority} must be the event authority ${ea}, not ${accounts[L.eventAuthority]!.address}`,
        );
      }
      if (def.name === "route_v2") {
        const override = accounts[JUPITER_ROUTE_V2_LAYOUT.optionalDestination]!;
        if (override.address !== programId) {
          violations.push(
            `${label}: destination_token_account (position ${JUPITER_ROUTE_V2_LAYOUT.optionalDestination}) must be None (the program id); Jupiter would deliver the output to ${override.address} instead of the trading wallet's account`,
          );
        }
      } else {
        await checkSharedAccounts(c, programId, args.id!, sourceMint, destinationMint);
      }

      // Which side is the quote asset (capped spend) and which is the token.
      const direction = swapDirection(caps, sourceMint, destinationMint);
      if (!direction) {
        violations.push(
          `${label}: no per-trade cap is configured for either mint (${sourceMint} in, ${destinationMint} out); one side must be wSOL or a quote mint with a cap`,
        );
      } else if (isQuoteAsset(caps, direction.baseMint)) {
        violations.push(`${label}: base mint ${direction.baseMint} is a quote asset; refusing to trade it as the token`);
      }
      if (violations.length || !direction) return { ok: false, violations };

      const minOut = (args.quotedOutAmount * BigInt(10_000 - args.slippageBps)) / 10_000n;
      const common = {
        kind: "trade",
        venue: name,
        instruction: def.name,
        baseMint: direction.baseMint,
        quoteMint: direction.quoteMint,
        route,
      } as const;
      const action: TradeAction =
        direction.side === "buy"
          ? { ...common, side: "buy", maxQuoteIn: args.inAmount, baseAmount: minOut, baseAmountIs: "min_out" }
          : { ...common, side: "sell", baseAmount: args.inAmount, baseAmountIs: "exact_in", minQuoteOut: minOut };
      return { ok: true, action };
    },
  };
}

/**
 * Shared-accounts routes move the input through program_source_token_account and the output through
 * program_destination_token_account, both owned by the program authority PDA ["authority", id]. The
 * program validates all three itself (InvalidProgramAuthority, token-account owner checks), so they may
 * come from a lookup table; the rule still pins each to its derivation so a substitution is refused here
 * instead of failing on chain.
 */
async function checkSharedAccounts(c: Check, programId: Address, id: number, sourceMint: Address, destinationMint: Address): Promise<void> {
  const L = JUPITER_SHARED_ROUTE_V2_LAYOUT;
  if (id >= JUPITER_PROGRAM_AUTHORITY_COUNT) {
    c.violations.push(`${c.label}: program authority id ${id} does not exist (ids 0-${JUPITER_PROGRAM_AUTHORITY_COUNT - 1})`);
    return;
  }
  const authority = await findJupiterProgramAuthority(programId, id);
  const expect = (index: number, expected: Address, what: string) => {
    const actual = c.core[index]!.address;
    if (actual !== expected) c.violations.push(`${c.label}: position ${index} must be the ${what} ${expected}, not ${actual}`);
  };
  expect(L.programAuthority, authority, `program authority (id ${id})`);
  const sourceProgram = c.core[L.sourceTokenProgram]!.address;
  const destinationProgram = c.core[L.destinationTokenProgram]!.address;
  if (!TOKEN_PROGRAMS.includes(sourceProgram) || !TOKEN_PROGRAMS.includes(destinationProgram)) return; // reported by checkUserTokenAccount
  expect(L.programSource, await c.env.ata(authority, sourceMint, sourceProgram), "program authority's token account for the source mint");
  expect(
    L.programDestination,
    await c.env.ata(authority, destinationMint, destinationProgram),
    "program authority's token account for the destination mint",
  );
}
