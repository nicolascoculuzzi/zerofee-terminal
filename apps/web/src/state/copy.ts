import type { CopyDelta, CopyPosition, CopySignal, CopySnapshot, CopyTask } from "@zerofee/protocol";
import { create } from "zustand";

const SIGNALS_MAX = 100;

/** Copy tasks, positions and signals from the `copy` topic (live mode, signed in). */
export interface CopyState {
  /** The topic is live for this session (false signed out, or in the simulation). */
  available: boolean;
  tasks: CopyTask[];
  positions: CopyPosition[];
  signals: CopySignal[];
  setAvailable(available: boolean): void;
  applySnapshot(s: CopySnapshot): void;
  applyDelta(d: CopyDelta): void;
  upsertTask(task: CopyTask): void;
  removeTask(id: string): void;
}

const byId = <T extends { id: string }>(list: T[], upsert: T[]): T[] => {
  if (upsert.length === 0) return list;
  const map = new Map(list.map((x) => [x.id, x]));
  for (const x of upsert) map.set(x.id, x);
  return [...map.values()];
};

const positionKey = (p: CopyPosition) => `${p.taskId}:${p.mint}`;

export const useCopy = create<CopyState>()((set) => ({
  available: false,
  tasks: [],
  positions: [],
  signals: [],
  setAvailable(available) {
    set(available ? { available } : { available, tasks: [], positions: [], signals: [] });
  },
  applySnapshot(s) {
    set({ available: true, tasks: s.tasks, positions: s.positions, signals: s.signals.slice(0, SIGNALS_MAX) });
  },
  applyDelta(d) {
    set((st) => {
      const removed = new Set(d.removedTasks ?? []);
      const closed = new Set(d.closedPositions ?? []);
      const positions = new Map(st.positions.map((p) => [positionKey(p), p]));
      for (const k of closed) positions.delete(k);
      for (const p of d.positions ?? []) positions.set(positionKey(p), p);
      const signals = byId(st.signals, d.signals ?? []).sort((a, b) => b.createdAt - a.createdAt);
      return {
        tasks: byId(st.tasks, d.tasks ?? []).filter((t) => !removed.has(t.id)),
        positions: [...positions.values()].filter((p) => !removed.has(p.taskId)),
        signals: signals.slice(0, SIGNALS_MAX),
      };
    });
  },
  upsertTask(task) {
    set((st) => ({ tasks: byId(st.tasks, [task]) }));
  },
  removeTask(id) {
    set((st) => ({ tasks: st.tasks.filter((t) => t.id !== id), positions: st.positions.filter((p) => p.taskId !== id) }));
  },
}));
