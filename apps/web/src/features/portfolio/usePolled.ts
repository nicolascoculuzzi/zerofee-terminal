import { useCallback, useEffect, useRef, useState } from "react";

export interface Polled<T> {
  /** Latest result for the current key (or, while it loads, the previous key's in the same group). */
  data: T | null;
  /** No result for the current key yet. */
  loading: boolean;
  /** Consecutive failures for the current key; 3 means it stopped retrying (DESIGN.md 4.18). */
  failures: number;
  retry: () => void;
}

const RETRY_MS = 5_000;
const MAX_FAILURES = 3;

interface State<T> {
  key: string;
  group: string | null;
  data: T | null;
  failures: number;
}

/**
 * Loads `key`'s data, then refreshes every `everyMs`. A failure keeps the last good result,
 * retries after 5 s, and gives up after three in a row until `retry()` (DESIGN.md 4.18).
 * While a new key loads, the previous result stays up if it belongs to the same `group` (the
 * same wallet at another range), so a range toggle doesn't blank the chart; another wallet's
 * data is never shown.
 */
export function usePolled<T>(key: string | null, load: () => Promise<T>, everyMs: number, group: string | null = null): Polled<T> {
  const [state, setState] = useState<State<T> | null>(null);
  const [attempt, setAttempt] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (key === null) return;
    // `attempt` is a dependency so retry() restarts the cycle.
    void attempt;
    let cancelled = false;
    let fails = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = () => {
      loadRef.current().then(
        (data) => {
          if (cancelled) return;
          fails = 0;
          setState({ key, group, data, failures: 0 });
          timer = setTimeout(run, everyMs);
        },
        () => {
          if (cancelled) return;
          fails++;
          const n = fails;
          setState((prev) => ({ key, group, data: prev?.key === key ? prev.data : null, failures: n }));
          if (n < MAX_FAILURES) timer = setTimeout(run, RETRY_MS);
        },
      );
    };
    run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [key, group, everyMs, attempt]);

  const retry = useCallback(() => {
    setState((prev) => (prev ? { ...prev, failures: 0 } : prev));
    setAttempt((n) => n + 1);
  }, []);

  const current = key !== null && state?.key === key ? state : null;
  const previous = key !== null && group !== null && state !== null && state.group === group ? state.data : null;
  return { data: current ? current.data : previous, loading: key !== null && current === null, failures: current?.failures ?? 0, retry };
}
