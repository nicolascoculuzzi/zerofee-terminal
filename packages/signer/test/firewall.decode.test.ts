import { describe, expect, test } from "bun:test";
import { type Address, getCompiledTransactionMessageEncoder } from "@solana/kit";
import { concatBytes } from "../src/bytes";
import { decodeTransaction } from "../src/firewall/decode";
import { checkTransaction } from "../src/firewall/firewall";
import { SYSTEM_PROGRAM } from "../src/firewall/programs";
import { JITO_TIP_ACCOUNTS, MAINNET, makeActors, makeContext, randomAddress } from "./helpers/fixtures";
import { curveBuyV2, expectRefused } from "./helpers/scenarios";
import { buildTransaction, randomBlockhash, transferSol } from "./helpers/tx";

type CompiledInput = Parameters<ReturnType<typeof getCompiledTransactionMessageEncoder>["encode"]>[0];

/** Wraps hand-built message bytes in a wire transaction with `signatures` empty slots. */
function wire(message: Uint8Array, signatures = 1): Uint8Array {
  return concatBytes(Uint8Array.of(signatures), new Uint8Array(64 * signatures), message);
}

function encodeMessage(message: CompiledInput): Uint8Array {
  return new Uint8Array(getCompiledTransactionMessageEncoder().encode(message));
}

/** A legacy System transfer signer -> tip, compiled by hand so tests can break it. */
function transferMessage(signer: Address, overrides: Partial<Record<string, unknown>> = {}): CompiledInput {
  const lamports = new Uint8Array(12);
  lamports.set([2, 0, 0, 0, 0xe8, 0x03]); // Transfer 1000 lamports
  return {
    version: "legacy",
    header: { numSignerAccounts: 1, numReadonlySignerAccounts: 0, numReadonlyNonSignerAccounts: 1 },
    staticAccounts: [signer, JITO_TIP_ACCOUNTS[0]!, SYSTEM_PROGRAM],
    lifetimeToken: randomBlockhash(),
    instructions: [{ programAddressIndex: 2, accountIndices: [0, 1], data: lamports }],
    ...overrides,
  } as CompiledInput;
}

