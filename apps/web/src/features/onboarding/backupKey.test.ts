import { describe, expect, test } from "bun:test";
import { base58Encode, keyGroups, pickPositions, simulatedSecretKey } from "./backupKey";

const enc = (s: string) => new TextEncoder().encode(s);

describe("backup key helpers", () => {
  test("base58 matches the reference vectors", () => {
    expect(base58Encode(new Uint8Array([]))).toBe("");
    expect(base58Encode(new Uint8Array([0]))).toBe("1");
    expect(base58Encode(new Uint8Array([0, 0, 0, 1]))).toBe("1112");
    expect(base58Encode(enc("Hello World!"))).toBe("2NEpo7TZRRrLZSi2U");
    expect(base58Encode(enc("The quick brown fox jumps over the lazy dog."))).toBe(
      "USm3fpXnKG5EUBx2ndxBDMPVciP5hGey2Jh4NDv6gmeo1LkMeiKrLJUUBk6Z",
    );
    expect(base58Encode(new Uint8Array(32))).toBe("11111111111111111111111111111111");
  });

  test("the stand-in key is stable and looks like a 64-byte secret", () => {
    const a = simulatedSecretKey("tw-1", "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
    expect(a).toBe(simulatedSecretKey("tw-1", "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"));
    expect(a).not.toBe(simulatedSecretKey("tw-2", "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"));
    expect(a.length).toBeGreaterThanOrEqual(86);
    expect(a.length).toBeLessThanOrEqual(88);
    expect(/^[1-9A-HJ-NP-Za-km-z]+$/.test(a)).toBe(true);
  });

  test("groups of four, positions spread out", () => {
    expect(keyGroups("abcdefghij")).toEqual(["abcd", "efgh", "ij"]);
    let i = 0;
    const seq = [0.05, 0.06, 0.2, 0.5];
    const pos = pickPositions(88, 3, () => seq[i++ % seq.length] ?? 0);
    expect(pos).toEqual([5, 18, 45]);
    expect(pickPositions(2)).toEqual([1, 2]);
  });
});
