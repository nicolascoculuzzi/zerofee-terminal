import { describe, expect, test } from "bun:test";
import {
  createSignInInput,
  createSignInMessage,
  createSignInMessageText,
  parseRfc3339,
  parseSignInMessageText,
  SIWS_MAX_EXPIRATION_MS,
  type SignInMessageFields,
} from "../src";
import { NOW } from "./helpers";

// Any valid base58 32-byte address works for format tests (this one is a public Jito tip account).
const ADDRESS = "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5";

const FULL: SignInMessageFields = {
  domain: "zerofee.example",
  address: ADDRESS,
  statement: "Sign in to zerofee-terminal.",
  uri: "https://zerofee.example",
  version: "1",
  chainId: "mainnet",
  nonce: "a1b2c3d4e5f60718",
  issuedAt: "2026-10-03T12:00:00.000Z",
  expirationTime: "2026-10-03T12:10:00.000Z",
  notBefore: "2026-10-03T11:59:00.000Z",
  requestId: "req-1",
  resources: ["https://zerofee.example/terms", "ipfs://bafy"],
};

// Hand-written from the SIWS format (Phantom spec / @solana/wallet-standard-util).
const FULL_TEXT = [
  "zerofee.example wants you to sign in with your Solana account:",
  ADDRESS,
  "",
  "Sign in to zerofee-terminal.",
  "",
  "URI: https://zerofee.example",
  "Version: 1",
  "Chain ID: mainnet",
  "Nonce: a1b2c3d4e5f60718",
  "Issued At: 2026-10-03T12:00:00.000Z",
  "Expiration Time: 2026-10-03T12:10:00.000Z",
  "Not Before: 2026-10-03T11:59:00.000Z",
  "Request ID: req-1",
  "Resources:",
  "- https://zerofee.example/terms",
  "- ipfs://bafy",
].join("\n");

describe("SIWS message text", () => {
  test("renders the reference format exactly", () => {
    expect(createSignInMessageText(FULL)).toBe(FULL_TEXT);
    expect(new TextDecoder().decode(createSignInMessage(FULL))).toBe(FULL_TEXT);
  });

  test("parses back to the same fields", () => {
    const parsed = parseSignInMessageText(FULL_TEXT);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.message).toEqual(FULL);
  });

  test("round-trips minimal and partial messages", () => {
    const variants: SignInMessageFields[] = [
      { domain: "zerofee.example", address: ADDRESS },
      { domain: "zerofee.example", address: ADDRESS, statement: "Hello" },
      { domain: "localhost:5173", address: ADDRESS, nonce: "abcdefgh12" },
      { domain: "zerofee.example", address: ADDRESS, statement: "Hi", resources: [] },
    ];
    for (const fields of variants) {
      const text = createSignInMessageText(fields);
      const parsed = parseSignInMessageText(text);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.message).toEqual(fields);
    }
  });

  test("rejects non-canonical or ambiguous text", () => {
    const bad: Record<string, string> = {
      crlf: FULL_TEXT.replaceAll("\n", "\r\n"),
      trailingNewline: `${FULL_TEXT}\n`,
      extraBlank: FULL_TEXT.replace("\n\nURI:", "\n\n\nURI:"),
      duplicateField: FULL_TEXT.replace("Version: 1", "Version: 1\nVersion: 1"),
      outOfOrder: FULL_TEXT.replace("URI: https://zerofee.example\nVersion: 1", "Version: 1\nURI: https://zerofee.example"),
      unknownLine: FULL_TEXT.replace("Version: 1", "Version: 1\nFoo: bar"),
      missingHeader: FULL_TEXT.replace(" wants you to sign in with your Solana account:", " wants you to sign in:"),
      emptyDomain: FULL_TEXT.replace("zerofee.example wants", " wants"),
      badTimestamp: FULL_TEXT.replace("2026-10-03T12:10:00.000Z", "tomorrow"),
      badAddress: FULL_TEXT.replace(ADDRESS, "not-an-address"),
      nullByte: FULL_TEXT.replace("req-1", "req\u00001"),
      afterResources: `${FULL_TEXT}\nVersion: 1`,
    };
    for (const [name, text] of Object.entries(bad)) {
      const parsed = parseSignInMessageText(text);
      expect({ name, ok: parsed.ok }).toEqual({ name, ok: false });
    }
  });

  test("builder refuses fields that would render ambiguously", () => {
    const base = { domain: "zerofee.example", address: ADDRESS };
    expect(() => createSignInMessageText({ ...base, statement: "line1\nURI: https://evil" })).toThrow();
    expect(() => createSignInMessageText({ ...base, statement: "URI: https://evil" })).toThrow();
    expect(() => createSignInMessageText({ ...base, statement: "" })).toThrow();
    expect(() => createSignInMessageText({ ...base, domain: "evil.example/path" })).toThrow();
    expect(() => createSignInMessageText({ ...base, domain: "has space" })).toThrow();
    expect(() => createSignInMessageText({ ...base, nonce: "short" })).toThrow();
    expect(() => createSignInMessageText({ ...base, address: "xyz" })).toThrow();
    expect(() => createSignInMessageText({ ...base, resources: ["a\nb"] })).toThrow();
  });
});

describe("createSignInInput", () => {
  test("fills version, mainnet chain and a 10 minute expiry", () => {
    const input = createSignInInput({
      domain: "zerofee.example",
      nonce: "0123456789abcdef",
      uri: "https://zerofee.example",
      now: () => NOW,
    });
    expect(input.version).toBe("1");
    expect(input.chainId).toBe("mainnet");
    expect(input.issuedAt).toBe("2026-10-03T12:00:00.000Z");
    expect(input.expirationTime).toBe("2026-10-03T12:10:00.000Z");
    expect(input.address).toBeUndefined();
  });

  test("refuses expiries beyond 10 minutes and bad input", () => {
    const base = { domain: "zerofee.example", nonce: "0123456789abcdef", uri: "https://zerofee.example", now: () => NOW };
    expect(() => createSignInInput({ ...base, expiresInMs: SIWS_MAX_EXPIRATION_MS + 1 })).toThrow();
    expect(() => createSignInInput({ ...base, expiresInMs: 0 })).toThrow();
    expect(() => createSignInInput({ ...base, uri: "javascript:alert(1)" })).toThrow();
    expect(() => createSignInInput({ ...base, nonce: "bad nonce!" })).toThrow();
  });
});

describe("parseRfc3339", () => {
  test("parses UTC and offsets, rejects junk", () => {
    expect(parseRfc3339("2026-10-03T12:00:00.000Z")).toBe(NOW);
    expect(parseRfc3339("2026-10-03T12:00:00Z")).toBe(NOW);
    expect(parseRfc3339("2026-10-03T14:00:00+02:00")).toBe(NOW);
    expect(parseRfc3339("2026-10-03T12:00:00.123456789Z")).toBe(NOW + 123);
    expect(parseRfc3339("2026-02-30T00:00:00Z")).toBeUndefined();
    expect(parseRfc3339("2026-10-03 12:00:00Z")).toBeUndefined();
    expect(parseRfc3339("2026-10-03T12:00:00")).toBeUndefined();
    expect(parseRfc3339("0050-01-01T00:00:00Z")).toBeUndefined();
  });
});
