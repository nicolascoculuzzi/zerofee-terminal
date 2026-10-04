/** On-chain metadata decoders against real mainnet accounts (test/fixtures/metadata-accounts.json). */
import { describe, expect, test } from "bun:test";
import { address, getBase64Encoder } from "@solana/kit";
import {
  decodeBondingCurve,
  decodeMetaplexMetadata,
  decodeMint,
  decodeMintExtensions,
  decodePool,
  metaplexMetadataPda,
  TOKEN_2022_EXTENSIONS,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "../src";
import snap from "./fixtures/metadata-accounts.json";

const b64 = getBase64Encoder();
function acc(a: string) {
  const x = (snap.accounts as Record<string, { owner: string; data: string }>)[a];
  if (!x) throw new Error(`fixture ${a} missing`);
  return { owner: address(x.owner), data: new Uint8Array(b64.encode(x.data)) };
}

describe("token metadata", () => {
  test("create_v2 mint: Token-2022 TokenMetadata extension carries name / symbol / uri, no dangers", () => {
    const m = acc(snap.v2Mint);
    expect(m.owner).toBe(TOKEN_2022_PROGRAM_ID);
    expect(decodeMint(m.data, m.owner)).toMatchObject({ decimals: 6, supply: 1_000_000_000_000_000n });
    const ext = decodeMintExtensions(m.data);
    expect(ext.types).toContain(TOKEN_2022_EXTENSIONS.tokenMetadata);
    expect(ext.metadata).toMatchObject({
      name: "SPECTRE",
      symbol: "SPEC",
      uri: "https://ipfs.io/ipfs/Qme95r8YzjeMNFeE8UTE6LRr3ZQRSHrktTYi97hPbNPjNF",
    });
    expect(ext.dangers).toEqual([]);
  });

  test("legacy mint: no extensions; Metaplex metadata PDA has the metadata", async () => {
    const m = acc(snap.legacyMint);
    expect(m.owner).toBe(TOKEN_PROGRAM_ID);
    expect(decodeMintExtensions(m.data)).toEqual({ types: [], metadata: null, dangers: [] });
    const md = acc(await metaplexMetadataPda(address(snap.legacyMint)));
    expect(decodeMetaplexMetadata(md.data)).toMatchObject({
      name: "Talune",
      symbol: "TALUN",
      uri: "https://ipfs.io/ipfs/bafkreifmkbmzfr7ugex7k3f3wrtoz6fvpr5ehlwpdbwak4azqweajtqic4",
    });
  });

  test("danger flags are read from the TLV entries", () => {
    // synthetic mint: base 165 bytes, account type 1, then PermanentDelegate(12) and DefaultAccountState(6)=frozen
    const tlv = (type: number, value: number[]) => [type & 0xff, type >> 8, value.length & 0xff, value.length >> 8, ...value];
    const data = new Uint8Array([
      ...new Array(165).fill(0),
      1,
      ...tlv(12, new Array(32).fill(7)),
      ...tlv(6, [2]),
      ...tlv(26, new Array(33).fill(0)),
    ]);
    expect(decodeMintExtensions(data).dangers).toEqual(["permanentDelegate", "frozenByDefault", "pausable"]);
  });

  test("pool and curve fixtures decode (used by the server's resolver tests)", () => {
    const pool = decodePool(acc(snap.pool).data);
    expect(pool.baseMint).toBe(address(snap.poolBaseMint));
    const curve = decodeBondingCurve(acc(snap.v2Curve).data);
    expect(curve.tokenTotalSupply).toBe(1_000_000_000_000_000n);
  });
});
