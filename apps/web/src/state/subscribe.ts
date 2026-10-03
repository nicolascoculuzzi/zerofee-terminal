import type { DeltaData, SnapshotData, Topic } from "../protocol";
import { getServices } from "../services";

/**
 * Subscribes with the protocol's sequencing rules: deltas before the first snapshot are
 * dropped, and a gap in `seq` triggers a resubscribe to get a fresh snapshot.
 */
export function subscribeSequenced<T extends Topic>(
  topic: T,
  onSnapshot: (data: SnapshotData<T>) => void,
  onDelta: (data: DeltaData<T>) => void,
): () => void {
  const { data } = getServices();
  let lastSeq: number | null = null;
  let unsub: (() => void) | null = null;
  let closed = false;

  const start = () => {
    lastSeq = null;
    unsub = data.subscribe(topic, (msg) => {
      if (closed) return;
      if (msg.type === "snapshot") {
        lastSeq = msg.seq;
        onSnapshot(msg.data as SnapshotData<T>);
        return;
      }
      if (lastSeq === null) return;
      if (msg.seq !== lastSeq + 1) {
        console.warn(`[feed] seq gap on ${topic}: expected ${lastSeq + 1}, got ${msg.seq}; resubscribing`);
        unsub?.();
        start();
        return;
      }
      lastSeq = msg.seq;
      onDelta(msg.data as DeltaData<T>);
    });
  };

  start();
  return () => {
    closed = true;
    unsub?.();
  };
}
