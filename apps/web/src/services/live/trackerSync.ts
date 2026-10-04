/**
 * Tracked wallets on the server (packages/protocol user.ts, /api/tracked-wallets): the server matches
 * every trade against them and serves the `tracked` and `tracked:<mint>` topics, so the list has to live
 * there, not only in this browser. While signed in:
 *   - on sign-in, the two lists are merged: wallets only the server has join the local list, wallets only
 *     this browser has are imported in one request (merge mode);
 *   - afterwards every local add, edit (name, emoji, alerts) and removal is mirrored with one REST call.
 * Signed out, the list stays local (the tracked topics need a session anyway).
 */
import type { TrackedWallet as ServerWallet, TrackedWalletImportResult, TrackedWalletInput } from "@zerofee/protocol";
import { type TrackedWallet, useTrackers } from "../../state/trackers";
import { api } from "./api";

export interface TrackerSyncDeps {
  /** Current session and its changes (LiveWalletService). */
  session(): unknown | null;
  onSessionChange(listener: () => void): () => void;
  rest?: <T>(path: string, o?: { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown }) => Promise<T>;
  /** Failures are reported here (the UI keeps working on the local list). */
  onError?: (message: string) => void;
}

const alertsOf = (on: boolean) => ({ buy: on, sell: on, create: on });
/** More new wallets than this at once go through the import endpoint. */
const BULK_ADD = 20;

function inputOf(w: TrackedWallet): TrackedWalletInput {
  return { address: w.address, label: w.name, emoji: w.emoji, alerts: alertsOf(w.alerts) };
}

function localOf(w: ServerWallet): Omit<TrackedWallet, "createdAt"> {
  return { address: w.address, name: w.label, emoji: w.emoji, alerts: w.alerts.buy || w.alerts.sell || w.alerts.create };
}

export class TrackerSync {
  private readonly rest: NonNullable<TrackerSyncDeps["rest"]>;
  private synced: Map<string, TrackedWallet> | null = null;
  private applying = false;
  private queue: Promise<void> = Promise.resolve();
  private readonly offs: (() => void)[] = [];

  constructor(private readonly d: TrackerSyncDeps) {
    this.rest = d.rest ?? ((path, o) => api(path, o));
  }

  start(): void {
    let signedIn = this.d.session() !== null;
    if (signedIn) this.enqueue(() => this.initial());
    this.offs.push(
      this.d.onSessionChange(() => {
        const now = this.d.session() !== null;
        if (now === signedIn) return;
        signedIn = now;
        this.synced = null;
        if (now) this.enqueue(() => this.initial());
      }),
      useTrackers.subscribe((s, prev) => {
        if (s.wallets === prev.wallets || this.applying || this.synced === null) return;
        this.enqueue(() => this.mirror(s.wallets));
      }),
    );
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
  }

  /** Resolves once queued work is done (tests). */
  idle(): Promise<void> {
    return this.queue;
  }

  private enqueue(job: () => Promise<void>): void {
    this.queue = this.queue.then(job).catch((e: unknown) => this.d.onError?.(e instanceof Error ? e.message : String(e)));
  }

  private async initial(): Promise<void> {
    const server = await this.rest<ServerWallet[]>("/api/tracked-wallets");
    const local = useTrackers.getState().wallets;
    const onServer = new Set(server.map((w) => w.address));
    const missingLocally = server.filter((w) => !local.some((l) => l.address === w.address));
    const missingOnServer = local.filter((w) => !onServer.has(w.address));
    if (missingLocally.length > 0) {
      this.applying = true;
      try {
        useTrackers.getState().importWallets(missingLocally.map(localOf));
      } finally {
        this.applying = false;
      }
    }
    if (missingOnServer.length > 0) {
      // GMGN's export shape ({ address, name, emoji }) is one of the formats the import detects.
      await this.rest<TrackedWalletImportResult>("/api/tracked-wallets/import", {
        method: "POST",
        body: { data: missingOnServer.map((w) => ({ address: w.address, name: w.name, emoji: w.emoji })), mode: "merge" },
      });
      // Alerts are not part of that format: set them where they differ from the server default.
      for (const w of missingOnServer) {
        if (!w.alerts) await this.rest(`/api/tracked-wallets/${w.address}`, { method: "PATCH", body: { alerts: alertsOf(false) } });
      }
    }
    this.synced = new Map(useTrackers.getState().wallets.map((w) => [w.address, w]));
  }

  private async mirror(wallets: TrackedWallet[]): Promise<void> {
    const before = this.synced ?? new Map<string, TrackedWallet>();
    const after = new Map(wallets.map((w) => [w.address, w]));
    for (const [address] of before) if (!after.has(address)) await this.rest(`/api/tracked-wallets/${address}`, { method: "DELETE" });
    const added = wallets.filter((w) => !before.has(w.address));
    if (added.length > BULK_ADD) {
      // A local import: one request instead of one per wallet.
      await this.rest<TrackedWalletImportResult>("/api/tracked-wallets/import", {
        method: "POST",
        body: { data: added.map((w) => ({ address: w.address, name: w.name, emoji: w.emoji })), mode: "merge" },
      });
    } else for (const w of added) await this.rest("/api/tracked-wallets", { method: "POST", body: inputOf(w) });
    for (const [address, w] of after) {
      const old = before.get(address);
      if (old && (old.name !== w.name || old.emoji !== w.emoji || old.alerts !== w.alerts)) {
        const { address: _a, ...patch } = inputOf(w);
        await this.rest(`/api/tracked-wallets/${address}`, { method: "PATCH", body: patch });
      }
    }
    this.synced = after;
  }
}
