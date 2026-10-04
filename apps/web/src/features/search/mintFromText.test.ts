import { describe, expect, test } from "bun:test";
import { mintFromText } from "./mintFromText";

const MINT = "4ddZmkmhHJ2C6436znty5s3YpezEkEX6S1oebwhapump";
const PAIR = "5RxfsBsyA8t2Z1J21SkSq2gaNr8JvPFGPZBd8crXY9Ck";

describe("mintFromText", () => {
  test("a bare address, trimmed", () => {
    expect(mintFromText(`  ${MINT}\n`)).toBe(MINT);
  });

  test("terminal and explorer links", () => {
    expect(mintFromText(`https://pump.fun/coin/${MINT}`)).toBe(MINT);
    expect(mintFromText(`pump.fun/coin/${MINT}?include-nsfw=true`)).toBe(MINT);
    expect(mintFromText(`https://dexscreener.com/solana/${PAIR}`)).toBe(PAIR);
    expect(mintFromText(`https://axiom.trade/meme/${PAIR}?chain=sol`)).toBe(PAIR);
    expect(mintFromText(`https://gmgn.ai/sol/token/abcd1234_${MINT}`)).toBe(MINT);
    expect(mintFromText(`https://gmgn.ai/sol/token/${MINT}`)).toBe(MINT);
    expect(mintFromText(`https://solscan.io/token/${MINT}#holders`)).toBe(MINT);
    expect(mintFromText(`https://jup.ag/swap?sell=So11111111111111111111111111111111111111112&outputMint=${MINT}`)).toBe(MINT);
    expect(mintFromText(`https://photon-sol.tinyastro.io/en/lp/${PAIR}?handle=x`)).toBe(PAIR);
  });

  test("text that holds no address", () => {
    expect(mintFromText("")).toBeNull();
    expect(mintFromText("pepe")).toBeNull();
    expect(mintFromText("https://pump.fun/board")).toBeNull();
    expect(mintFromText("0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl")).toBeNull();
    expect(mintFromText(`not a link ${MINT}`)).toBeNull();
  });
});
