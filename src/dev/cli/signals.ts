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
 * Listens for SIGINT and SIGTERM only while a cleanup is registered. On either, it removes its
 * listeners, runs every registered cleanup, and runs straight away any cleanup registered later.
 * Once all have settled it raises the signal again, so the process still dies of it with the
 * usual exit status.
 */
export function onProcessInterrupt(target: SignalTarget = process): OnInterrupt {
  const cleanups = new Set<() => Promise<void>>();
  let running: Promise<void>[] | undefined;
  const listen = (): void => {
    for (const signal of SIGNALS) target.on(signal, interrupted);
  };
  const stopListening = (): void => {
    for (const signal of SIGNALS) target.off(signal, interrupted);
  };
  function interrupted(signal: NodeJS.Signals): void {
    stopListening();
    const started = [...cleanups].map((cleanup) => cleanup());
    running = started;
    void settleAll(started).then(() => target.kill(target.pid, signal));
  }
  return (cleanup) => {
    if (running !== undefined) {
      running.push(cleanup());
      return () => {};
    }
    if (cleanups.size === 0) listen();
    cleanups.add(cleanup);
    return () => {
      cleanups.delete(cleanup);
      if (cleanups.size === 0) stopListening();
    };
  };
}

/** Settles every promise in `running`, including those pushed onto it while it waits. */
async function settleAll(running: readonly Promise<void>[]): Promise<void> {
  const count = running.length;
  await Promise.allSettled(running);
  if (running.length > count) await settleAll(running);
}
