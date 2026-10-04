import { describe, expect, test } from "bun:test";
import { encodeQr, type QrCode, qrPath } from "./qr";

/** Reads the 15 format bits from the copy next to the top-left finder, most significant first. */
function formatBits(code: QrCode): string {
  const at = (x: number, y: number) => (code.modules[y]?.[x] ? "1" : "0");
  const bits: string[] = [];
  for (let i = 0; i <= 5; i++) bits[i] = at(8, i);
  bits[6] = at(8, 7);
  bits[7] = at(8, 8);
  bits[8] = at(7, 8);
  for (let i = 9; i < 15; i++) bits[i] = at(14 - i, 8);
  return bits.reverse().join("");
}

// ISO/IEC 18004 format information table (after masking with 101010000010010).
const FORMAT_TABLE = {
  M: [
    "101010000010010",
    "101000100100101",
    "101111001111100",
    "101101101001011",
    "100010111111001",
    "100000011001110",
    "100111110010111",
    "100101010100000",
  ],
  L: [
    "111011111000100",
    "111001011110011",
    "111110110101010",
    "111100010011101",
    "110011000101111",
    "110001100011000",
    "110110001000001",
    "110100101110110",
  ],
} as const;

describe("QR encoder", () => {
  test("format information matches the standard table for every mask", () => {
    for (const ecc of ["M", "L"] as const) {
      for (let mask = 0; mask < 8; mask++) {
        expect(formatBits(encodeQr("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", ecc, mask))).toBe(FORMAT_TABLE[ecc][mask]);
      }
    }
  });

  test("picks the smallest version for the byte-mode capacity", () => {
    expect(encodeQr("A").version).toBe(1);
    expect(encodeQr("x".repeat(14)).version).toBe(1);
    expect(encodeQr("x".repeat(15)).version).toBe(2);
    expect(encodeQr("x".repeat(42)).version).toBe(3);
    expect(encodeQr("x".repeat(43)).version).toBe(4);
    expect(encodeQr("x".repeat(44)).size).toBe(33); // a Solana address: version 4-M, 33 × 33
    expect(encodeQr("x".repeat(53), "L").version).toBe(3);
    expect(encodeQr("x".repeat(213)).version).toBe(10);
    expect(() => encodeQr("x".repeat(214))).toThrow();
  });

  test("draws the finder patterns and the dark module", () => {
    const code = encodeQr("HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH");
    const row = (y: number) =>
      (code.modules[y] ?? [])
        .slice(0, 7)
        .map((v) => (v ? 1 : 0))
        .join("");
    expect([row(0), row(1), row(2), row(3), row(6)]).toEqual(["1111111", "1000001", "1011101", "1011101", "1111111"]);
    expect(code.modules[code.size - 8]?.[8]).toBe(true);
    expect(qrPath(code).startsWith("M4,4h1v1h-1z")).toBe(true);
  });
});
