import type { CopySignal, CopyTask } from "@zerofee/protocol";
import { Copy, Pause, Play, Trash2 } from "lucide-react";
import { type FormEvent, useId, useMemo, useState } from "react";
import { Age } from "../../components/ui/Age";
import { Button, IconButton } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/bits";
import { NumberInput, Switch } from "../../components/ui/controls";
import { isBase58Address } from "../../lib/address";
import { cn } from "../../lib/cn";
import { fmtInt, fmtSol, shortAddr, signClass } from "../../lib/format";
import { getServices } from "../../services";
import { useCopy } from "../../state/copy";
import { useTrackers } from "../../state/trackers";
import { useWallet } from "../../state/wallet";
import { Tag } from "../settings/ui";
import { MetaCount, PaneToolbar, ToolbarSep } from "./bits";

/*
 * Copy trading (live mode). Tasks follow a leader wallet; the server vets each of the leader's trades and
 * pushes a signal, and this browser builds, checks (signer firewall) and signs the copy while it is open
 * with the keystore unlocked. Sized in SOL with a per-buy and a daily cap; sells mirror the leader's.
 */

const STATUS_TONE: Record<CopySignal["status"], "neutral" | "buy" | "sell" | "warn" | "info"> = {
  pending: "info",
  executed: "buy",
  failed: "sell",
  declined: "warn",
  expired: "neutral",
  revoked: "neutral",
  skipped: "neutral",
};

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function NewTask() {
  const id = useId();
  const wallets = useTrackers((s) => s.wallets);
  const [leader, setLeader] = useState("");
  const [sol, setSol] = useState<number | null>(0.05);
  const [maxPerBuy, setMaxPerBuy] = useState<number | null>(0.25);
  const [daily, setDaily] = useState<number | null>(1);
  const [copySells, setCopySells] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const address = leader.trim();
  const tracked = wallets.find((w) => w.address === address);
  const valid = isBase58Address(address) && sol !== null && sol > 0 && maxPerBuy !== null && maxPerBuy > 0 && daily !== null && daily > 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const copy = getServices().copy;
    if (!copy || !valid) return;
    setBusy(true);
    setError(null);
    try {
      await copy.create({
        leader: address,
        label: tracked?.name || shortAddr(address),
        config: {
          sizing: { mode: "fixed", sol: sol as number },
          maxPerBuySol: maxPerBuy as number,
          dailySpendLimitSol: daily as number,
          copySells,
        },
      });
      setLeader("");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-2 border-b border-hairline p-3" noValidate>
      <div className="text-data font-medium text-fg-1">New copy task</div>
      <label className="flex flex-col gap-1 text-label text-fg-3" htmlFor={`${id}-leader`}>
        Leader wallet
        <input
          id={`${id}-leader`}
          className="zf-input font-mono"
          value={leader}
          list={`${id}-tracked`}
          spellCheck={false}
          autoComplete="off"
          placeholder="Address, or pick a tracked wallet"
          onChange={(e) => setLeader(e.target.value)}
        />
        <datalist id={`${id}-tracked`}>
          {wallets.slice(0, 500).map((w) => (
            <option key={w.address} value={w.address}>
              {w.name || shortAddr(w.address)}
            </option>
          ))}
        </datalist>
      </label>
      <div className="grid grid-cols-3 gap-2 text-label text-fg-3">
        <span className="flex flex-col gap-1">
          Per buy
          <NumberInput value={sol} onChange={setSol} min={0} suffix="SOL" ariaLabel="SOL per copied buy" />
        </span>
        <span className="flex flex-col gap-1">
          Max per buy
          <NumberInput value={maxPerBuy} onChange={setMaxPerBuy} min={0} suffix="SOL" ariaLabel="Largest copied buy, SOL" />
        </span>
        <span className="flex flex-col gap-1">
          Daily cap
          <NumberInput value={daily} onChange={setDaily} min={0} suffix="SOL" ariaLabel="Copied buys per day, SOL" />
        </span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-label text-fg-2">
          <Switch checked={copySells} onChange={setCopySells} label="Mirror the leader's sells" />
          Mirror the leader's sells
        </span>
        <Button size="sm" variant="primary" type="submit" icon={<Copy />} disabled={!valid || busy}>
          {busy ? "Creating…" : "Copy wallet"}
        </Button>
      </div>
      {error && <p className="text-label text-sell">{error}</p>}
    </form>
  );
}

