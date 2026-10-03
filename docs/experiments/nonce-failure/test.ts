// Devnet experiment: does a durable-nonce transaction that FAILS during execution still advance the nonce?
// Throwaway in-memory keypairs, devnet faucet SOL only (no real value). Nothing touches mainnet.
import {
  type Address,
  type Blockhash,
  address,
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessageLifetimeUsingDurableNonce,
  signTransactionMessageWithSigners,
  airdropFactory,
  type Signature,
} from "@solana/kit";
import {
  fetchNonce,
  getCreateAccountInstruction,
  getInitializeNonceAccountInstruction,
  getNonceSize,
  getTransferSolInstruction,
} from "@solana-program/system";

const rpc = createSolanaRpc(process.env.RPC_URL ?? "https://api.devnet.solana.com");
const rpcSubscriptions = createSolanaRpcSubscriptions(process.env.WS_URL ?? "wss://api.devnet.solana.com");
const SYSTEM = address("11111111111111111111111111111111");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitStatus(sig: Signature, timeoutMs = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const { value } = await rpc.getSignatureStatuses([sig], { searchTransactionHistory: true }).send();
    const s = value[0];
    if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) return s;
    await sleep(1000);
  }
  return null;
}

async function send(tx: Parameters<typeof getBase64EncodedWireTransaction>[0]) {
  const wire = getBase64EncodedWireTransaction(tx);
  const sig = await rpc.sendTransaction(wire, { encoding: "base64", skipPreflight: true }).send();
  return sig;
}
async function sendUntilLanded(tx: Parameters<typeof getBase64EncodedWireTransaction>[0], timeoutMs = 30_000) {
  const sig = getSignatureFromTransaction(tx);
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await send(tx).catch(() => {});
    const { value } = await rpc.getSignatureStatuses([sig], { searchTransactionHistory: true }).send();
    const st = value[0];
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return { sig, st };
    await sleep(1500);
  }
  return { sig, st: null };
}

const balance = async (a: Address) => (await rpc.getBalance(a, { commitment: "confirmed" }).send()).value;
const nonceValue = async (a: Address) => (await fetchNonce(rpc, a, { commitment: "confirmed" })).data.blockhash;

const payer = await generateKeyPairSigner();
const nonceAcct = await generateKeyPairSigner();
console.log("payer", payer.address, "nonce account", nonceAcct.address);

// 1) faucet
const airdrop = airdropFactory({ rpc, rpcSubscriptions });
let funded = false;
for (const amt of [1_000_000_000n, 500_000_000n, 200_000_000n]) {
  try {
    await airdrop({ recipientAddress: payer.address, lamports: lamports(amt), commitment: "confirmed" });
    funded = true;
    break;
  } catch (e) {
    console.log(`airdrop ${amt} failed: ${(e as Error).message.slice(0, 120)}`);
    await sleep(3000);
  }
}
if (!funded) {
  console.log("RESULT: could not get devnet SOL from the public faucet (rate limited). Experiment not run.");
  process.exit(2);
}
console.log("funded:", await balance(payer.address));

// 2) create + init nonce account
const space = BigInt(getNonceSize());
const rent = await rpc.getMinimumBalanceForRentExemption(space).send();
const { value: bh } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
const createMsg = pipe(
  createTransactionMessage({ version: 0 }),
  (m) => setTransactionMessageFeePayerSigner(payer, m),
  (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
  (m) =>
    appendTransactionMessageInstructions(
      [
        getCreateAccountInstruction({ payer, newAccount: nonceAcct, lamports: rent, space, programAddress: SYSTEM }),
        getInitializeNonceAccountInstruction({ nonceAccount: nonceAcct.address, nonceAuthority: payer.address }),
      ],
      m,
    ),
);
const createTx = await signTransactionMessageWithSigners(createMsg);
const { sig: createSig, st: cs } = await sendUntilLanded(createTx);
console.log("nonce account create:", createSig, cs ? (cs.err ? JSON.stringify(cs.err) : "landed ok") : "NOT LANDED", `(rent ${rent} lamports for ${space} bytes)`);
if (!cs || cs.err) process.exit(3);

// 3) case A: nonce tx whose second instruction fails at execution (transfer far more than the balance)
const nonce1 = await nonceValue(nonceAcct.address);
const b1 = await balance(payer.address);
const sink = (await generateKeyPairSigner()).address;
const failMsg = pipe(
  createTransactionMessage({ version: 0 }),
  (m) => setTransactionMessageFeePayerSigner(payer, m),
  (m) =>
    setTransactionMessageLifetimeUsingDurableNonce(
      { nonce: nonce1 as unknown as Blockhash as never, nonceAccountAddress: nonceAcct.address, nonceAuthorityAddress: payer.address },
      m,
    ),
  (m) => appendTransactionMessageInstructions([getTransferSolInstruction({ source: payer, destination: sink, amount: 1_000_000_000_000n })], m),
);
const failTx = await signTransactionMessageWithSigners(failMsg);
const failSig = getSignatureFromTransaction(failTx);
const { st: fs } = await sendUntilLanded(failTx);
const nonce2 = await nonceValue(nonceAcct.address);
const b2 = await balance(payer.address);
console.log("\nCASE A (execution failure):");
console.log("  signature     ", failSig);
console.log("  landed status ", fs ? JSON.stringify(fs.err, (_, v) => (typeof v === "bigint" ? v.toString() : v)) : "NOT LANDED");
console.log("  fee charged   ", (b1 - b2).toString(), "lamports");
console.log("  nonce before  ", nonce1);
console.log("  nonce after   ", nonce2);
console.log("  NONCE ADVANCED ON FAILURE:", nonce1 !== nonce2 ? "YES" : "NO");

// 4) case B: replay the same signed failing tx — must not land again
await send(failTx).catch((e) => console.log("  replay send error:", (e as Error).message.slice(0, 120)));
await sleep(8000);
const b3 = await balance(payer.address);
console.log("\nCASE B (replay of the same signed tx): extra fee charged =", (b2 - b3).toString(), "lamports", b2 === b3 ? "(rejected, good)" : "(!!)");

// 5) case C: control — a successful nonce tx on the new nonce value
const okMsg = pipe(
  createTransactionMessage({ version: 0 }),
  (m) => setTransactionMessageFeePayerSigner(payer, m),
  (m) =>
    setTransactionMessageLifetimeUsingDurableNonce(
      { nonce: nonce2 as never, nonceAccountAddress: nonceAcct.address, nonceAuthorityAddress: payer.address },
      m,
    ),
  (m) => appendTransactionMessageInstructions([getTransferSolInstruction({ source: payer, destination: sink, amount: 1_000_000n })], m),
);
const okTx = await signTransactionMessageWithSigners(okMsg);
const okSig = getSignatureFromTransaction(okTx);
const { st: oks } = await sendUntilLanded(okTx);
const nonce3 = await nonceValue(nonceAcct.address);
console.log("\nCASE C (control, successful nonce tx):", oks ? (oks.err ? JSON.stringify(oks.err) : "ok") : "NOT LANDED", "| nonce advanced:", nonce2 !== nonce3 ? "YES" : "NO");
process.exit(0);
