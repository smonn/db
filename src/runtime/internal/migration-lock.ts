import type { Queryable } from "../ports/index.ts";

// "SMONNDBMIGRATE" on a phone keypad, per ADR-0008.
export const MIGRATION_LOCK_KEY = "76666326447283";

const POLL_INTERVAL_MS = 100;

/** Resolves after `ms`, or as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

function throwIfStopped(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new Error("stopped waiting for the migrator's lock", { cause: signal.reason });
  }
}

function once(fn: (() => void) | undefined): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    fn?.();
  };
}

async function tryLock(session: Queryable): Promise<boolean> {
  const { rows } = await session.query(
    `select pg_try_advisory_lock(${MIGRATION_LOCK_KEY}) as locked`,
  );
  return rows[0]?.["locked"] === true;
}

/**
 * Takes the migration session advisory lock by polling `pg_try_advisory_lock`, which the session's
 * reset releases. Blocking in `pg_advisory_lock` would deadlock with a `CONCURRENTLY` statement in
 * the holder, which waits on the snapshot of a waiter (ADR-0020).
 *
 * `onWait` runs once, after the first attempt finds the lock held, so a caller can say it is waiting.
 * A free lock never calls it.
 *
 * Aborting `signal` ends the wait with an error whose `cause` is the signal's reason. A poll already
 * sent still finishes, and a lock it takes stays with the session until the session ends.
 */
export async function acquireMigrationLock(
  session: Queryable,
  {
    intervalMs = POLL_INTERVAL_MS,
    signal,
    onWait,
  }: {
    readonly intervalMs?: number;
    readonly signal?: AbortSignal | undefined;
    readonly onWait?: (() => void) | undefined;
  } = {},
): Promise<void> {
  const notifyOnce = once(onWait);
  for (;;) {
    throwIfStopped(signal);
    // oxlint-disable-next-line eslint/no-await-in-loop -- each poll waits on the one before it.
    if (await tryLock(session)) return;
    notifyOnce();
    // oxlint-disable-next-line eslint/no-await-in-loop -- see above.
    await sleep(intervalMs, signal);
  }
}
