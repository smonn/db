import { describe, expect, it, vi } from "vitest";
import { onProcessInterrupt } from "./signals.ts";

type Listener = (signal: NodeJS.Signals) => void;

// Keeps duplicates, as Node's process does, so a listener added twice counts twice.
function fakeProcess() {
  const listeners: { signal: NodeJS.Signals; listener: Listener }[] = [];
  return {
    pid: 42,
    kill: vi.fn<(pid: number, signal: NodeJS.Signals) => void>(),
    on(signal: NodeJS.Signals, listener: Listener): void {
      listeners.push({ signal, listener });
    },
    off(signal: NodeJS.Signals, listener: Listener): void {
      const index = listeners.findIndex((l) => l.signal === signal && l.listener === listener);
      if (index !== -1) listeners.splice(index, 1);
    },
    emit(signal: NodeJS.Signals): void {
      for (const l of listeners.filter((entry) => entry.signal === signal)) l.listener(signal);
    },
    counts: (): number[] =>
      ["SIGINT", "SIGTERM"].map((signal) => listeners.filter((l) => l.signal === signal).length),
  };
}

describe("onProcessInterrupt", () => {
  it.each(["SIGINT", "SIGTERM"] as const)(
    "runs every cleanup on %s, then re-raises it with no listener left",
    async (signal) => {
      const target = fakeProcess();
      const onInterrupt = onProcessInterrupt(target);
      const ran: string[] = [];
      const cleanup = (name: string) => (): Promise<void> => {
        ran.push(name);
        return Promise.resolve();
      };
      onInterrupt(cleanup("shadow"));
      onInterrupt(() => Promise.reject(new Error("gone")));
      onInterrupt(cleanup("definition"));

      target.emit(signal);

      await vi.waitFor(() => {
        expect(target.kill).toHaveBeenCalledWith(42, signal);
      });
      expect(ran).toStrictEqual(["shadow", "definition"]);
      expect(target.counts()).toStrictEqual([0, 0]);
    },
  );

  it("listens once however many cleanups are registered, and stops when all are unregistered", () => {
    const target = fakeProcess();
    const onInterrupt = onProcessInterrupt(target);

    const unregister = [1, 2, 3].map(() => onInterrupt(() => Promise.resolve()));
    expect(target.counts()).toStrictEqual([1, 1]);
    for (const done of unregister) done();
    expect(target.counts()).toStrictEqual([0, 0]);

    onInterrupt(() => Promise.resolve())();
    expect(target.counts()).toStrictEqual([0, 0]);
    expect(target.kill).not.toHaveBeenCalled();
  });
});
