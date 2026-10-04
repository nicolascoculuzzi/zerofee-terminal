/**
 * Proves the size claim under the signer firewall's rule that lookup tables hold only shared
 * accounts (token programs, mints, user accounts, pool, transfer destinations stay static):
 * nonce advance + compute budget + tip(s) + pump buy_v2/sell_v2 (+ ATA) and the PumpSwap
 * equivalents fit in 1,232 bytes with the operator lookup table, and buys do not without it.
 * Raydium LaunchLab / CPMM variants (every account the firewall pins static) fit too.
 * Also checks the assembly invariants (nonce first, firewall-sensitive accounts static).
 */
import { describe, expect, test } from "bun:test";
import {
  AccountRole,
  type Address,
  address,
  decompileTransactionMessage,
  getCompiledTransactionMessageDecoder,
  type Instruction,
} from "@solana/kit";
import {
  ArmedTxTooLargeError,
  armedFeeRecipients,
  armedStaticAccounts,
  assertShareableLookupTableContents,
  compileArmedTransaction,
  compileCancelTransaction,
  FIREWALL_ALL_STATIC_PROGRAMS,
  FIREWALL_STATIC_VENUE_POSITIONS,
  findAssociatedTokenAddress,
  HELIUS_SENDER_TIP_ACCOUNTS,
  inspectArmedTransaction,
  JITO_DONT_FRONT,
  JITO_TIP_ACCOUNTS_FALLBACK,
  measureArmedTransaction,
  NEVER_LOOKED_UP,
  PACKET_DATA_SIZE,
  pumpEventAuthorityPda,
  pumpGlobalVolumeAccumulatorPda,
  SYSTEM_PROGRAM_ID,
  SYSVAR_RECENT_BLOCKHASHES_ID,
  systemTransferInstruction,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
} from "../src";
import {
  ARMED_TIPS_DUAL,
  ARMED_TIPS_JITO,
  armedSizeMatrix,
  armedTradeShapes,
  SIZE_NONCE,
  SIZE_USER,
  sizeFixtureContext,
} from "./armedSizeCases";

describe("operator lookup table contents", () => {
  test("static set: PDAs, programs, sysvar, every fee recipient and its wSOL ATA; never tips, markers or signers", async () => {
    const { staticSet, global, globalConfig } = await sizeFixtureContext();
    expect(staticSet.length).toBe(new Set(staticSet).size);
    expect(staticSet.length).toBeLessThanOrEqual(256);
    expect(staticSet).toContain(SYSVAR_RECENT_BLOCKHASHES_ID);
    expect(staticSet).toContain(await pumpEventAuthorityPda());
    expect(staticSet).toContain(await pumpGlobalVolumeAccumulatorPda());
    const recipients = armedFeeRecipients({ pumpGlobal: global, ammGlobalConfig: globalConfig });
    for (const r of [
      ...global.feeRecipients,
      ...global.reservedFeeRecipients,
      ...global.buybackFeeRecipients,
      ...globalConfig.protocolFeeRecipients,
    ]) {
      expect(recipients).toContain(r);
      expect(staticSet).toContain(await findAssociatedTokenAddress(r, WSOL_MINT, TOKEN_PROGRAM_ID));
    }
    // Never in the table: what the firewall requires as static keys.
    for (const a of NEVER_LOOKED_UP) expect(staticSet).not.toContain(a);
    for (const a of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, SYSTEM_PROGRAM_ID, WSOL_MINT, JITO_DONT_FRONT])
      expect(staticSet).not.toContain(a);
    expect(() => assertShareableLookupTableContents(staticSet)).not.toThrow();
    expect(() => assertShareableLookupTableContents([...staticSet, TOKEN_PROGRAM_ID])).toThrow("static keys");
    // 63 pump / PumpSwap accounts + the SOL LaunchLab GlobalConfig + 3 graduation AmmConfigs.
    expect(staticSet).toHaveLength(67);
    expect((await armedStaticAccounts({ pumpGlobal: global, ammGlobalConfig: globalConfig, raydium: false })).length).toBe(63);
    // Fallback lists are used when no live config is given.
    expect((await armedStaticAccounts()).length).toBe(staticSet.length);
  });
});

