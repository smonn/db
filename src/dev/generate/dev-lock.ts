import type { Driver } from "../../runtime/ports/index.ts";

// "SMONNDBDEV" on a phone keypad. The migrator's key spells "SMONNDBMIGRATE", so the two differ.
const DEV_LOCK_KEY = "7666632338";

/**
 * Runs `fn` while holding a session `pg_try_advisory_lock` on the Dev database, shared by
 * `generate`, `commit`, and `reset`. A second run fails at once instead of waiting, since a waiting
 * run would only redo the first run's reset.
 */
export function withDevLock<T>(driver: Driver, command: string, fn: () => Promise<T>): Promise<T> {
  return driver.session(async (session) => {
    const {
      rows: [row],
    } = await session.query(`select pg_try_advisory_lock(${DEV_LOCK_KEY}) as locked`);
    if (row?.["locked"] !== true) {
      throw new Error(
        `can't ${command}: another generate, commit, or reset holds advisory lock ${DEV_LOCK_KEY} on the Dev database`,
      );
    }
    return fn();
  });
}
