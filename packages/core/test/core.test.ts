import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { address } from "@solana/kit";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import {
  ammFeeConfigPda,
  ammGlobalConfigPda,
  bondingCurvePda,
  canonicalPoolPda,
  findAssociatedTokenAddress,
  formatUnits,
  PUMP_AMM_FEE_CONFIG,
  PUMP_AMM_GLOBAL_CONFIG,
  PUMP_FEE_CONFIG,
  PUMP_GLOBAL,
  parseUiAmount,
  pumpFeeConfigPda,
  pumpGlobalPda,
  Reader,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
} from "../src";

describe("isomorphic core: no Node-only APIs in packages/core/src", () => {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) files.push(p);
    }
  };
  walk(join(import.meta.dir, "../src"));

  test.each([
    [/from\s+["']node:/, "node: imports"],
    [/from\s+["'](fs|path|crypto|os|child_process|net|http|https|buffer)["']/, "node builtins"],
    [/\bBuffer\b/, "Buffer"],
    [/\bprocess\./, "process"],
    [/\brequire\(/, "require"],
    [/@solana\/web3\.js|@coral-xyz\/anchor|@pump-fun\//, "web3.js v1 / anchor / pump SDK"],
  ])("%p (%s)", (re) => {
    const offenders = files.filter((f) => re.test(readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")));
    expect(offenders).toEqual([]);
  });
});

describe("PDAs and ATAs", () => {
  test("well-known PDAs derive to the documented addresses", async () => {
    expect(await pumpGlobalPda()).toBe(PUMP_GLOBAL);
    expect(await pumpFeeConfigPda()).toBe(PUMP_FEE_CONFIG);
    expect(await ammGlobalConfigPda()).toBe(PUMP_AMM_GLOBAL_CONFIG);
    expect(await ammFeeConfigPda()).toBe(PUMP_AMM_FEE_CONFIG);
  });

  test("canonical pool PDA of a migrated coin matches the live pool (3nK1vwb8… -> DN5CZBVz…)", async () => {
    expect(await canonicalPoolPda(address("3nK1vwb8qWYtYVih5rfBz2FHTiVm35eLvmgjMTvkpump"))).toBe(
      address("DN5CZBVz9hv5upEmAvdBQ8TeCxXDL9NaHtsE6CJ4rgRM"),
    );
    expect(await bondingCurvePda(address("8iF53SDsUDd3WpcJ1XQcwFxHD36t2RVEBescHU56pump"))).toBe(
      address("2kZ7tEj2ajkHZZGQAiy3jPHu5A7YbcuiEhXvtsZPwBAD"),
    );
  });

  test("ATA derivation is Token / Token-2022 aware and matches spl-token", async () => {
    const owner = address("HpqMfMw5r9DT3qWMHup63YndJF6hsjGAcy9qkFGtdpq4");
    const mint = address("8iF53SDsUDd3WpcJ1XQcwFxHD36t2RVEBescHU56pump");
    for (const prog of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      const ref = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), true, new PublicKey(prog)).toBase58();
      expect(await findAssociatedTokenAddress(owner, mint, prog)).toBe(address(ref));
    }
    expect(await findAssociatedTokenAddress(owner, WSOL_MINT, TOKEN_PROGRAM_ID)).not.toBe(
      await findAssociatedTokenAddress(owner, WSOL_MINT, TOKEN_2022_PROGRAM_ID),
    );
  });
});

describe("bytes and units", () => {
  test("Reader zero-pads past the end (legacy short accounts)", () => {
    const r = new Reader(new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 7]));
    expect(r.u64()).toBe(1n);
    expect(r.u64()).toBe(7n);
    expect(r.bool()).toBe(false);
    expect(r.pubkey()).toBe(address("11111111111111111111111111111111"));
  });

  test("decimal parsing/formatting without floats", () => {
    expect(parseUiAmount("0.01", 9)).toBe(10_000_000n);
    expect(parseUiAmount("12", 6)).toBe(12_000_000n);
    expect(() => parseUiAmount("0.0000000001", 9)).toThrow();
    expect(() => parseUiAmount("-1", 9)).toThrow();
    expect(formatUnits(59_471_149n, 9)).toBe("0.059471149");
    expect(formatUnits(1_000_000n, 6)).toBe("1");
  });
});
