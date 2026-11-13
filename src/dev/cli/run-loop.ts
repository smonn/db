export type RunLoop = {
  /** Records a change at `path`. A run starts once no change has come for the quiet time. */
  changed(path: string): void;
  /** Starts no more runs, and resolves once the run in progress, if any, has ended. */
  stop(): Promise<void>;
};

export type RunLoopOptions = {
  /** One run, given the paths that changed since the last one began. Its rejection is its own. */
  readonly run: (changes: readonly string[]) => Promise<void>;
  readonly quietMs: number;
};

/**
 * Runs `run` once at start, then again after each burst of changes, once `quietMs` pass without
 * another. Changes that settle during a run queue one rerun, which starts when the run ends, or
 * once the changes still arriving settle.
 */
export function runLoop({ run, quietMs }: RunLoopOptions): RunLoop {
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let queued = false;
  let stopped = false;

  const start = (): void => {
    const changes = [...pending];
    pending.clear();
    queued = false;
    running = run(changes)
      .catch(() => {})
      .finally(() => {
        running = undefined;
        // With a timer pending, the changes are still arriving: the timer starts the rerun.
        if (queued && !stopped && timer === undefined) start();
      });
  };
  const quiet = (): void => {
    timer = undefined;
    if (stopped) return;
    if (running === undefined) start();
    else queued = true;
  };

  start();
  return {
    changed(path) {
      pending.add(path);
      clearTimeout(timer);
      timer = setTimeout(quiet, quietMs);
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
