/**
 * Dev tool: records real Jupiter Swap API V2 `/build` responses into test/fixtures/jupiter-build.json
 * (read-only: keyless /build calls and getMultipleAccounts; no keys, nothing is signed or sent).
 *   bun run packages/core/scripts/capture-jupiter-fixtures.ts
 *
 * The taker is a synthetic address (sha256 of a label), not anyone's wallet: /build does not check
 * balances, and the tests sign nothing. Cases:
 *   - long-tail tokens on venues we do not build locally: a Meteora Dynamic Bonding Curve coin (SPL) and
 *     a Token-2022 coin on Meteora DAMM v2, bought and sold against SOL;
 *   - a normal pair (BONK / SOL) both ways;
 *   - a USDC-funded buy that Jupiter routes over two hops (shared_accounts_route_v2);
 *   - MALICIOUS: the BONK buy re-requested with platformFeeBps=50 and an attacker-owned feeAccount, which
 *     core's client refuses to send; the signer's corpus replays it.
 * Each mint's account is stored (owner, lamports, data) so tests can run loadTokenState offline, and the
 * capture asserts that none of them has a pump.fun curve, canonical PumpSwap pool or LaunchLab SOL pair
 * owned by the venue program, i.e. that core's venue resolution falls back to Jupiter for every one of
 * them. Venue PDAs that exist under another owner are stored too.
 */
import { type Address, address, createSolanaRpc, getAddressDecoder } from "@solana/kit";
import {
  bondingCurvePda,
  canonicalPoolPda,
  DEFAULT_RPC_URL,
  fetchRawAccounts,
  JUPITER_SWAP_API_BASE,
  jupiterBuildUrl,
  launchLabPoolPda,
  PUMP_AMM_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  parseJupiterBuildResponse,
  RAYDIUM_LAUNCHLAB_PROGRAM_ID,
  USDC_MINT,
  WSOL_MINT,
} from "../src";

const RPC_URL = process.env.RPC_URL ?? DEFAULT_RPC_URL;
const OUT = new URL("../test/fixtures/jupiter-build.json", import.meta.url);

const synthetic = (label: string): Address =>
  getAddressDecoder().decode(new Uint8Array(new Bun.CryptoHasher("sha256").update(label).digest()));
const TAKER = synthetic("zerofee-terminal jupiter fixture taker");
const ATTACKER = synthetic("zerofee-terminal jupiter fixture attacker");

/** Meteora Dynamic Bonding Curve coin (SPL Token), still on its curve on 2026-10-03. */
const DBC_COIN = address("3XhUNiVssekpBBQk7VunVTEooJDf4vF3M8ridbtCqRVn");
/** Token-2022 coin graduated from a DBC curve to Meteora DAMM v2. */
const DAMM_2022_COIN = address("4Vn9mQogr4CNDokzSaH3L4sq3cbEtNrT7G1CpX1VtJLh");
/** SPL coin on Meteora DAMM v2 (graduated from DBC); USDC buys of it route over two hops. */
const DAMM_COIN = address("6VsnbKz6erJRTPiiD34Msq7eWmmgZHDnh4Bxan4MpGjm");
/** BONK: a normal, deep pair. */
const BONK = address("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263");

const SLIPPAGE_BPS = 1500; // the CLI default (SLIPPAGE_BPS)
const SOL_IN = 10_000_000n; // 0.01 SOL

interface Case {
  inputMint: Address;
  outputMint: Address;
  amount: bigint;
  /** Extra raw query parameters (malicious cases only: core's client never sends them). */
  raw?: Record<string, string>;
  note: string;
}

const CASES: Record<string, Case | ((captured: Record<string, { response: { outAmount: string } }>) => Case)> = {
  longtailCurveBuy: { inputMint: WSOL_MINT, outputMint: DBC_COIN, amount: SOL_IN, note: "SOL -> Meteora DBC curve coin (SPL)" },
  longtailCurveSell: (c) => ({
    inputMint: DBC_COIN,
    outputMint: WSOL_MINT,
    amount: BigInt(c.longtailCurveBuy!.response.outAmount) / 2n,
    note: "Meteora DBC curve coin -> SOL (half of the buy)",
  }),
  longtail2022Buy: { inputMint: WSOL_MINT, outputMint: DAMM_2022_COIN, amount: SOL_IN, note: "SOL -> Token-2022 coin on Meteora DAMM v2" },
  longtail2022Sell: (c) => ({
    inputMint: DAMM_2022_COIN,
    outputMint: WSOL_MINT,
    amount: BigInt(c.longtail2022Buy!.response.outAmount),
    note: "Token-2022 coin on Meteora DAMM v2 -> SOL (all of the buy)",
  }),
  normalBuy: { inputMint: WSOL_MINT, outputMint: BONK, amount: SOL_IN, note: "SOL -> BONK" },
  normalSell: (c) => ({
    inputMint: BONK,
    outputMint: WSOL_MINT,
    amount: BigInt(c.normalBuy!.response.outAmount),
    note: "BONK -> SOL",
  }),
  usdcBuy: { inputMint: USDC_MINT, outputMint: DAMM_COIN, amount: 1_000_000n, note: "1 USDC -> DAMM v2 coin (two hops, shared accounts)" },
  platformFeeBuy: {
    inputMint: WSOL_MINT,
    outputMint: BONK,
    amount: SOL_IN,
    raw: { platformFeeBps: "50", feeAccount: ATTACKER },
    note: "MALICIOUS: SOL -> BONK with platformFeeBps=50 paid to an attacker's feeAccount",
  },
};