describe("armed transaction sizes (offline mainnet fixtures)", async () => {
  const rows = await armedSizeMatrix();

  test.each(rows.map((r) => [r.trade, r.tips, r] as const))("%s, %s: fits 1,232 bytes with the table", (_t, _tips, r) => {
    expect(r.size.fits).toBe(true);
    expect(r.size.size).toBeLessThanOrEqual(PACKET_DATA_SIZE);
    // Raydium pins almost every venue account static: only the sysvar and the shared configs load from the table.
    expect(r.size.lookedUpAccounts).toBeGreaterThanOrEqual(r.family === "pump" ? 9 : 1);
  });

  test("without the table every pump / PumpSwap buy overflows, so armed buys need it; Raydium variants fit either way", () => {
    for (const r of rows.filter((x) => x.family === "pump" && /buy|snipe/.test(x.trade)))
      expect(r.size.sizeWithoutLookupTables).toBeGreaterThan(PACKET_DATA_SIZE);
    const raydium = rows.filter((x) => x.family === "raydium");
    expect(raydium).toHaveLength(20);
    for (const r of raydium) expect(r.size.sizeWithoutLookupTables).toBeLessThanOrEqual(PACKET_DATA_SIZE);
  });

  test("worst case keeps ~180 bytes of headroom; the signer's measurement (buy + ATA + tip = 1,240 B without a table) matches", () => {
    expect(Math.max(...rows.map((r) => r.size.size))).toBeLessThan(1_060);
    const buy = rows.find((r) => r.trade.startsWith("pump buy_exact") && r.tips === "jito + dontfront");
    expect(buy?.size.sizeWithoutLookupTables).toBe(1_240);
  });

  test("compileArmedTransaction refuses an oversized variant", async () => {
    const [buy] = await armedTradeShapes();
    expect(() =>
      compileArmedTransaction({ feePayer: SIZE_USER, nonce: SIZE_NONCE, instructions: buy?.instructions ?? [], fees: ARMED_TIPS_DUAL }),
    ).toThrow(ArmedTxTooLargeError);
  });
});