describe("decoder: canonical, well-formed legacy and v0 only", () => {
  test("baseline hand-built transfer passes", async () => {
    const a = makeActors();
    const summary = await checkTransaction(wire(encodeMessage(transferMessage(a.signer))), makeContext(a));
    expect(summary.ok).toBe(true);
  });

  test("trailing bytes, empty input, oversize and v1 envelopes are refused", async () => {
    const a = makeActors();
    const ctx = makeContext(a);
    const good = buildTransaction({ feePayer: a.signer, instructions: [transferSol(a.signer, JITO_TIP_ACCOUNTS[0]!, 1_000n)] });
    await expectRefused(concatBytes(good, Uint8Array.of(0)), ctx, /not canonical/);
    await expectRefused(new Uint8Array(0), ctx, /empty/);
    await expectRefused(new Uint8Array(1300), ctx, /limited to 1232/);
    const v1 = good.slice();
    v1[0] = 0x81;
    await expectRefused(v1, ctx, /unsupported transaction format/);
  });

  test("alias (non-minimal) shortvec encodings are refused", async () => {
    const a = makeActors();
    const message = encodeMessage(transferMessage(a.signer));
    // Signature count 1 encoded as [0x81, 0x00] instead of [0x01].
    const alias = concatBytes(Uint8Array.of(0x81, 0x00), new Uint8Array(64), message);
    const result = await checkTransaction(alias, makeContext(a));
    expect(result.ok).toBe(false);
  });

  test("signature count that disagrees with the header is refused", async () => {
    const a = makeActors();
    await expectRefused(wire(encodeMessage(transferMessage(a.signer)), 2), makeContext(a), /malformed|not canonical/);
  });

  test("inconsistent headers are refused", async () => {
    const a = makeActors();
    const ctx = makeContext(a);
    const noSigner = transferMessage(a.signer, {
      header: { numSignerAccounts: 0, numReadonlySignerAccounts: 0, numReadonlyNonSignerAccounts: 1 },
    });
    await expectRefused(concatBytes(Uint8Array.of(0), encodeMessage(noSigner)), ctx, /requires no signatures|no expected signers/);
    const readonlyPayer = transferMessage(a.signer, {
      header: { numSignerAccounts: 1, numReadonlySignerAccounts: 1, numReadonlyNonSignerAccounts: 1 },
    });
    await expectRefused(wire(encodeMessage(readonlyPayer)), ctx, /fee payer must be a writable signer/);
    const overlap = transferMessage(a.signer, {
      header: { numSignerAccounts: 1, numReadonlySignerAccounts: 0, numReadonlyNonSignerAccounts: 3 },
    });
    await expectRefused(wire(encodeMessage(overlap)), ctx, /inconsistent/);
  });

  test("duplicate account keys are refused (every account must have one role)", async () => {
    const a = makeActors();
    const dup = transferMessage(a.signer, { staticAccounts: [a.signer, JITO_TIP_ACCOUNTS[0]!, JITO_TIP_ACCOUNTS[0]!, SYSTEM_PROGRAM] });
    await expectRefused(wire(encodeMessage(dup)), makeContext(a), /appears more than once/);
    // The same address once static and once through a lookup table.
    const alt = randomAddress();
    const loaded = {
      ...transferMessage(a.signer),
      version: 0,
      addressTableLookups: [{ lookupTableAddress: alt, writableIndexes: [0], readonlyIndexes: [] }],
    } as CompiledInput;
    await expectRefused(
      wire(encodeMessage(loaded)),
      makeContext(a, { addressLookupTables: { [alt]: [JITO_TIP_ACCOUNTS[0]!] } }),
      /appears more than once/,
    );
  });

  test("out-of-range indices, fee payer as program, writable program are refused", async () => {
    const a = makeActors();
    const ctx = makeContext(a);
    const data = Uint8Array.from([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
    const badAccount = transferMessage(a.signer, { instructions: [{ programAddressIndex: 2, accountIndices: [0, 9], data }] });
    await expectRefused(wire(encodeMessage(badAccount)), ctx, /out of range/);
    const payerProgram = transferMessage(a.signer, { instructions: [{ programAddressIndex: 0, accountIndices: [0, 1], data }] });
    await expectRefused(wire(encodeMessage(payerProgram)), ctx, /must be a static, non-fee-payer account/);
    const writableProgram = transferMessage(a.signer, {
      header: { numSignerAccounts: 1, numReadonlySignerAccounts: 0, numReadonlyNonSignerAccounts: 0 },
    });
    await expectRefused(wire(encodeMessage(writableProgram)), ctx, /writable program account/);
  });

  test("lookup tables: empty lookups and non-address entries are refused", async () => {
    const a = makeActors();
    const alt = randomAddress();
    const empty = {
      ...transferMessage(a.signer),
      version: 0,
      addressTableLookups: [{ lookupTableAddress: alt, writableIndexes: [], readonlyIndexes: [] }],
    } as CompiledInput;
    await expectRefused(wire(encodeMessage(empty)), makeContext(a, { addressLookupTables: { [alt]: [] } }), /without loading any account/);
    const junk = {
      ...transferMessage(a.signer),
      version: 0,
      addressTableLookups: [{ lookupTableAddress: alt, writableIndexes: [], readonlyIndexes: [0] }],
    } as CompiledInput;
    await expectRefused(
      wire(encodeMessage(junk)),
      makeContext(a, { addressLookupTables: { [alt]: ["not-an-address"] } }),
      /is not an address/,
    );
  });

  test("v0 roles: static signer/writable/readonly, then ALT writable, then ALT readonly", async () => {
    const a = makeActors();
    const alt = randomAddress();
    const tables = { [alt]: [MAINNET.pumpGlobal, MAINNET.pumpFeeRecipient] };
    const tx = buildTransaction({ feePayer: a.signer, instructions: await curveBuyV2(a), lookupTables: tables });
    const decoded = decodeTransaction(tx, tables);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const byAddress = new Map(decoded.tx.accounts.map((acc) => [acc.address, acc]));
    expect(byAddress.get(a.signer)).toMatchObject({ isSigner: true, isWritable: true, isStatic: true, index: 0 });
    expect(byAddress.get(MAINNET.pumpFeeRecipient)).toMatchObject({ isSigner: false, isWritable: true, isStatic: false });
    expect(byAddress.get(MAINNET.pumpGlobal)).toMatchObject({ isSigner: false, isWritable: false, isStatic: false });
    // Loaded writable accounts come before loaded readonly ones.
    expect(byAddress.get(MAINNET.pumpFeeRecipient)!.index).toBeLessThan(byAddress.get(MAINNET.pumpGlobal)!.index);
  });

  test("context validation fails closed", async () => {
    const a = makeActors();
    const tx = buildTransaction({ feePayer: a.signer, instructions: [transferSol(a.signer, a.connected, 1n)] });
    const bad = { ...makeContext(a), caps: { ...makeContext(a).caps, maxBuyLamports: 1 as unknown as bigint } };
    await expectRefused(tx, bad, /invalid firewall context: caps.maxBuyLamports/);
    await expectRefused(tx, { ...makeContext(a), connectedWallet: "nope" as Address }, /connectedWallet is not an address/);
  });
});
