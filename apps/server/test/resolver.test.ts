/** AccountResolver against real mainnet accounts (packages/core/test/fixtures/metadata-accounts.json). */
import { describe, expect, test } from "bun:test";
import { TOKEN_2022_PROGRAM_ID, WSOL_MINT } from "@zerofee/core";
import snap from "../../../packages/core/test/fixtures/metadata-accounts.json";
import { AccountResolver, type MintResolved, type PoolInfo } from "../src/accounts/resolver";
import { RpcClient } from "../src/util/rpc";
import { mockFetch, waitFor } from "./helpers";

const ACCOUNTS = snap.accounts as Record<string, { owner: string; lamports: string; data: string }>;

function rpcWithFixtures(missing = new Set<string>()) {
  const m = mockFetch((_url, body) => {
    const addrs = (body?.params?.[0] as string[]) ?? [];
    return [
      200,
      {
        jsonrpc: "2.0",
        id: 1,
        result: {
          context: { slot: 5 },
          value: addrs.map((a) =>
            ACCOUNTS[a] && !missing.has(a)
              ? { owner: ACCOUNTS[a].owner, lamports: Number(ACCOUNTS[a].lamports), data: [ACCOUNTS[a].data, "base64"] }
              : null,
          ),
        },
      },
    ];
  });
  return { rpc: new RpcClient({ url: "http://rpc.test", fetchFn: m.fn }), calls: m.calls };
}

describe("account resolver", () => {
  test("a pool resolves to its base mint, vaults, canonical flag and decimals (pool + mint in two batches)", async () => {
    const { rpc, calls } = rpcWithFixtures();
    const pools: PoolInfo[] = [];
    const persisted: string[] = [];
    const r = new AccountResolver(rpc, {
      pool: (p) => pools.push(p),
      mint: () => {},
      curve: () => {},
      metaplex: () => {},
      persistPool: (p) => persisted.push(p.pool),
    });
    r.requestPool(snap.pool);
    await r.tick();
    await r.tick();
    expect(pools).toHaveLength(1);
    expect(pools[0]).toMatchObject({
      pool: snap.pool,
      baseMint: snap.poolBaseMint,
      quoteMint: WSOL_MINT,
      baseDecimals: 6,
      quoteDecimals: 9,
      baseTokenProgram: TOKEN_2022_PROGRAM_ID,
      isCanonical: true,
      fromAccount: true,
    });
    expect(pools[0]?.poolBaseTokenAccount).toBeTruthy();
    // The account size travels to the trade context (a short pool needs extend_account before a swap).
    expect(pools[0]?.dataLength).toBeGreaterThan(200);
    expect(AccountResolver.ready(pools[0])).toBe(true);
    expect(calls.every((c) => c.method === "getMultipleAccounts")).toBe(true);
    expect(persisted).toContain(snap.pool);
  });

  test("a Token-2022 mint yields decimals, supply and on-chain metadata; legacy mints fall through to Metaplex", async () => {
    const { rpc } = rpcWithFixtures();
    const mints: MintResolved[] = [];
    const metaplex: [string, string][] = [];
    const r = new AccountResolver(rpc, {
      pool: () => {},
      mint: (m) => mints.push(m),
      curve: () => {},
      metaplex: (mint, md) => metaplex.push([mint, md.symbol]),
    });
    r.requestMint(snap.v2Mint);
    r.requestMint(snap.legacyMint);
    await r.tick();
    // the mint handler queues the metaplex job after an async PDA derivation (no promise exposed)
    await waitFor(() => r.pending > 0);
    await r.tick();
    expect(mints.find((m) => m.mint === snap.v2Mint)).toMatchObject({ decimals: 6, metadata: { symbol: "SPEC" } });
    expect(mints.find((m) => m.mint === snap.legacyMint)?.metadata).toBeNull();
    expect(metaplex).toEqual([[snap.legacyMint, "TALUN"]]);
  });

  test("bonding curves of tokens first seen mid-life", async () => {
    const { rpc } = rpcWithFixtures();
    const curves: string[] = [];
    const r = new AccountResolver(rpc, {
      pool: () => {},
      mint: () => {},
      curve: (c) => curves.push(`${c.mint}:${c.curve.tokenTotalSupply}`),
      metaplex: () => {},
    });
    await r.requestCurve(snap.v2Mint);
    await r.tick();
    expect(curves).toEqual([`${snap.v2Mint}:1000000000000000`]);
  });

  test("missing accounts are retried, then given up on", async () => {
    const { rpc } = rpcWithFixtures(new Set([snap.pool]));
    const r = new AccountResolver(
      rpc,
      { pool: () => {}, mint: () => {}, curve: () => {}, metaplex: () => {} },
      { maxAttempts: 2, retryDelayMs: 0 },
    );
    r.requestPool(snap.pool);
    await r.tick();
    await r.tick();
    expect(r.stats.gaveUp).toBe(1);
    expect(r.pending).toBe(0);
    r.requestPool(snap.pool); // not re-queued
    expect(r.pending).toBe(0);
  });

  test("RPC rate limiting puts the resolver in cooldown", async () => {
    const m = mockFetch(() => [429, {}]);
    const rpc = new RpcClient({ url: "http://rpc.test", fetchFn: m.fn, cooldownMs: 60_000 });
    const r = new AccountResolver(rpc, { pool: () => {}, mint: () => {}, curve: () => {}, metaplex: () => {} });
    r.requestPool(snap.pool);
    await r.tick();
    expect(rpc.coolingDown()).toBe(true);
    await r.tick(); // skipped while cooling down
    expect(m.calls).toHaveLength(1);
  });
});
