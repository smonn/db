import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runLoop } from "./run-loop.ts";

/** A run that records its changes and waits for the test to finish it. */
function recorder() {
  const runs: (readonly string[])[] = [];
  const gates: PromiseWithResolvers<void>[] = [];
  return {
    runs,
    run: (changes: readonly string[]): Promise<void> => {
      runs.push(changes);
      const next = Promise.withResolvers<void>();
      gates.push(next);
      return next.promise;
    },
    /** Finishes the run in progress and lets the loop react. */
    finish: async (): Promise<void> => {
      gates.at(-1)?.resolve();
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("runLoop", () => {
  it("runs once at start, with no changes", () => {
    const { runs, run } = recorder();

    runLoop({ run, quietMs: 100 });

    expect(runs).toStrictEqual([[]]);
  });

  it("starts a run after the quiet time, with every change since the last one", async () => {
    const runs = recorder();
    const loop = runLoop({ run: runs.run, quietMs: 100 });
    await runs.finish();

    loop.changed("a.ts");
    await vi.advanceTimersByTimeAsync(60);
    loop.changed("b.ts");
    await vi.advanceTimersByTimeAsync(99);
    expect(runs.runs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(runs.runs).toStrictEqual([[], ["a.ts", "b.ts"]]);
  });

  it("names a path once however often it changed", async () => {
    const runs = recorder();
    const loop = runLoop({ run: runs.run, quietMs: 100 });
    await runs.finish();

    loop.changed("a.ts");
    loop.changed("a.ts");
    await vi.advanceTimersByTimeAsync(100);

    expect(runs.runs.at(-1)).toStrictEqual(["a.ts"]);
  });

  it("hands each run only the changes since the one before", async () => {
    const runs = recorder();
    const loop = runLoop({ run: runs.run, quietMs: 100 });
    await runs.finish();
    loop.changed("a.ts");
    await vi.advanceTimersByTimeAsync(100);
    await runs.finish();

    loop.changed("b.ts");
    await vi.advanceTimersByTimeAsync(100);

    expect(runs.runs).toStrictEqual([[], ["a.ts"], ["b.ts"]]);
  });

  it("queues at most one rerun for changes during a run, and starts it when the run ends", async () => {
    const runs = recorder();
    const loop = runLoop({ run: runs.run, quietMs: 100 });

    loop.changed("a.ts");
    await vi.advanceTimersByTimeAsync(100);
    loop.changed("b.ts");
    await vi.advanceTimersByTimeAsync(100);
    expect(runs.runs).toHaveLength(1);
    await runs.finish();

    expect(runs.runs).toStrictEqual([[], ["a.ts", "b.ts"]]);
    await runs.finish();
    await vi.advanceTimersByTimeAsync(1000);
    expect(runs.runs).toHaveLength(2);
  });

  it("leaves a queued rerun to the quiet timer while changes are still arriving", async () => {
    const runs = recorder();
    const loop = runLoop({ run: runs.run, quietMs: 100 });
    loop.changed("a.ts");
    await vi.advanceTimersByTimeAsync(100);
    loop.changed("b.ts");
    await vi.advanceTimersByTimeAsync(50);

    await runs.finish();
    expect(runs.runs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(runs.runs).toStrictEqual([[], ["a.ts", "b.ts"]]);
    await runs.finish();
    await vi.advanceTimersByTimeAsync(1000);

    expect(runs.runs).toHaveLength(2);
  });

  it("waits for quiet before a queued rerun that is still changing", async () => {
    const runs = recorder();
    const loop = runLoop({ run: runs.run, quietMs: 100 });

    loop.changed("a.ts");
    await runs.finish();
    expect(runs.runs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);

    expect(runs.runs).toStrictEqual([[], ["a.ts"]]);
  });

  it("keeps running after a run rejects", async () => {
    const runs: (readonly string[])[] = [];
    const loop = runLoop({
      run: (changes) => {
        runs.push(changes);
        return Promise.reject(new Error("boom"));
      },
      quietMs: 100,
    });
    await vi.advanceTimersByTimeAsync(0);

    loop.changed("a.ts");
    await vi.advanceTimersByTimeAsync(100);

    expect(runs).toStrictEqual([[], ["a.ts"]]);
  });

  it("drops a queued rerun once stopped, and resolves when the run in progress ends", async () => {
    const runs = recorder();
    const loop = runLoop({ run: runs.run, quietMs: 100 });
    loop.changed("a.ts");
    await vi.advanceTimersByTimeAsync(100);

    let stopped = false;
    void loop.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    await runs.finish();

    expect(stopped).toBe(true);
    expect(runs.runs).toStrictEqual([[]]);
  });

  it("starts nothing for a change once stopped", async () => {
    const runs = recorder();
    const loop = runLoop({ run: runs.run, quietMs: 100 });
    await runs.finish();
    await loop.stop();

    loop.changed("a.ts");
    await vi.advanceTimersByTimeAsync(1000);

    expect(runs.runs).toStrictEqual([[]]);
  });
});
