import { describe, expect, test } from "bun:test";
import {
  createSignInInput,
  createSignInMessage,
  InMemoryNonceStore,
  issueNonce,
  type SignInExpectations,
  type SignInMessageFields,
  type SolanaSignInOutput,
  toRfc3339,
  toSignInOutput,
  verifySignIn,
} from "../src";
import { NOW, type TestSigner, throwawaySigner } from "./helpers";

const DOMAIN = "zerofee.example";
const URI = "https://zerofee.example";

interface Flow {
  signer: TestSigner;
  store: InMemoryNonceStore;
  nonce: string;
  fields: SignInMessageFields;
  expectations: SignInExpectations;
}

/** Server issues a nonce and input; the "wallet" renders and signs the message. */
async function setup(): Promise<Flow> {
  const signer = await throwawaySigner();
  const store = new InMemoryNonceStore({ now: () => NOW });
  const nonce = await issueNonce(store);
  const input = createSignInInput({ domain: DOMAIN, uri: URI, nonce, now: () => NOW });
  const fields: SignInMessageFields = { ...input, domain: DOMAIN, address: signer.address };
  return { signer, store, nonce, fields, expectations: { domain: DOMAIN, uri: URI, nonceStore: store, now: NOW + 30_000 } };
}

async function signFields(signer: TestSigner, fields: SignInMessageFields): Promise<SolanaSignInOutput> {
  const signedMessage = createSignInMessage(fields);
  return toSignInOutput({
    address: signer.address,
    publicKey: signer.publicKey,
    signedMessage,
    signature: await signer.sign(signedMessage),
  });
}

/** Signs arbitrary text (to model a wallet or attacker producing messages our builder would refuse). */
async function signText(signer: TestSigner, text: string): Promise<SolanaSignInOutput> {
  const signedMessage = new TextEncoder().encode(text);
  return toSignInOutput({
    address: signer.address,
    publicKey: signer.publicKey,
    signedMessage,
    signature: await signer.sign(signedMessage),
  });
}

