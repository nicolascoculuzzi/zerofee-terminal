/**
 * wallet:<address> feed: RPC balances + stored fills on subscribe, live fills from the ingest, balance
 * diffs after a fill and on the refresh timer; end to end through a signed-in socket.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@zerofee/core";
import type { Trade, WalletDelta } from "@zerofee/protocol";
import { diffBalances, WalletFeed } from "../src/wallets/feed";
import { addr, FakeCurve, synthTx, waitFor } from "./helpers";
import { Browser, startUserApp, TestSource, type UserTestEnv } from "./userHelpers";

const W = addr("feed-wallet");
const MINT = addr("feed-mint");

function trade(over: Partial<Trade> = {}): Trade {
  return {
    id: "s:0",
    signature: "s",
    slot: 10,
    txIndex: null,
    mint: MINT,
    venue: "pump",
    side: "buy",
    trader: W,
    quoteAmount: "100000000",
    tokenAmount: "5000000000",
    amountSol: 0.1,
    amountUsd: 12,
    priceSol: 0.00000002,
    mcSol: 20,
    blockTime: 1,
    receivedAt: 2,
    tags: [],
    ...over,
  };
}

/** A scripted RPC: lamports and token accounts per call, recorded. */
type FakeAccount = { account: string; mint: string; amount: string };

function fakeRpc() {
  const state = {
    lamports: 2_000_000_000n,
    legacy: [] as FakeAccount[],
    t22: [] as FakeAccount[],
  };
  const calls: string[] = [];
  return {
    state,
    calls,
    rpc: {
      async getMultipleAccounts(addresses: readonly string[]) {
        calls.push("getMultipleAccounts");
        return {
          slot: 5,
          accounts: addresses.map((a) => ({
            address: a,
            owner: "11111111111111111111111111111111",
            lamports: state.lamports,
            data: new Uint8Array(),
          })),
        } as never;
      },
      async getTokenAccountsByOwner(_owner: string, programId: string) {
        calls.push(`tokens:${programId === TOKEN_PROGRAM_ID ? "legacy" : "t22"}`);
        const list = programId === TOKEN_2022_PROGRAM_ID ? state.t22 : state.legacy;
        return { slot: 6, accounts: list.map((t) => ({ ...t, decimals: 6, tokenProgram: programId })) };
      },
    },
  };
}

describe("WalletFeed", () => {
  test("snapshot: RPC balances from both token programs plus stored fills; a fill goes out at once, balances follow", async () => {
    const r = fakeRpc();
    r.state.t22.push({ account: "Ata1", mint: MINT, amount: "5000000000" });
    const published: WalletDelta[] = [];
    let watched = true;
    const feed = new WalletFeed({
      rpc: r.rpc,
      history: (a, limit) => (a === W ? [trade({ id: "old:0" })].slice(0, limit) : []),
      watched: (a) => watched && a === W,
      watchedAll: () => (watched ? [W] : []),
      publish: (_a, d) => {
        published.push(d);
        return true;
      },
      refreshMs: 60_000,
      afterFillMs: 10,
    });
    const snap = await feed.snapshot(W);
    expect(snap).toMatchObject({ address: W, lamports: "2000000000", slot: 6 });
    expect(snap.tokens).toEqual([{ account: "Ata1", mint: MINT, amount: "5000000000", decimals: 6, tokenProgram: TOKEN_2022_PROGRAM_ID }]);
    expect(snap.fills.map((f) => f.id)).toEqual(["old:0"]);
    expect(r.calls.sort()).toEqual(["getMultipleAccounts", "tokens:legacy", "tokens:t22"]);

    // The wallet sells everything: the fill goes out immediately, the balance change a moment later.
    r.state.lamports = 2_100_000_000n;
    r.state.t22.length = 0;
    feed.onTrade(trade({ id: "new:0", side: "sell" }));
    expect(published[0]).toEqual({ fills: [expect.objectContaining({ id: "new:0" })], slot: 10 });
    await waitFor(() => published.length >= 2);
    expect(published[1]).toEqual({ lamports: "2100000000", closed: ["Ata1"], slot: 6 });

    // Nothing changed: no delta. Someone else's trade, or an unwatched wallet: ignored.
    await feed.refresh(W);
    feed.onTrade(trade({ trader: addr("someone") }));
    watched = false;
    feed.onTrade(trade());
    expect(published).toHaveLength(2);
    feed.stop();
  });

  test("diffBalances: changed amounts and new accounts are upserts, vanished accounts are closed", () => {
    const t = (account: string, amount: string) => ({ account, mint: MINT, amount, decimals: 6, tokenProgram: TOKEN_PROGRAM_ID });
    const prev = {
      slot: 1,
      lamports: "5",
      tokens: new Map([
        ["A", t("A", "1")],
        ["B", t("B", "2")],
      ]),
    };
    expect(diffBalances(prev, { ...prev, slot: 2 })).toBeNull();
    const next = {
      slot: 3,
      lamports: "5",
      tokens: new Map([
        ["A", t("A", "9")],
        ["C", t("C", "1")],
      ]),
    };
    expect(diffBalances(prev, next)).toEqual({ tokens: [t("A", "9"), t("C", "1")], closed: ["B"], slot: 3 });
  });
});

describe("wallet topic end to end", () => {
  let env: UserTestEnv;
  const source = new TestSource();
  const trading = addr("e2e-trading-wallet");
  const curve = new FakeCurve(addr("e2e-feed-mint"), addr("e2e-feed-dev"));
  let lamports = 1_500_000_000;

  beforeAll(async () => {
    env = await startUserApp({
      source,
      env: { WALLET_AFTER_FILL_MS: "20" },
      rpcRoute: (method, params) => {
        if (method === "getMultipleAccounts") {
          const list = (params[0] as string[]) ?? [];
          return {
            context: { slot: 77 },
            value: list.map((a) =>
              a === trading ? { owner: "11111111111111111111111111111111", lamports, data: ["", "base64"], executable: false } : null,
            ),
          };
        }
        return undefined;
      },
    });
  }, 60_000);
  afterAll(async () => {
    await env.close();
  });

  test("a registered trading wallet: snapshot over RPC, its own trades as fills, the balance after them", async () => {
    const b = new Browser(env);
    const { me } = await b.signIn();
    const userId = (await env.user.store.users.byWallet(me.wallet))?.id as string;
    await env.user.store.users.upsertTradingWallet(userId, trading, "trading", Date.now(), 25);
    const c = await b.socket();
    c.send({ type: "subscribe", topic: `wallet:${trading}` });
    const snap = await c.next((m) => m.type === "snapshot" && m.topic === `wallet:${trading}`);
    expect(snap.data).toMatchObject({ address: trading, lamports: "1500000000", tokens: [], fills: [] });

    const now = Math.floor(Date.now() / 1000);
    source.emit(synthTx(900_001, [curve.create(now), curve.buy(trading, 250_000_000n, now)]));
    const fill = await c.next((m) => m.type === "delta" && m.topic === `wallet:${trading}` && !!m.data.fills);
    expect(fill.seq).toBe((snap.seq ?? 0) + 1);
    expect(fill.data.fills[0]).toMatchObject({ trader: trading, side: "buy", mint: curve.mint });
    lamports = 1_249_000_000;
    const bal = await c.next((m) => m.type === "delta" && m.topic === `wallet:${trading}` && m.data.lamports !== undefined);
    expect(bal.data.lamports).toBe("1249000000");
    c.ws.close();
  });
});
