import type { OnInterrupt } from "../shadow/index.ts";

type SignalListener = (signal: NodeJS.Signals) => void;

type SignalTarget = {
  readonly pid: number;
  on(signal: NodeJS.Signals, listener: SignalListener): unknown;
  off(signal: NodeJS.Signals, listener: SignalListener): unknown;
  kill(pid: number, signal: NodeJS.Signals): unknown;
};

const SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

/**
 * Listens for SIGINT and SIGTERM only while a cleanup is registered. On either, it runs every
 * registered cleanup, then removes its listeners and raises the signal again, so the process
 * still dies of it with the usual exit status.
 */
export function onProcessInterrupt(target: SignalTarget = process): OnInterrupt {
  const cleanups = new Set<() => Promise<void>>();
  const listen = (): void => {
    for (const signal of SIGNALS) target.on(signal, interrupted);
  };
  const stopListening = (): void => {
    for (const signal of SIGNALS) target.off(signal, interrupted);
  };
  function interrupted(signal: NodeJS.Signals): void {
    stopListening();
    void Promise.allSettled([...cleanups].map((cleanup) => cleanup())).then(() =>
      target.kill(target.pid, signal),
    );
  }
  return (cleanup) => {
    if (cleanups.size === 0) listen();
    cleanups.add(cleanup);
    return () => {
      cleanups.delete(cleanup);
      if (cleanups.size === 0) stopListening();
    };
  };
}
