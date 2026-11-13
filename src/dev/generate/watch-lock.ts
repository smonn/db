import type { Driver } from "../../runtime/ports/index.ts";

// "SMONNDBWATCH" on a phone keypad, unlike the Dev and migrator keys.
export const WATCH_LOCK_KEY = "766663292824";

/** Another `generate --watch` holds the watcher's advisory lock on the Dev database. */
export class WatcherLockedError extends Error {}

/**
 * Runs `fn` while holding the watcher's session `pg_try_advisory_lock`, so a second watcher on the
 * Dev database fails at start: it is almost always a forgotten terminal. The lock holds one
 * connection for as long as `fn` runs, and each run takes the Dev lock on another.
 */
export function withWatchLock<T>(driver: Driver, fn: () => Promise<T>): Promise<T> {
  return driver.session(async (session) => {
    const {
      rows: [row],
    } = await session.query(`select pg_try_advisory_lock(${WATCH_LOCK_KEY}) as locked`);
    if (row!["locked"] !== true) {
      throw new WatcherLockedError(
        `can't watch: another generate --watch holds advisory lock ${WATCH_LOCK_KEY} on the Dev database`,
      );
    }
    return fn();
  });
}
