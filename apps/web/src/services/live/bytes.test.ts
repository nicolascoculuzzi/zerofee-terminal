import { describe, expect, test } from "bun:test";
import { getBase58Decoder } from "@solana/kit";
import { fromBase64, toBase58, toBase64 } from "./bytes";

describe("bytes", () => {
  test("toBase58 matches @solana/kit on signatures, keys, leading zeros and empty input", () => {
    const kit = getBase58Decoder();
    const cases: Uint8Array[] = [new Uint8Array(0), new Uint8Array([0]), new Uint8Array([0, 0, 1, 2]), new Uint8Array(32).fill(255)];
    for (let n = 0; n < 50; n++) cases.push(crypto.getRandomValues(new Uint8Array(n % 2 ? 64 : 32)));
    for (const b of cases) expect(toBase58(b)).toBe(kit.decode(b));
  });

  test("base64 round trip", () => {
    const b = crypto.getRandomValues(new Uint8Array(1_000));
    expect(fromBase64(toBase64(b))).toEqual(b);
  });
});
