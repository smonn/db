import type { ParsedMigration, TrackingSchema } from "../internal/index.ts";
import type { Queryable } from "../ports/index.ts";

/** Runs `fn` in a transaction: `migrate` opens one per file, `reset` hands over the one it replays in. */
export type Transact = (fn: (tx: Queryable) => Promise<void>) => Promise<void>;

/**
 * The one apply step that `migrate` and `reset` share. A transactional Committed migration runs
 * its body and records its row inside `transact`. A no-transaction one (ADR-0020) ignores
 * `transact` and runs on `session`, which must not be in a transaction: its row is recorded
 * `started` first and set to `applied`, or to `failed` with Postgres's message, after. A process
 * that dies mid-statement leaves `started`. Rethrows the statement's error.
 */
export function applyMigration(
  session: Queryable,
  tracking: TrackingSchema,
  migration: ParsedMigration,
  transact: Transact,
): Promise<void> {
  return migration.noTransaction
    ? applyWithoutTransaction(session, tracking, migration)
    : transact(async (tx) => {
        await tx.execute(migration.body);
        await tracking.recordMigration(tx, migration);
      });
}

async function applyWithoutTransaction(
  session: Queryable,
  tracking: TrackingSchema,
  migration: ParsedMigration,
): Promise<void> {
  await tracking.recordStarted(session, migration);
  try {
    await session.execute(migration.body);
  } catch (error) {
    try {
      await tracking.markFailed(
        session,
        migration,
        error instanceof Error ? error.message : String(error),
      );
    } catch (markError) {
      throw new AggregateError([error, markError], "the statement failed, and so did marking it", {
        cause: markError,
      });
    }
    throw error;
  }
  await tracking.markApplied(session, migration);
}