async function build(c: Case): Promise<{ url: string; json: unknown }> {
  let url = jupiterBuildUrl({
    inputMint: c.inputMint,
    outputMint: c.outputMint,
    amount: c.amount,
    slippageBps: SLIPPAGE_BPS,
    taker: TAKER,
  });
  if (c.raw) url += `&${new URLSearchParams(c.raw)}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (res.status === 429 && attempt < 5) {
      await Bun.sleep(3_000 * (attempt + 1));
      continue;
    }
    const text = await res.text();
    // Jupiter's token cache sometimes misses a fresh coin ("Missing token program"); it fills on retry.
    if (res.status === 400 && /Missing token program/.test(text) && attempt < 5) {
      await Bun.sleep(5_000);
      continue;
    }
    if (!res.ok) throw new Error(`/build ${res.status}: ${text.slice(0, 300)}`);
    const json = JSON.parse(text) as unknown;
    parseJupiterBuildResponse(json); // shape check
    return { url: url.replace(JUPITER_SWAP_API_BASE, "{JUPITER_SWAP_API_BASE}"), json };
  }
}

const captured: Record<string, { note: string; url: string; request: Record<string, string>; response: { outAmount: string } }> = {};
for (const [label, spec] of Object.entries(CASES)) {
  const c = typeof spec === "function" ? spec(captured) : spec;
  const { url, json } = await build(c);
  captured[label] = {
    note: c.note,
    url,
    request: {
      inputMint: c.inputMint,
      outputMint: c.outputMint,
      amount: c.amount.toString(),
      slippageBps: String(SLIPPAGE_BPS),
      taker: TAKER,
      ...c.raw,
    },
    response: json as { outAmount: string },
  };
  const r = json as { routePlan: { swapInfo: { label: string } }[]; outAmount: string };
  console.log(`${label}: ${r.routePlan.map((s) => s.swapInfo.label).join(" > ")} out ${r.outAmount}`);
  await Bun.sleep(2_500); // keyless /build: 0.5 RPS
}

// Mint accounts, and proof that no local venue exists for any captured token.
const mints = [DBC_COIN, DAMM_2022_COIN, DAMM_COIN, BONK, USDC_MINT];
const accounts: Record<string, { owner: string; lamports: string; data: string }> = {};
const solana = createSolanaRpc(RPC_URL);
const raw = await fetchRawAccounts(solana, mints);
raw.forEach((acc, i) => {
  if (!acc) throw new Error(`mint ${mints[i]} not found`);
  accounts[mints[i]!] = { owner: acc.owner, lamports: acc.lamports.toString(), data: Buffer.from(acc.data).toString("base64") };
});
const localVenues = (
  await Promise.all(
    mints.filter((m) => m !== USDC_MINT).map((m) => Promise.all([bondingCurvePda(m), canonicalPoolPda(m), launchLabPoolPda(m, WSOL_MINT)])),
  )
).flat();
const venueAccounts = await fetchRawAccounts(solana, localVenues);
const VENUE_OWNERS = [PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, RAYDIUM_LAUNCHLAB_PROGRAM_ID];
const present = localVenues.filter((_, i) => venueAccounts[i]?.owner === VENUE_OWNERS[i % 3]);
if (present.length) throw new Error(`local venue accounts exist for a captured token: ${present.join(", ")}`);
// Venue PDAs that exist under another owner (on 2026-10-03 someone had sent 1.12 SOL to BONK's would-be
// pump curve PDA) are kept, so the offline tests replay them through venue resolution.
venueAccounts.forEach((acc, i) => {
  if (acc)
    accounts[localVenues[i]!] = { owner: acc.owner, lamports: acc.lamports.toString(), data: Buffer.from(acc.data).toString("base64") };
});
const slot = Number(await solana.getSlot({ commitment: "confirmed" }).send());

await Bun.write(
  OUT,
  `${JSON.stringify(
    {
      capturedAt: new Date().toISOString(),
      slot,
      source: `${JUPITER_SWAP_API_BASE}/build (keyless)`,
      taker: TAKER,
      attacker: ATTACKER,
      noLocalVenue: localVenues,
      accounts,
      cases: captured,
    },
    null,
    2,
  )}\n`,
);
console.log(`wrote ${OUT.pathname} (slot ${slot})`);
