/**
 * Jupiter v6's IDL, read from the program's own on-chain Anchor IDL account (Jupiter publishes no IDL
 * repo; jup-ag/jupiter-cpi's idl.json stopped at 2024-01 and lacks every *_v2 route). The account is
 * createWithSeed(base = PDA([], program), seed "anchor:idl", owner = program); its data is
 * discriminator (8) + authority (32) + u32 length + zlib-deflated JSON.
 *
 *   bun run packages/core/scripts/jupiter-idl.ts            # compare idl/jupiter.json with the chain
 *   bun run packages/core/scripts/jupiter-idl.ts --update   # refresh idl/jupiter.json and idl/JUPITER_SOURCE.json
 *
 * check-pump-idl.ts (the daily interface watch) runs the comparison too.
 */

import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { type Address, createAddressWithSeed, getProgramDerivedAddress } from "@solana/kit";
import { DEFAULT_RPC_URL, JUPITER_PROGRAM_ID } from "../src/constants";

export interface JupiterIdlSnapshot {
  idlAccount: Address;
  slot: number;
  /** The inflated JSON exactly as stored on chain. */
  bytes: Uint8Array;
  sha256: string;
}

export interface JupiterSource {
  note: string;
  program: string;
  idlAccount: string;
  fetchedAt: string;
  slot: number;
  sha256: string;
  [key: string]: unknown;
}

export const JUPITER_SOURCE_PATH = join(import.meta.dir, "..", "idl", "JUPITER_SOURCE.json");
export const JUPITER_IDL_PATH = join(import.meta.dir, "..", "idl", "jupiter.json");

const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

export async function jupiterIdlAccount(program: Address = JUPITER_PROGRAM_ID): Promise<Address> {
  const [base] = await getProgramDerivedAddress({ programAddress: program, seeds: [] });
  return createAddressWithSeed({ baseAddress: base, programAddress: program, seed: "anchor:idl" });
}

export async function fetchJupiterIdl(rpcUrl = process.env.RPC_URL?.trim() || DEFAULT_RPC_URL): Promise<JupiterIdlSnapshot> {
  const idlAccount = await jupiterIdlAccount();
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [idlAccount, { encoding: "base64" }] }),
  });
  if (!res.ok) throw new Error(`getAccountInfo ${idlAccount}: HTTP ${res.status}`);
  const body = (await res.json()) as {
    result?: { context: { slot: number }; value: { owner: string; data: [string, string] } | null };
    error?: { message: string };
  };
  const value = body.result?.value;
  if (!value) throw new Error(`Jupiter IDL account ${idlAccount} not found (${body.error?.message ?? "null"})`);
  if (value.owner !== JUPITER_PROGRAM_ID) throw new Error(`IDL account owner ${value.owner} is not ${JUPITER_PROGRAM_ID}`);
  const data = Buffer.from(value.data[0], "base64");
  const length = data.readUInt32LE(40);
  const bytes = new Uint8Array(inflateSync(data.subarray(44, 44 + length)));
  const idl = JSON.parse(new TextDecoder().decode(bytes)) as { address?: string };
  if (idl.address !== JUPITER_PROGRAM_ID) throw new Error(`on-chain IDL names program ${idl.address}`);
  return { idlAccount, slot: body.result!.context.slot, bytes, sha256: sha256(bytes) };
}

export async function readJupiterSource(): Promise<JupiterSource> {
  return (await Bun.file(JUPITER_SOURCE_PATH).json()) as JupiterSource;
}

/** Writes idl/jupiter.json and the pin (other keys of JUPITER_SOURCE.json are kept). */
export async function writeJupiterIdl(snapshot: JupiterIdlSnapshot): Promise<void> {
  const source = await readJupiterSource();
  await Bun.write(JUPITER_IDL_PATH, snapshot.bytes);
  await Bun.write(
    JUPITER_SOURCE_PATH,
    `${JSON.stringify({ ...source, idlAccount: snapshot.idlAccount, fetchedAt: new Date().toISOString(), slot: snapshot.slot, sha256: snapshot.sha256 }, null, 2)}\n`,
  );
}

if (import.meta.main) {
  const snapshot = await fetchJupiterIdl();
  const source = await readJupiterSource();
  const local = sha256(new Uint8Array(await Bun.file(JUPITER_IDL_PATH).arrayBuffer()));
  console.log(`on-chain IDL ${snapshot.idlAccount} at slot ${snapshot.slot}: sha256 ${snapshot.sha256}`);
  console.log(`vendored idl/jupiter.json: sha256 ${local} (pin ${source.sha256})`);
  if (process.argv.includes("--update")) {
    await writeJupiterIdl(snapshot);
    console.log("updated idl/jupiter.json and idl/JUPITER_SOURCE.json");
  } else if (snapshot.sha256 !== source.sha256 || local !== source.sha256) {
    console.log("DRIFT: the Jupiter IDL changed; update the signer's route decoder (packages/signer/src/firewall/rules/jupiter-idl.ts)");
    process.exit(1);
  }
}