describe("verifySignIn", () => {
  test("valid flow passes and returns the address", async () => {
    const f = await setup();
    const result = await verifySignIn(await signFields(f.signer, f.fields), f.expectations);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.address).toBe(f.signer.address);
      expect(result.message.nonce).toBe(f.nonce);
    }
  });

  test("signMessage fallback uses the same text and the same verifier", async () => {
    const f = await setup();
    // The wallet's signMessage returns { signedMessage, signature }; the client wraps it.
    const message = createSignInMessage(f.fields);
    const signature = await f.signer.sign(message);
    const output = toSignInOutput({ address: f.signer.address, publicKey: f.signer.publicKey, signedMessage: message, signature });
    expect((await verifySignIn(output, f.expectations)).ok).toBe(true);
  });

  test("tampered message fails", async () => {
    const f = await setup();
    const output = await signFields(f.signer, f.fields);
    const tampered = new Uint8Array(output.signedMessage);
    const at = new TextDecoder().decode(tampered).indexOf("Chain ID: mainnet") + "Chain ID: ".length;
    tampered[at] = "d".charCodeAt(0); // mainnet -> dainnet
    const result = await verifySignIn({ ...output, signedMessage: tampered }, f.expectations);
    expect(result).toMatchObject({ ok: false, reason: "invalid_signature" });
  });

  test("wrong signature fails", async () => {
    const f = await setup();
    const output = await signFields(f.signer, f.fields);
    const other = await throwawaySigner();
    const wrong = await other.sign(output.signedMessage);
    expect(await verifySignIn({ ...output, signature: wrong }, f.expectations)).toMatchObject({ ok: false, reason: "invalid_signature" });
    expect(await verifySignIn({ ...output, signature: new Uint8Array(64) }, f.expectations)).toMatchObject({
      ok: false,
      reason: "invalid_signature",
    });
    expect(await verifySignIn({ ...output, signature: new Uint8Array(63) }, f.expectations)).toMatchObject({
      ok: false,
      reason: "malformed_output",
    });
  });

  test("wrong domain fails (phishing clone)", async () => {
    const f = await setup();
    const clone = await signFields(f.signer, { ...f.fields, domain: "zer0fee.example" });
    expect(await verifySignIn(clone, f.expectations)).toMatchObject({ ok: false, reason: "domain_mismatch" });
    // A message for our domain checked against another expected domain fails too.
    const ours = await signFields(f.signer, f.fields);
    expect(await verifySignIn(ours, { ...f.expectations, domain: "other.example" })).toMatchObject({
      ok: false,
      reason: "domain_mismatch",
    });
  });

  test("wrong address fails", async () => {
    const f = await setup();
    const victim = await throwawaySigner();
    // Signed by f.signer but claims victim's address in the text.
    const claimsVictim = await signFields(f.signer, { ...f.fields, address: victim.address });
    expect(await verifySignIn(claimsVictim, f.expectations)).toMatchObject({ ok: false, reason: "address_mismatch" });
    // Output claims the victim account while the signature is f.signer's.
    const output = await signFields(f.signer, f.fields);
    const spoofed = { ...output, account: { address: victim.address, publicKey: victim.publicKey } };
    expect(await verifySignIn(spoofed, f.expectations)).toMatchObject({ ok: false, reason: "invalid_signature" });
    // Output whose publicKey and address disagree.
    const inconsistent = { ...output, account: { address: victim.address, publicKey: f.signer.publicKey } };
    expect(await verifySignIn(inconsistent, f.expectations)).toMatchObject({ ok: false, reason: "account_mismatch" });
  });

  test("replayed nonce fails", async () => {
    const f = await setup();
    const output = await signFields(f.signer, f.fields);
    expect((await verifySignIn(output, f.expectations)).ok).toBe(true);
    expect(await verifySignIn(output, f.expectations)).toMatchObject({ ok: false, reason: "nonce_invalid" });
  });

  test("unknown nonce fails", async () => {
    const f = await setup();
    const output = await signFields(f.signer, { ...f.fields, nonce: "ffffffffffffffffffffffffffffffff" });
    expect(await verifySignIn(output, f.expectations)).toMatchObject({ ok: false, reason: "nonce_invalid" });
  });

  test("expired message fails", async () => {
    const f = await setup();
    const output = await signFields(f.signer, f.fields);
    const result = await verifySignIn(output, { ...f.expectations, now: NOW + 10 * 60 * 1000 + 1, maxAgeMs: 60 * 60 * 1000 });
    expect(result).toMatchObject({ ok: false, reason: "expired" });
  });

  test("missing expiration fails", async () => {
    const f = await setup();
    const { expirationTime: _drop, ...rest } = f.fields;
    const output = await signFields(f.signer, rest);
    expect(await verifySignIn(output, f.expectations)).toMatchObject({ ok: false, reason: "missing_expiration" });
  });

  test("far-future expiration fails", async () => {
    const f = await setup();
    const output = await signFields(f.signer, { ...f.fields, expirationTime: toRfc3339(NOW + 60 * 60 * 1000) });
    expect(await verifySignIn(output, f.expectations)).toMatchObject({ ok: false, reason: "expiration_too_far" });
    const justOver = await signFields(f.signer, { ...f.fields, expirationTime: toRfc3339(NOW + 10 * 60 * 1000 + 1) });
    expect(await verifySignIn(justOver, f.expectations)).toMatchObject({ ok: false, reason: "expiration_too_far" });
  });

  test("issuedAt outside the clock-skew window fails", async () => {
    const f = await setup();
    const future = await signFields(f.signer, {
      ...f.fields,
      issuedAt: toRfc3339(NOW + 5 * 60 * 1000),
      expirationTime: toRfc3339(NOW + 6 * 60 * 1000),
    });
    expect(await verifySignIn(future, f.expectations)).toMatchObject({ ok: false, reason: "issued_at_out_of_range" });
    const old = await signFields(f.signer, f.fields);
    expect(await verifySignIn(old, { ...f.expectations, now: NOW + 9 * 60 * 1000, maxAgeMs: 60_000 })).toMatchObject({
      ok: false,
      reason: "issued_at_out_of_range",
    });
  });

  test("wrong chain, version, uri and notBefore fail", async () => {
    const f = await setup();
    const cases: [Partial<SignInMessageFields>, string][] = [
      [{ chainId: "devnet" }, "chain_mismatch"],
      [{ version: "2" }, "version_mismatch"],
      [{ uri: "https://evil.example" }, "uri_mismatch"],
      [{ notBefore: toRfc3339(NOW + 5 * 60 * 1000) }, "not_yet_valid"],
    ];
    for (const [patch, reason] of cases) {
      const output = await signFields(f.signer, { ...f.fields, ...patch });
      expect(await verifySignIn(output, f.expectations)).toMatchObject({ ok: false, reason });
    }
  });

  test("failed checks do not burn the nonce; non-canonical text is refused", async () => {
    const f = await setup();
    const wrongDomain = await signFields(f.signer, { ...f.fields, domain: "zer0fee.example" });
    expect((await verifySignIn(wrongDomain, f.expectations)).ok).toBe(false);
    // Same nonce still works for the genuine message afterwards.
    const crlf = await signText(f.signer, new TextDecoder().decode(createSignInMessage(f.fields)).replaceAll("\n", "\r\n"));
    expect(await verifySignIn(crlf, f.expectations)).toMatchObject({ ok: false, reason: "malformed_message" });
    expect((await verifySignIn(await signFields(f.signer, f.fields), f.expectations)).ok).toBe(true);
  });

  test("invalid UTF-8 and unsupported signature types fail", async () => {
    const f = await setup();
    const bytes = new Uint8Array([0xff, 0xfe, 0x00]);
    const badUtf8 = toSignInOutput({
      address: f.signer.address,
      publicKey: f.signer.publicKey,
      signedMessage: bytes,
      signature: await f.signer.sign(bytes),
    });
    expect(await verifySignIn(badUtf8, f.expectations)).toMatchObject({ ok: false, reason: "invalid_message_encoding" });
    const output = await signFields(f.signer, f.fields);
    expect(await verifySignIn({ ...output, signatureType: "secp256k1" as "ed25519" }, f.expectations)).toMatchObject({
      ok: false,
      reason: "unsupported_signature_type",
    });
  });
});