describe("armed transaction assembly", async () => {
  const { tables } = await sizeFixtureContext();
  const [buy] = await armedTradeShapes();
  const instructions = buy?.instructions as Instruction[];

  test("nonce advance first, nonce value as lifetime, kit decompiles it back with the tables", () => {
    const { transaction, size } = compileArmedTransaction({
      feePayer: SIZE_USER,
      nonce: SIZE_NONCE,
      instructions,
      fees: ARMED_TIPS_JITO,
      lookupTables: tables,
    });
    expect(size).toBeLessThanOrEqual(PACKET_DATA_SIZE);
    const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
    expect(compiled.lifetimeToken).toBe(SIZE_NONCE.value);
    const msg = decompileTransactionMessage(compiled, { addressesByLookupTableAddress: tables });
    expect("nonce" in msg.lifetimeConstraint && msg.lifetimeConstraint.nonce).toBe(SIZE_NONCE.value);
    const programs = msg.instructions.map((i) => i.programAddress);
    expect(programs[0]).toBe(SYSTEM_PROGRAM_ID);
    expect(msg.instructions[0]?.accounts?.[0]?.address).toBe(SIZE_NONCE.account);
    expect(msg.feePayer.address).toBe(SIZE_USER);
  });

  test("inspection resolves lookups; nonce account, tip account and dontfront marker stay static", () => {
    const { transaction } = compileArmedTransaction({
      feePayer: SIZE_USER,
      nonce: SIZE_NONCE,
      instructions,
      fees: ARMED_TIPS_JITO,
      lookupTables: tables,
    });
    const wire = Buffer.from(
      new Uint8Array([...[1], ...(transaction.signatures[SIZE_USER] ?? new Uint8Array(64)), ...transaction.messageBytes]),
    ).toString("base64");
    const insp = inspectArmedTransaction(wire, tables);
    expect(insp.nonce).toMatchObject({ account: SIZE_NONCE.account, authority: SIZE_USER, accountIsStatic: true, accountIsWritable: true });
    expect(insp.accountKeys.every((k) => k !== null)).toBe(true);
    expect(insp.staticAccounts).toContain(JITO_DONT_FRONT);
    const tip = insp.instructions.at(-1);
    expect(tip?.program).toBe(SYSTEM_PROGRAM_ID);
    expect(JITO_TIP_ACCOUNTS_FALLBACK).toContain(tip?.accounts[1] as Address);
    expect(insp.staticAccounts).toContain(tip?.accounts[1] as Address);
    expect(insp.lookupTables).toEqual(Object.keys(tables) as Address[]);
    // RecentBlockhashes is loaded from the table (saves 31 bytes; exercised on a real validator in the integration suite).
    expect(insp.staticAccounts).not.toContain(SYSVAR_RECENT_BLOCKHASHES_ID);
  });

  test("a table containing firewall-sensitive accounts still leaves them static (nonce, tips, marker, programs, mints, user ATAs, pool)", async () => {
    const tip = JITO_TIP_ACCOUNTS_FALLBACK[0] as Address;
    const fees = { ...ARMED_TIPS_JITO, tips: [{ lane: "jito" as const, lamports: 10_000n, tipAccount: tip }] };
    const shapes = await armedTradeShapes();
    for (const shape of shapes) {
      // Poison the table with EVERY account of the trade plus the nonce, tip and marker.
      const everything = [...new Set(shape.instructions.flatMap((ix) => (ix.accounts ?? []).map((a) => a.address)))];
      const poisoned = {
        [Object.keys(tables)[0] as Address]: [
          ...(Object.values(tables)[0] as Address[]),
          ...everything,
          SIZE_NONCE.account,
          tip,
          JITO_DONT_FRONT,
        ],
      };
      const { transaction } = compileArmedTransaction({
        feePayer: SIZE_USER,
        nonce: SIZE_NONCE,
        instructions: shape.instructions,
        fees,
        lookupTables: poisoned,
      });
      const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
      for (const a of [SIZE_NONCE.account, tip, JITO_DONT_FRONT, TOKEN_PROGRAM_ID, WSOL_MINT]) expect(compiled.staticAccounts).toContain(a);
      for (const ix of shape.instructions) {
        const pinned = FIREWALL_ALL_STATIC_PROGRAMS.has(ix.programAddress)
          ? (ix.accounts ?? []).map((a) => a.address)
          : (FIREWALL_STATIC_VENUE_POSITIONS.get(ix.programAddress) ?? []).map((i) => ix.accounts?.[i]?.address as Address);
        for (const a of pinned) expect(compiled.staticAccounts).toContain(a);
      }
    }
  });

  test("nonce authority must be the fee payer", () => {
    expect(() =>
      compileArmedTransaction({
        feePayer: SIZE_USER,
        nonce: { ...SIZE_NONCE, authority: address("Hy5oibb1cYdmjyPJ2fiypDtKYvp1uZTuPkmFzVy7TL8c") },
        instructions,
        fees: ARMED_TIPS_JITO,
      }),
    ).toThrow("nonce authority");
  });

  test("cancel = advance + compute limit (+ price, + optional tips) and nothing else", () => {
    const plain = compileCancelTransaction(SIZE_USER, SIZE_NONCE);
    const msg = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(plain.transaction.messageBytes));
    expect(msg.instructions).toHaveLength(2);
    expect(msg.instructions[0]?.data).toEqual(new Uint8Array([4, 0, 0, 0]));
    const tipped = compileCancelTransaction(SIZE_USER, SIZE_NONCE, {
      cuPriceMicroLamports: 1_000n,
      tips: [{ lane: "helius", lamports: 5_000n }],
    });
    const msg2 = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(tipped.transaction.messageBytes));
    expect(msg2.instructions).toHaveLength(4);
    expect(HELIUS_SENDER_TIP_ACCOUNTS).toContain(msg2.instructions[3]?.accounts?.[1]?.address as Address);
    expect(plain.size).toBeLessThan(300);
  });

  test("measureArmedTransaction reports both sizes and the account split; transfer destinations stay static", () => {
    const m = measureArmedTransaction({
      feePayer: SIZE_USER,
      nonce: SIZE_NONCE,
      instructions,
      fees: ARMED_TIPS_JITO,
      lookupTables: tables,
    });
    expect(m.sizeWithoutLookupTables - m.size).toBeGreaterThan(200);
    expect(m.fits).toBe(true);
    expect(m.staticAccounts).toBe(22);
    expect(m.lookedUpAccounts).toBe(10);
    // A lone transfer gains nothing from a table (only the sysvar is shareable) but stays correct.
    const transfer = systemTransferInstruction({
      from: SIZE_USER,
      to: address("Hy5oibb1cYdmjyPJ2fiypDtKYvp1uZTuPkmFzVy7TL8c"),
      lamports: 1n,
    });
    const { transaction } = compileArmedTransaction({
      feePayer: SIZE_USER,
      nonce: SIZE_NONCE,
      instructions: [transfer],
      fees: ARMED_TIPS_JITO,
      lookupTables: tables,
    });
    const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
    expect(compiled.staticAccounts).toContain(address("Hy5oibb1cYdmjyPJ2fiypDtKYvp1uZTuPkmFzVy7TL8c"));
    expect(transfer.accounts?.[0]?.role).toBe(AccountRole.WRITABLE_SIGNER);
  });
});
