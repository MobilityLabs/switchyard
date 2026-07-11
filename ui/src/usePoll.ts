import { useCallback, useEffect, useRef, useState } from "react";

export function usePoll<T>(fn: () => Promise<T>, deps: unknown[], intervalMs = 15000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    const run = () =>
      fnRef.current().then(
        (d) => { if (live) { setData(d); setError(null); } },
        (e) => { if (live) setError(e instanceof Error ? e.message : String(e)); },
      );
    const start = () => {
      if (timer === null) timer = setInterval(run, intervalMs);
    };
    const stop = () => {
      if (timer !== null) { clearInterval(timer); timer = null; }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        stop();
      } else {
        run();
        start();
      }
    };
    run();
    if (document.visibilityState !== "hidden") start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      live = false;
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, intervalMs]);

  return { data, error, reload };
}
