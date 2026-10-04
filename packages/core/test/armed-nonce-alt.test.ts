/**
 * Durable-nonce and lookup-table encoders/decoders vs @solana/web3.js v1 (test oracle only) and kit.
 */
import { describe, expect, test } from "bun:test";
import {
  type Address,
  address,
  createTransactionMessage,
  getAddressEncoder,
  getBase58Encoder,
  type Instruction,
  isAdvanceNonceAccountInstruction,
  isSignerRole,
  isWritableRole,
  type Nonce,
  setTransactionMessageLifetimeUsingDurableNonce,
} from "@solana/kit";
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  NonceAccount,
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
  NONCE_ACCOUNT_LENGTH as W3_NONCE_LENGTH,
} from "@solana/web3.js";
import {
  ADDRESS_LOOKUP_TABLE_PROGRAM_ID,
  advanceNonceInstruction,
  authorizeNonceInstruction,
  closeLookupTableInstruction,
  createAccountWithSeedInstruction,
  createLookupTableInstruction,
  createNonceSlotInstructions,
  deactivateLookupTableInstruction,
  decodeLookupTable,
  decodeNonceAccount,
  deriveLookupTableAddress,
  extendLookupTableInstruction,
  fetchLookupTables,
  fetchNonceRent,
  fetchNonceSlots,
  initializeNonceInstruction,
  LOOKUP_TABLE_EXTEND_CHUNK,
  LOOKUP_TABLE_META_SIZE,
  lookupTableStatus,
  NONCE_ACCOUNT_LENGTH,
  nonceSlotAddress,
  nonceSlotAddresses,
  planLookupTableExtension,
  SYSTEM_PROGRAM_ID,
  toAddressesByLookupTable,
  usableLookupTableAddresses,
  withdrawNonceInstruction,
} from "../src";

