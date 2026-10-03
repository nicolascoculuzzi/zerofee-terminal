/**
 * Durable-nonce and lookup-table mechanics of armed orders on a LOCAL Agave test validator.
 * Opt-in (slow, needs the Solana toolchain):  bun run test:validator   (ZF_VALIDATOR_TESTS=1)
 * ZF_VALIDATOR_SLOW=1 also waits out an ALT deactivation cooldown to close the table.
 *
 * The pump programs are not on a local validator (pump end-to-end tests come via a fork harness),
 * so armed orders here use a test-only trade template whose "trade" is SPL Token Burn + CloseAccount
 * (the same full-exit shape: sell the whole balance and close the account). Its min-out decides
 * whether the trade succeeds, which models slippage failures. Throwaway keys, local SOL only.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  AccountRole,
  type Address,
  appendTransactionMessageInstructions,
  type Base64EncodedWireTransaction,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  type Instruction,
  type KeyPairSigner,
  lamports,
  pipe,
  type Signature,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessageLifetimeUsingDurableNonce,
  signTransaction,
} from "@solana/kit";
import {
  type ArmedOrder,
  applyArmedOrderEvent,
  armedStaticAccounts,
  armOcoPair,
  armOrder,
  closeAccountInstruction,
  closeLookupTableInstruction,
  compileArmedTransaction,
  compileCancelTransaction,
  createAtaIdempotentInstruction,
  createLookupTableInstruction,
  createNonceSlotInstructions,
  DEFAULT_CANCEL_CU_LIMIT,
  type DurableNonceRef,
  deactivateLookupTableInstruction,
  extendLookupTableInstruction,
  fetchLookupTables,
  fetchNonceRent,
  fetchNonceSlots,
  findAssociatedTokenAddress,
  JITO_TIP_ACCOUNTS_FALLBACK,
  jitoTipLevels,
  LOOKUP_TABLE_DEACTIVATION_COOLDOWN_SLOTS,
  lookupTableStatus,
  pickVariant,
  planLookupTableExtension,
  type SignedTx,
  SYSTEM_PROGRAM_ID,
  SYSVAR_RECENT_BLOCKHASHES_ID,
  signTransactionBatch,
  systemTransferInstruction,
  TOKEN_PROGRAM_ID,
  type TradeTemplate,
  toSignedTx,
  WSOL_MINT,
  withdrawNonceInstruction,
} from "../../src";
import { addressBytes, concatBytes, u8, u64le } from "../../src/util/bytes";
import { type LocalValidator, startValidator } from "./validator";

const RUN = process.env.ZF_VALIDATOR_TESTS === "1";
const SLOW = process.env.ZF_VALIDATOR_SLOW === "1";
const SOL = 1_000_000_000n;

// ---- SPL Token instructions the test template needs (Burn / MintTo / InitializeMint2) ----
const tokenIx = (accounts: Instruction["accounts"], data: Uint8Array): Instruction => ({
  programAddress: TOKEN_PROGRAM_ID,
  accounts,
  data,
});
const burnIx = (account: Address, mint: Address, owner: Address, amount: bigint) =>
  tokenIx(
    [
      { address: account, role: AccountRole.WRITABLE },
      { address: mint, role: AccountRole.WRITABLE },
      { address: owner, role: AccountRole.READONLY_SIGNER },
    ],
    concatBytes(u8(8), u64le(amount)),
  );
const mintToIx = (mint: Address, dest: Address, authority: Address, amount: bigint) =>
  tokenIx(
    [
      { address: mint, role: AccountRole.WRITABLE },
      { address: dest, role: AccountRole.WRITABLE },
      { address: authority, role: AccountRole.READONLY_SIGNER },
    ],
    concatBytes(u8(7), u64le(amount)),
  );
const initMint2Ix = (mint: Address, authority: Address) =>
  tokenIx([{ address: mint, role: AccountRole.WRITABLE }], concatBytes(u8(20), u8(6), addressBytes(authority), u8(0)));
/** SPL Memo (built into the test validator): carries the variant's min-out, as a real trade's data would. */
const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" as Address;
const memoIx = (text: string): Instruction => ({ programAddress: MEMO_PROGRAM_ID, data: new TextEncoder().encode(text) });
const createAccountIx = (payer: Address, account: Address, lamportsAmount: bigint, space: number, owner: Address): Instruction => ({
  programAddress: SYSTEM_PROGRAM_ID,
  accounts: [
    { address: payer, role: AccountRole.WRITABLE_SIGNER },
    { address: account, role: AccountRole.WRITABLE_SIGNER },
  ],
  data: concatBytes(new Uint8Array([0, 0, 0, 0]), u64le(lamportsAmount), u64le(BigInt(space)), addressBytes(owner)),
});

