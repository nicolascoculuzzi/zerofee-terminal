import { describe, expect, test } from "bun:test";
import { isCommonPassphrase, passphraseChecks } from "./password";

describe("passphrase checklist", () => {
  test("flags the passphrases attackers try first", () => {
    for (const pw of [
      "password",
      "Password2024!",
      "solana123",
      "qwertyuiop",
      "123456789012",
      "aaaaaaaaaaaa",
      "passwordpassword",
      "abcabcabcabc",
    ]) {
      expect(isCommonPassphrase(pw)).toBe(true);
    }
  });

  test("accepts ordinary long passphrases", () => {
    for (const pw of ["correct horse battery staple", "violet-ledger-87-tundra", "My dog eats bread at 9"]) {
      expect(isCommonPassphrase(pw)).toBe(false);
    }
  });

  test("the checklist turns on as rules are met", () => {
    expect(passphraseChecks("").map((c) => c.met)).toEqual([false, false]);
    expect(passphraseChecks("short").map((c) => c.met)).toEqual([false, true]);
    expect(passphraseChecks("Password2024!").map((c) => c.met)).toEqual([true, false]);
    expect(passphraseChecks("violet-ledger-87-tundra").map((c) => c.met)).toEqual([true, true]);
  });
});
