import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TrackedWallet as ServerWallet } from "@zerofee/protocol";
import type { Trade } from "../../protocol";
import { useTrackers } from "../../state/trackers";
import { setApiFetch } from "./api";
import { MINT, TRADER, trackedRow, wireTrade } from "./fixtures";
import { LiveDataSource } from "./LiveDataSource";
import { type FakeSocket, ManualClock, socketFactory } from "./testkit";
import { TrackerSync } from "./trackerSync";

const A = "WhaLeAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const B = "BobBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const C = "CarolCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

function serverWallet(address: string, label: string): ServerWallet {
  return { address, label, emoji: "", tags: [], alerts: { buy: true, sell: true, create: false }, createdAt: 1, updatedAt: 1 };
}

describe("tracked wallets follow the server while signed in", () => {
  let calls: string[];
  let bodies: unknown[];
  let session: unknown;
  let listeners: (() => void)[];
  let sync: TrackerSync;

  beforeEach(() => {
    useTrackers.setState({ wallets: [{ address: B, name: "Bob", emoji: "", alerts: true, createdAt: 1 }] });
    calls = [];
    bodies = [];
    session = { address: "me" };
    listeners = [];
    sync = new TrackerSync({
      session: () => session,
      onSessionChange: (l) => {
        listeners.push(l);
        return () => {};
      },
      rest: async <T>(path: string, o: { method?: string; body?: unknown } = {}) => {
        calls.push(`${o.method ?? "GET"} ${path}`);
        if (o.body !== undefined) bodies.push(o.body);
        if (path === "/api/tracked-wallets" && !o.method) return [serverWallet(A, "Whale")] as T;
        return {} as T;
      },
    });
  });

  afterEach(() => {
    sync.stop();
    useTrackers.setState({ wallets: [] });
  });

  test("sign-in merges both lists; local edits are mirrored one call each; signed out nothing is sent", async () => {
    sync.start();
    await sync.idle();
    // The server's wallet joined the local list; the local one went up in one import.
    expect(
      useTrackers
        .getState()
        .wallets.map((w) => w.address)
        .sort(),
    ).toEqual([A, B].sort());
    expect(calls).toEqual(["GET /api/tracked-wallets", "POST /api/tracked-wallets/import"]);
    expect(bodies[0]).toEqual({ data: [{ address: B, name: "Bob", emoji: "" }], mode: "merge" });

    calls.length = 0;
    useTrackers.getState().addWallet({ address: C, name: "Carol", emoji: "C", alerts: false });
    await sync.idle();
    useTrackers.getState().updateWallet(B, { name: "Bobby" });
    await sync.idle();
    useTrackers.getState().removeWallet(A);
    await sync.idle();
    expect(calls).toEqual([`POST /api/tracked-wallets`, `PATCH /api/tracked-wallets/${B}`, `DELETE /api/tracked-wallets/${A}`]);

    calls.length = 0;
    session = null;
    for (const l of listeners) l();
    useTrackers.getState().removeWallet(C);
    await sync.idle();
    expect(calls).toEqual([]);
  });
});

describe("the tape carries the tracked wallets' older trades on the token", () => {
  let ds: LiveDataSource;
  let s: FakeSocket;

  beforeEach(() => {
    setApiFetch(async () => new Response("{}", { status: 404 }));
    const f = socketFactory();
    ds = new LiveDataSource({
      socket: { url: "ws://gw.test/ws", createSocket: f.create, clock: new ManualClock(), random: () => 1 },
      healthPollMs: 0,
    });
    s = f.last();
    s.open();
  });

  afterEach(() => {
    ds.close();
    setApiFetch(null);
  });

  test("tracked:<mint> rows outside the tape join it once; launches and duplicates do not", () => {
    let last: Trade[] = [];
    ds.subscribe(`trades:${MINT}`, (m) => {
      if (m.type === "snapshot") last = (m.data as { trades: Trade[] }).trades;
    });
    s.snapshot(`trades:${MINT}`, 1, { trades: [wireTrade({ id: "sig1:0", signature: "sig1", slot: 300_000_050 })] });
    expect(last).toHaveLength(1);
    s.snapshot(`tracked:${MINT}`, 1, {
      rows: [
        trackedRow({ id: "sig1:0:W", signature: "sig1", trader: TRADER, slot: 300_000_050 }), // already in the tape
        trackedRow({ id: "sigOld:0:W", signature: "sigOld", slot: 299_000_000 }),
        trackedRow({ id: "sigLaunch:0:W", signature: "sigLaunch", kind: "create", slot: 298_000_000 }),
      ],
    });
    expect(last.map((t) => t.signature)).toEqual(["sig1", "sigOld"]);
    // A dead slot drops the tracked row again.
    s.correction(`tracked:${MINT}`, 2, { remove: ["sigOld:0:W"] });
    expect(last.map((t) => t.signature)).toEqual(["sig1"]);
  });

  test("signed out the tracked topic errors and the tape works alone", () => {
    let last: Trade[] = [];
    ds.subscribe(`trades:${MINT}`, (m) => {
      if (m.type === "snapshot") last = (m.data as { trades: Trade[] }).trades;
    });
    s.error(`tracked:${MINT}`, "unauthorized");
    s.snapshot(`trades:${MINT}`, 1, { trades: [wireTrade()] });
    expect(last).toHaveLength(1);
  });
});
