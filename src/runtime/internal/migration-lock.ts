import type { Queryable } from "../ports/index.ts";

// "SMONNDBMIGRATE" on a phone keypad, per ADR-0008.
const MIGRATION_LOCK_KEY = "76666326447283";

const POLL_INTERVAL_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Takes the migration session advisory lock by polling `pg_try_advisory_lock`, which the session's
 * reset releases. Blocking in `pg_advisory_lock` would deadlock with a `CONCURRENTLY` statement in
 * the holder, which waits on the snapshot of a waiter (ADR-0020).
 */
export async function acquireMigrationLock(
  session: Queryable,
  { intervalMs = POLL_INTERVAL_MS }: { readonly intervalMs?: number } = {},
): Promise<void> {
  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each poll waits on the one before it.
    const { rows } = await session.query(
      `select pg_try_advisory_lock(${MIGRATION_LOCK_KEY}) as locked`,
    );
    if (rows[0]?.["locked"] === true) {
      return;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- see above.
    await sleep(intervalMs);
  }
}
