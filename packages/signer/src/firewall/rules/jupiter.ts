/**
 * Venue rule for Jupiter v6 routes (the long-tail fallback: Swap API V2 `/build`). The program ID is
 * injected (the shipped policy passes the signer's embedded JUPITER_PROGRAM, see policy.ts); layouts and
 * the route-plan decoder come from the program's own IDL (jupiter-idl.ts).
 *
 * What the rule proves, for the two routes /build emits:
 *   - who signs: user_transfer_authority is the trading wallet (static, signing);
 *   - where the funds come from: the source token account is the trading wallet's own ATA for the
 *     source mint under the source token program (all three static keys);
 *   - where the output lands: the destination token account is the trading wallet's own ATA for the
 *     destination mint under the destination token program (static), and route_v2's optional
 *     destination_token_account override is None (the program id);
 *   - that no hop can move the user's funds anywhere else (below);
 *   - how much goes in: in_amount, exact (both routes are exact-in). When the input is wSOL or a quote
 *     mint with a cap, the trade is a buy and in_amount is reported for the central per-trade and daily
 *     caps; when the output is, it is a sell. Two non-quote mints, or two quote mints, are refused;
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
 * The hops. Checking user_source / user_destination is NOT enough on its own: on 2026-10-03 a mainnet
 * simulation of a captured route_v2 with only the hop's output slot pointed at another holder's token
 * account succeeded, crediting that account while the user's destination stayed unchanged. Jupiter
 * trusts the hop accounts. So the rule pins the hops' user side, per route kind:
 *   - shared_accounts_route_v2: the hops trade between token accounts of Jupiter's program authority
 *     and sign with its PDA. The trading wallet may appear only as user_transfer_authority and its two
 *     ATAs only in their fixed slots, so no hop receives the user's signature or touches the user's
 *     accounts. Jupiter itself moves exactly in_amount from the source ATA into its program account and
 *     forwards the output from its program account to the destination ATA, failing below the minimum;
 *   - route_v2: the hop itself takes the input from a user account with the user's signature, so only a
 *     single hop through a venue whose hop layout has been reviewed (JUPITER_REVIEWED_HOPS: Meteora DBC,
 *     Meteora DAMM v2, Orca Whirlpool) is accepted, with its input slot = the source ATA, its output slot
 *     = the destination ATA and its payer / authority slot = the trading wallet, and the trading wallet
 *     and its ATAs nowhere else. The venue validates the rest of the hop (pool, vaults, mints) against
 *     its own state, so funds can only move source ATA -> pool -> destination ATA.
 * Everything else (other venues on route_v2, multi-hop route_v2, shared routes whose hops name the
 * user) is refused; core re-quotes such routes over the reviewed venues before they reach the signer.
 *
 * What remains: the minimum output is only as good as the quote it is checked against. Jupiter's quote
 * comes from Jupiter's API, so a compromised API (or app) can quote a bad price and a matching minimum;
 * expectations catch a minimum that does not match the quote the user was shown, not a dishonest quote.
 * The pool itself is not pinned (anyone can create a pool on these venues), so a route through a bad
 * pool is bounded by that same minimum. Shared routes rely on the Jupiter program forwarding what the
 * hops produced and enforcing the minimum on it, as /build's own routes do.
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
  JUPITER_REVIEWED_HOPS,
  JUPITER_ROUTE_INSTRUCTIONS,
  JUPITER_ROUTE_V2_LAYOUT,
  JUPITER_SEEDS,
  JUPITER_SHARED_ROUTE_V2_LAYOUT,
  JupiterRoutePlanError,
  type JupiterRouteStep,
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
      let steps: JupiterRouteStep[] = [];
      try {
        steps = decodeJupiterRoutePlan(data, def.routePlanOffset);
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
      const userSide = new Set<string>([signer, accounts[L.source]!.address, accounts[L.destination]!.address]);
      if (def.name === "route_v2") {
        const override = accounts[JUPITER_ROUTE_V2_LAYOUT.optionalDestination]!;
        if (override.address !== programId) {
          violations.push(
            `${label}: destination_token_account (position ${JUPITER_ROUTE_V2_LAYOUT.optionalDestination}) must be None (the program id); Jupiter would deliver the output to ${override.address} instead of the trading wallet's account`,
          );
        }
        if (steps.length) checkReviewedHop(c, steps, userSide);
      } else {
        await checkSharedAccounts(c, programId, args.id!, sourceMint, destinationMint);
        // No hop may name the trading wallet (it would receive the user's signature) or its token accounts.
        accounts.forEach((account, i) => {
          if (i >= L.fixedAccounts && userSide.has(account.address)) {
            violations.push(
              `${label}: hop account at position ${i} is ${account.address === signer ? "the trading wallet" : "the trading wallet's token account"}; shared-accounts hops must trade only Jupiter's program accounts`,
            );
          }
        });
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
        route: steps.map((step) => step.venue),
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
 * route_v2: exactly one hop, spending all of the input (token index 0 -> 1), through a reviewed venue,
 * with its user-side slots pinned to the trading wallet and its ATAs, which appear nowhere else.
 */
function checkReviewedHop(c: Check, steps: readonly JupiterRouteStep[], userSide: ReadonlySet<string>): void {
  const L = JUPITER_ROUTE_V2_LAYOUT;
  const step = steps[0]!;
  if (steps.length !== 1 || step.bps !== 10_000 || step.inputIndex !== 0 || step.outputIndex !== 1) {
    c.violations.push(`${c.label}: route_v2 is accepted only as one hop of the whole input (got ${steps.length} step(s))`);
    return;
  }
  const hop = Object.hasOwn(JUPITER_REVIEWED_HOPS, step.venue) ? JUPITER_REVIEWED_HOPS[step.venue] : undefined;
  if (!hop) {
    c.violations.push(
      `${c.label}: hop venue ${step.venue} is not reviewed for route_v2 (its accounts would act with the trading wallet's signature); reviewed: ${Object.keys(JUPITER_REVIEWED_HOPS).join(", ")}`,
    );
    return;
  }
  const hopAccounts = c.core.slice(L.fixedAccounts);
  if (hop.remaining ? hopAccounts.length < hop.accounts : hopAccounts.length !== hop.accounts) {
    c.violations.push(
      `${c.label}: a ${step.venue} hop has ${hop.accounts} accounts${hop.remaining ? " or more" : ""}, got ${hopAccounts.length}`,
    );
    return;
  }
  if (hopAccounts[0]!.address !== hop.program) c.violations.push(`${c.label}: the ${step.venue} hop must invoke ${hop.program}`);
  const aToB = hop.aToB ? step.fields[0] === 1 : true;
  const [input, output] = aToB ? [hop.input, hop.output] : [hop.output, hop.input];
  const expected = new Map<number, [string, string]>([
    [L.fixedAccounts + input, [c.core[L.source]!.address, "the input slot must be the source token account"]],
    [L.fixedAccounts + output, [c.core[L.destination]!.address, "the output slot must be the destination token account"]],
    [L.fixedAccounts + hop.authority, [c.env.ctx.signer, "the payer / authority slot must be the trading wallet"]],
  ]);
  for (const [i, [address, what]] of expected) {
    if (c.core[i]!.address !== address)
      c.violations.push(`${c.label}: ${step.venue} hop: ${what} (position ${i} is ${c.core[i]!.address})`);
  }
  c.core.forEach((account, i) => {
    if (i >= L.fixedAccounts && !expected.has(i) && userSide.has(account.address)) {
      c.violations.push(
        `${c.label}: ${step.venue} hop names the trading wallet or its token account in an unexpected slot (position ${i})`,
      );
    }
  });
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