describe.skipIf(!RUN)("armed orders on a local Agave validator", () => {
  let v: LocalValidator;
  let wallet: KeyPairSigner;
  let operator: KeyPairSigner;
  let mint: Address;
  let ata: Address;
  const slots: Address[] = [];
  let tables: Record<Address, Address[]> = {};
  let tableAddress: Address;
  const tipAccount = JITO_TIP_ACCOUNTS_FALLBACK[0] as Address;
  const tipLevels = jitoTipLevels([{ tipLamports: 10_000n, cuPriceMicroLamports: 1_000n }]);

  // ---- helpers ----------------------------------------------------------------------------
  const confirm = async (sig: string, timeoutMs = 30_000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const { value } = await v.rpc.getSignatureStatuses([sig as Signature], { searchTransactionHistory: true }).send();
      const s = value[0];
      if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) return s;
      await Bun.sleep(80);
    }
    throw new Error(`not confirmed in time: ${sig}`);
  };
  const send = (wire: string) =>
    v.rpc.sendTransaction(wire as Base64EncodedWireTransaction, { encoding: "base64", skipPreflight: true, maxRetries: 0n }).send();
  /** Sends (rebroadcasting) until it lands; returns the status (err = landed but failed). */
  const land = async (tx: SignedTx) => {
    for (let i = 0; i < 20; i++) {
      await send(tx.wireBase64).catch(() => {});
      try {
        return await confirm(tx.signature, 1_500);
      } catch {
        /* rebroadcast */
      }
    }
    throw new Error(`did not land: ${tx.signature}`);
  };
  /** A dead transaction (nonce already advanced) is refused at preflight and never charges a fee. */
  const expectRejected = async (tx: SignedTx) => {
    const before = await balance(wallet.address);
    const err = await v.rpc
      .sendTransaction(tx.wireBase64 as Base64EncodedWireTransaction, { encoding: "base64", preflightCommitment: "confirmed" })
      .send()
      .then(
        () => null,
        (e: Error) => e,
      );
    expect(err).not.toBeNull();
    await Bun.sleep(400);
    expect(await balance(wallet.address)).toBe(before);
    const { value } = await v.rpc.getSignatureStatuses([tx.signature as Signature], { searchTransactionHistory: true }).send();
    expect(value[0]).toBeNull();
  };
  const balance = async (a: Address) => (await v.rpc.getBalance(a, { commitment: "confirmed" }).send()).value;
  const slotNow = async () => v.rpc.getSlot({ commitment: "confirmed" }).send();
  const waitForSlot = async (target: bigint) => {
    while ((await slotNow()) < target) await Bun.sleep(50);
  };
  const nonceOf = async (account: Address): Promise<DurableNonceRef> => {
    const [s] = await fetchNonceSlots(v.rpc, [account]);
    if (!s) throw new Error(`nonce slot ${account} missing`);
    return { account, authority: s.authority, value: s.value };
  };
  /** Ordinary blockhash transaction signed by `signers` (first = fee payer). */
  const sendNow = async (signers: KeyPairSigner[], instructions: Instruction[]) => {
    const { value: bh } = await v.rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    const msg = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer((signers[0] as KeyPairSigner).address, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    );
    const tx = await signTransaction(
      signers.map((s) => s.keyPair),
      compileTransaction(msg),
    );
    const status = await land({ wireBase64: getBase64EncodedWireTransaction(tx), signature: getSignatureFromTransaction(tx), size: 0 });
    expect(status.err).toBeNull();
    return status;
  };
  const airdrop = async (to: Address, amount: bigint) => confirm(await v.rpc.requestAirdrop(to, lamports(amount)).send());
  const tokenBalance = async (account: Address) => {
    const r = await v.rpc
      .getTokenAccountBalance(account, { commitment: "confirmed" })
      .send()
      .catch(() => null);
    return r ? BigInt(r.value.amount) : null;
  };
  const mintTokens = async (amount: bigint) =>
    sendNow(
      [wallet],
      [
        createAtaIdempotentInstruction({ payer: wallet.address, ata, owner: wallet.address, mint, tokenProgram: TOKEN_PROGRAM_ID }),
        mintToIx(mint, ata, wallet.address, amount),
      ],
    );
  /**
   * Test-only trade: "sell" `amount` tokens = Burn(amount) + CloseAccount (a full exit). A min-out
   * above `fillsUpTo` burns one token more than the balance, so the trade lands and FAILS.
   */
  const burnTemplate = (amount: bigint, fillsUpTo: bigint): TradeTemplate => ({
    venue: "pump",
    side: "sell",
    mint,
    amount,
    closesBaseAccount: true,
    build: async (minOut) => [
      memoIx(`min-out ${minOut}`),
      burnIx(ata, mint, wallet.address, minOut > fillsUpTo ? amount + 1n : amount),
      closeAccountInstruction({ account: ata, destination: wallet.address, owner: wallet.address }),
    ],
    frozen: {
      baseTokenProgram: TOKEN_PROGRAM_ID,
      quoteMint: WSOL_MINT,
      creator: wallet.address,
      market: mint,
      feeRecipient: wallet.address,
      buybackFeeRecipient: wallet.address,
    },
    defaultCuLimit: 40_000,
  });
  const fullExit = async (id: string, amount: bigint, nonceIdx: number[], minOuts: bigint[], fillsUpTo: bigint, ocoGroup?: string) => ({
    id,
    kind: "stop-loss" as const,
    wallet: wallet.address,
    mint,
    amount,
    fullExit: true,
    trigger: { type: "quote-at-most" as const, threshold: 1_000n },
    templates: [burnTemplate(amount, fillsUpTo)],
    minOuts,
    tipLevels,
    nonces: await Promise.all(nonceIdx.map((i) => nonceOf(slots[i] as Address))),
    armingQuoteOut: 1_000n,
    lookupTables: tables,
    tipAccounts: { jito: [tipAccount] },
    ...(ocoGroup ? { ocoGroup } : {}),
  });
  const variantFor = (o: ArmedOrder, attempt: number, minOut: bigint) =>
    o.attempts[attempt]?.variants.find((x) => x.minOut === minOut) as ArmedOrder["attempts"][number]["variants"][number];

  beforeAll(async () => {
    v = await startValidator();
    wallet = await generateKeyPairSigner();
    operator = await generateKeyPairSigner();
    await airdrop(wallet.address, 50n * SOL);
    await airdrop(operator.address, 5n * SOL);
    // Tip accounts do not exist on a fresh cluster; fund them so small tips are rent-valid.
    for (const tip of JITO_TIP_ACCOUNTS_FALLBACK) await airdrop(tip, SOL);
    // Test token: the wallet is mint authority and holds tokens in its ATA.
    const mintKp = await generateKeyPairSigner();
    mint = mintKp.address;
    ata = await findAssociatedTokenAddress(wallet.address, mint, TOKEN_PROGRAM_ID);
    const mintRent = BigInt(await v.rpc.getMinimumBalanceForRentExemption(82n).send());
    await sendNow(
      [wallet, mintKp],
      [createAccountIx(wallet.address, mint, mintRent, 82, TOKEN_PROGRAM_ID), initMint2Ix(mint, wallet.address)],
    );
  }, 180_000);

  afterAll(async () => {
    await v?.stop();
  });

  // ---- tests ------------------------------------------------------------------------------

  test("nonce slots: one signature each (CreateAccountWithSeed + InitializeNonceAccount), rent read from the cluster", async () => {
    const rent = await fetchNonceRent(v.rpc);
    expect(rent).toBe(BigInt(await v.rpc.getMinimumBalanceForRentExemption(80n).send()));
    for (let i = 0; i < 12; i++) {
      const { address, instructions } = await createNonceSlotInstructions({ wallet: wallet.address, index: i, rentLamports: rent });
      await sendNow([wallet], instructions);
      slots.push(address);
    }
    for (const s of await fetchNonceSlots(v.rpc, slots)) {
      expect(s?.authority).toBe(wallet.address);
      expect(s?.lamports).toBe(rent);
    }
  }, 60_000);

  test("operator lookup table: create, extend with the armed static set, decode, warm up", async () => {
    const recentSlot = await v.rpc.getSlot({ commitment: "finalized" }).send();
    const created = await createLookupTableInstruction({ authority: operator.address, payer: operator.address, recentSlot });
    tableAddress = created.address;
    await sendNow([operator], [created.instruction]);
    const contents = await armedStaticAccounts();
    for (const batch of planLookupTableExtension([], contents)) {
      await sendNow(
        [operator],
        [extendLookupTableInstruction({ table: tableAddress, authority: operator.address, payer: operator.address, addresses: batch })],
      );
    }
    const state = (await fetchLookupTables(v.rpc, [tableAddress]))[tableAddress];
    expect(state?.addresses).toEqual(contents);
    expect(state?.authority).toBe(operator.address);
    expect(lookupTableStatus(state as never, await slotNow())).toBe("active");
    await waitForSlot((state?.lastExtendedSlot ?? 0n) + 2n);
    tables = { [tableAddress]: contents };
  }, 60_000);

  test("a variant signed earlier lands after its blockhash expired; its siblings and the cancel are then dead", async () => {
    const nonce = await nonceOf(slots[0] as Address);
    const fees = {
      cuLimit: 10_000,
      cuPriceMicroLamports: 1_000n,
      tips: [{ lane: "jito" as const, lamports: 10_000n, tipAccount }],
      jitoDontFront: true,
    };
    const variants = [1_000_000n, 2_000_000n].map((amount) =>
      compileArmedTransaction({
        feePayer: wallet.address,
        nonce,
        instructions: [systemTransferInstruction({ from: wallet.address, to: operator.address, lamports: amount })],
        fees,
        lookupTables: tables,
      }),
    );
    const cancel = compileCancelTransaction(wallet.address, nonce);
    const signed = (await signTransactionBatch(wallet, [...variants.map((x) => x.transaction), cancel.transaction])).map((t) =>
      toSignedTx(t, wallet.address),
    );
    const { value: bh } = await v.rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    // Wait until the blockhash current at signing time is no longer valid (> 150 blocks).
    while ((await v.rpc.isBlockhashValid(bh.blockhash, { commitment: "processed" }).send()).value) await Bun.sleep(200);

    const before = await balance(operator.address);
    const status = await land(signed[0] as SignedTx);
    expect(status.err).toBeNull();
    expect(await balance(operator.address)).toBe(before + 1_000_000n);
    expect((await nonceOf(nonce.account)).value).not.toBe(nonce.value);
    await expectRejected(signed[1] as SignedTx);
    await expectRejected(signed[2] as SignedTx);
    // The AdvanceNonceAccount sysvar was loaded from the operator table (read-only lookup).
    const tx = await v.rpc
      .getTransaction((signed[0] as SignedTx).signature as Signature, {
        encoding: "json",
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      })
      .send();
    expect(tx?.meta?.loadedAddresses?.readonly).toContain(SYSVAR_RECENT_BLOCKHASHES_ID);
  }, 90_000);

  test("OCO: the stop-loss lands, the take-profit sharing its nonce is burned", async () => {
    await mintTokens(1_000n);
    const tpSpec = await fullExit("tp", 1_000n, [1], [500n], 1_000n);
    const slSpec = await fullExit("sl", 1_000n, [1], [300n], 1_000n);
    const { nonces: _a, ...tpRest } = tpSpec;
    const { nonces, ...slRest } = slSpec;
    const [tp, sl] = await armOcoPair(
      { group: "oco", nonce: nonces[0] as DurableNonceRef, takeProfit: { ...tpRest, kind: "take-profit" }, stopLoss: slRest },
      wallet,
    );
    const slVariant = variantFor(sl, 0, 300n);
    let slOrder = applyArmedOrderEvent(sl, { type: "submitted", attempt: 0, variantId: slVariant.id }).order;
    const status = await land(slVariant.tx);
    expect(status.err).toBeNull();
    expect(await tokenBalance(ata)).toBeNull(); // burned and closed
    await expectRejected(variantFor(tp, 0, 500n).tx);
    slOrder = applyArmedOrderEvent(slOrder, {
      type: "nonce-consumed",
      nonce: slots[1] as Address,
      signature: slVariant.tx.signature,
      success: true,
    }).order;
    const tpOrder = applyArmedOrderEvent(tp, {
      type: "nonce-consumed",
      nonce: slots[1] as Address,
      signature: slVariant.tx.signature,
      success: true,
      bySiblingOrderId: "sl",
    }).order;
    expect(slOrder.status).toBe("filled");
    expect(tpOrder.status).toBe("cancelled");
  }, 60_000);

  test("a landed failure consumes the nonce (fee paid, tokens kept); the full-exit ladder fills on the next nonce", async () => {
    await mintTokens(1_000n);
    // min-out 200 "slips" (fails); min-out 100 fills.
    let order = await armOrder(await fullExit("ladder", 1_000n, [2, 3], [200n, 100n], 150n), wallet);
    expect(order.attempts).toHaveLength(2);
    const failing = variantFor(order, 0, 200n);
    const nonceBefore = (await nonceOf(slots[2] as Address)).value;
    const walletBefore = await balance(wallet.address);
    order = applyArmedOrderEvent(order, { type: "submitted", attempt: 0, variantId: failing.id }).order;
    const status = await land(failing.tx);
    expect(status.err).not.toBeNull();
    expect((await nonceOf(slots[2] as Address)).value).not.toBe(nonceBefore);
    expect(await tokenBalance(ata)).toBe(1_000n);
    expect(walletBefore - (await balance(wallet.address))).toBe(5_000n + failing.priorityFeeLamports); // tip reverted
    await expectRejected(variantFor(order, 0, 100n).tx);
    order = applyArmedOrderEvent(order, {
      type: "nonce-consumed",
      nonce: slots[2] as Address,
      signature: failing.tx.signature,
      success: false,
    }).order;
    expect(order.status).toBe("armed");
    expect(order.attempts[0]?.status).toBe("landed-failed");

    // The engine now picks attempt 1's variant below the live quote.
    const next = pickVariant(order.attempts[1]?.variants ?? [], 120n, { safetyMarginBps: 0 });
    expect(next?.minOut).toBe(100n);
    order = applyArmedOrderEvent(order, { type: "submitted", attempt: 1, variantId: next?.id as string }).order;
    expect((await land(next?.tx as SignedTx)).err).toBeNull();
    order = applyArmedOrderEvent(order, {
      type: "nonce-consumed",
      nonce: slots[3] as Address,
      signature: next?.tx.signature as string,
      success: true,
    }).order;
    expect(order.status).toBe("filled");
    expect(await tokenBalance(ata)).toBeNull();
  }, 60_000);

  test("after a fill, a re-bought position cannot be sold by a leftover ladder attempt (CloseAccount guard); cancels burn the rest", async () => {
    await mintTokens(1_000n);
    let order = await armOrder(await fullExit("guard", 1_000n, [4, 5, 6], [100n], 1_000n), wallet);
    const first = variantFor(order, 0, 100n);
    order = applyArmedOrderEvent(order, { type: "submitted", attempt: 0, variantId: first.id }).order;
    expect((await land(first.tx)).err).toBeNull();
    const filled = applyArmedOrderEvent(order, {
      type: "nonce-consumed",
      nonce: slots[4] as Address,
      signature: first.tx.signature,
      success: true,
    });
    expect(filled.order.status).toBe("filled");
    const cancels = filled.effects.filter((e) => e.type === "fire-cancel");
    expect(cancels.map((e) => e.type === "fire-cancel" && e.nonce)).toEqual([slots[5], slots[6]]);

    // Suppose the engine had NOT fired the cancels and the user re-bought MORE tokens:
    await mintTokens(1_001n);
    const leftover = variantFor(order, 1, 100n);
    const st = await land(leftover.tx);
    expect(st.err).not.toBeNull(); // burn 1,000 then close fails (1 token left): the whole tx reverts
    expect(await tokenBalance(ata)).toBe(1_001n);
    // Fire the remaining cancel: its nonce advances and attempt 2 is dead.
    const cancel2 = cancels[1];
    if (cancel2?.type !== "fire-cancel") throw new Error("expected a cancel effect");
    expect((await land(cancel2.cancel)).err).toBeNull();
    await expectRejected(variantFor(order, 2, 100n).tx);
  }, 60_000);

  test("cancel: advances the nonce, kills every variant, costs only the base fee and fits its CU budget", async () => {
    const order = await armOrder(await fullExit("cxl", 1_000n, [7], [100n, 90n], 1_000n), wallet);
    const cancel = order.attempts[0]?.nonce.cancel as SignedTx;
    const before = await balance(wallet.address);
    expect((await land(cancel)).err).toBeNull();
    expect(before - (await balance(wallet.address))).toBe(5_000n);
    for (const variant of order.attempts[0]?.variants ?? []) await expectRejected(variant.tx);
    const tx = await v.rpc
      .getTransaction(cancel.signature as Signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" })
      .send();
    expect(Number(tx?.meta?.computeUnitsConsumed ?? 0n)).toBeLessThanOrEqual(DEFAULT_CANCEL_CU_LIMIT);
    console.log(`  cancel consumed ${tx?.meta?.computeUnitsConsumed} CU (limit ${DEFAULT_CANCEL_CU_LIMIT})`);
  }, 60_000);

  test("reclaim: withdrawing a slot's whole balance closes it and refunds the rent to the wallet", async () => {
    const slot = slots[7] as Address;
    const [snap] = await fetchNonceSlots(v.rpc, [slot]);
    await waitForSlot((await slotNow()) + 2n); // not in the same blockhash window as the last advance
    const before = await balance(wallet.address);
    await sendNow(
      [wallet],
      [
        withdrawNonceInstruction({
          nonceAccount: slot,
          authority: wallet.address,
          recipient: wallet.address,
          lamports: snap?.lamports ?? 0n,
        }),
      ],
    );
    expect(
      await v.rpc
        .getAccountInfo(slot, { commitment: "confirmed" })
        .send()
        .then((r) => r.value),
    ).toBeNull();
    expect((await balance(wallet.address)) - before).toBe((snap?.lamports ?? 0n) - 5_000n);
  }, 60_000);

  test("SIMD-0242: a durable-nonce tx whose nonce account is loaded from a lookup table is refused (armed txs keep it static)", async () => {
    const nonce = await nonceOf(slots[8] as Address);
    const recentSlot = await v.rpc.getSlot({ commitment: "finalized" }).send();
    const created = await createLookupTableInstruction({ authority: operator.address, payer: operator.address, recentSlot });
    await sendNow([operator], [created.instruction]);
    await sendNow(
      [operator],
      [
        extendLookupTableInstruction({
          table: created.address,
          authority: operator.address,
          payer: operator.address,
          addresses: [nonce.account],
        }),
      ],
    );
    await waitForSlot((await slotNow()) + 2n);
    const msg = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(wallet.address, m),
      (m) =>
        appendTransactionMessageInstructions(
          [systemTransferInstruction({ from: wallet.address, to: operator.address, lamports: 1_000_000n })],
          m,
        ),
      (m) =>
        setTransactionMessageLifetimeUsingDurableNonce(
          { nonce: nonce.value, nonceAccountAddress: nonce.account, nonceAuthorityAddress: wallet.address },
          m,
        ),
      (m) => compressTransactionMessageUsingAddressLookupTables(m, { [created.address]: [nonce.account] }),
    );
    const tx = await signTransaction([wallet.keyPair], compileTransaction(msg));
    const wire = { wireBase64: getBase64EncodedWireTransaction(tx), signature: getSignatureFromTransaction(tx), size: 0 };
    await expectRejected(wire);
    expect((await nonceOf(nonce.account)).value).toBe(nonce.value);
  }, 60_000);

  test.skipIf(!SLOW)(
    "operator table lifecycle: deactivate, refuse to close during the cooldown, close after it",
    async () => {
      await sendNow([operator], [deactivateLookupTableInstruction({ table: tableAddress, authority: operator.address })]);
      const state = (await fetchLookupTables(v.rpc, [tableAddress]))[tableAddress];
      expect(lookupTableStatus(state as never, await slotNow())).toBe("deactivating");
      const close = closeLookupTableInstruction({ table: tableAddress, authority: operator.address, recipient: operator.address });
      const { value: bh } = await v.rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
      const early = await signTransaction(
        [operator.keyPair],
        compileTransaction(
          pipe(
            createTransactionMessage({ version: 0 }),
            (m) => setTransactionMessageFeePayer(operator.address, m),
            (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
            (m) => appendTransactionMessageInstructions([close], m),
          ),
        ),
      );
      const sim = await v.rpc.simulateTransaction(getBase64EncodedWireTransaction(early), { encoding: "base64" }).send();
      expect(sim.value.err).not.toBeNull();
      await waitForSlot((state?.deactivationSlot ?? 0n) + BigInt(LOOKUP_TABLE_DEACTIVATION_COOLDOWN_SLOTS) + 2n);
      const before = await balance(operator.address);
      await sendNow([operator], [close]);
      expect((await fetchLookupTables(v.rpc, [tableAddress]))[tableAddress]).toBeNull();
      expect(await balance(operator.address)).toBeGreaterThan(before);
    },
    180_000,
  );
});