const PAYER = address("HpqMfMw5r9DT3qWMHup63YndJF6hsjGAcy9qkFGtdpq4");
const NONCE = address("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
const OTHER = address("Hy5oibb1cYdmjyPJ2fiypDtKYvp1uZTuPkmFzVy7TL8c");
const pk = (a: string) => new PublicKey(a);

type Meta = [string, boolean, boolean];
const ours = (ix: Instruction) => ({
  program: ix.programAddress as string,
  metas: (ix.accounts ?? []).map((m): Meta => [m.address, isSignerRole(m.role), isWritableRole(m.role)]),
  data: [...(ix.data ?? new Uint8Array())],
});
const theirs = (ix: TransactionInstruction) => ({
  program: ix.programId.toBase58(),
  metas: ix.keys.map((k): Meta => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
  data: [...ix.data],
});

describe("nonce slot instructions vs web3.js SystemProgram", () => {
  test("nonce account size matches web3.js", () => {
    expect(NONCE_ACCOUNT_LENGTH).toBe(W3_NONCE_LENGTH);
  });

  test("advance / withdraw / authorize / initialize", () => {
    expect(ours(advanceNonceInstruction({ nonceAccount: NONCE, authority: PAYER }))).toEqual(
      theirs(SystemProgram.nonceAdvance({ noncePubkey: pk(NONCE), authorizedPubkey: pk(PAYER) })),
    );
    expect(ours(withdrawNonceInstruction({ nonceAccount: NONCE, authority: PAYER, recipient: OTHER, lamports: 1_447_680n }))).toEqual(
      theirs(
        SystemProgram.nonceWithdraw({ noncePubkey: pk(NONCE), authorizedPubkey: pk(PAYER), toPubkey: pk(OTHER), lamports: 1_447_680 }),
      ),
    );
    expect(ours(authorizeNonceInstruction({ nonceAccount: NONCE, authority: PAYER, newAuthority: OTHER }))).toEqual(
      theirs(SystemProgram.nonceAuthorize({ noncePubkey: pk(NONCE), authorizedPubkey: pk(PAYER), newAuthorizedPubkey: pk(OTHER) })),
    );
    expect(ours(initializeNonceInstruction({ nonceAccount: NONCE, authority: OTHER }))).toEqual(
      theirs(SystemProgram.nonceInitialize({ noncePubkey: pk(NONCE), authorizedPubkey: pk(OTHER) })),
    );
  });

  test("our advance is kit's advance (kit recognises the durable-nonce lifetime)", () => {
    const ix = advanceNonceInstruction({ nonceAccount: NONCE, authority: PAYER });
    const kitMsg = setTransactionMessageLifetimeUsingDurableNonce(
      { nonce: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N" as Nonce, nonceAccountAddress: NONCE, nonceAuthorityAddress: PAYER },
      createTransactionMessage({ version: 0 }),
    );
    expect(ours(ix)).toEqual(ours(kitMsg.instructions[0]));
    expect(isAdvanceNonceAccountInstruction(ix)).toBe(true);
  });

  test("slot creation = CreateAccountWithSeed (wallet is the only signer) + InitializeNonceAccount, as web3.js encodes them", async () => {
    const { address: slot, seed } = await nonceSlotAddress(PAYER, 3);
    expect(seed).toBe("zerofee-nonce-3");
    expect(slot).toBe(address((await PublicKey.createWithSeed(pk(PAYER), seed, SystemProgram.programId)).toBase58()));
    expect(await nonceSlotAddresses(PAYER, 4)).toContain(slot);
    const { instructions } = await createNonceSlotInstructions({ wallet: PAYER, index: 3, rentLamports: 1_447_680n });
    // Only the wallet signs: the firewall refuses any second signature.
    const signers = new Set(instructions.flatMap((ix) => (ix.accounts ?? []).filter((a) => isSignerRole(a.role)).map((a) => a.address)));
    expect([...signers]).toEqual([PAYER]);
    const ref = SystemProgram.createAccountWithSeed({
      fromPubkey: pk(PAYER),
      newAccountPubkey: pk(slot),
      basePubkey: pk(PAYER),
      seed,
      lamports: 1_447_680,
      space: 80,
      programId: SystemProgram.programId,
    });
    expect(ours(instructions[0] as Instruction)).toEqual(theirs(ref));
    expect(ours(instructions[1] as Instruction)).toEqual(
      theirs(SystemProgram.nonceInitialize({ noncePubkey: pk(slot), authorizedPubkey: pk(PAYER) })),
    );
    // A distinct base is an extra read-only signer.
    const withBase = createAccountWithSeedInstruction({
      payer: PAYER,
      newAccount: slot,
      base: OTHER,
      seed,
      lamports: 1n,
      space: 80,
      owner: SYSTEM_PROGRAM_ID,
    });
    expect(withBase.accounts?.[2]).toEqual({ address: OTHER, role: 2 });
    await expect(nonceSlotAddress(PAYER, -1)).rejects.toThrow();
    // Funding is capped like the signer firewall (0.002 SOL by default); rent comes from RPC.
    await expect(createNonceSlotInstructions({ wallet: PAYER, index: 0, rentLamports: 2_000_001n })).rejects.toThrow("firewall cap");
    await expect(createNonceSlotInstructions({ wallet: PAYER, index: 0, rentLamports: 0n })).rejects.toThrow();
    await expect(createNonceSlotInstructions({ wallet: PAYER, index: 0, rentLamports: 1_056_640n })).resolves.toBeDefined();
    expect(() =>
      createAccountWithSeedInstruction({
        payer: PAYER,
        newAccount: slot,
        base: PAYER,
        seed: "x".repeat(33),
        lamports: 1n,
        space: 80,
        owner: SYSTEM_PROGRAM_ID,
      }),
    ).toThrow("seed longer");
  });
});

function nonceAccountBytes(authority: Address, nonce: Uint8Array, version = 1, state = 1, lamportsPerSignature = 5_000n): Uint8Array {
  const data = new Uint8Array(80);
  const v = new DataView(data.buffer);
  v.setUint32(0, version, true);
  v.setUint32(4, state, true);
  data.set(getAddressEncoder().encode(authority), 8);
  data.set(nonce, 40);
  v.setBigUint64(72, lamportsPerSignature, true);
  return data;
}

describe("nonce account decoding", () => {
  const nonceBytes = getBase58Encoder().encode("EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N") as Uint8Array;

  test("initialized current-version account matches web3.js NonceAccount", () => {
    const data = nonceAccountBytes(PAYER, nonceBytes);
    const d = decodeNonceAccount(data);
    const ref = NonceAccount.fromAccountData(Buffer.from(data));
    expect(d).toEqual({
      version: "current",
      initialized: true,
      authority: address(ref.authorizedPubkey.toBase58()),
      nonce: ref.nonce as never,
      lamportsPerSignature: BigInt(ref.feeCalculator.lamportsPerSignature),
    });
    expect(d.nonce).toBe("EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N" as never);
  });

  test("uninitialized, legacy and malformed accounts", () => {
    expect(decodeNonceAccount(new Uint8Array(80)).initialized).toBe(false);
    expect(decodeNonceAccount(nonceAccountBytes(PAYER, nonceBytes, 0)).version).toBe("legacy");
    expect(() => decodeNonceAccount(new Uint8Array(79))).toThrow("80 bytes");
    expect(() => decodeNonceAccount(nonceAccountBytes(PAYER, nonceBytes, 2))).toThrow("version");
    expect(() => decodeNonceAccount(nonceAccountBytes(PAYER, nonceBytes, 1, 7))).toThrow("state");
  });

  test("fetchNonceSlots / fetchNonceRent over a mock RPC (rent comes from the cluster)", async () => {
    const data = nonceAccountBytes(PAYER, nonceBytes);
    const b64 = Buffer.from(data).toString("base64");
    const rpc = {
      getMultipleAccounts: (addrs: Address[]) => ({
        send: async () => ({
          value: addrs.map((a) =>
            a === NONCE
              ? { owner: SYSTEM_PROGRAM_ID, lamports: 1_447_680n, data: [b64, "base64"] }
              : a === OTHER
                ? { owner: ADDRESS_LOOKUP_TABLE_PROGRAM_ID, lamports: 1n, data: [b64, "base64"] }
                : null,
          ),
        }),
      }),
      getMinimumBalanceForRentExemption: (space: bigint) => ({ send: async () => space * 13_233n }),
    };
    const [slot, wrongOwner, missing] = await fetchNonceSlots(rpc as never, [NONCE, OTHER, PAYER]);
    expect(slot).toEqual({
      account: NONCE,
      authority: PAYER,
      value: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N" as never,
      lamports: 1_447_680n,
    });
    expect(wrongOwner).toBeNull();
    expect(missing).toBeNull();
    expect(await fetchNonceRent(rpc as never)).toBe(80n * 13_233n);
  });
});

function lookupTableBytes(args: {
  deactivationSlot: bigint;
  lastExtendedSlot: bigint;
  startIndex: number;
  authority: Address | null;
  addresses: Address[];
}) {
  const data = new Uint8Array(LOOKUP_TABLE_META_SIZE + 32 * args.addresses.length);
  const v = new DataView(data.buffer);
  v.setUint32(0, 1, true);
  v.setBigUint64(4, args.deactivationSlot, true);
  v.setBigUint64(12, args.lastExtendedSlot, true);
  data[20] = args.startIndex;
  if (args.authority) {
    data[21] = 1;
    data.set(getAddressEncoder().encode(args.authority), 22);
  }
  args.addresses.forEach((a, i) => {
    data.set(getAddressEncoder().encode(a), LOOKUP_TABLE_META_SIZE + 32 * i);
  });
  return data;
}

describe("address lookup table instructions vs web3.js AddressLookupTableProgram", () => {
  test("create derives the same table address and encodes the same instruction", async () => {
    const recentSlot = 312_345_678n;
    const { instruction, address: table, bump } = await createLookupTableInstruction({ authority: PAYER, payer: OTHER, recentSlot });
    const [refIx, refAddr] = AddressLookupTableProgram.createLookupTable({ authority: pk(PAYER), payer: pk(OTHER), recentSlot });
    expect(table).toBe(address(refAddr.toBase58()));
    expect(ours(instruction)).toEqual(theirs(refIx));
    expect((await deriveLookupTableAddress(PAYER, recentSlot)).bump).toBe(bump);
    const relaxed = await createLookupTableInstruction({ authority: PAYER, payer: OTHER, recentSlot, authoritySigns: false });
    expect(relaxed.instruction.accounts?.[1]?.role).toBe(0);
  });

  test("extend / deactivate / close", async () => {
    const table = (await deriveLookupTableAddress(PAYER, 1n)).address;
    const addrs = [NONCE, OTHER, SYSTEM_PROGRAM_ID];
    expect(ours(extendLookupTableInstruction({ table, authority: PAYER, payer: OTHER, addresses: addrs }))).toEqual(
      theirs(
        AddressLookupTableProgram.extendLookupTable({
          lookupTable: pk(table),
          authority: pk(PAYER),
          payer: pk(OTHER),
          addresses: addrs.map(pk),
        }),
      ),
    );
    expect(ours(deactivateLookupTableInstruction({ table, authority: PAYER }))).toEqual(
      theirs(AddressLookupTableProgram.deactivateLookupTable({ lookupTable: pk(table), authority: pk(PAYER) })),
    );
    expect(ours(closeLookupTableInstruction({ table, authority: PAYER, recipient: OTHER }))).toEqual(
      theirs(AddressLookupTableProgram.closeLookupTable({ lookupTable: pk(table), authority: pk(PAYER), recipient: pk(OTHER) })),
    );
    expect(() => extendLookupTableInstruction({ table, authority: PAYER, payer: OTHER, addresses: [] })).toThrow();
  });

  test("decoder matches web3.js AddressLookupTableAccount.deserialize", () => {
    const U64_MAX = (1n << 64n) - 1n;
    const data = lookupTableBytes({
      deactivationSlot: U64_MAX,
      lastExtendedSlot: 900n,
      startIndex: 2,
      authority: PAYER,
      addresses: [NONCE, OTHER, PAYER],
    });
    const t = decodeLookupTable(data);
    const ref = AddressLookupTableAccount.deserialize(data);
    expect(t.deactivationSlot).toBe(ref.deactivationSlot);
    expect(t.lastExtendedSlot).toBe(BigInt(ref.lastExtendedSlot));
    expect(t.lastExtendedSlotStartIndex).toBe(ref.lastExtendedSlotStartIndex);
    expect(t.authority).toBe(address(ref.authority?.toBase58() ?? ""));
    expect(t.addresses).toEqual(ref.addresses.map((a) => address(a.toBase58())));
    const frozen = decodeLookupTable(
      lookupTableBytes({ deactivationSlot: U64_MAX, lastExtendedSlot: 1n, startIndex: 0, authority: null, addresses: [] }),
    );
    expect(frozen.authority).toBeNull();
    expect(() => decodeLookupTable(new Uint8Array(10))).toThrow();
    expect(() => decodeLookupTable(new Uint8Array(56))).toThrow("type 0");
  });

  test("status, warm-up and extension planning", () => {
    const U64_MAX = (1n << 64n) - 1n;
    const t = decodeLookupTable(
      lookupTableBytes({
        deactivationSlot: U64_MAX,
        lastExtendedSlot: 900n,
        startIndex: 2,
        authority: PAYER,
        addresses: [NONCE, OTHER, PAYER],
      }),
    );
    expect(lookupTableStatus(t, 1_000n)).toBe("active");
    expect(lookupTableStatus({ deactivationSlot: 1_000n }, 1_200n)).toBe("deactivating");
    expect(lookupTableStatus({ deactivationSlot: 1_000n }, 1_514n)).toBe("closeable");
    // Entries appended in slot 900 are unusable by a tx in slot 900.
    expect(usableLookupTableAddresses(t, 900n)).toEqual([NONCE, OTHER]);
    expect(usableLookupTableAddresses(t, 901n)).toEqual([NONCE, OTHER, PAYER]);

    const wanted = Array.from({ length: 60 }, (_v, i) => address(new PublicKey(i + 1).toBase58()));
    const batches = planLookupTableExtension(wanted.slice(0, 5), [...wanted, ...wanted]);
    expect(batches.flat()).toEqual(wanted.slice(5));
    expect(batches.every((b) => b.length <= LOOKUP_TABLE_EXTEND_CHUNK)).toBe(true);
    expect(planLookupTableExtension(wanted, wanted)).toEqual([]);
    expect(() => planLookupTableExtension(Array(250).fill(PAYER), wanted)).toThrow("256");
  });

  test("fetchLookupTables + toAddressesByLookupTable", async () => {
    const U64_MAX = (1n << 64n) - 1n;
    const data = lookupTableBytes({ deactivationSlot: U64_MAX, lastExtendedSlot: 1n, startIndex: 0, authority: PAYER, addresses: [NONCE] });
    const rpc = {
      getMultipleAccounts: (addrs: Address[]) => ({
        send: async () => ({
          value: addrs.map((a) =>
            a === OTHER
              ? { owner: ADDRESS_LOOKUP_TABLE_PROGRAM_ID, lamports: 1n, data: [Buffer.from(data).toString("base64"), "base64"] }
              : null,
          ),
        }),
      }),
    };
    const states = await fetchLookupTables(rpc as never, [OTHER, PAYER]);
    expect(states[OTHER]?.addresses).toEqual([NONCE]);
    expect(states[PAYER]).toBeNull();
    expect(toAddressesByLookupTable(states)).toEqual({ [OTHER]: [NONCE] });
  });
});