function TaskRow({ task }: { task: CopyTask }) {
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<unknown>) => async () => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const copy = getServices().copy;
  const s = task.stats;
  const sizing = task.config.sizing.mode === "fixed" ? `${fmtSol(task.config.sizing.sol)} SOL` : `${task.config.sizing.pct}% of leader`;
  return (
    <li className="flex flex-col gap-1 border-b border-hairline px-3 py-2 text-data">
      <div className="flex items-center gap-2">
        <span className="min-w-0 truncate font-medium text-fg-1">{task.label || shortAddr(task.leader)}</span>
        <span className="font-mono text-label text-fg-3">{shortAddr(task.leader)}</span>
        <Tag tone={task.status === "active" ? "buy" : "neutral"}>{task.status === "active" ? "Active" : "Paused"}</Tag>
        <span className="ml-auto flex items-center gap-1">
          {copy && task.status === "active" && (
            <IconButton size="sm" label="Pause copying" disabled={busy} onClick={() => void run(() => copy.pause(task.id))()}>
              <Pause />
            </IconButton>
          )}
          {copy && task.status === "paused" && (
            <IconButton size="sm" label="Resume copying" disabled={busy} onClick={() => void run(() => copy.resume(task.id))()}>
              <Play />
            </IconButton>
          )}
          {copy &&
            (confirmDelete ? (
              <Button size="xs" variant="secondary" disabled={busy} onClick={() => void run(() => copy.remove(task.id))()}>
                Delete task
              </Button>
            ) : (
              <IconButton size="sm" label="Delete copy task" disabled={busy} onClick={() => setConfirmDelete(true)}>
                <Trash2 />
              </IconButton>
            ))}
        </span>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-label text-fg-3">
        <span>{sizing} per buy</span>
        <span>
          today <span className="zf-num text-fg-2">{fmtSol(s.spentTodaySol)}</span> / {fmtSol(task.config.dailySpendLimitSol)} SOL
        </span>
        <span>
          <span className="zf-num text-fg-2">{fmtInt(s.executed)}</span> copied · {fmtInt(s.failed)} failed · {fmtInt(s.skipped)} skipped
        </span>
        <span>
          PnL <span className={cn("zf-num", signClass(s.realizedPnlSol))}>{fmtSol(s.realizedPnlSol)}</span> SOL
        </span>
      </div>
      {error && <p className="text-label text-sell">{error}</p>}
    </li>
  );
}

function SignalRow({ signal }: { signal: CopySignal }) {
  return (
    <li className="flex items-center gap-2 border-b border-hairline px-3 py-1 text-label">
      <Age ts={signal.createdAt} className="w-8 shrink-0" />
      <span className={cn("w-7 shrink-0 font-medium", signal.side === "buy" ? "text-buy" : "text-sell")}>
        {signal.side === "buy" ? "Buy" : "Sell"}
      </span>
      <span className="min-w-0 flex-1 truncate text-fg-1">{signal.symbol || shortAddr(signal.mint)}</span>
      {signal.side === "buy" && signal.sizeSol !== null && <span className="zf-num text-fg-2">{fmtSol(signal.sizeSol)} SOL</span>}
      <Tag tone={STATUS_TONE[signal.status]}>{signal.status}</Tag>
      {signal.reason && (
        <span className="max-w-32 truncate text-fg-3" title={signal.reason}>
          {signal.reason}
        </span>
      )}
    </li>
  );
}

export function CopyPane({ query }: { query: string }) {
  const available = useCopy((s) => s.available);
  const tasks = useCopy((s) => s.tasks);
  const signals = useCopy((s) => s.signals);
  const session = useWallet((s) => s.service.session);
  const locked = useWallet((s) => s.service.locked);
  const q = query.trim().toLowerCase();
  const shownTasks = useMemo(
    () => (q ? tasks.filter((t) => t.leader.toLowerCase().includes(q) || t.label.toLowerCase().includes(q)) : tasks),
    [tasks, q],
  );
  const shownSignals = useMemo(
    () =>
      q
        ? signals.filter(
            (s) => s.symbol.toLowerCase().includes(q) || s.mint.toLowerCase().includes(q) || s.leader.toLowerCase().includes(q),
          )
        : signals,
    [signals, q],
  );

  if (!session) {
    return (
      <EmptyState
        icon={<Copy />}
        title="Sign in to copy trade"
        body="Copy tasks live on the server with your session; the copies are signed in this browser."
      />
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PaneToolbar>
        <MetaCount>{tasks.length === 1 ? "1 copy task" : `${fmtInt(tasks.length)} copy tasks`}</MetaCount>
        <ToolbarSep />
        <MetaCount className={locked ? "text-warn" : undefined}>
          {locked ? "Keystore locked: signals wait until it's unlocked" : "Copies are signed here while this tab is open"}
        </MetaCount>
      </PaneToolbar>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <NewTask />
        {!available ? (
          <EmptyState title="Copy trading is connecting" body="Waiting for the copy feed from the server." />
        ) : shownTasks.length === 0 ? (
          <EmptyState title={q ? "No task matches" : "No copy tasks yet"} body="Pick a wallet above to copy its trades." />
        ) : (
          <ul aria-label="Copy tasks">
            {shownTasks.map((t) => (
              <TaskRow key={t.id} task={t} />
            ))}
          </ul>
        )}
        {shownSignals.length > 0 && (
          <section aria-label="Recent copy signals">
            <div className="px-3 pt-3 pb-1 text-label font-medium text-fg-2">Recent signals</div>
            <ul>
              {shownSignals.slice(0, 50).map((s) => (
                <SignalRow key={s.id} signal={s} />
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
